// ---------------------------------------------------------------------------
// Topic dedup — prevents publishing overlapping content that cannibalizes
// its own rankings. Checks a candidate slug/keywords against:
//   1. Published posts on the main site (content/blog/*.md slugs)
//   2. Recent pipeline drafts (tmp/drafts/*.md slugs)
//   3. Open PRs on visquanta-dev/site with ultraplan- label
//
// Two layers:
//   (a) pre-draft cluster overlap (checkTopicOverlap) — cheap slug/keyword
//       check that runs at bundle selection. Catches "inventory" spam pattern.
//   (b) post-draft entity + source overlap (checkPostOverlap) — catches the
//       CSI-style case where two posts shared primary sources and identical
//       entities despite different slugs. Runs after enrichment, before PR.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { TopicCluster } from './cluster';
import { listRuns } from '../admin/run-logger';

// Minimum word overlap ratio to consider two topics as duplicates
const OVERLAP_THRESHOLD = 0.5;

/**
 * Load all known slugs that should block a candidate cluster. Pulls from
 * three sources and unions them:
 *   1. Vercel Blob "runs/" — the canonical record of every successful
 *      pipeline run that shipped a PR. This works on both local and cron
 *      environments (blob storage is remote), and is the source of truth
 *      for "has this cluster already been published or drafted".
 *   2. Local site repo content/blog/*.md — catches posts that merged to
 *      main before the blob storage existed, or were hand-authored.
 *      Gracefully falls back to empty on environments without the checkout.
 *   3. Local tmp/drafts/*.md — catches in-flight drafts from the same
 *      local session that haven't hit blob yet.
 *
 * Failure to read any one source logs a warning and returns the partial
 * union rather than throwing — dedup is advisory, not load-bearing, and
 * we'd rather pick a mild duplicate than crash the pipeline on a transient
 * blob read failure.
 */
async function loadExistingSlugs(): Promise<Set<string>> {
  const slugs = new Set<string>();

  // 1. Vercel Blob — every successful run ever shipped
  try {
    const runs = await listRuns(500);
    for (const run of runs) {
      if (run.slug) slugs.add(run.slug);
    }
  } catch (err) {
    console.warn(
      '[dedup] could not list runs from blob storage — continuing with local sources only:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // 2. Local site checkout (check multiple possible locations)
  const candidateDirs = [
    path.join(process.cwd(), 'site-checkout', 'content', 'blog'),  // CI: checked out inside repo
    path.join(process.cwd(), 'site', 'content', 'blog'),           // CI: alt name
    path.join(process.cwd(), '..', 'site', 'content', 'blog'),     // Local: ../site
    path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', 'Desktop', 'site', 'content', 'blog'),  // Local: ~/Desktop/site
  ];
  for (const siteBlogDir of candidateDirs) {
    if (fs.existsSync(siteBlogDir)) {
      for (const file of fs.readdirSync(siteBlogDir)) {
        if (file.endsWith('.md')) {
          slugs.add(file.replace(/\.md$/, ''));
        }
      }
      break; // Use the first match
    }
  }

  // 3. Local drafts
  const draftsDir = path.join(process.cwd(), 'tmp', 'drafts');
  if (fs.existsSync(draftsDir)) {
    for (const file of fs.readdirSync(draftsDir)) {
      if (file.endsWith('.md')) {
        // Draft filenames may have timestamps appended: slug-mntxxxxxx.md
        const slug = file.replace(/\.md$/, '').replace(/-m[a-z0-9]{8,}$/, '');
        slugs.add(slug);
      }
    }
  }

  return slugs;
}

/**
 * Load existing slugs as keyword sets for semantic comparison.
 */
function slugToKeywords(slug: string): Set<string> {
  return new Set(slug.split('-').filter((w) => w.length >= 3));
}

/**
 * Calculate keyword overlap between two sets (Jaccard-like).
 * Returns ratio of shared keywords to total unique keywords.
 */
function keywordOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) { if (b.has(w)) shared++; }
  const union = new Set([...a, ...b]).size;
  return union > 0 ? shared / union : 0;
}

/**
 * Check if a candidate cluster overlaps too much with existing content.
 * Returns { isDuplicate, reason, existingSlug } if overlap > threshold.
 */
export async function checkTopicOverlap(
  cluster: TopicCluster,
): Promise<{ isDuplicate: boolean; reason?: string; existingSlug?: string }> {
  const existingSlugs = await loadExistingSlugs();
  const candidateKeywords = new Set(cluster.keywords);

  // Direct slug match
  if (existingSlugs.has(cluster.slug)) {
    return {
      isDuplicate: true,
      reason: `Exact slug "${cluster.slug}" already published`,
      existingSlug: cluster.slug,
    };
  }

  // Semantic overlap check
  for (const existing of existingSlugs) {
    const existingKw = slugToKeywords(existing);
    const overlap = keywordOverlap(candidateKeywords, existingKw);

    if (overlap >= OVERLAP_THRESHOLD) {
      return {
        isDuplicate: true,
        reason: `Cluster keywords overlap ${Math.round(overlap * 100)}% with existing "${existing}"`,
        existingSlug: existing,
      };
    }
  }

  return { isDuplicate: false };
}

