/**
 * Run the full blog pipeline locally — same code path as the cron route,
 * but free from serverless timeouts. Opens a real PR on success.
 *
 * Usage: npx tsx scripts/run-pipeline-local.ts [lane] [curatedBucket]
 *   lane defaults to daily_seo
 *   curatedBucket forces a specific curated_sources.yaml bucket (e.g. service_drive_fixed_ops)
 */
import { config } from 'dotenv';
config({ path: '.env.cron.tmp' });

import { resolveSlot } from '../lib/topics/resolver';
import { runBlogPipeline } from '../workflows/blog-pipeline';
import { getLaneWordCount, type Lane, type SourceStrategy } from '../lib/config/topics-config';

const VALID_LANES: Lane[] = ['daily_seo', 'weekly_authority', 'monthly_anonymized_case', 'listicle'];
const lane = (process.argv[2] as Lane) ?? 'daily_seo';
const curatedBucket = process.argv[3] ?? undefined;
const strategyFlag = process.argv.find(a => a.startsWith('--strategy='))?.split('=')[1]
  ?? (process.argv.includes('--strategy') ? process.argv[process.argv.indexOf('--strategy') + 1] : undefined);

if (!VALID_LANES.includes(lane)) {
  console.error(`Unknown lane: ${lane}. Valid: ${VALID_LANES.join(', ')}`);
  process.exit(1);
}

const wordCount = getLaneWordCount(lane);
const startedAt = Date.now();

function stamp(label: string) {
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[local +${secs}s] ${label}`);
}

async function main() {
  stamp(`Starting pipeline — lane: ${lane}, word count: ${wordCount.min}-${wordCount.max}${curatedBucket ? `, bucket: ${curatedBucket}` : ''}`);

  stamp('resolveSlot: begin');
  const { bundle } = await resolveSlot(lane, {
    onSearch: (n) => stamp(`resolveSlot.onSearch: ${n} articles`),
    onCluster: (c) => stamp(`resolveSlot.onCluster: "${c.label}" (${c.articles.length} articles)`),
    onScrape: (total, ok) => stamp(`resolveSlot.onScrape: ${ok}/${total} succeeded`),
    ...(curatedBucket ? { curatedBucket, forcedStrategy: 'curated_first' as const } : {}),
    ...(strategyFlag ? { forcedStrategy: strategyFlag as SourceStrategy } : {}),
  });
  stamp(`resolveSlot: done — bundle slug "${bundle.topic_slug}", ${bundle.sources.length} sources`);

  stamp('runBlogPipeline: begin');
  const result = await runBlogPipeline({ bundle, wordCount });
  stamp(`runBlogPipeline: done — verdict: ${result.verdict}`);

  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nTotal wall time: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  // Write result to file for CI consumption (GitHub Actions reads this)
  const fs = await import('node:fs');
  fs.writeFileSync('pipeline-result.json', JSON.stringify(result));
}

main().catch((err) => {
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.error(`\n[local +${secs}s] FATAL: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
