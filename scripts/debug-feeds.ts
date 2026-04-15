/**
 * Debug the feed discovery path in isolation — crawl all index pages,
 * run the relevance filter, print a report. No clustering, no scraping,
 * no LLM calls, no PR. Useful for verifying config/feed_sources.yaml
 * + the allowlist + the article filter all line up before running the
 * full 10-minute pipeline.
 *
 * Usage: npx tsx scripts/debug-feeds.ts [lane]
 *   lane defaults to daily_seo
 */
import { config } from 'dotenv';
config({ path: '.env.cron.tmp' });

import { crawlAllFeeds, loadFeedSources } from '../lib/sources/crawl-index';
import { filterByRelevance, scoreAndRank } from '../lib/sources/relevance-filter';
import type { Lane } from '../lib/config/topics-config';

const lane = (process.argv[2] as Lane) ?? 'daily_seo';
const startedAt = Date.now();

function stamp(label: string) {
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[debug-feeds +${secs}s] ${label}`);
}

async function main() {
  const sources = loadFeedSources();
  stamp(`loaded ${sources.length} feed sources from config/feed_sources.yaml`);

  for (const s of sources) {
    console.log(`  - ${s.key} (tier ${s.tier}): ${s.indexUrls.length} index URL${s.indexUrls.length === 1 ? '' : 's'}, max ${s.maxArticlesPerCrawl} articles, ${s.freshnessDays}d freshness`);
  }

  stamp('crawling all feeds (concurrency=4)...');
  const { articles, stats } = await crawlAllFeeds({ concurrency: 4 });
  stamp(`crawl done: ${stats.sourcesSucceeded}/${stats.sourcesAttempted} sources succeeded, ${articles.length} articles passed filter+allowlist`);

  // Per-source breakdown
  const bySource = new Map<string, number>();
  for (const a of articles) {
    bySource.set(a.sourceKey, (bySource.get(a.sourceKey) ?? 0) + 1);
  }
  console.log('\n=== articles per source ===');
  for (const s of sources) {
    const n = bySource.get(s.key) ?? 0;
    const marker = n === 0 ? 'FAIL' : 'ok  ';
    console.log(`  ${marker}  ${s.key.padEnd(20)} ${n}`);
  }

  stamp(`running relevance filter for lane "${lane}"`);
  const filtered = filterByRelevance(articles, lane);
  console.log(`\nrelevance filter: ${filtered.length} kept from ${articles.length}`);

  const scored = scoreAndRank(articles, lane);
  console.log('\n=== top 20 articles by relevance score ===');
  for (const { article, score } of scored.slice(0, 20)) {
    console.log(`  [${score}] ${article.sourceKey.padEnd(18)} ${article.url}`);
  }

  console.log('\n=== zero-relevance sample (first 10) ===');
  for (const { article, score } of scored.filter((s) => s.score === 0).slice(0, 10)) {
    console.log(`  [${score}] ${article.sourceKey.padEnd(18)} ${article.url}`);
  }

  console.log(`\nTotal wall time: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.error(`\n[debug-feeds +${secs}s] FATAL: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