/**
 * Check if a final post slug (derived from the headline, not the cluster)
 * already exists in any published / drafted source. Used mid-pipeline after
 * slug re-derivation to catch headline-slug collisions that cluster-level
 * dedup missed — e.g. two different clusters ("voice-ai-dealerships" and
 * "dealerships-dealership-2026") whose LLM-written headlines both reduce
 * to "74-dealers-buying-voice-agents-2026" and would clobber each other
 * on main if merged blindly.
 */
export class SlugCollisionError extends Error {
  collidedSlug: string;
  constructor(slug: string) {
    super(
      `slug "${slug}" already exists (main content/blog/ OR Vercel Blob run index). ` +
      `Aborting publish — pipeline should pick a different topic rather than ship a near-duplicate at an uglier URL.`,
    );
    this.name = 'SlugCollisionError';
    this.collidedSlug = slug;
  }
}

/**
 * Throws `SlugCollisionError` on collision. Historic behavior was to append
 * -v{N} and publish anyway, which produced ugly versioned URLs (see 2026-04-17
 * post-mortem: two -v2 slugs shipped because Vercel Blob carried ghost entries
 * from earlier failed runs). Clean slugs are non-negotiable — if the candidate
 * is taken, the pipeline aborts and the resolver picks a different topic on
 * the next run.
 *
 * Known cleanup debt: periodic purge of Vercel Blob run-index entries whose
 * slug has no corresponding markdown on site main. Without it, genuine
 * first-publish attempts can false-positive as collisions and abort.
 */
export async function findAvailableSlug(candidate: string): Promise<{
  slug: string;
  collided: false;
  original: string;
}> {
  const existing = await loadExistingSlugs();
  if (!existing.has(candidate)) {
    return { slug: candidate, collided: false, original: candidate };
  }
  throw new SlugCollisionError(candidate);
  // The unreachable return below keeps TypeScript's inference narrower even
  // though the function always either returns or throws. Left as a placeholder
  // anchor for the legacy return shape; do not re-enable -v{N} suffixing.
  // eslint-disable-next-line no-unreachable
  return {
    slug: `${candidate}-unreachable`,
    collided: false,
    original: candidate,
  };
}

// ---------------------------------------------------------------------------
// Post-draft overlap check — entities + source citations
//
// Calibrated from the 2026-04-18 branch audit: same-week cannibalization was
// systemic (4 inventory drafts on 2026-04-17, CSI listicle+daily_seo pair,
// 3 lead-response posts in 3 days). Slug dedup caught some of these but
// missed entity/source overlap. Thresholds:
//   - 3/3 entity match against any post in last 14 days  -> block
//   - >=3 shared primary-source URLs against any post in last 7 days -> block
//   - title cosine > 0.55                                -> block
// ---------------------------------------------------------------------------

export class PostOverlapError extends Error {
  matchedSlug: string;
  reason: string;
  constructor(reason: string, matchedSlug: string) {
    super(`[dedup] post overlaps with ${matchedSlug}: ${reason}`);
    this.name = 'PostOverlapError';
    this.matchedSlug = matchedSlug;
    this.reason = reason;
  }
}

interface RecentPostMeta {
  slug: string;
  title: string;
  publishedAt: string; // ISO date
  entities: Array<{ name: string; sameAs: string }>;
  /** Lowercased host+path fragments pulled from source citations in body. */
  sourceFingerprints: Set<string>;
}

function findSiteBlogDir(): string | null {
  const candidates = [
    path.join(process.cwd(), 'site-checkout', 'content', 'blog'),
    path.join(process.cwd(), 'site', 'content', 'blog'),
    path.join(process.cwd(), '..', 'site', 'content', 'blog'),
    path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', 'Desktop', 'site', 'content', 'blog'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

function extractSourceFingerprints(body: string): Set<string> {
  // Pull domain+path fragments from markdown link targets — these are the
  // primary source citations. Two posts citing chriscollinsinc.com and
  // cdkglobal.com/insights/... repeatedly will share these fingerprints.
  const fps = new Set<string>();
  for (const m of body.matchAll(/\]\((https?:\/\/[^)]+)\)/g)) {
    try {
      const u = new URL(m[1]);
      // Skip internal visquanta links — those are CTA placements, not citations
      if (u.hostname.includes('visquanta.com')) continue;
      const pathFrag = u.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
      fps.add(`${u.hostname}${pathFrag ? '/' + pathFrag : ''}`);
    } catch {
      // malformed URL — skip
    }
  }
  return fps;
}

