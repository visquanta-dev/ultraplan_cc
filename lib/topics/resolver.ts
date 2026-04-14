import { searchForLane } from './search';
import { clusterArticles, type TopicCluster } from './cluster';
import { filterDuplicateClusters } from './dedup';
import { scoreCluster, type ClusterScore } from './keyword-scorer';
import { scrapeMany } from '../sources/firecrawl';
import { assembleBundle } from '../bundle/assemble';
import type { Bundle, ScrapedInput } from '../bundle/types';
import { loadCuratedSources, pickCuratedBucket, resolveFromCurated, bucketToCluster } from './curated-sources';

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
    /** Default: true — try curated sources before Firecrawl keyword search */
    preferCurated?: boolean;
  } = {},
): Promise<ResolvedSlot> {
  const preferCurated = options.preferCurated !== false;

  // Step 0: Try curated sources path first (if enabled and buckets exist).
  // Iterates through all buckets for the lane and picks the first one that
  // hasn't been shipped recently (per dedup). Falls back to Firecrawl search
  // if every curated bucket is a duplicate or none exist.
  if (preferCurated) {
    const allBuckets = loadCuratedSources();
    const excluded = new Set<string>();
    let picked = null;
    while (true) {
      const candidate = pickCuratedBucket(lane, {
        requestedTopic: options.curatedBucket,
        excludeTopics: excluded,
      });
      if (!candidate) break;
      // Run the candidate through dedup
      const tempCluster = bucketToCluster(candidate);
      const { filtered } = await filterDuplicateClusters([tempCluster]);
      if (filtered.length > 0) {
        picked = candidate;
        break;
      }
      console.log(
        `[resolver] Curated bucket "${candidate.topic}" already shipped — trying next`,
      );
      excluded.add(candidate.topic);
      // If the user explicitly requested a topic, don't rotate — bail out
      if (options.curatedBucket) break;
    }

    if (picked) {
      console.log(`[resolver] Using curated bucket "${picked.topic}" — skipping Firecrawl keyword search`);
      options.onCluster?.(bucketToCluster(picked));
      return resolveFromCurated(picked, lane, { onScrape: options.onScrape });
    }

    if (allBuckets.size > 0) {
      console.log(`[resolver] All curated buckets for lane "${lane}" are duplicates — falling back to Firecrawl keyword search`);
    } else {
      console.log(`[resolver] No curated buckets defined — falling back to Firecrawl keyword search`);
    }
  }

  // Step 1: Search
  console.log(`[resolver] Searching for ${lane} topics...`);
  const searchResults = await searchForLane(lane, { limit: 20 });
  options.onSearch?.(searchResults.length);

  if (searchResults.length === 0) {
    throw new Error(
      `[resolver] No articles found for lane "${lane}". Check FIRECRAWL_API_KEY and source allowlist.`,
    );
  }

  console.log(`[resolver] Found ${searchResults.length} articles`);

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

  // Step 4: Convert to ScrapedInputs and assemble bundle
  const inputs: ScrapedInput[] = scrapeResults
    .filter((r) => r.article)
    .map((r) => ({
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
