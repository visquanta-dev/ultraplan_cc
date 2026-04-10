import { searchForLane } from './search';
import { clusterArticles, type TopicCluster } from './cluster';
import { scrapeMany } from '../sources/firecrawl';
import { assembleBundle } from '../bundle/assemble';
import type { Bundle, ScrapedInput } from '../bundle/types';

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
  } = {},
): Promise<ResolvedSlot> {
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
  const clusters = clusterArticles(searchResults, { maxClusters: 5 });
  if (clusters.length === 0) {
    throw new Error('[resolver] Clustering produced zero clusters');
  }

  // Pick the strongest cluster (first = most diverse source coverage)
  const winner = clusters[0];
  options.onCluster?.(winner);
  console.log(
    `[resolver] Winning cluster: "${winner.label}" (${winner.sourceCount} sources, ${winner.articles.length} articles)`,
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
