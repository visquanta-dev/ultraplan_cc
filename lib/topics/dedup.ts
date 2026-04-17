// ---------------------------------------------------------------------------
// Topic dedup — prevents publishing overlapping content that cannibalizes
// its own rankings. Checks a candidate slug/keywords against:
//   1. Published posts on the main site (content/blog/*.md slugs)
//   2. Recent pipeline drafts (tmp/drafts/*.md slugs)
//   3. Open PRs on visquanta-dev/site with ultraplan- label
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
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
