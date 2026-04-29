// ---------------------------------------------------------------------------
// Competitor signal — content strategy §4 (2026-04-18 redesign)
//
// Reads source config from config/categories.yaml, fetches sitemaps for all
// 19 sources, filters by freshness window, clusters similar posts across
// competitors, and returns a ranked list of candidate topic clusters for
// the resolver to draw from.
//
// V1 scope: sitemap XML via plain fetch (no Firecrawl dep — sitemaps are
// public, standard XML, and firewall-free). Slug-based clustering via
// token Jaccard similarity. Tier-weighted scoring that rewards topics
// multiple tier-1/tier-2 competitors covered recently.
//
// Deferred to V2: full content scraping via Firecrawl, LLM-based semantic
// clustering (beats slug tokens on paraphrased titles), primary-source
// citation overlap scoring.
//
// Reads: config/categories.yaml (via ./category-cooldown.ts helpers)
// Writes: tmp/competitor-signal-cache.json (cached scrape results)
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { categorizePost, getCategoryStatus, listCategories } from './category-cooldown';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Tier = 1 | 2 | 3 | 4;

interface SourceConfig {
  id: string;
  name: string;
  tier: Tier;
  url: string;
  sitemap_path: string | null;
  freshness: 'daily' | 'weekly' | 'on_demand';
  notes?: string;
}

export interface CandidateURL {
  url: string;
  title: string;
  lastmod: string | null;
  source_id: string;
  source_name: string;
  tier: Tier;
  suggested_category: string;
}

export interface TopicCluster {
  id: string;
  representative_title: string;
  urls: CandidateURL[];
  tier_counts: { tier1: number; tier2: number; tier3: number; tier4: number };
  most_recent_lastmod: string | null;
  suggested_category: string;
  /** Computed score; higher = more worth writing about */
  score: number;
  /** True if the suggested_category is currently in cooldown — resolver filters these out */
  category_blocked: boolean;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

interface CategoriesFile {
  sources: Record<string, Omit<SourceConfig, 'id'>>;
  categories: Record<string, unknown>;
  rules: {
    freshness: { tier1_window_days: number; tier2_window_days: number; tier4_window_days: number };
    research_density: { min_primary_sources: number; min_quotes_per_source: number };
  };
}

let cachedConfig: CategoriesFile | null = null;
function loadConfig(): CategoriesFile {
  if (cachedConfig) return cachedConfig;
  const p = path.join(process.cwd(), 'config', 'categories.yaml');
  cachedConfig = yaml.parse(fs.readFileSync(p, 'utf-8')) as CategoriesFile;
  return cachedConfig;
}

function listSources(): SourceConfig[] {
  const cfg = loadConfig();
  return Object.entries(cfg.sources).map(([id, s]) => ({ id, ...s }));
}

function freshnessWindowForTier(tier: Tier): number {
  const cfg = loadConfig();
  if (tier === 1) return cfg.rules.freshness.tier1_window_days;
  if (tier === 2) return cfg.rules.freshness.tier2_window_days;
  if (tier === 4) return cfg.rules.freshness.tier4_window_days;
  return 90; // tier 3 authorities don't have a window; accept a wide 90d default
}

// ---------------------------------------------------------------------------
// Sitemap parsing — XML is well-specified, regex handles it safely here
// ---------------------------------------------------------------------------

interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

export function parseSitemapXML(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  // Match <url>...</url> blocks (sitemap-urlset format). Sitemap indexes
  // use <sitemap> blocks — we handle those separately in fetchSitemap().
  const urlBlockRe = /<url[^>]*>([\s\S]*?)<\/url>/g;
  let m: RegExpExecArray | null;
  while ((m = urlBlockRe.exec(xml)) !== null) {
    const block = m[1];
    const loc = /<loc>([^<]+)<\/loc>/.exec(block)?.[1]?.trim();
    const lastmod = /<lastmod>([^<]+)<\/lastmod>/.exec(block)?.[1]?.trim() ?? null;
    if (loc) entries.push({ loc, lastmod });
  }
  return entries;
}

function parseSitemapIndex(xml: string): string[] {
  // Some sites ship a sitemap index pointing at multiple sub-sitemaps
  // (e.g. post-sitemap1.xml, post-sitemap2.xml). Return all child sitemap
  // URLs for the caller to follow.
  const indexes: string[] = [];
  const blockRe = /<sitemap[^>]*>([\s\S]*?)<\/sitemap>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml)) !== null) {
    const loc = /<loc>([^<]+)<\/loc>/.exec(m[1])?.[1]?.trim();
    if (loc) indexes.push(loc);
  }
  return indexes;
}

