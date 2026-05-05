/* eslint-disable no-console */
import '../lib/load-env';
import { scrape } from '../lib/sources/firecrawl';
import { scrapeSubreddit } from '../lib/sources/apify-reddit';
import { scrapeHashtag } from '../lib/sources/apify-linkedin';

// ---------------------------------------------------------------------------
// scripts/smoke-scrape.ts
// Manual end-to-end smoke test of the source layer. Hits one allowlisted URL
// via each wrapper and prints a summary. Used to verify API keys and
// network connectivity without running the full pipeline.
//
// Usage:
//   1. Copy .env.example to .env.local and fill in FIRECRAWL_API_KEY + APIFY_API_TOKEN
//      (APIFY_TOKEN also works as an alias).
//   2. npx tsx scripts/smoke-scrape.ts
// ---------------------------------------------------------------------------

const TEST_FIRECRAWL_URL = 'https://www.automotivenews.com/dealers';
const TEST_SUBREDDIT = 'askcarsales';
const TEST_HASHTAG = '#dealership';

async function main() {
  let firecrawlOk = false;
  let redditOk = false;
  let linkedinOk = false;

  console.log('\n=== UltraPlan source layer smoke test ===\n');

  // -- Firecrawl --
  console.log(`[1/3] Firecrawl: scraping ${TEST_FIRECRAWL_URL}`);
  try {
    const article = await scrape(TEST_FIRECRAWL_URL);
    console.log(`  title: ${article.title.slice(0, 80)}`);
    console.log(`  publishedAt: ${article.publishedAt ?? 'unknown'}`);
    console.log(`  author: ${article.author ?? 'unknown'}`);
    console.log(`  rawText: ${article.rawText.length} chars`);
    console.log(`  canonicalUrl: ${article.canonicalUrl}`);
    firecrawlOk = true;
  } catch (err) {
    console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log();

  // -- Reddit --
  console.log(`[2/3] Apify Reddit: scraping r/${TEST_SUBREDDIT} (last 48h)`);
  try {
    const posts = await scrapeSubreddit(TEST_SUBREDDIT, { maxPosts: 10, hoursBack: 48 });
    console.log(`  posts returned: ${posts.length}`);
    if (posts[0]) {
      console.log(`  first post: "${posts[0].title.slice(0, 80)}"`);
      console.log(`  first post upvotes: ${posts[0].upvotes}`);
    }
    redditOk = true;
  } catch (err) {
    console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log();

  // -- LinkedIn --
  console.log(`[3/3] Apify LinkedIn: scraping ${TEST_HASHTAG}`);
  try {
    const posts = await scrapeHashtag(TEST_HASHTAG, { maxPosts: 10 });
    console.log(`  posts returned: ${posts.length}`);
    if (posts[0]) {
      console.log(`  first post author: ${posts[0].author}`);
      console.log(`  first post reactions: ${posts[0].reactions}`);
      console.log(`  content: ${posts[0].content.slice(0, 120)}...`);
    }
    linkedinOk = true;
  } catch (err) {
    console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log();
  console.log('=== Summary ===');
  console.log(`  Firecrawl: ${firecrawlOk ? 'OK' : 'FAIL'}`);
  console.log(`  Reddit:    ${redditOk ? 'OK' : 'FAIL'}`);
  console.log(`  LinkedIn:  ${linkedinOk ? 'OK' : 'FAIL'}`);
  console.log();

  if (!firecrawlOk || !redditOk || !linkedinOk) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
