import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { isAllowed } from './allowlist';

// ---------------------------------------------------------------------------
// Feed index crawler — cheap discovery path
//
// Loads config/feed_sources.yaml and crawls each source's index page(s) via
// Firecrawl /v2/map, which returns URLs only (no content) and costs ~1 credit
// per call vs the ~5-10 credits a full /v2/scrape costs. Extracted links are
// filtered to article-looking URLs and run through the allowlist.
//
// Falls back to /v2/scrape of the index page with HTML link extraction if
// /v2/map is unavailable for a given domain (some CDNs block the map
// endpoint). Both paths converge on the same filter + allowlist pipeline.
//
// The output is a flat list of discovered articles with source metadata.
// The resolver pairs this with a cheap relevance filter before deciding
// which 4-6 articles to full-scrape for the bundle.
// ---------------------------------------------------------------------------

const FIRECRAWL_API_BASE = 'https://api.firecrawl.dev/v2';

export interface FeedSource {
  key: string;
  name: string;
  tier: 1 | 2;
  indexUrls: string[];
  maxArticlesPerCrawl: number;
  freshnessDays: number;
}

export interface FeedArticle {
  url: string;
  sourceKey: string;
  sourceName: string;
  discoveredAt: string;
  /** Optional title from Firecrawl /v2/map metadata — richer than slug tokens */
  title?: string;
  /** Optional description from Firecrawl /v2/map metadata */
  description?: string;
}

interface FeedSourcesConfig {
  version: number;
  sources: Record<string, {
    name: string;
    tier: 1 | 2;
    index_urls: string[];
    max_articles_per_crawl: number;
    freshness_days: number;
  }>;
}

let cachedSources: FeedSource[] | null = null;
let cachedHostnameToFreshness: Map<string, number> | null = null;

/**
 * Load and parse config/feed_sources.yaml into the internal shape. Cached
 * after first read — the file is static config and doesn't change during
 * a pipeline run.
 */
export function loadFeedSources(): FeedSource[] {
  if (cachedSources) return cachedSources;
  const configPath = path.join(process.cwd(), 'config', 'feed_sources.yaml');
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = YAML.parse(raw) as FeedSourcesConfig;
  cachedSources = Object.entries(parsed.sources).map(([key, value]) => ({
    key,
    name: value.name,
    tier: value.tier,
    indexUrls: value.index_urls,
    maxArticlesPerCrawl: value.max_articles_per_crawl,
    freshnessDays: value.freshness_days,
  }));
  return cachedSources;
}

/**
 * Look up the per-source freshness_days window for a given article URL by
 * matching the URL's hostname against the index_urls in feed_sources.yaml.
 * Returns null if the URL doesn't belong to any feed source — callers
 * should fall back to the lane-level default in that case.
 *
 * The match uses apex-domain comparison (www. stripped on both sides),
 * so https://www.callrevu.com/blog/foo matches a source whose index_urls
 * include https://www.callrevu.com/blog/.
 */