// ---------------------------------------------------------------------------
// Fetch + filter per source
// Common bot-friendly UA — some hosts (e.g. Heroku's default filter on
// dealershipguy.com) 503 unknown UAs. Browser UA is universally allowed
// and sitemaps are public SEO assets explicitly published for crawling.
const SIGNAL_UA =
  'Mozilla/5.0 (compatible; UltraPlanBot/1.0; +https://visquanta.com)';

// ---------------------------------------------------------------------------

async function fetchSitemap(url: string): Promise<SitemapEntry[]> {
  const res = await fetch(url, {
    headers: { 'User-Agent': SIGNAL_UA },
  });
  if (!res.ok) {
    throw new Error(`sitemap fetch failed: ${res.status} ${url}`);
  }
  const xml = await res.text();

  // If this is a sitemap index, follow the first few child sitemaps and
  // merge. Cap at 5 children to avoid runaway fan-out on sites with
  // paginated sitemaps like wordpress-post-sitemap1.xml, 2.xml, ...
  if (/<sitemapindex\b/.test(xml)) {
    // Some CMSes (Drupal in NADA's case) leak internal hostnames into
    // sitemap-index child URLs — e.g. live-drupal.nada.org instead of
    // www.nada.org. The same paths serve fine on the public origin, so
    // rewrite any child whose hostname differs from the parent's.
    const parentHost = (() => {
      try { return new URL(url).hostname; } catch { return null; }
    })();
    const children = parseSitemapIndex(xml)
      .map((child) => {
        if (!parentHost) return child;
        try {
          const u = new URL(child);
          if (u.hostname !== parentHost) {
            u.hostname = parentHost;
            u.protocol = 'https:';
            return u.toString();
          }
          return child;
        } catch {
          return child;
        }
      })
      .slice(0, 5);
    const all: SitemapEntry[] = [];
    for (const child of children) {
      try {
        const entries = await fetchSitemap(child);
        all.push(...entries);
      } catch (err) {
        console.warn(`[signal] child sitemap ${child} failed:`, err instanceof Error ? err.message : err);
      }
    }
    return all;
  }

  return parseSitemapXML(xml);
}

/**
 * Fetch a site's robots.txt and extract any Sitemap: directives. Standard
 * mechanism every sitemap-aware site publishes. Silent on network errors.
 */
async function discoverSitemapsFromRobots(origin: string): Promise<string[]> {
  try {
    const res = await fetch(`${origin.replace(/\/+$/, '')}/robots.txt`, {
      headers: { 'User-Agent': SIGNAL_UA },
    });
    if (!res.ok) return [];
    const txt = await res.text();
    const matches = [...txt.matchAll(/^\s*Sitemap:\s*(\S+)\s*$/gim)];
    return matches.map((m) => m[1]);
  } catch {
    return [];
  }
}

/**
 * Resolve a source to a working sitemap using a fallback chain:
 *   1. The sitemap_path configured in categories.yaml (if not null)
 *   2. Sitemap directives in the site's robots.txt
 *   3. `{origin}/sitemap.xml` at the root
 * Returns SitemapEntry[] from the first path that succeeds with a non-empty
 * result. Prefers post-specific sitemaps when robots.txt lists several.
 */
