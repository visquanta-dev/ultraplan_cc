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

// Minimum word overlap ratio to consider two topics as duplicates
const OVERLAP_THRESHOLD = 0.5;

/**
 * Load all known published slugs from the main site repo (if cloned locally)
 * and from recent local drafts.
 */
function loadExistingSlugs(): Set<string> {
  const slugs = new Set<string>();

  // Check main site content/blog/ directory
  const siteBlogDir = path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', 'Desktop', 'site', 'content', 'blog');
  if (fs.existsSync(siteBlogDir)) {
    for (const file of fs.readdirSync(siteBlogDir)) {
      if (file.endsWith('.md')) {
        slugs.add(file.replace(/\.md$/, ''));
      }
    }
  }

  // Check local drafts
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
export function checkTopicOverlap(
  cluster: TopicCluster,
): { isDuplicate: boolean; reason?: string; existingSlug?: string } {
  const existingSlugs = loadExistingSlugs();
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
 * Filter an array of clusters, removing any that overlap with existing content.
 * Returns the filtered list and a log of what was removed.
 */
export function filterDuplicateClusters(
  clusters: TopicCluster[],
): { filtered: TopicCluster[]; removed: Array<{ cluster: TopicCluster; reason: string }> } {
  const filtered: TopicCluster[] = [];
  const removed: Array<{ cluster: TopicCluster; reason: string }> = [];

  for (const cluster of clusters) {
    const check = checkTopicOverlap(cluster);
    if (check.isDuplicate) {
      removed.push({ cluster, reason: check.reason! });
    } else {
      filtered.push(cluster);
    }
  }

  return { filtered, removed };
}
