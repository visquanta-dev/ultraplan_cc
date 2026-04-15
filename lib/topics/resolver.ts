import { searchForLane, type SearchResult } from './search';
import { clusterArticles, type TopicCluster } from './cluster';
import { filterDuplicateClusters } from './dedup';
import { scoreCluster, type ClusterScore } from './keyword-scorer';
import { scrapeMany } from '../sources/firecrawl';
import { assembleBundle } from '../bundle/assemble';
import type { Bundle, ScrapedInput } from '../bundle/types';
import { loadCuratedSources, pickCuratedBucket, resolveFromCurated, bucketToCluster } from './curated-sources';
import { crawlAllFeeds, getFreshnessDaysForUrl, type FeedArticle } from '../sources/crawl-index';
import { filterByRelevance } from '../sources/relevance-filter';
import { getLaneStrategy as loadLaneStrategy, type SourceStrategy } from '../config/topics-config';

// ---------------------------------------------------------------------------
// Slot resolver — spec §4
// Ties together search → cluster → scrape → bundle assembly.
// Given a lane, discovers trending topics, picks the strongest cluster,
// scrapes the articles, and assembles a research bundle.
// ---------------------------------------------------------------------------

export interface ResolvedSlot {
  bundle: Bundle;
  cluster: TopicCluster;
}

export type { SourceStrategy };

function getLaneStrategy(lane: 'daily_seo' | 'weekly_authority' | 'monthly_anonymized_case'): SourceStrategy {
  return loadLaneStrategy(lane);
}

/**
 * Convert a FeedArticle into a SearchResult-compatible shape for the
 * existing clustering pipeline. Since the feed crawler only discovers URLs
 * (no title or description), we synthesize a "title" from the URL slug —
 * most vendor/trade blogs slugify the headline, so the slug tokens are a
 * reasonable proxy for the real title on a clustering-weight budget.
 */
function feedArticleToSearchResult(article: FeedArticle): SearchResult {
  let slugText = '';
  try {
    const parsed = new URL(article.url);
    const lastSegment = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
    slugText = lastSegment.replace(/[-_]+/g, ' ').replace(/\.(html?|php|aspx?)$/i, '');
  } catch {
    slugText = article.url;
  }
  return {
    url: article.url,
    title: slugText,
    description: `${article.sourceName}: ${slugText}`,
    publishedAt: null,
  };
}

/**
 * Feed discovery path — crawls every index in config/feed_sources.yaml via
 * Firecrawl /v2/map (cheap), filters to article-looking URLs on allowlisted
 * domains, runs the relevance filter to drop off-topic links, converts the
 * survivors into SearchResult shape, and returns them for clustering.
 *
 * Returns an empty array on any failure so the caller can fall through to
 * the next strategy (curated or search) without blowing up the pipeline.
 */
