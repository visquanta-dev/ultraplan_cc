import type { TopicCluster } from './cluster';
import { filterDuplicateClusters } from './dedup';
import { scrapeMany } from '../sources/firecrawl';
import { assembleBundle } from '../bundle/assemble';
import type { Bundle, ScrapedInput } from '../bundle/types';
import { loadCuratedSources, pickCuratedBucket, resolveFromCurated, bucketToCluster } from './curated-sources';
import { getSignalCandidates, type TopicCluster as SignalCluster } from './competitor-signal';
import { getCategoryStatus, getAvailableCategories } from './category-cooldown';
import { getFreshnessDaysForUrl } from '../sources/crawl-index';
import type { SourceStrategy } from '../config/topics-config';

// ---------------------------------------------------------------------------
// Slot resolver — content strategy redesign (2026-04-18)
//
// Replaces the four-strategy (feed_first / calendar_first / curated_first /
// search_first) flow with a two-path model:
//
//   1. SIGNAL-DRIVEN (default) — queries competitor-signal.ts for clusters
//      that (a) have tier-1/2 competitor coverage, (b) map to a category
//      that's NOT in cooldown, (c) meet research-density thresholds. Picks
//      the highest-scored cluster. This is how the pipeline runs on autopilot.
//
//   2. CURATED OVERRIDE (explicit) — when the operator passes `curatedBucket`,
//      bypass signal selection and use the specified curated_sources.yaml
//      bucket. This is the escape hatch for news-breaking topics or
//      deliberate editorial choices.
//
// Removed: feed_first, calendar_first, search_first. These produced the
// cannibalization problems documented 2026-04-18 — fixed schedules and
// stale calendar picks kept landing on over-covered topics.
//
// Skip-if-thin: if the signal path has no viable clusters (all categories
// in cooldown, OR no competitor coverage, OR research too thin), throws a
// SkipRunError. The scheduled cron should treat this as a non-post day,
// not an error.
// ---------------------------------------------------------------------------

export interface ResolvedSlot {
  bundle: Bundle;
  cluster: TopicCluster;
}

export type { SourceStrategy };

export class SkipRunError extends Error {
  constructor(msg: string) {
    super(`[resolver] SKIP: ${msg}`);
    this.name = 'SkipRunError';
  }
}

/**
 * Resolve a topic slot for the given lane.
 *
 * @throws SkipRunError when no viable cluster exists — caller should treat
 *   this as a planned non-post day, not a pipeline failure.
 * @throws Error on unexpected failures (no fresh sources after scrape, etc.)
 */
export async function resolveSlot(
  lane: 'daily_seo' | 'weekly_authority' | 'monthly_anonymized_case' | 'listicle',
  options: {
    onSearch?: (count: number) => void;
    onCluster?: (cluster: TopicCluster) => void;
    onScrape?: (total: number, succeeded: number) => void;
    /** Explicit curated bucket override — bypasses signal selection */
    curatedBucket?: string;
    /** Legacy flag kept for backward compat with admin dashboard + CLI */
    preferCurated?: boolean;
    /** Legacy flag — ignored unless it's curated_first with a bucket */
    forcedStrategy?: SourceStrategy;
  } = {},
): Promise<ResolvedSlot> {
  // ------------------------------------------------------------------
  // PATH 1: Curated override (explicit)
  // ------------------------------------------------------------------
  if (options.curatedBucket) {
    console.log(`[resolver] Curated override: bucket=${options.curatedBucket}`);
    return resolveCuratedPath(lane, options);
  }

  // ------------------------------------------------------------------
  // PATH 2: Signal-driven (default)
  // ------------------------------------------------------------------
  return resolveSignalPath(lane, options);
}

// ---------------------------------------------------------------------------
// Signal-driven path
// ---------------------------------------------------------------------------

