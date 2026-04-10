/**
 * Generate multiple blog posts. Each run resolves a fresh topic slot.
 * Usage: npx tsx scripts/generate-batch.ts [count]
 * Default: 5 posts
 */
import 'dotenv/config';
import { config } from 'dotenv';
config({ path: '.env.local', override: true });

import { resolveSlot } from '../lib/topics/resolver';
import { runBlogPipeline } from '../workflows/blog-pipeline/index';

const count = parseInt(process.argv[2] ?? '5', 10);
const lanes = ['daily_seo', 'weekly_authority', 'daily_seo', 'daily_seo', 'weekly_authority'] as const;

async function main() {
  console.log(`=== Generating ${count} blog posts ===\n`);
  const results: Array<{ slug: string; verdict: string; prUrl?: string; duration: number }> = [];

  for (let i = 0; i < count; i++) {
    const lane = lanes[i % lanes.length];
    console.log(`\n--- Post ${i + 1}/${count} (${lane}) ---\n`);

    try {
      const { bundle } = await resolveSlot(lane);
      console.log(`Topic: "${bundle.topic_slug}" — ${bundle.sources.length} sources\n`);

      const result = await runBlogPipeline({
        bundle,
        wordCount: lane === 'weekly_authority' ? { min: 1200, max: 1800 } : { min: 1000, max: 1400 },
      });

      results.push({
        slug: result.slug,
        verdict: result.verdict,
        prUrl: result.prUrl,
        duration: result.durationMs,
      });

      console.log(`\n  Result: ${result.verdict} ${result.prUrl ?? result.error ?? ''}`);
    } catch (e: any) {
      console.error(`\n  FATAL: ${e.message}`);
      results.push({ slug: `post-${i + 1}`, verdict: 'error', duration: 0 });
    }
  }

  console.log('\n\n=== SUMMARY ===');
  console.log('| # | Slug | Verdict | PR | Duration |');
  console.log('|---|------|---------|-----|----------|');
  results.forEach((r, i) => {
    console.log(`| ${i + 1} | ${r.slug} | ${r.verdict} | ${r.prUrl ?? '-'} | ${(r.duration / 1000).toFixed(0)}s |`);
  });
}

main().catch(e => console.error('FATAL:', e.message));