async function discoverFromFeeds(lane: string): Promise<SearchResult[]> {
  try {
    console.log(`[resolver] Feed discovery: crawling index pages...`);
    const { articles, stats } = await crawlAllFeeds({ concurrency: 4 });
    console.log(
      `[resolver] Feed discovery stats: ${stats.sourcesSucceeded}/${stats.sourcesAttempted} sources, ` +
      `${articles.length} articles found`,
    );
    if (articles.length === 0) return [];

    const relevant = filterByRelevance(articles, lane);
    console.log(`[resolver] Feed relevance filter: ${relevant.length} kept from ${articles.length}`);
    if (relevant.length === 0) return [];

    return relevant.map(feedArticleToSearchResult);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[resolver] Feed discovery failed (${msg.slice(0, 160)}) — falling through`);
    return [];
  }
}

/**
 * Resolve a topic slot for the given lane. Full flow:
 * 1. Search allowlisted sources for recent articles relevant to the lane
 * 2. Cluster results by keyword overlap
 * 3. Pick the strongest cluster (most diverse source coverage)
 * 4. Scrape the cluster's articles via Firecrawl
 * 5. Assemble a research bundle from the scraped content
 *
 * @throws if no articles are found or no bundle can be assembled
 */
export async function resolveSlot(
  lane: 'daily_seo' | 'weekly_authority' | 'monthly_anonymized_case',
  options: {
    onSearch?: (count: number) => void;
    onCluster?: (cluster: TopicCluster) => void;
    onScrape?: (total: number, succeeded: number) => void;
    /** Optional: force the resolver to use a specific curated bucket */
    curatedBucket?: string;
    /** Legacy: if false, skip the curated path. Overrides source_strategy. */
    preferCurated?: boolean;
    /** Override config/topics.yaml source_strategy for this call. */
    forcedStrategy?: SourceStrategy;
  } = {},
): Promise<ResolvedSlot> {
  // Resolve strategy: explicit override > legacy preferCurated=false > topics.yaml
  let strategy: SourceStrategy;
  if (options.forcedStrategy) {
    strategy = options.forcedStrategy;
  } else if (options.preferCurated === false) {
    strategy = 'search_first';
  } else {
    strategy = getLaneStrategy(lane);
  }
  console.log(`[resolver] Source strategy: ${strategy} (lane: ${lane})`);

  // Buffer for whichever strategy populates it first. Clustering (Step 2+)
  // runs against this list regardless of where it came from.
  let searchResults: SearchResult[] = [];

  // ------------------------------------------------------------------
  // Strategy A: feed_first — crawl feed_sources.yaml indices first
  // ------------------------------------------------------------------
  if (strategy === 'feed_first') {
    searchResults = await discoverFromFeeds(lane);
    if (searchResults.length > 0) {
      console.log(`[resolver] Feed path: ${searchResults.length} articles discovered`);
      options.onSearch?.(searchResults.length);
    } else {
      console.log('[resolver] Feed path: empty — falling through to curated');
    }
  }

  // ------------------------------------------------------------------
  // Strategy B: curated_first (or feed_first fallback) — curated_sources.yaml
  // ------------------------------------------------------------------
  const tryCurated = searchResults.length === 0
    && (strategy === 'curated_first' || strategy === 'feed_first');
  if (tryCurated) {
    const allBuckets = loadCuratedSources();
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
      if (options.curatedBucket) break;
    }

    if (picked) {
      console.log(`[resolver] Using curated bucket "${picked.topic}"`);
      options.onCluster?.(bucketToCluster(picked));
      return resolveFromCurated(picked, lane, { onScrape: options.onScrape });
    }

    if (allBuckets.size > 0) {
      console.log(`[resolver] All curated buckets for lane "${lane}" are duplicates — falling back to search`);
    } else {
      console.log(`[resolver] No curated buckets defined — falling back to search`);
    }
  }

  // ------------------------------------------------------------------
  // Strategy C: search — Firecrawl keyword search (always the final fallback)
  // ------------------------------------------------------------------
  if (searchResults.length === 0) {
    console.log(`[resolver] Searching for ${lane} topics via Firecrawl...`);
    searchResults = await searchForLane(lane, { limit: 20 });
    options.onSearch?.(searchResults.length);
  }

  if (searchResults.length === 0) {
    throw new Error(
      `[resolver] No articles found for lane "${lane}" via any strategy. Check FIRECRAWL_API_KEY and source allowlist.`,
    );
  }

  console.log(`[resolver] Proceeding to clustering with ${searchResults.length} articles`);

  // Step 2: Cluster
  const rawClusters = clusterArticles(searchResults, { maxClusters: 5 });
  if (rawClusters.length === 0) {
    throw new Error('[resolver] Clustering produced zero clusters');
  }

  // Step 2b: Filter out topics that overlap with existing published content
  const { filtered: clusters, removed } = await filterDuplicateClusters(rawClusters);
  for (const r of removed) {
    console.log(`[resolver] Skipped cluster "${r.cluster.label}" — ${r.reason}`);
  }
  if (clusters.length === 0) {
    throw new Error('[resolver] All clusters overlap with existing content. Try again tomorrow or expand search queries.');
  }

  // Step 2c: Score clusters with Ahrefs keyword data (volume, difficulty, traffic potential)
  console.log(`[resolver] Scoring ${clusters.length} clusters with Ahrefs...`);
  const scores: ClusterScore[] = [];
  for (const cluster of clusters) {
    const score = await scoreCluster(cluster.label, cluster.keywords);
    scores.push(score);
    const best = score.bestKeyword;
    if (best && best.volume > 0) {
      console.log(
        `[resolver]   "${cluster.label}" → best keyword: "${best.keyword}" (vol: ${best.volume}, KD: ${best.difficulty}, TP: ${best.trafficPotential}) → score: ${score.score.toFixed(1)}`,
      );
    } else {
      console.log(`[resolver]   "${cluster.label}" → no Ahrefs data (neutral score)`);
    }
  }

  // Re-rank clusters: Ahrefs score > source diversity
  // If Ahrefs data is available (score > 0), sort by Ahrefs score
  // Otherwise fall back to source diversity (original ordering)
  const hasAhrefsData = scores.some((s) => s.score > 0);
  let rankedClusters: TopicCluster[];
  if (hasAhrefsData) {
    const clusterWithScores = clusters.map((c, i) => ({ cluster: c, score: scores[i] }));
    clusterWithScores.sort((a, b) => b.score.score - a.score.score);
    rankedClusters = clusterWithScores.map((cs) => cs.cluster);
    console.log(`[resolver] Re-ranked by Ahrefs score (keyword-first selection)`);
  } else {
    rankedClusters = clusters;
    console.log(`[resolver] No Ahrefs data — using source diversity ranking`);
  }

  // Pick the strongest cluster
  const winner = rankedClusters[0];
  const winnerScore = scores[clusters.indexOf(winner)];
  options.onCluster?.(winner);
  console.log(
    `[resolver] Winning cluster: "${winner.label}" (${winner.sourceCount} sources, ${winner.articles.length} articles)` +
    (winnerScore?.bestKeyword ? ` — target keyword: "${winnerScore.bestKeyword.keyword}" (vol: ${winnerScore.bestKeyword.volume}, KD: ${winnerScore.bestKeyword.difficulty})` : ''),
  );

  // Step 3: Scrape the cluster's articles
  const urls = winner.articles.map((a) => a.url);
  console.log(`[resolver] Scraping ${urls.length} URLs...`);
  const scrapeResults = await scrapeMany(urls, 3);

  const succeeded = scrapeResults.filter((r) => r.article).length;
  options.onScrape?.(urls.length, succeeded);
  console.log(`[resolver] Scraped ${succeeded}/${urls.length} successfully`);

  if (succeeded === 0) {
    throw new Error(
      '[resolver] All scrapes failed. Check FIRECRAWL_API_KEY and source URLs.',
    );
  }

  // Step 3b: Source-freshness filter.
  //
  // Two cutoffs stacked: a lane-level ceiling (18 months for daily_seo,
  // 36 for weekly/monthly — no current-events post should cite a 2-year-old
  // article), AND a per-source override from feed_sources.yaml freshness_days
  // (30/45/60 days). When a URL belongs to a feed source, we use
  // min(lane_cutoff, source_cutoff). This makes the feed sources tighter
  // than the lane default instead of looser — a CBT News article must be
  // less than 30 days old even though the lane would have allowed 18 months.
  //
  // Articles with no publishedAt metadata are kept (we can't filter on
  // unknown data). If every article is stale, throw.
  const LANE_CUTOFF_DAYS = lane === 'daily_seo' ? 18 * 30 : 36 * 30;
  const now = Date.now();
  const freshResults = scrapeResults.filter((r) => {
    if (!r.article) return false;
    const pub = r.article.publishedAt;
    if (!pub) return true; // unknown date → keep, rather than drop
    const pubMs = Date.parse(pub);
    if (Number.isNaN(pubMs)) return true;

    const sourceCutoff = getFreshnessDaysForUrl(r.url);
    const effectiveDays = sourceCutoff != null
      ? Math.min(LANE_CUTOFF_DAYS, sourceCutoff)
      : LANE_CUTOFF_DAYS;
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
  if (freshCount === 0) {
    throw new Error(
      `[resolver] Every source in cluster "${winner.label}" failed the freshness filter (lane cutoff ${LANE_CUTOFF_DAYS}d + per-source overrides). Bundle unusable.`,
    );
  }

  // Step 4: Convert to ScrapedInputs and assemble bundle
  const inputs: ScrapedInput[] = freshResults.map((r) => ({
    url: r.url,
    title: r.article!.title,
    publishedAt: r.article!.publishedAt,
    rawText: r.article!.rawText,
  }));

  const bundle = assembleBundle(inputs, {
    lane,
    topic_slug: winner.slug,
  });

  console.log(
    `[resolver] Bundle assembled: ${bundle.sources.length} sources, ${bundle.sources.reduce((n, s) => n + s.quotes.length, 0)} quotes`,
  );

  return { bundle, cluster: winner };
}