async function resolveSignalPath(
  lane: 'daily_seo' | 'weekly_authority' | 'monthly_anonymized_case' | 'listicle',
  options: {
    onSearch?: (count: number) => void;
    onCluster?: (cluster: TopicCluster) => void;
    onScrape?: (total: number, succeeded: number) => void;
  },
): Promise<ResolvedSlot> {
  console.log('[resolver] Signal-driven resolution');

  // Log cooldown state up front so operators can see why picks are narrow
  const status = getCategoryStatus();
  const available = getAvailableCategories();
  console.log(
    `[resolver] Category cooldown: ${available.length}/${status.length} open ` +
      `(open: ${available.map((c) => c.id).join(', ') || 'none'})`,
  );

  if (available.length === 0) {
    throw new SkipRunError('every category is in cooldown — nothing to write about today');
  }

  // Fetch ranked signal clusters (cached 6h; pass bypassCache if a fresh run is needed)
  const signal = await getSignalCandidates({ limit: 20 });
  console.log(
    `[resolver] Signal: ${signal.total_candidates} candidates from ${signal.sources_scraped}/${signal.sources_scraped + signal.sources_failed} sources → ${signal.clusters.length} viable clusters`,
  );
  options.onSearch?.(signal.total_candidates);

  if (signal.clusters.length === 0) {
    throw new SkipRunError(
      'no viable clusters — every candidate either maps to a cooldowned category ' +
        'or lacks tier-1/2 competitor coverage',
    );
  }

  // Pick the winner — highest score among unblocked + competitor-backed clusters
  const winner = signal.clusters[0];
  console.log(
    `[resolver] Winning cluster: "${winner.representative_title}" ` +
      `(category: ${winner.suggested_category}, score: ${winner.score.toFixed(2)}, ` +
      `tiers: T1:${winner.tier_counts.tier1} T2:${winner.tier_counts.tier2} T3:${winner.tier_counts.tier3} T4:${winner.tier_counts.tier4})`,
  );

  // Adapt the signal cluster shape to the legacy TopicCluster the bundle pipeline expects
  const legacyCluster = adaptSignalCluster(winner);
  options.onCluster?.(legacyCluster);

  // Check dedup — the signal module already filters cooldown, but dedup
  // catches slug-level collisions (same post about to be drafted twice)
  const { filtered } = await filterDuplicateClusters([legacyCluster]);
  if (filtered.length === 0) {
    throw new SkipRunError(
      `winning cluster "${winner.representative_title}" collides with an existing post — skipping`,
    );
  }

  // Scrape the cluster URLs and assemble a bundle, propagating category_id
  // so downstream stages (CTA routing, cooldown accounting) know which
  // product category this post belongs to.
  return scrapeAndAssemble(filtered[0], lane, {
    ...options,
    category_id: winner.suggested_category,
  });
}

function adaptSignalCluster(signal: SignalCluster): TopicCluster {
  // Re-shape competitor-signal.TopicCluster into the legacy TopicCluster
  // format the bundle pipeline and dedup gates expect.
  const keywords = Array.from(
    new Set(
      signal.urls
        .flatMap((u) => u.title.toLowerCase().split(/\s+/))
        .filter((w) => w.length >= 4),
    ),
  ).slice(0, 12);

  const slug = signal.representative_title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);

  return {
    label: signal.representative_title,
    slug,
    keywords,
    sourceCount: new Set(signal.urls.map((u) => u.source_id)).size,
    articles: signal.urls.map((u) => ({
      url: u.url,
      title: u.title,
      description: `${u.source_name} · ${u.suggested_category}`,
      publishedAt: u.lastmod,
    })),
  };
}

// ---------------------------------------------------------------------------
// Curated override path — unchanged behavior from the old resolver
// ---------------------------------------------------------------------------

async function resolveCuratedPath(
  lane: 'daily_seo' | 'weekly_authority' | 'monthly_anonymized_case' | 'listicle',
  options: {
    onSearch?: (count: number) => void;
    onCluster?: (cluster: TopicCluster) => void;
    onScrape?: (total: number, succeeded: number) => void;
    curatedBucket?: string;
  },
): Promise<ResolvedSlot> {
  const allBuckets = loadCuratedSources();
  if (allBuckets.size === 0) {
    throw new Error('[resolver] No curated buckets defined in config/curated_sources.yaml');
  }

  const excluded = new Set<string>();
  let picked = null;
  while (true) {
    const candidate = pickCuratedBucket(lane, {
      requestedTopic: options.curatedBucket,
      excludeTopics: excluded,
    });
    if (!candidate) break;
    const tempCluster = bucketToCluster(candidate);
    const { filtered } = await filterDuplicateClusters([tempCluster]);
    if (filtered.length > 0) {
      picked = candidate;
      break;
    }
    console.log(`[resolver] Curated bucket "${candidate.topic}" already shipped — trying next`);
    excluded.add(candidate.topic);
    if (options.curatedBucket) break; // explicit override: don't silently fall over
  }

  if (!picked) {
    throw new SkipRunError(
      options.curatedBucket
        ? `curated bucket "${options.curatedBucket}" collides with an existing post`
        : 'every curated bucket for this lane is a duplicate of an existing post',
    );
  }

  console.log(`[resolver] Using curated bucket "${picked.topic}"`);
  options.onCluster?.(bucketToCluster(picked));
  return resolveFromCurated(picked, lane, { onScrape: options.onScrape });
}

