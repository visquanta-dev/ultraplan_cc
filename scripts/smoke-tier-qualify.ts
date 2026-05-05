import { clusterCandidates, scoreCluster, type TopicCluster } from '../lib/topics/competitor-signal';
import { getCategoryStatus } from '../lib/topics/category-cooldown';
import fs from 'node:fs';
import path from 'node:path';

const cachePath = path.join(process.cwd(), 'tmp', 'competitor-signal-cache.json');
const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
const status = getCategoryStatus();
const weights: Record<string, number> = {};
for (const s of status) weights[s.id] = s.editorial_weight;

// 1) Synthetic spot-checks on the qualifying logic.
// Populates `urls` with N distinct source_ids per tier so the new
// distinct-source scoring path is exercised (tier_counts is descriptive only).
function mk(t1: number, t2: number, t3: number, t4: number, cat = 'speed_to_lead'): TopicCluster {
  const urls = [
    ...Array.from({ length: t1 }, (_, i) => ({ url: `https://t1-${i}.example/p`, title: `T1 ${i}`, lastmod: null, source_id: `t1_src_${i}`, source_name: `T1 Src ${i}`, tier: 1 as const, suggested_category: cat })),
    ...Array.from({ length: t2 }, (_, i) => ({ url: `https://t2-${i}.example/p`, title: `T2 ${i}`, lastmod: null, source_id: `t2_src_${i}`, source_name: `T2 Src ${i}`, tier: 2 as const, suggested_category: cat })),
    ...Array.from({ length: t3 }, (_, i) => ({ url: `https://t3-${i}.example/p`, title: `T3 ${i}`, lastmod: null, source_id: `t3_src_${i}`, source_name: `T3 Src ${i}`, tier: 3 as const, suggested_category: cat })),
    ...Array.from({ length: t4 }, (_, i) => ({ url: `https://t4-${i}.example/p`, title: `T4 ${i}`, lastmod: null, source_id: `t4_src_${i}`, source_name: `T4 Src ${i}`, tier: 4 as const, suggested_category: cat })),
  ];
  return {
    id: `synth_${t1}_${t2}_${t3}_${t4}`,
    representative_title: `synth t1=${t1} t2=${t2} t3=${t3} t4=${t4}`,
    urls,
    tier_counts: { tier1: t1, tier2: t2, tier3: t3, tier4: t4 },
    linkable_source_count: t1 + t2 + t3 + t4,
    no_link_source_count: 0,
    most_recent_lastmod: new Date().toISOString(),
    suggested_category: cat,
    score: 0,
    category_blocked: false,
  };
}

// Single-domain bulk-crawl trap: 64 URLs, all from same source — should not
// qualify on the alt path now (was the NADA failure mode).
function mkSingleSourceBulk(tier: 3 | 4, count: number, sourceId = 'bulk_src'): TopicCluster {
  const urls = Array.from({ length: count }, (_, i) => ({
    url: `https://${sourceId}.example/p${i}`,
    title: `bulk ${i}`,
    lastmod: null,
    source_id: sourceId,
    source_name: 'Bulk Source',
    tier,
    suggested_category: 'industry_trends',
  }));
  return {
    id: `bulk_${tier}_${count}`,
    representative_title: `${count}× single-source tier${tier} bulk`,
    urls,
    tier_counts: { tier1: 0, tier2: 0, tier3: tier === 3 ? count : 0, tier4: tier === 4 ? count : 0 },
    linkable_source_count: 1,
    no_link_source_count: 0,
    most_recent_lastmod: new Date().toISOString(),
    suggested_category: 'industry_trends',
    score: 0,
    category_blocked: false,
  };
}

const cases = [
  ['T1=1, rest 0', mk(1, 0, 0, 0)],
  ['T2=1, rest 0', mk(0, 1, 0, 0)],
  ['T3=1 only',    mk(0, 0, 1, 0)],
  ['T4=2 only',    mk(0, 0, 0, 2)],
  ['T3+T4=3 alt (3 distinct)',  mk(0, 0, 2, 1)],
  ['T3=3 alt (3 distinct)',     mk(0, 0, 3, 0)],
  ['T4=4 alt+bonus (4 distinct)', mk(0, 0, 0, 4)],
  ['T1=1 + T3+T4=3 mixed',     mk(1, 0, 1, 2)],
  ['64× single-source T3 bulk (NADA-style)', mkSingleSourceBulk(3, 64)],
  ['16× single-source T3 bulk (CDK-style)',  mkSingleSourceBulk(3, 16)],
] as const;

console.log('=== Synthetic qualifying matrix ===');
for (const [label, c] of cases) {
  c.score = scoreCluster(c, weights);
  const status = c.score === 0 ? 'REJECTED' : 'qualifies';
  console.log(`  [${c.score.toFixed(2).padStart(6)}] ${status.padEnd(9)} ${label}`);
}

// 2) Re-rank cached candidates to see what previously got 0 now qualifies
console.log('\n=== Cached pool: clusters that NOW qualify (T3+T4≥3 only, no T1/T2) ===');
const rawClusters = clusterCandidates(cached.candidates);
let newlyQualifying = 0;
const newQualifiers: { score: number; cluster: TopicCluster }[] = [];
for (const c of rawClusters) {
  c.category_blocked = false;
  c.score = scoreCluster(c, weights);
  const isAltOnly = c.tier_counts.tier1 === 0 && c.tier_counts.tier2 === 0;
  if (isAltOnly && c.score > 0) {
    newlyQualifying++;
    newQualifiers.push({ score: c.score, cluster: c });
  }
}
console.log(`  ${newlyQualifying} clusters newly qualify under the alternative path`);
newQualifiers.sort((a, b) => b.score - a.score);
for (const { score, cluster: c } of newQualifiers.slice(0, 10)) {
  const cov = `T1:${c.tier_counts.tier1} T2:${c.tier_counts.tier2} T3:${c.tier_counts.tier3} T4:${c.tier_counts.tier4}`;
  console.log(`  [${score.toFixed(2)}] ${c.suggested_category.padEnd(20)} ${cov}`);
  console.log(`     ← ${c.representative_title}`);
}

// 3) Show the top-10 overall on the cached pool to verify primary-led still ranks above
console.log('\n=== Top 10 overall (verify primary-led clusters still dominate) ===');
const sorted = [...rawClusters].sort((a, b) => b.score - a.score).slice(0, 10);
for (const c of sorted) {
  const cov = `T1:${c.tier_counts.tier1} T2:${c.tier_counts.tier2} T3:${c.tier_counts.tier3} T4:${c.tier_counts.tier4}`;
  const path = (c.tier_counts.tier1 > 0 || c.tier_counts.tier2 > 0) ? 'PRIMARY' : 'ALT    ';
  console.log(`  [${c.score.toFixed(2)}] ${path}  ${cov}  ← ${c.representative_title.slice(0, 70)}`);
}
