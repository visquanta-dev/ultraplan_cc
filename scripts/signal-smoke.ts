import { getSignalCandidates, clusterCandidates, scoreCluster } from '../lib/topics/competitor-signal';
import { getCategoryStatus } from '../lib/topics/category-cooldown';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
  console.log('=== Competitor-signal smoke test ===');
  console.log('(forcing fresh scrape if cache is cold — hits all 19 sitemaps)\n');

  const start = Date.now();
  const result = await getSignalCandidates({ limit: 10 });
  const elapsedS = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`\n=== Result summary ===`);
  console.log(`  fetched_at:        ${result.fetched_at}`);
  console.log(`  sources scraped:   ${result.sources_scraped}/${result.sources_scraped + result.sources_failed}`);
  console.log(`  total candidates:  ${result.total_candidates}`);
  console.log(`  clusters (top N):  ${result.clusters.length}`);
  console.log(`  blocked cats:      ${result.blocked_categories.join(', ') || '(none)'}`);
  console.log(`  elapsed:           ${elapsedS}s`);

  console.log(`\n=== Top 10 UNBLOCKED topic clusters (passing the cooldown filter) ===\n`);
  if (result.clusters.length === 0) {
    console.log('  (none — every cluster maps to a category currently in cooldown)');
  }
  for (const c of result.clusters) {
    const cov = `T1:${c.tier_counts.tier1} T2:${c.tier_counts.tier2} T3:${c.tier_counts.tier3} T4:${c.tier_counts.tier4}`;
    const mostRecent = c.most_recent_lastmod
      ? new Date(c.most_recent_lastmod).toISOString().slice(0, 10)
      : '—';
    console.log(`  [score ${c.score.toFixed(2)}]  ${c.suggested_category.padEnd(20)}  ${cov}  recent:${mostRecent}`);
    console.log(`    ← ${c.representative_title}`);
    for (const u of c.urls.slice(0, 3)) {
      console.log(`        · ${u.source_name.padEnd(18)} ${u.title.slice(0, 80)}`);
    }
    if (c.urls.length > 3) console.log(`        · (+${c.urls.length - 3} more)`);
  }

  // Diagnostic view: ALL clusters, including blocked — so we can see the
  // raw signal and verify the clustering/scoring logic without the cooldown
  // filter masking everything.
  console.log(`\n=== Top 15 RAW clusters (cooldown filter disabled) ===\n`);
  const cachePath = path.join(process.cwd(), 'tmp', 'competitor-signal-cache.json');
  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  const rawClusters = clusterCandidates(cached.candidates);
  const status = getCategoryStatus();
  const weights: Record<string, number> = {};
  for (const s of status) weights[s.id] = s.editorial_weight;
  for (const c of rawClusters) {
    c.category_blocked = false; // force unblock for scoring visibility
    c.score = scoreCluster(c, weights);
  }
  const topRaw = rawClusters.sort((a, b) => b.score - a.score).slice(0, 15);
  for (const c of topRaw) {
    const cov = `T1:${c.tier_counts.tier1} T2:${c.tier_counts.tier2} T3:${c.tier_counts.tier3} T4:${c.tier_counts.tier4}`;
    const mostRecent = c.most_recent_lastmod
      ? new Date(c.most_recent_lastmod).toISOString().slice(0, 10)
      : '—';
    const blocked = status.find((s) => s.id === c.suggested_category)?.blocked ? ' 🔒' : ' 🟢';
    console.log(`  [${c.score.toFixed(2)}]${blocked} ${c.suggested_category.padEnd(20)} ${cov} recent:${mostRecent}  urls=${c.urls.length}`);
    console.log(`    ← ${c.representative_title}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