// ---------------------------------------------------------------------------
// Scrape + freshness filter + bundle assembly (shared by both paths)
// ---------------------------------------------------------------------------

async function scrapeAndAssemble(
  cluster: TopicCluster,
  lane: 'daily_seo' | 'weekly_authority' | 'monthly_anonymized_case' | 'listicle',
  options: { onScrape?: (total: number, succeeded: number) => void; category_id?: string },
): Promise<ResolvedSlot> {
  const urls = cluster.articles.map((a) => a.url);
  console.log(`[resolver] Scraping ${urls.length} URLs...`);
  const scrapeResults = await scrapeMany(urls, 3);

  const succeeded = scrapeResults.filter((r) => r.article).length;
  options.onScrape?.(urls.length, succeeded);
  console.log(`[resolver] Scraped ${succeeded}/${urls.length} successfully`);

  if (succeeded === 0) {
    throw new Error('[resolver] All scrapes failed. Check FIRECRAWL_API_KEY and source URLs.');
  }

  // Freshness filter: lane cutoff (18mo daily_seo, 36mo otherwise) +
  // per-source overrides from feed_sources.yaml. See old-resolver comments
  // for the reasoning; unchanged logic.
  const LANE_CUTOFF_DAYS = lane === 'daily_seo' ? 18 * 30 : 36 * 30;
  const now = Date.now();
  const freshResults = scrapeResults.filter((r) => {
    if (!r.article) return false;
    const pub = r.article.publishedAt;
    if (!pub) return true;
    const pubMs = Date.parse(pub);
    if (Number.isNaN(pubMs)) return true;

    const sourceCutoff = getFreshnessDaysForUrl(r.url);
    const effectiveDays = sourceCutoff != null ? Math.min(LANE_CUTOFF_DAYS, sourceCutoff) : LANE_CUTOFF_DAYS;
    const cutoffMs = now - effectiveDays * 24 * 60 * 60 * 1000;

    const isFresh = pubMs >= cutoffMs;
    if (!isFresh) {
      const ageDays = Math.round((now - pubMs) / (24 * 60 * 60 * 1000));
      console.log(
        `[resolver] Dropping stale source: ${r.url} (age ${ageDays}d, cutoff ${effectiveDays}d${sourceCutoff != null ? ' from feed_sources' : ''})`,
      );
    }
    return isFresh;
  });

  const freshCount = freshResults.length;
  console.log(`[resolver] After freshness filter: ${freshCount}/${succeeded} sources kept`);

  // Research-density threshold: require at least 3 fresh sources. Matches
  // config/categories.yaml rules.research_density.min_primary_sources.
  // This is what "skip-if-thin" enforces — better no post than a post built
  // on one or two shaky sources.
  const MIN_PRIMARY_SOURCES = 3;
  if (freshCount < MIN_PRIMARY_SOURCES) {
    throw new SkipRunError(
      `only ${freshCount} fresh source${freshCount === 1 ? '' : 's'} after scrape + filter (need ≥${MIN_PRIMARY_SOURCES}) — research too thin to draft`,
    );
  }

  const inputs: ScrapedInput[] = freshResults.map((r) => ({
    url: r.url,
    title: r.article!.title,
    publishedAt: r.article!.publishedAt,
    rawText: r.article!.rawText,
  }));

  const bundle = assembleBundle(inputs, {
    lane,
    topic_slug: cluster.slug,
    ...(options.category_id ? { category_id: options.category_id } : {}),
  });

  console.log(
    `[resolver] Bundle assembled: ${bundle.sources.length} sources, ${bundle.sources.reduce((n, s) => n + s.quotes.length, 0)} quotes`,
  );

  return { bundle, cluster };
}
