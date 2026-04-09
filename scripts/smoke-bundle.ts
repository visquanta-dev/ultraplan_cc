/* eslint-disable no-console */
import '../lib/load-env';
import fs from 'node:fs';
import path from 'node:path';
import { scrapeMany } from '../lib/sources/firecrawl';
import { assembleBundle } from '../lib/bundle/assemble';
import type { ScrapedInput } from '../lib/bundle/types';

// ---------------------------------------------------------------------------
// scripts/smoke-bundle.ts
// End-to-end smoke test: source layer → bundle assembler → bundle.json on disk.
// Uses three allowlisted trade-press URLs to verify the full extraction
// pipeline produces a valid bundle before hooking up the drafter.
//
// Usage:
//   npx tsx scripts/smoke-bundle.ts
// ---------------------------------------------------------------------------

const TEST_URLS = [
  'https://www.automotivenews.com/dealers',
  'https://www.wardsauto.com/dealers',
  'https://www.autoremarketing.com/',
];

const TEST_TOPIC_SLUG = 'smoke-test-after-hours-ai';
const TEST_LANE = 'daily_seo' as const;

async function main() {
  console.log('\n=== UltraPlan bundle smoke test ===\n');

  // 1. Scrape
  console.log(`[1/3] Scraping ${TEST_URLS.length} URLs via Firecrawl`);
  const scraped = await scrapeMany(TEST_URLS, 2);
  const ok = scraped.filter((r) => r.article);
  const failed = scraped.filter((r) => r.error);

  console.log(`  success: ${ok.length}/${TEST_URLS.length}`);
  if (failed.length > 0) {
    console.log(`  failures:`);
    for (const f of failed) {
      console.log(`    ${f.url} — ${f.error}`);
    }
  }

  if (ok.length === 0) {
    console.error('\nNo URLs scraped successfully. Bundle assembly cannot proceed.');
    process.exit(1);
  }

  // 2. Normalize to ScrapedInput
  const inputs: ScrapedInput[] = ok.map((r) => ({
    url: r.article!.canonicalUrl,
    title: r.article!.title,
    publishedAt: r.article!.publishedAt,
    rawText: r.article!.rawText,
  }));

  // 3. Assemble
  console.log(`\n[2/3] Assembling bundle for topic "${TEST_TOPIC_SLUG}"`);
  const bundle = assembleBundle(inputs, {
    lane: TEST_LANE,
    topic_slug: TEST_TOPIC_SLUG,
  });

  console.log(`  bundle_id: ${bundle.bundle_id}`);
  console.log(`  lane: ${bundle.lane}`);
  console.log(`  sources: ${bundle.sources.length}`);

  for (const source of bundle.sources) {
    console.log(`    ${source.source_id} — ${source.domain} — ${source.quotes.length} quotes`);
    for (const quote of source.quotes.slice(0, 2)) {
      console.log(`      [${quote.type}] ${quote.text.slice(0, 100)}...`);
    }
  }

  // 4. Write to disk
  console.log(`\n[3/3] Writing bundle.json to tmp/`);
  const outDir = path.join(process.cwd(), 'tmp');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${bundle.bundle_id}.json`);
  fs.writeFileSync(outPath, JSON.stringify(bundle, null, 2));
  console.log(`  wrote: ${outPath}`);
  console.log(`  size: ${fs.statSync(outPath).size} bytes`);

  const totalQuotes = bundle.sources.reduce((sum, s) => sum + s.quotes.length, 0);
  console.log();
  console.log('=== Summary ===');
  console.log(`  sources:       ${bundle.sources.length}`);
  console.log(`  total quotes:  ${totalQuotes}`);
  console.log(`  output:        tmp/${path.basename(outPath)}`);
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
