// Sweep the cluster Jaccard threshold across [0.20, 0.25, 0.30, 0.35, 0.40]
// against the cached candidate pool, reporting:
//   - total cluster count
//   - distribution of clusters by URL count (singletons vs multi)
//   - distribution by distinct-source count (the new corroboration metric)
//   - sample multi-source clusters newly formed at each lower threshold
//
// This tells us empirically which threshold actually unblocks
// cross-publisher merging without producing slop.

import fs from 'node:fs';
import path from 'node:path';
import type { TopicCluster, CandidateURL } from '../lib/topics/competitor-signal';

const cachePath = path.join(process.cwd(), 'tmp', 'competitor-signal-cache.json');
const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));

const CLUSTER_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you',
  'how', 'why', 'what', 'when', 'are', 'will', 'can', 'use', 'using',
  'car', 'cars', 'auto', 'automotive', 'dealer', 'dealers', 'dealership',
  'dealerships', 'sales', 'new', 'tips', 'guide', 'best', 'top', 'ways',
  'blog', 'post', 'article', 'read', 'more', 'get', 'make', 'need',
]);
function titleTokens(title: string): Set<string> {
  return new Set(
    title.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/)
      .filter((w) => w.length >= 3 && !CLUSTER_STOPWORDS.has(w)),
  );
}
function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  const union = new Set([...a, ...b]).size;
  return union > 0 ? shared / union : 0;
}

function clusterAtThreshold(candidates: CandidateURL[], threshold: number) {
  const filtered = candidates.filter((c) => titleTokens(c.title).size >= 3);
  const tokens = filtered.map((c) => titleTokens(c.title));
  const parent: number[] = filtered.map((_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  for (let i = 0; i < filtered.length; i++) {
    for (let j = i + 1; j < filtered.length; j++) {
      if (jaccard(tokens[i], tokens[j]) >= threshold) {
        const ra = find(i); const rb = find(j);
        if (ra !== rb) parent[ra] = rb;
      }
    }
  }
  const groups: Record<number, CandidateURL[]> = {};
  for (let i = 0; i < filtered.length; i++) {
    const r = find(i);
    (groups[r] ??= []).push(filtered[i]);
  }
  return Object.values(groups);
}

console.log(`Cached pool: ${cached.candidates.length} candidates from cache fetched ${cached.fetched_at}\n`);
console.log('threshold | clusters | singletons | multi-url | distinct-src≥2 | distinct-src≥3 | largest');
console.log('----------|----------|------------|-----------|----------------|----------------|--------');
for (const t of [0.40, 0.35, 0.30, 0.25, 0.20]) {
  const clusters = clusterAtThreshold(cached.candidates, t);
  const singletons = clusters.filter((c) => c.length === 1).length;
  const multi = clusters.filter((c) => c.length > 1).length;
  const dist2 = clusters.filter((c) => new Set(c.map((u: CandidateURL) => u.source_id)).size >= 2).length;
  const dist3 = clusters.filter((c) => new Set(c.map((u: CandidateURL) => u.source_id)).size >= 3).length;
  const largest = Math.max(...clusters.map((c) => c.length));
  console.log(
    `   ${t.toFixed(2)}   |   ${String(clusters.length).padStart(4)}   |    ${String(singletons).padStart(4)}    |   ${String(multi).padStart(4)}    |       ${String(dist2).padStart(4)}     |       ${String(dist3).padStart(4)}     |   ${largest}`,
  );
}

// Show sample clusters that are NEW at 0.25 (i.e. exist at 0.25 but not at 0.40)
console.log('\n=== Sample CROSS-PUBLISHER clusters newly formed at threshold 0.25 (vs 0.40) ===');
const at40 = clusterAtThreshold(cached.candidates, 0.40);
const at25 = clusterAtThreshold(cached.candidates, 0.25);
function clusterKey(c: CandidateURL[]) { return c.map((u) => u.url).sort().join('|'); }
const keys40 = new Set(at40.map(clusterKey));
const new25 = at25.filter((c) => !keys40.has(clusterKey(c)) && new Set(c.map((u) => u.source_id)).size >= 2);
new25.sort((a, b) => b.length - a.length);
for (const c of new25.slice(0, 8)) {
  const sources = [...new Set(c.map((u) => u.source_name))];
  console.log(`  cluster of ${c.length} (${sources.length} distinct: ${sources.join(' + ')})`);
  for (const u of c.slice(0, 4)) console.log(`     · [${u.source_name}] ${u.title.slice(0, 80)}`);
  if (c.length > 4) console.log(`     · (+${c.length - 4} more)`);
}

// And check 0.20 to confirm we're not over-merging
console.log('\n=== Largest clusters at threshold 0.20 (over-merge check) ===');
const at20 = clusterAtThreshold(cached.candidates, 0.20);
const big20 = at20.filter((c) => c.length >= 5).sort((a, b) => b.length - a.length).slice(0, 5);
for (const c of big20) {
  const sources = [...new Set(c.map((u) => u.source_name))];
  console.log(`  ${c.length} URLs across ${sources.length} sources: ${sources.join(' + ')}`);
  for (const u of c.slice(0, 3)) console.log(`     · ${u.title.slice(0, 90)}`);
  if (c.length > 3) console.log(`     · (+${c.length - 3} more)`);
}

console.log('\n=== Largest cluster at 0.30 — inspect for slop ===');
const at30 = clusterAtThreshold(cached.candidates, 0.30);
const big30 = at30.filter((c) => c.length >= 5).sort((a, b) => b.length - a.length).slice(0, 3);
for (const c of big30) {
  const sourceCounts: Record<string, number> = {};
  for (const u of c) sourceCounts[u.source_name] = (sourceCounts[u.source_name] ?? 0) + 1;
  console.log(`  ${c.length} URLs across ${Object.keys(sourceCounts).length} sources: ${JSON.stringify(sourceCounts)}`);
  for (const u of c.slice(0, 4)) console.log(`     · [${u.source_name}] ${u.title.slice(0, 80)}`);
  if (c.length > 4) console.log(`     · (+${c.length - 4} more)`);
}