export function getFreshnessDaysForUrl(url: string): number | null {
  if (!cachedHostnameToFreshness) {
    cachedHostnameToFreshness = new Map();
    for (const source of loadFeedSources()) {
      for (const indexUrl of source.indexUrls) {
        try {
          const host = new URL(indexUrl).hostname.replace(/^www\./, '');
          // First definition wins if two sources share a hostname (shouldn't
          // happen in practice, but be deterministic anyway).
          if (!cachedHostnameToFreshness.has(host)) {
            cachedHostnameToFreshness.set(host, source.freshnessDays);
          }
        } catch {
          // Skip malformed index URLs silently
        }
      }
    }
  }
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return cachedHostnameToFreshness.get(host) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Article URL filter
//
// The goal is to reject anything that obviously isn't an article: nav,
// pagination, category/tag/author archives, feeds, and utility pages. We're
// deliberately permissive on the positive side — slug-style paths count as
// articles even without a date, because many of the tier-2 vendor blogs
// don't include dates in their URLs.
// ---------------------------------------------------------------------------

const ARTICLE_POSITIVE_HINTS = [
  '/news/',
  '/blog/',
  '/insights/',
  '/insight-',
  '/analysis/',
  '/article/',
  '/articles/',
  '/post/',
  '/posts/',
  '/story/',
  '/stories/',
  '/research/',
  '/opinion/',
  '/commentary/',
  '/guest-commentary/',
  '/headlines/',
];

const ARTICLE_NEGATIVE_HINTS = [
  '/category/',
  '/categories/',
  '/tag/',
  '/tags/',
  '/author/',
  '/authors/',
  '/page/',
  '/feed',
  '/rss',
  '/sitemap',
  '/search',
  '/login',
  '/signup',
  '/subscribe',
  '/contact',
  '/privacy',
  '/terms',
  '/about',
  '/advertise',
  '/newsletter/signup',
  '/wp-admin',
  '/wp-content',
  '/wp-json',
];

const FILE_EXTENSION_REJECT = /\.(png|jpe?g|webp|gif|svg|ico|css|js|mjs|woff2?|ttf|eot|pdf|zip|mp4|webm|json|xml|rss|txt)(\?|$)/i;

const DATE_PATH_RE = /\/(20[2-3][0-9])\/([01]?[0-9])(\/|$)/;
const SLUG_PATH_RE = /\/[a-z0-9][a-z0-9-]{10,}(\/|$)/i;

export function looksLikeArticle(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const pathLower = parsed.pathname.toLowerCase();

  // Reject static assets + obvious utility endpoints
  if (FILE_EXTENSION_REJECT.test(pathLower)) return false;
  for (const neg of ARTICLE_NEGATIVE_HINTS) {
    if (pathLower.includes(neg)) return false;
  }

  // Reject bare domain / index pages (path is "/" or "/index")
  if (pathLower === '/' || pathLower === '/index' || pathLower === '/index.html') return false;

  // Positive signals: explicit article sections, date-year paths, or long slugs
  for (const pos of ARTICLE_POSITIVE_HINTS) {
    if (pathLower.includes(pos)) return true;
  }
  if (DATE_PATH_RE.test(pathLower)) return true;
  if (SLUG_PATH_RE.test(pathLower)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Firecrawl /v2/map — primary discovery endpoint
//
// Returns all URLs reachable from a given starting URL as a flat array. We
// cap via `limit` to avoid discovering the entire site on every run, and
// fall back to /v2/scrape + HTML link extraction if the map endpoint errors
// (common on CDN-heavy vendor blogs).
// ---------------------------------------------------------------------------

// Firecrawl /v2/map returns an array of objects with optional metadata —
// NOT a flat string array. The object shape gives us title + description
// for free, which we use in the relevance filter.
interface FirecrawlMapLink {
  url: string;
  title?: string;
  description?: string;
}

interface FirecrawlMapResponse {
  success: boolean;
  links?: Array<FirecrawlMapLink | string>;
  data?: { links?: Array<FirecrawlMapLink | string> };
  error?: string;
  warning?: string;
}

function normalizeMapLinks(raw: Array<FirecrawlMapLink | string> | undefined): FirecrawlMapLink[] {
  if (!raw) return [];
  return raw.map((entry) =>
    typeof entry === 'string'
      ? { url: entry }
      : { url: entry.url, title: entry.title, description: entry.description },
  );
}

async function mapIndex(indexUrl: string, limit: number): Promise<FirecrawlMapLink[]> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error('[crawl-index] FIRECRAWL_API_KEY not set');

  const response = await fetch(`${FIRECRAWL_API_BASE}/map`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url: indexUrl,
      limit: Math.min(limit * 5, 100),
      includeSubdomains: false,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`[crawl-index] map failed: ${response.status} ${response.statusText} — ${text.slice(0, 200)}`);
  }

  const body = (await response.json()) as FirecrawlMapResponse;
  if (!body.success) {
    throw new Error(`[crawl-index] map unsuccessful: ${body.error ?? 'unknown'}`);
  }
  return normalizeMapLinks(body.links ?? body.data?.links);
}

/**
 * Firecrawl's /v2/map is designed to walk a whole domain from the apex, not
 * to enumerate a deep category path. Requests like /category/dealership/
 * return 0 links with a "try mapping the base domain" warning. This helper
 * maps the apex + filters results to URLs that contain the original deep
 * path as a prefix, so we get the intended scoping without the zero-result
 * penalty.
 */
async function mapIndexWithFallback(indexUrl: string, limit: number): Promise<FirecrawlMapLink[]> {
  // First attempt: the deep URL as configured
  const direct = await mapIndex(indexUrl, limit);
  if (direct.length > 0) return direct;

  // Second attempt: the apex domain, filtered to the original path prefix
  let parsed: URL;
  try {
    parsed = new URL(indexUrl);
  } catch {
    return [];
  }
  const apex = `${parsed.protocol}//${parsed.hostname}/`;
  // If the deep path was already the apex, don't infinite-loop
  if (parsed.pathname === '/' || parsed.pathname === '') return [];

  console.log(`[crawl-index] ${parsed.hostname}: deep path empty, retrying with apex + path prefix "${parsed.pathname}"`);
  const apexLinks = await mapIndex(apex, limit * 2);
  const prefix = parsed.pathname.replace(/\/$/, '');
  return apexLinks.filter((link) => {
    try {
      const linkPath = new URL(link.url).pathname;
      return linkPath.startsWith(prefix);
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Fallback: /v2/scrape the index page as HTML, parse <a href> links
//
// Cheap HTML regex rather than a DOM parser — we only need hrefs and the
// allowlist + article filter handles everything else. Losing a few edge
// cases (JS-rendered links, base href resolution) is fine; the primary path
// is /v2/map.
// ---------------------------------------------------------------------------

interface FirecrawlScrapeHtmlResponse {
  success: boolean;
  data?: { html?: string; markdown?: string };
  error?: string;
}

async function scrapeIndexHtml(indexUrl: string): Promise<string[]> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error('[crawl-index] FIRECRAWL_API_KEY not set');

  const response = await fetch(`${FIRECRAWL_API_BASE}/scrape`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url: indexUrl,
      formats: ['html'],
      onlyMainContent: false,
      waitFor: 800,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`[crawl-index] scrape fallback failed: ${response.status} — ${text.slice(0, 200)}`);
  }

  const body = (await response.json()) as FirecrawlScrapeHtmlResponse;
  if (!body.success || !body.data?.html) return [];

  const base = new URL(indexUrl);
  const hrefs = [...body.data.html.matchAll(/href=["']([^"'#]+)["']/gi)].map((m) => m[1]);
  const resolved = new Set<string>();
  for (const href of hrefs) {
    try {
      // Skip obviously non-http schemes
      if (/^(mailto:|javascript:|tel:|#)/i.test(href)) continue;
      const full = new URL(href, base).toString();
      resolved.add(full);
    } catch {
      // Skip malformed URLs silently
    }
  }
  return [...resolved];
}

// ---------------------------------------------------------------------------
// Per-source crawl
// ---------------------------------------------------------------------------

/**
 * Crawl one source's index URLs and return the filtered article list.
 * Tries /v2/map first, falls back to /v2/scrape + HTML link extraction.
 * Returns at most `source.maxArticlesPerCrawl` articles.
 */
export async function crawlFeed(sourceKey: string): Promise<FeedArticle[]> {
  const sources = loadFeedSources();
  const source = sources.find((s) => s.key === sourceKey);
  if (!source) throw new Error(`[crawl-index] unknown source: ${sourceKey}`);

  const seen = new Set<string>();
  const articles: FeedArticle[] = [];
  const discoveredAt = new Date().toISOString();

  for (const indexUrl of source.indexUrls) {
    let links: FirecrawlMapLink[] = [];
    try {
      links = await mapIndexWithFallback(indexUrl, source.maxArticlesPerCrawl);
    } catch (mapErr) {
      const msg = mapErr instanceof Error ? mapErr.message : String(mapErr);
      console.warn(`[crawl-index] ${source.key}: map failed (${msg.slice(0, 120)}) — falling back to HTML scrape`);
      try {
        const stringLinks = await scrapeIndexHtml(indexUrl);
        links = stringLinks.map((url) => ({ url }));
      } catch (scrapeErr) {
        const msg2 = scrapeErr instanceof Error ? scrapeErr.message : String(scrapeErr);
        console.warn(`[crawl-index] ${source.key}: fallback scrape also failed (${msg2.slice(0, 120)}) — skipping index`);
        continue;
      }
    }

    for (const link of links) {
      if (seen.has(link.url)) continue;
      seen.add(link.url);
      if (!looksLikeArticle(link.url)) continue;
      if (!isAllowed(link.url)) continue;
      articles.push({
        url: link.url,
        sourceKey: source.key,
        sourceName: source.name,
        discoveredAt,
        title: link.title,
        description: link.description,
      });
      if (articles.length >= source.maxArticlesPerCrawl) break;
    }
    if (articles.length >= source.maxArticlesPerCrawl) break;
  }

  return articles;
}

// ---------------------------------------------------------------------------
// Parallel crawl of every source in feed_sources.yaml
// ---------------------------------------------------------------------------

export interface CrawlAllStats {
  sourcesAttempted: number;
  sourcesSucceeded: number;
  totalLinksExtracted: number;
  totalLinksArticle: number;
  totalLinksAllowed: number;
}

/**
 * Crawl every source in config/feed_sources.yaml in parallel, bounded by
 * `concurrency`. Returns the merged article list with per-source metadata
 * and a stats summary. Sources that fail individually log a warning and are
 * skipped — one broken index page does not kill the whole discovery run.
 */
export async function crawlAllFeeds(options: { concurrency?: number } = {}): Promise<{
  articles: FeedArticle[];
  stats: CrawlAllStats;
}> {
  const { concurrency = 4 } = options;
  const sources = loadFeedSources();

  const stats: CrawlAllStats = {
    sourcesAttempted: sources.length,
    sourcesSucceeded: 0,
    totalLinksExtracted: 0,
    totalLinksArticle: 0,
    totalLinksAllowed: 0,
  };

  const allArticles: FeedArticle[] = [];
  const queue = [...sources];

  async function worker() {
    while (queue.length > 0) {
      const source = queue.shift();
      if (!source) return;
      try {
        const found = await crawlFeed(source.key);
        allArticles.push(...found);
        stats.sourcesSucceeded++;
        stats.totalLinksArticle += found.length;
        stats.totalLinksAllowed += found.length;
        console.log(`[crawl-index] ${source.key}: ${found.length} articles`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[crawl-index] ${source.key}: crawl failed (${msg.slice(0, 120)}) — skipping`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, sources.length) }, worker);
  await Promise.all(workers);

  return { articles: allArticles, stats };
}