async function resolveSitemapEntries(source: SourceConfig): Promise<SitemapEntry[]> {
  const origin = source.url.replace(/\/+$/, '');
  const attempts: string[] = [];

  // 1. Configured path
  if (source.sitemap_path) {
    attempts.push(origin + source.sitemap_path);
  }

  // 2. robots.txt — prefer URLs with post/article/news in the path
  const robots = await discoverSitemapsFromRobots(origin);
  const ranked = robots.sort((a, b) => {
    const score = (u: string) => {
      if (/post[-_]?sitemap/i.test(u)) return 3;
      if (/(article|news|blog)/i.test(u)) return 2;
      if (/sitemap\.xml$/i.test(u)) return 1;
      return 0;
    };
    return score(b) - score(a);
  });
  for (const r of ranked) {
    if (!attempts.includes(r)) attempts.push(r);
  }

  // 3. Root /sitemap.xml fallback
  const root = `${origin}/sitemap.xml`;
  if (!attempts.includes(root)) attempts.push(root);

  let lastErr: unknown = null;
  for (const url of attempts) {
    try {
      const entries = await fetchSitemap(url);
      if (entries.length > 0) return entries;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw new Error(`all sitemap discovery attempts failed for ${source.id} (last: ${lastErr instanceof Error ? lastErr.message : String(lastErr)})`);
  return [];
}

function titleFromSlug(slug: string): string {
  return slug
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .pop()!
    .replace(/\.html?$/i, '')
    .split(/[-_]/)
    .filter((w) => w.length > 0)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

// URL patterns that are almost certainly navigational / non-article and
// should never be treated as topic candidates.
const SKIP_URL_PATTERNS = [
  /\/(tag|tags)\//i,
  /\/(category|categories)\//i,
  /\/author\//i,
  /\/page\/\d+/i,
  /\/feed\/?$/i,
  /\/wp-(content|admin|login|includes)\//i,
  /\.(xml|rss)$/i,
  /\/(privacy|terms|cookie|contact|about|careers|team|pricing|demo|book[- ]demo|request[- ]demo|reviews|retail|partners?|resources?|events?|affiliate|requirements)\/?$/i,
  /\/search\/?/i,
  /#/,
];

function isContentURL(u: string): boolean {
  if (SKIP_URL_PATTERNS.some((re) => re.test(u))) return false;
  // Reject single-segment paths (e.g. /blog, /reviews, /retail). Real
  // articles live at >=2 segments (/blog/slug-name, /resource-center/slug).
  try {
    const pathSegs = new URL(u).pathname.split('/').filter(Boolean);
    if (pathSegs.length < 2) return false;
    // Reject URLs whose last segment is a single word (landing/section page)
    const last = pathSegs[pathSegs.length - 1];
    if (!/-|_/.test(last) && last.length < 20) return false;
  } catch {
    return false;
  }
  return true;
}

async function collectFromSource(source: SourceConfig, windowDays: number): Promise<CandidateURL[]> {
  let entries: SitemapEntry[];
  try {
    entries = await resolveSitemapEntries(source);
  } catch (err) {
    console.warn(`[signal] ${source.id}: ${err instanceof Error ? err.message : err}`);
    return [];
  }

  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const fresh: CandidateURL[] = [];

  for (const entry of entries) {
    if (!isContentURL(entry.loc)) continue;
    if (entry.lastmod) {
      const ts = Date.parse(entry.lastmod);
      if (!Number.isNaN(ts) && ts < cutoff) continue;
    } else if (source.tier === 3) {
      // Tier 3 authority sources have massive archive sitemaps. No lastmod
      // means we can't prove freshness → skip. Competitor tiers (1/2) keep
      // entries without lastmod because smaller blogs sometimes omit it.
      continue;
    }
    const slug = new URL(entry.loc).pathname;
    const title = titleFromSlug(slug);
    const cat = categorizePost({ slug, title });
    fresh.push({
      url: entry.loc,
      title,
      lastmod: entry.lastmod,
      source_id: source.id,
      source_name: source.name,
      tier: source.tier,
      suggested_category: cat,
    });
  }
  return fresh;
}

// ---------------------------------------------------------------------------
// Caching — avoid re-scraping every pipeline run
// ---------------------------------------------------------------------------

const CACHE_PATH = path.join(process.cwd(), 'tmp', 'competitor-signal-cache.json');
const CACHE_TTL_HOURS = 6; // re-scrape every 6 hours max

interface CacheEntry {
  fetched_at: string; // ISO
  candidates: CandidateURL[];
}

function readCache(): CacheEntry | null {
  if (!fs.existsSync(CACHE_PATH)) return null;
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as CacheEntry;
    const age = Date.now() - Date.parse(parsed.fetched_at);
    if (age > CACHE_TTL_HOURS * 60 * 60 * 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(candidates: CandidateURL[]): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    const entry: CacheEntry = { fetched_at: new Date().toISOString(), candidates };
    fs.writeFileSync(CACHE_PATH, JSON.stringify(entry, null, 2));
  } catch (err) {
    console.warn('[signal] cache write failed:', err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Clustering — slug-token Jaccard similarity over fresh candidates
// ---------------------------------------------------------------------------

// Common stopwords + navigational tokens that would over-bind clusters if
// kept in the similarity comparison.
const CLUSTER_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you',
  'how', 'why', 'what', 'when', 'are', 'will', 'can', 'use', 'using',
  'car', 'cars', 'auto', 'automotive', 'dealer', 'dealers', 'dealership',
  'dealerships', 'sales', 'new', 'tips', 'guide', 'best', 'top', 'ways',
  'blog', 'post', 'article', 'read', 'more', 'get', 'make', 'need',
]);
// Note: titleTokens() also strips tokens shorter than 3 chars, which
// already neutralises 'ai', 'cx', 'ev', etc. as cluster magnets. If a
// future change lowers that minimum length, those should join this list
// — they're corpus-wide descriptors, not topical signal.

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/[\s-]+/)
      .filter((w) => w.length >= 3 && !CLUSTER_STOPWORDS.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  const union = new Set([...a, ...b]).size;
  return union > 0 ? shared / union : 0;
}

// Jaccard threshold for cross-publisher cluster merging. 0.30 was selected
// empirically via scripts/smoke-jaccard-sweep.ts against the cached pool —
// 0.40 left ~99% of articles as singletons (4 multi-publisher clusters);
// 0.25 produced a ~300-URL "AI in dealerships" megacluster; 0.30 yields
// ~11 multi-publisher clusters with no megacluster. Adjust together with
// CLUSTER_STOPWORDS — narrowing token vocabulary effectively raises Jaccard
// at any constant threshold.
const CLUSTER_JACCARD_THRESHOLD = 0.30;

export function clusterCandidates(candidates: CandidateURL[]): TopicCluster[] {
  // Filter candidates whose titles have fewer than 3 meaningful tokens —
  // single-word titles like "Review" / "Retail" / "Demo" are nav pages
  // masquerading as articles and would form bogus giant clusters.
  const filtered = candidates.filter((c) => titleTokens(c.title).size >= 3);
  const tokens = filtered.map((c) => titleTokens(c.title));
  const parent: number[] = filtered.map((_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (let i = 0; i < filtered.length; i++) {
    for (let j = i + 1; j < filtered.length; j++) {
      if (jaccard(tokens[i], tokens[j]) >= CLUSTER_JACCARD_THRESHOLD) {
        union(i, j);
      }
    }
  }

  const groups: Record<number, CandidateURL[]> = {};
  for (let i = 0; i < filtered.length; i++) {
    const r = find(i);
    (groups[r] ??= []).push(filtered[i]);
  }

  return Object.values(groups).map((urls, idx) => {
    const tierCounts = { tier1: 0, tier2: 0, tier3: 0, tier4: 0 } as TopicCluster['tier_counts'];
    for (const u of urls) {
      const key = `tier${u.tier}` as keyof typeof tierCounts;
      tierCounts[key]++;
    }

    const lastmodDates = urls
      .map((u) => (u.lastmod ? Date.parse(u.lastmod) : 0))
      .filter((t) => !Number.isNaN(t) && t > 0);
    const mostRecent = lastmodDates.length > 0 ? Math.max(...lastmodDates) : 0;

    // Pick the representative title: prefer the highest-tier source's post,
    // tie-break on most recent lastmod.
    const rep = urls
      .slice()
      .sort((a, b) => {
        if (a.tier !== b.tier) return a.tier - b.tier;
        const ta = a.lastmod ? Date.parse(a.lastmod) : 0;
        const tb = b.lastmod ? Date.parse(b.lastmod) : 0;
        return tb - ta;
      })[0];

    // Suggested category: majority vote across cluster members (ties go
    // to the first-seen category).
    const catCounts: Record<string, number> = {};
    for (const u of urls) catCounts[u.suggested_category] = (catCounts[u.suggested_category] ?? 0) + 1;
    const suggested_category = Object.entries(catCounts).sort((a, b) => b[1] - a[1])[0][0];

    return {
      id: `cluster_${idx}_${rep.source_id}`,
      representative_title: rep.title,
      urls,
      tier_counts: tierCounts,
      most_recent_lastmod: mostRecent > 0 ? new Date(mostRecent).toISOString() : null,
      suggested_category,
      score: 0, // computed by scoreCluster
      category_blocked: false, // resolver fills this in
    };
  });
}

// ---------------------------------------------------------------------------
// Scoring — tier weight × source count × freshness
// ---------------------------------------------------------------------------

export function scoreCluster(cluster: TopicCluster, availableCategoryWeights: Record<string, number>): number {
  // Qualifying signal — cluster is real signal if EITHER:
  //   (a) PRIMARY: any T1/T2 competitor is in it (full multiplier), OR
  //   (b) ALTERNATIVE: ≥3 DISTINCT trade-press/analyst sources (T3+T4) are
  //       in it — applies a 0.6× score haircut so T1/T2-led clusters still
  //       rank above when both qualify.
  // Counts use distinct source domains, not raw URL counts. Otherwise a
  // single big crawl (e.g. 64 NADA footer-link URLs) would qualify on
  // sheer volume — not corroboration.
  const distinctByTier = { tier1: new Set<string>(), tier2: new Set<string>(), tier3: new Set<string>(), tier4: new Set<string>() };
  for (const u of cluster.urls) {
    const key = `tier${u.tier}` as keyof typeof distinctByTier;
    if (distinctByTier[key]) distinctByTier[key].add(u.source_id);
  }
  const d1 = distinctByTier.tier1.size;
  const d2 = distinctByTier.tier2.size;
  const d3 = distinctByTier.tier3.size;
  const d4 = distinctByTier.tier4.size;

  const hasPrimary = d1 > 0 || d2 > 0;
  const tradePressDistinct = d3 + d4;
  const hasTradePressCorroboration = tradePressDistinct >= 3;
  if (!hasPrimary && !hasTradePressCorroboration) return 0;
  const qualificationMultiplier = hasPrimary ? 1.0 : 0.6;

  // Tier coverage on DISTINCT sources: tier 1 competitors weight highest
  // because they're direct threats; tier 4 dealer media shift topic
  // attention but don't compete. Distinct-source counting also makes one
  // domain's bulk-crawl unable to dominate scoring.
  const tierWeight =
    d1 * 5 +
    d2 * 3 +
    d4 * 2 +
    d3 * 1;

  // Bonus when multiple distinct sources in the same lane are covering —
  // shows the topic is actively in the air, not a one-off. Trade-press
  // concurrency bonus mirrors the competitor-side bonuses so a real news
  // cycle shows up.
  const concurrencyBonus =
    (d1 >= 2 ? 3 : 0) +
    (d2 >= 3 ? 2 : 0) +
    (tradePressDistinct >= 4 ? 2 : 0);

  // Freshness: linear decay over 30 days.
  let freshnessMultiplier = 1.0;
  if (cluster.most_recent_lastmod) {
    const daysAgo = (Date.now() - Date.parse(cluster.most_recent_lastmod)) / (24 * 60 * 60 * 1000);
    freshnessMultiplier = Math.max(0.2, 1 - daysAgo / 30);
  }

  // Category weight from categories.yaml editorial_weight. Zero if the
  // category is in cooldown — effectively removes the cluster from the pool.
  const categoryMultiplier = cluster.category_blocked ? 0 : (availableCategoryWeights[cluster.suggested_category] ?? 0.5);

  return (tierWeight + concurrencyBonus) * freshnessMultiplier * categoryMultiplier * qualificationMultiplier;
}

// ---------------------------------------------------------------------------
// Public API — the resolver calls this
// ---------------------------------------------------------------------------

export interface SignalOptions {
  /** Force a fresh scrape, ignoring cache */
  bypassCache?: boolean;
  /** Upper bound on clusters returned (default 20) */
  limit?: number;
}

export interface SignalResult {
  fetched_at: string;
  sources_scraped: number;
  sources_failed: number;
  total_candidates: number;
  clusters: TopicCluster[];
  /** Categories currently blocked — informational */
  blocked_categories: string[];
}

export async function getSignalCandidates(opts: SignalOptions = {}): Promise<SignalResult> {
  let candidates: CandidateURL[];
  let fetchedAt: string;

  if (!opts.bypassCache) {
    const cached = readCache();
    if (cached) {
      candidates = cached.candidates;
      fetchedAt = cached.fetched_at;
      console.log(`[signal] cache hit — ${candidates.length} candidates from ${fetchedAt}`);
    } else {
      ({ candidates, fetchedAt } = await scrapeAllSources());
      writeCache(candidates);
    }
  } else {
    ({ candidates, fetchedAt } = await scrapeAllSources());
    writeCache(candidates);
  }

  // Cluster + score
  const clusters = clusterCandidates(candidates);
  const status = getCategoryStatus();
  const availableWeights: Record<string, number> = {};
  for (const c of status) availableWeights[c.id] = c.editorial_weight;
  const blockedCategories = status.filter((c) => c.blocked).map((c) => c.id);

  for (const cluster of clusters) {
    cluster.category_blocked = blockedCategories.includes(cluster.suggested_category);
    cluster.score = scoreCluster(cluster, availableWeights);
  }

  const sorted = clusters
    .filter((c) => !c.category_blocked && c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 20);

  const sourcesScraped = new Set(candidates.map((c) => c.source_id)).size;

  return {
    fetched_at: fetchedAt,
    sources_scraped: sourcesScraped,
    sources_failed: listSources().length - sourcesScraped,
    total_candidates: candidates.length,
    clusters: sorted,
    blocked_categories: blockedCategories,
  };
}

async function scrapeAllSources(): Promise<{ candidates: CandidateURL[]; fetchedAt: string }> {
  const sources = listSources();
  console.log(`[signal] scraping ${sources.length} sources…`);
  const start = Date.now();

  // Parallel with concurrency cap — avoid hammering any single host + stay
  // under reasonable network budget.
  const CONCURRENCY = 6;
  const queue = [...sources];
  const all: CandidateURL[] = [];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const src = queue.shift()!;
      const window = freshnessWindowForTier(src.tier);
      try {
        const fresh = await collectFromSource(src, window);
        console.log(`[signal]   ${src.id} (T${src.tier}): ${fresh.length} fresh`);
        all.push(...fresh);
      } catch (err) {
        console.warn(`[signal]   ${src.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const elapsedMs = Date.now() - start;
  console.log(`[signal] scrape complete in ${(elapsedMs / 1000).toFixed(1)}s — ${all.length} total candidates`);
  return { candidates: all, fetchedAt: new Date().toISOString() };
}

// Test-only helpers
export function __resetCacheForTests(): void {
  cachedConfig = null;
}
