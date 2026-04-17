/**
 * Generate a topical map from seed keywords via Ahrefs.
 *
 * Usage: npx tsx scripts/topical-map.ts
 *
 * Reads config/seed-keywords.yaml, expands each seed via Ahrefs
 * matching-terms + related-terms, clusters into pillars, scores
 * by opportunity, and writes config/content-calendar.yaml.
 */
import { config } from 'dotenv';
config({ path: '.env.cron.tmp' });

import { generateTopicalMap, writeCalendar } from '../lib/topics/topical-map';

const startedAt = Date.now();

function stamp(label: string) {
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[topical-map +${secs}s] ${label}`);
}

async function main() {
  stamp('Starting topical map generation');

  const calendar = await generateTopicalMap({
    onSeed: (vertical, seed) => stamp(`  ${vertical}: expanding "${seed}"`),
    onExpand: (seed, count) => stamp(`    → ${count} keywords found`),
    onComplete: (pillars, topics) => stamp(`Done: ${pillars.length} pillars, ${topics.length} total topics`),
  });

  const outPath = writeCalendar(calendar);
  stamp(`Calendar written to ${outPath}`);

  // Print summary
  console.log('\n=== TOP 20 UNPUBLISHED OPPORTUNITIES ===\n');
  const unpublished = calendar.pillars
    .flatMap(p => p.topics)
    .filter(t => !t.published)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  console.log('| # | Keyword | Vol | KD | TP | Score | Vertical |');
  console.log('|---|---------|-----|----|----|-------|----------|');
  unpublished.forEach((t, i) => {
    console.log(`| ${i + 1} | ${t.keyword} | ${t.volume} | ${t.difficulty} | ${t.trafficPotential} | ${Math.round(t.score * 10) / 10} | ${t.vertical} |`);
  });

  console.log(`\nAhrefs API units used: ${calendar.unitsUsedAfter - calendar.unitsUsedBefore}`);
  console.log(`Total wall time: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