async function loadRecentPosts(windowDays: number): Promise<RecentPostMeta[]> {
  const blogDir = findSiteBlogDir();
  if (!blogDir) return [];
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const posts: RecentPostMeta[] = [];
  for (const file of fs.readdirSync(blogDir)) {
    if (!file.endsWith('.md')) continue;
    try {
      const raw = fs.readFileSync(path.join(blogDir, file), 'utf-8');
      const parsed = matter(raw);
      const publishedAt = typeof parsed.data.publishedAt === 'string' ? parsed.data.publishedAt : '';
      if (!publishedAt) continue;
      const ts = Date.parse(publishedAt);
      if (Number.isNaN(ts) || ts < cutoff) continue;
      const entities = Array.isArray(parsed.data.entities)
        ? parsed.data.entities
            .filter((e: unknown) => e && typeof e === 'object')
            .map((e: unknown) => {
              const obj = e as Record<string, unknown>;
              return {
                name: typeof obj.name === 'string' ? obj.name : '',
                sameAs: typeof obj.sameAs === 'string' ? obj.sameAs : '',
              };
            })
            .filter((e: { name: string; sameAs: string }) => e.name && e.sameAs)
        : [];
      posts.push({
        slug: file.replace(/\.md$/, ''),
        title: typeof parsed.data.title === 'string' ? parsed.data.title : '',
        publishedAt,
        entities,
        sourceFingerprints: extractSourceFingerprints(parsed.content),
      });
    } catch {
      // malformed file — skip, don't fail dedup
    }
  }
  return posts;
}

function titleCosine(a: string, b: string): number {
  const tokenize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3);
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const counts: Record<string, { a: number; b: number }> = {};
  for (const w of ta) (counts[w] ??= { a: 0, b: 0 }).a += 1;
  for (const w of tb) (counts[w] ??= { a: 0, b: 0 }).b += 1;
  let dot = 0, magA = 0, magB = 0;
  for (const { a, b } of Object.values(counts)) {
    dot += a * b;
    magA += a * a;
    magB += b * b;
  }
  return magA && magB ? dot / Math.sqrt(magA * magB) : 0;
}

export async function checkPostOverlap(args: {
  title: string;
  entities: Array<{ name: string; sameAs: string }>;
  body: string;
}): Promise<void> {
  const { title, entities, body } = args;
  const fingerprints = extractSourceFingerprints(body);
  const entitySameAs = new Set(entities.map((e) => e.sameAs));

  // Two windows: 14d for entity/title, 7d for source fingerprints. Recent
  // citation reuse is a stronger cannibalization signal than a distant echo.
  const recent14 = await loadRecentPosts(14);
  const recent7 = recent14.filter(
    (p) => Date.parse(p.publishedAt) >= Date.now() - 7 * 24 * 60 * 60 * 1000,
  );

  for (const post of recent14) {
    // 3/3 entity match
    if (entities.length >= 3 && post.entities.length >= 3) {
      const postSameAs = new Set(post.entities.map((e) => e.sameAs));
      const shared = [...entitySameAs].filter((s) => postSameAs.has(s)).length;
      if (shared >= 3) {
        throw new PostOverlapError(
          `3/3 entities identical (${[...entitySameAs].filter((s) => postSameAs.has(s)).join(', ')})`,
          post.slug,
        );
      }
    }
    // Title cosine. Dropped from 0.55 to 0.35 after the 2026-04-18 false
    // negative: "Why Do Half of Dealers Now Nail a 15-Minute Lead Response?"
    // (2026-04-15) vs "Why 51% of Dealers Now Reply to Web Leads in Under
    // 15 Minutes" (today) scored 0.375 — same thesis, same Pied Piper ILE
    // source, different vocabulary. Paraphrase-of-a-paraphrase slips past
    // token-based similarity unless the bar is low. Risk: more false
    // positives within a tight topic cluster, accepted as the price of
    // catching same-stat restatements.
    const cos = titleCosine(title, post.title);
    if (cos > 0.35) {
      throw new PostOverlapError(
        `title cosine ${cos.toFixed(2)} vs "${post.title}"`,
        post.slug,
      );
    }
  }

  for (const post of recent7) {
    // >=3 shared source fingerprints
    const shared = [...fingerprints].filter((f) => post.sourceFingerprints.has(f));
    if (shared.length >= 3) {
      throw new PostOverlapError(
        `${shared.length} shared citations in last 7d: ${shared.slice(0, 3).join(', ')}`,
        post.slug,
      );
    }
  }
}

/**
 * Filter an array of clusters, removing any that overlap with existing content.
 * Returns the filtered list and a log of what was removed.
 */
export async function filterDuplicateClusters(
  clusters: TopicCluster[],
): Promise<{ filtered: TopicCluster[]; removed: Array<{ cluster: TopicCluster; reason: string }> }> {
  const filtered: TopicCluster[] = [];
  const removed: Array<{ cluster: TopicCluster; reason: string }> = [];

  for (const cluster of clusters) {
    const check = await checkTopicOverlap(cluster);
    if (check.isDuplicate) {
      removed.push({ cluster, reason: check.reason! });
    } else {
      filtered.push(cluster);
    }
  }

  return { filtered, removed };
}
