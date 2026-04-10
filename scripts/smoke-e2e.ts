/**
 * End-to-end smoke test: resolveSlot → runBlogPipeline (with real PR creation).
 * Usage: npx tsx scripts/smoke-e2e.ts
 */
import 'dotenv/config';
import { config } from 'dotenv';
config({ path: '.env.local', override: true });

import { resolveSlot } from '../lib/topics/resolver';
import { runBlogPipeline } from '../workflows/blog-pipeline/index';

async function main() {
  console.log('=== UltraPlan E2E smoke test ===\n');

  // Step 1: Resolve a topic slot (search → cluster → scrape → bundle)
  console.log('[e2e] Step 1: Resolving topic slot (daily_seo lane)...\n');
  const { bundle, cluster } = await resolveSlot('daily_seo');
  console.log(`\n[e2e] Topic: "${cluster.label}" — ${bundle.sources.length} sources, ${bundle.sources.reduce((n, s) => n + s.quotes.length, 0)} quotes\n`);

  // Step 2: Run full pipeline (outline → draft → gates → image → PR)
  console.log('[e2e] Step 2: Running full blog pipeline...\n');
  const result = await runBlogPipeline({
    bundle,
    wordCount: { min: 1000, max: 1400 },
  });

  console.log('\n=== E2E Result ===');
  console.log(`  slug:     ${result.slug}`);
  console.log(`  lane:     ${result.lane}`);
  console.log(`  verdict:  ${result.verdict}`);
  console.log(`  duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  if (result.prUrl) console.log(`  PR:       ${result.prUrl}`);
  if (result.error) console.log(`  error:    ${result.error}`);
}

main().catch((err) => {
  console.error('\n[e2e] FATAL:', err.message || err);
  process.exit(1);
});
