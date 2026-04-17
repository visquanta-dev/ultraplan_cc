import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { scrapeMany } from '../sources/firecrawl';
import { assembleBundle } from '../bundle/assemble';
import type { Bundle, ScrapedInput } from '../bundle/types';
import type { TopicCluster } from './cluster';
import type { ResolvedSlot } from './resolver';

// ---------------------------------------------------------------------------
// Curated sources — spec §4 extension
//
// Lets the pipeline resolve a research bundle from a hand-curated URL list
// in config/curated_sources.yaml instead of doing a Firecrawl keyword search
// and cluster-picking the result. Curated path produces dramatically better
// bundles because:
//   - the user has vetted the publication authority (no SEO farm spam)
//   - every URL is editorially current (no stale-source leaks)
//   - the topic is declared upfront (no cluster roulette)
//   - richer source diversity feeds better drafter synthesis
//
// Fallback behavior: if no curated bucket matches the lane+topic, the
// resolver drops back to the existing search/cluster/scrape flow. Curated
// is opt-in via the `curatedBucket` option on resolveSlot().
// ---------------------------------------------------------------------------

export interface CuratedBucket {
  lane: string;
  topic: string;
  /** Fully-qualified URL list, http/https only */
  urls: string[];
}

const CURATED_SOURCES_PATH = path.join(
  process.cwd(),
  'config',
  'curated_sources.yaml',
);

/**
 * Load the curated sources file into a keyed map of "lane/topic" → bucket.
 * Empty-list placeholders in the YAML (e.g. `leadership_lessons: [[]]`)
 * are filtered out. Returns an empty map if the file doesn't exist.
 */
export function loadCuratedSources(): Map<string, CuratedBucket> {
  const buckets = new Map<string, CuratedBucket>();
  if (!fs.existsSync(CURATED_SOURCES_PATH)) {
    return buckets;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(CURATED_SOURCES_PATH, 'utf-8'));
  } catch (err) {
    console.warn(
      '[curated] failed to parse curated_sources.yaml:',
      err instanceof Error ? err.message : String(err),
    );
    return buckets;
  }

  if (!parsed || typeof parsed !== 'object') return buckets;
  const laneMap = parsed as Record<string, unknown>;

  for (const laneName of Object.keys(laneMap)) {
    const laneBuckets = laneMap[laneName];
    if (!laneBuckets || typeof laneBuckets !== 'object') continue;
    const topics = laneBuckets as Record<string, unknown>;

    for (const topicName of Object.keys(topics)) {
      const rawUrls = topics[topicName];
      if (!Array.isArray(rawUrls)) continue;
      const urls = rawUrls.filter(
        (u): u is string =>
          typeof u === 'string' && (u.startsWith('http://') || u.startsWith('https://')),
      );
      if (urls.length === 0) continue;

      buckets.set(`${laneName}/${topicName}`, {
        lane: laneName,
        topic: topicName,
        urls,
      });
    }
  }

  return buckets;
}

/**
 * Pick a curated bucket for the given lane. Respects an explicit topic
 * request if provided; otherwise returns the first available bucket for
 * the lane that hasn't been shipped recently (caller is responsible for
 * dedup filtering).
 */
export function pickCuratedBucket(
  lane: string,
  opts: { requestedTopic?: string; excludeTopics?: Set<string> } = {},
): CuratedBucket | null {
  const all = loadCuratedSources();
  if (all.size === 0) return null;

  // Exact match on requested topic
  if (opts.requestedTopic) {
    const key = `${lane}/${opts.requestedTopic}`;
    if (all.has(key)) return all.get(key)!;
  }

  // Any bucket for the lane, skipping excluded topics
  for (const [, bucket] of all.entries()) {
    if (bucket.lane !== lane) continue;
    if (opts.excludeTopics?.has(bucket.topic)) continue;
    return bucket;
  }

  return null;
}

/**
 * Build a minimal TopicCluster from a curated bucket. Exists so the
 * downstream pipeline (dedup, logging, PR labels) can treat curated
 * bundles the same way it treats discovered ones.
 */
export function bucketToCluster(bucket: CuratedBucket): TopicCluster {
  // The bucket topic becomes both the slug and the label — consistent with
  // how cluster slugs are built from labels via toSlug(). Keywords are
  // derived from the topic name so downstream keyword matching still works.
  const label = bucket.topic.replace(/_/g, ' ');
  const slug = bucket.topic.replace(/_/g, '-');
  const keywords = label.split(/\s+/).filter((w) => w.length >= 3);
  return {
    slug,
    label,
    keywords,
    sourceCount: bucket.urls.length,
    articles: bucket.urls.map((url) => ({
      url,
      title: '', // filled in after scrape
      description: '',
      publishedAt: null,
    })),
  };
}

/**
 * Resolve a research bundle directly from a curated bucket. Scrapes every
 * URL in the bucket, drops any whose scrape failed, and assembles the bundle.
 * Throws if no URLs scraped successfully — a curated bucket that produces
 * zero usable sources indicates the URL list has decayed and needs
 * refreshing.
 */
export async function resolveFromCurated(
  bucket: CuratedBucket,
  lane: 'daily_seo' | 'weekly_authority' | 'monthly_anonymized_case' | 'listicle',
  options: {
    onScrape?: (total: number, succeeded: number) => void;
  } = {},
): Promise<ResolvedSlot> {
  console.log(
    `[resolver] CURATED path — bucket "${lane}/${bucket.topic}" (${bucket.urls.length} URLs)`,
  );

  const scrapeResults = await scrapeMany(bucket.urls, 3);
  const succeeded = scrapeResults.filter((r) => r.article).length;
  options.onScrape?.(bucket.urls.length, succeeded);
  console.log(`[resolver] Scraped ${succeeded}/${bucket.urls.length} successfully`);

  if (succeeded === 0) {
    throw new Error(
      `[resolver] Curated bucket "${lane}/${bucket.topic}" produced zero usable scrapes. URL list may need refreshing.`,
    );
  }

  const inputs: ScrapedInput[] = scrapeResults
    .filter((r) => r.article)
    .map((r) => ({
      url: r.url,
      title: r.article!.title,
      publishedAt: r.article!.publishedAt,
      rawText: r.article!.rawText,
    }));

  const cluster = bucketToCluster(bucket);
  // Rewrite article titles on the cluster with real scraped titles so the
  // downstream dedup/logging has something descriptive to reference.
  cluster.articles = inputs.map((i) => ({
    url: i.url,
    title: i.title,
    description: '',
    publishedAt: i.publishedAt ?? null,
  }));

  const bundle: Bundle = assembleBundle(inputs, {
    lane,
    topic_slug: cluster.slug,
  });

  console.log(
    `[resolver] Curated bundle assembled: ${bundle.sources.length} sources, ${bundle.sources.reduce((n, s) => n + s.quotes.length, 0)} quotes`,
  );

  return { bundle, cluster };
}
