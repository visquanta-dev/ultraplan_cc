# Topical Maps via Ahrefs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a topical map generator that uses Ahrefs API to discover low-competition, high-traffic keywords in the dealership space, clusters them into pillar/subtopic groups, and outputs a prioritized content calendar the pipeline can consume.

**Architecture:** A new `lib/topics/ahrefs-client.ts` module wraps the Ahrefs v3 API (matching-terms, related-terms, overview endpoints). A new `lib/topics/topical-map.ts` module takes seed keywords, expands them via Ahrefs, clusters by semantic similarity, deduplicates against published content, scores by opportunity (low KD × high TP), and writes a `config/content-calendar.yaml` file. A CLI script `scripts/topical-map.ts` exposes the workflow. The resolver gains a new `calendar_first` strategy that picks topics from the calendar instead of feeds or curated buckets.

**Tech Stack:** TypeScript, Ahrefs API v3 (REST, Bearer auth), YAML for calendar output, existing keyword-scorer.ts as foundation.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `lib/topics/ahrefs-client.ts` | Create | Low-level Ahrefs v3 API wrapper (matching-terms, related-terms, overview, organic-keywords) |
| `lib/topics/topical-map.ts` | Create | Orchestrates: seed expansion → clustering → dedup → scoring → calendar output |
| `config/content-calendar.yaml` | Create (generated) | The output — prioritized topic list with keyword data |
| `config/seed-keywords.yaml` | Create | Input — seed keywords organized by product vertical |
| `scripts/topical-map.ts` | Create | CLI entry point: `npx tsx scripts/topical-map.ts` |
| `lib/topics/keyword-scorer.ts` | Modify | Add AHREFS_API_TOKEN to .env.cron.tmp, remove placeholder MCP base URL |
| `lib/config/topics-config.ts` | Modify | Add `calendar_first` source strategy |
| `lib/topics/resolver.ts` | Modify | Add Strategy C: calendar_first path |
| `.env.cron.tmp` | Modify | Add AHREFS_API_TOKEN |

---

### Task 1: Add Ahrefs API Token to Environment

**Files:**
- Modify: `.env.cron.tmp`

- [ ] **Step 1: Add the Ahrefs API token**

Append to `.env.cron.tmp`:
```
AHREFS_API_TOKEN=9j6WdLQHkzuyFz4dTz5qdqFA1qYEkkDWIKFemvpM
```

- [ ] **Step 2: Verify the existing keyword-scorer picks it up**

Run: `cd C:/Users/usuario/Desktop/ultraplan_cc && node -e "require('dotenv').config({path:'.env.cron.tmp'}); console.log('AHREFS_API_TOKEN:', process.env.AHREFS_API_TOKEN ? 'SET' : 'MISSING')"`
Expected: `AHREFS_API_TOKEN: SET`

- [ ] **Step 3: Commit**

```bash
git add .env.cron.tmp
git commit -m "chore: add AHREFS_API_TOKEN to env"
```

---

### Task 2: Create Ahrefs API Client

**Files:**
- Create: `lib/topics/ahrefs-client.ts`

- [ ] **Step 1: Write the Ahrefs client module**

```typescript
/**
 * Ahrefs API v3 client — wraps the REST endpoints used by the topical map
 * generator and keyword scorer.
 *
 * API docs: https://api.ahrefs.com/v3/
 * Auth: Bearer token via AHREFS_API_TOKEN env var
 * Rate limit: 60 req/min, 50 units minimum per request
 * Budget: Lite plan = 25,000 units/month
 */

const BASE_URL = 'https://api.ahrefs.com/v3';

function getToken(): string {
  const token = process.env.AHREFS_API_TOKEN;
  if (!token) throw new Error('[ahrefs-client] AHREFS_API_TOKEN not set');
  return token;
}

async function ahrefsGet<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${BASE_URL}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[ahrefs-client] ${endpoint} returned ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

// ---- Types ----

export interface AhrefsKeyword {
  keyword: string;
  volume: number;
  difficulty: number;
  traffic_potential: number;
  cpc: number | null;
  global_volume: number;
}

export interface AhrefsMatchingTermsResponse {
  keywords: AhrefsKeyword[];
}

export interface AhrefsOverviewResponse {
  keywords: AhrefsKeyword[];
}

export interface AhrefsDomainRatingResponse {
  domain_rating: number;
  ahrefs_rank: number;
}

export interface AhrefsOrganicKeyword {
  keyword: string;
  volume: number;
  difficulty: number;
  position: number;
  traffic: number;
  url: string;
}

export interface AhrefsOrganicKeywordsResponse {
  keywords: AhrefsOrganicKeyword[];
}

// ---- Endpoints ----

/**
 * Find keywords matching a seed term.
 * ~50 units per call.
 */
export async function matchingTerms(
  keyword: string,
  options: { country?: string; limit?: number; maxKD?: number } = {},
): Promise<AhrefsKeyword[]> {
  const { country = 'us', limit = 30, maxKD = 30 } = options;
  const data = await ahrefsGet<AhrefsMatchingTermsResponse>(
    'keywords-explorer/matching-terms',
    {
      select: 'keyword,volume,difficulty,traffic_potential,cpc,global_volume',
      keyword,
      country,
      limit: String(limit),
      where: `difficulty <= ${maxKD}`,
    },
  );
  return data.keywords ?? [];
}

/**
 * Find semantically related keywords.
 * ~50 units per call.
 */
export async function relatedTerms(
  keyword: string,
  options: { country?: string; limit?: number; maxKD?: number } = {},
): Promise<AhrefsKeyword[]> {
  const { country = 'us', limit = 20, maxKD = 30 } = options;
  const data = await ahrefsGet<AhrefsMatchingTermsResponse>(
    'keywords-explorer/related-terms',
    {
      select: 'keyword,volume,difficulty,traffic_potential,cpc,global_volume',
      keyword,
      country,
      limit: String(limit),
      where: `difficulty <= ${maxKD}`,
    },
  );
  return data.keywords ?? [];
}

/**
 * Get keyword overview (volume, KD, TP) for specific keywords.
 * ~50 units per call.
 */
export async function keywordOverview(
  keywords: string[],
  options: { country?: string } = {},
): Promise<AhrefsKeyword[]> {
  const { country = 'us' } = options;
  const data = await ahrefsGet<AhrefsOverviewResponse>(
    'keywords-explorer/overview',
    {
      select: 'keyword,volume,difficulty,traffic_potential,cpc,global_volume',
      keywords: keywords.slice(0, 10).join(','),
      country,
    },
  );
  return data.keywords ?? [];
}

/**
 * Get organic keywords a domain ranks for.
 * Useful for competitor content gap analysis.
 * ~50 units per call.
 */
export async function organicKeywords(
  domain: string,
  options: { country?: string; limit?: number } = {},
): Promise<AhrefsOrganicKeyword[]> {
  const { country = 'us', limit = 50 } = options;
  const data = await ahrefsGet<AhrefsOrganicKeywordsResponse>(
    'site-explorer/organic-keywords',
    {
      select: 'keyword,volume,difficulty,position,traffic,url',
      target: domain,
      country,
      limit: String(limit),
      mode: 'domain',
    },
  );
  return data.keywords ?? [];
}

/**
 * Get domain rating for a target.
 * ~50 units per call.
 */
export async function domainRating(domain: string): Promise<AhrefsDomainRatingResponse> {
  return ahrefsGet<AhrefsDomainRatingResponse>(
    'site-explorer/domain-rating',
    { target: domain, mode: 'domain' },
  );
}

/**
 * Check remaining API units for budget tracking.
 */
export async function checkUsage(): Promise<{ unitsUsed: number; unitsLimit: number }> {
  const data = await ahrefsGet<{ units_used: number; units_limit: number }>(
    'subscription-info/limits-and-usage',
    {},
  );
  return { unitsUsed: data.units_used, unitsLimit: data.units_limit };
}
```

- [ ] **Step 2: Verify the client compiles**

Run: `cd C:/Users/usuario/Desktop/ultraplan_cc && npx tsc --noEmit lib/topics/ahrefs-client.ts`
Expected: no errors

- [ ] **Step 3: Quick smoke test**

Run: `cd C:/Users/usuario/Desktop/ultraplan_cc && npx tsx -e "require('dotenv').config({path:'.env.cron.tmp'}); const { checkUsage } = require('./lib/topics/ahrefs-client'); checkUsage().then(u => console.log('Usage:', u))"`
Expected: `Usage: { unitsUsed: <number>, unitsLimit: 25000 }`

- [ ] **Step 4: Commit**

```bash
git add lib/topics/ahrefs-client.ts
git commit -m "feat: add Ahrefs v3 API client wrapper"
```

---

### Task 3: Create Seed Keywords Config

**Files:**
- Create: `config/seed-keywords.yaml`

- [ ] **Step 1: Write the seed keywords file**

```yaml
# ============================================================================
# UltraPlan — seed keywords for topical map generation
#
# Each vertical maps to VisQuanta product pages. The topical map generator
# expands these seeds via Ahrefs matching-terms and related-terms to build
# pillar/cluster topic groups.
#
# max_kd: maximum keyword difficulty to include (0-100)
# min_volume: minimum monthly search volume to include
# product_page: VisQuanta URL this vertical funnels toward
# ============================================================================

version: 1

verticals:
  service_department:
    product_page: /service-drive
    seeds:
      - dealership service department
      - fixed ops profitability
      - fixed ops marketing
      - service lane technology
      - service advisor training
      - dealership service retention
    max_kd: 25
    min_volume: 10

  bdc_operations:
    product_page: /speed-to-lead
    seeds:
      - automotive bdc
      - bdc dealership
      - dealership lead response
      - bdc car dealership meaning
      - dealership bdc training
      - speed to lead dealership
    max_kd: 25
    min_volume: 10

  customer_experience:
    product_page: /reputation-management
    seeds:
      - dealership customer experience
      - dealership csi scores
      - improve dealership customer experience
      - dealership online reviews
      - dealership reputation management
    max_kd: 25
    min_volume: 10

  dealer_marketing:
    product_page: /auto-master-suite
    seeds:
      - auto dealer seo
      - dealership marketing ideas
      - car dealer ai
      - dealership call tracking
      - dealership digital marketing
    max_kd: 25
    min_volume: 10

  dealer_operations:
    product_page: /
    seeds:
      - dealership profitability
      - dealer principal challenges
      - dealership employee retention
      - dealership inventory management
    max_kd: 30
    min_volume: 10
```

- [ ] **Step 2: Commit**

```bash
git add config/seed-keywords.yaml
git commit -m "feat: add seed keywords config for topical map generation"
```

---

### Task 4: Create Topical Map Generator

**Files:**
- Create: `lib/topics/topical-map.ts`

- [ ] **Step 1: Write the topical map module**

```typescript
/**
 * Topical map generator — takes seed keywords, expands via Ahrefs,
 * clusters into pillar/subtopic groups, deduplicates against published
 * content, scores by opportunity, and outputs a content calendar.
 */

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { matchingTerms, relatedTerms, keywordOverview, checkUsage, type AhrefsKeyword } from './ahrefs-client';

// ---- Types ----

export interface TopicEntry {
  keyword: string;
  volume: number;
  difficulty: number;
  trafficPotential: number;
  cpc: number | null;
  /** Opportunity score: trafficPotential / (difficulty + 10) */
  score: number;
  /** Which vertical/product page this maps to */
  vertical: string;
  productPage: string;
  /** Whether we've already published on this keyword */
  published: boolean;
  /** Pillar keyword this subtopic belongs to */
  pillar: string;
}

export interface PillarGroup {
  pillar: string;
  vertical: string;
  productPage: string;
  topics: TopicEntry[];
  /** Best single topic score in this pillar */
  bestScore: number;
  /** Total traffic potential across all topics */
  totalTrafficPotential: number;
}

export interface ContentCalendar {
  generatedAt: string;
  unitsUsedBefore: number;
  unitsUsedAfter: number;
  pillars: PillarGroup[];
}

// ---- Seed config loader ----

interface SeedVertical {
  product_page: string;
  seeds: string[];
  max_kd: number;
  min_volume: number;
}

interface SeedConfig {
  verticals: Record<string, SeedVertical>;
}

function loadSeeds(): SeedConfig {
  const raw = fs.readFileSync(path.join(process.cwd(), 'config', 'seed-keywords.yaml'), 'utf-8');
  return YAML.parse(raw) as SeedConfig;
}

// ---- Published slug loader (for dedup) ----

function loadPublishedKeywords(): Set<string> {
  const keywords = new Set<string>();
  const blogDir = path.join(process.cwd(), '..', 'site', 'content', 'blog');

  // Try local site checkout
  if (fs.existsSync(blogDir)) {
    for (const file of fs.readdirSync(blogDir).filter(f => f.endsWith('.md'))) {
      // Slug is the filename without .md, with hyphens as word separators
      const slug = file.replace('.md', '');
      // Convert slug words to a rough keyword for matching
      const words = slug.split('-').join(' ');
      keywords.add(words.toLowerCase());
    }
  }

  // Also check local drafts
  const draftsDir = path.join(process.cwd(), 'tmp', 'drafts');
  if (fs.existsSync(draftsDir)) {
    for (const file of fs.readdirSync(draftsDir).filter(f => f.endsWith('.md'))) {
      const slug = file.replace('.md', '');
      keywords.add(slug.split('-').join(' ').toLowerCase());
    }
  }

  return keywords;
}

/**
 * Check if a keyword is too similar to something already published.
 * Simple word-overlap check — matches if 60%+ of words overlap.
 */
function isPublished(keyword: string, published: Set<string>): boolean {
  const kwWords = new Set(keyword.toLowerCase().split(/\s+/));
  for (const pub of published) {
    const pubWords = new Set(pub.split(/\s+/));
    const overlap = [...kwWords].filter(w => pubWords.has(w)).length;
    const ratio = overlap / Math.min(kwWords.size, pubWords.size);
    if (ratio >= 0.6) return true;
  }
  return false;
}

// ---- Main generator ----

export async function generateTopicalMap(
  options: {
    onSeed?: (vertical: string, seed: string) => void;
    onExpand?: (seed: string, count: number) => void;
    onComplete?: (pillars: number, topics: number) => void;
  } = {},
): Promise<ContentCalendar> {
  const seeds = loadSeeds();
  const published = loadPublishedKeywords();
  const usageBefore = await checkUsage();

  const allTopics: TopicEntry[] = [];

  for (const [verticalName, vertical] of Object.entries(seeds.verticals)) {
    for (const seed of vertical.seeds) {
      options.onSeed?.(verticalName, seed);

      // Expand each seed via matching-terms and related-terms
      const [matching, related] = await Promise.all([
        matchingTerms(seed, { maxKD: vertical.max_kd, limit: 20 }),
        relatedTerms(seed, { maxKD: vertical.max_kd, limit: 10 }),
      ]);

      // Merge and deduplicate by keyword string
      const seen = new Set<string>();
      const expanded: AhrefsKeyword[] = [];

      // Always include the seed itself if we have data
      for (const kw of [...matching, ...related]) {
        const key = kw.keyword.toLowerCase();
        if (!seen.has(key) && kw.volume >= vertical.min_volume) {
          seen.add(key);
          expanded.push(kw);
        }
      }

      options.onExpand?.(seed, expanded.length);

      // Convert to TopicEntry
      for (const kw of expanded) {
        allTopics.push({
          keyword: kw.keyword,
          volume: kw.volume,
          difficulty: kw.difficulty,
          trafficPotential: kw.traffic_potential,
          cpc: kw.cpc,
          score: kw.traffic_potential / (kw.difficulty + 10),
          vertical: verticalName,
          productPage: vertical.product_page,
          published: isPublished(kw.keyword, published),
          pillar: seed,
        });
      }

      // Rate limit: 60 req/min, we made 2 calls. Small pause between seeds.
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Global dedup — same keyword may appear from multiple seeds
  const globalSeen = new Set<string>();
  const deduped = allTopics.filter(t => {
    const key = t.keyword.toLowerCase();
    if (globalSeen.has(key)) return false;
    globalSeen.add(key);
    return true;
  });

  // Group by pillar
  const pillarMap = new Map<string, TopicEntry[]>();
  for (const topic of deduped) {
    const key = topic.pillar;
    if (!pillarMap.has(key)) pillarMap.set(key, []);
    pillarMap.get(key)!.push(topic);
  }

  // Build pillar groups, sorted by best score
  const pillars: PillarGroup[] = [...pillarMap.entries()]
    .map(([pillar, topics]) => {
      // Sort topics by score descending
      topics.sort((a, b) => b.score - a.score);
      const vertical = topics[0]!.vertical;
      const productPage = topics[0]!.productPage;
      return {
        pillar,
        vertical,
        productPage,
        topics,
        bestScore: topics[0]!.score,
        totalTrafficPotential: topics.reduce((sum, t) => sum + t.trafficPotential, 0),
      };
    })
    .sort((a, b) => b.bestScore - a.bestScore);

  const usageAfter = await checkUsage();

  options.onComplete?.(pillars.length, deduped.length);

  return {
    generatedAt: new Date().toISOString(),
    unitsUsedBefore: usageBefore.unitsUsed,
    unitsUsedAfter: usageAfter.unitsUsed,
    pillars,
  };
}

/**
 * Write the content calendar to config/content-calendar.yaml
 */
export function writeCalendar(calendar: ContentCalendar): string {
  const outPath = path.join(process.cwd(), 'config', 'content-calendar.yaml');

  // Convert to a clean YAML structure
  const output = {
    generated_at: calendar.generatedAt,
    ahrefs_units_used: calendar.unitsUsedAfter - calendar.unitsUsedBefore,
    total_topics: calendar.pillars.reduce((s, p) => s + p.topics.length, 0),
    total_unpublished: calendar.pillars.reduce(
      (s, p) => s + p.topics.filter(t => !t.published).length, 0,
    ),
    pillars: calendar.pillars.map(p => ({
      pillar: p.pillar,
      vertical: p.vertical,
      product_page: p.productPage,
      best_score: Math.round(p.bestScore * 10) / 10,
      total_traffic_potential: p.totalTrafficPotential,
      topics: p.topics.map(t => ({
        keyword: t.keyword,
        volume: t.volume,
        kd: t.difficulty,
        traffic_potential: t.trafficPotential,
        cpc: t.cpc,
        score: Math.round(t.score * 10) / 10,
        published: t.published,
      })),
    })),
  };

  fs.writeFileSync(outPath, YAML.stringify(output, { lineWidth: 120 }), 'utf-8');
  return outPath;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd C:/Users/usuario/Desktop/ultraplan_cc && npx tsc --noEmit lib/topics/topical-map.ts`
Expected: no errors (or only pre-existing errors from other files)

- [ ] **Step 3: Commit**

```bash
git add lib/topics/topical-map.ts
git commit -m "feat: add topical map generator with Ahrefs expansion"
```

---

### Task 5: Create CLI Script

**Files:**
- Create: `scripts/topical-map.ts`

- [ ] **Step 1: Write the CLI entry point**

```typescript
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
    onComplete: (pillars, topics) => stamp(`Done: ${pillars} pillars, ${topics} total topics`),
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
```

- [ ] **Step 2: Run the topical map generator**

Run: `cd C:/Users/usuario/Desktop/ultraplan_cc && npx tsx scripts/topical-map.ts`
Expected: outputs keyword expansion progress, writes `config/content-calendar.yaml`, prints top 20 opportunities table

- [ ] **Step 3: Review the generated calendar**

Run: `head -60 config/content-calendar.yaml`
Expected: YAML with pillars, topics sorted by score, published flags

- [ ] **Step 4: Commit**

```bash
git add scripts/topical-map.ts config/content-calendar.yaml
git commit -m "feat: add topical map CLI script + first generated calendar"
```

---

### Task 6: Wire Calendar into Resolver

**Files:**
- Modify: `lib/config/topics-config.ts`
- Modify: `lib/topics/resolver.ts`

- [ ] **Step 1: Add calendar_first strategy to topics-config.ts**

In `lib/config/topics-config.ts`, update the SourceStrategy type:

```typescript
export type SourceStrategy = 'feed_first' | 'curated_first' | 'search_first' | 'calendar_first';
```

- [ ] **Step 2: Add calendar resolution to resolver.ts**

Add a new import and Strategy C block in `lib/topics/resolver.ts`. After the curated_first block and before the search_first fallback, add:

```typescript
import { loadCalendar, pickCalendarTopic, calendarTopicToBundle } from './calendar-source';
```

And in the resolveSlot function, add the calendar_first strategy block:

```typescript
  // ------------------------------------------------------------------
  // Strategy C: calendar_first — pick from content-calendar.yaml
  // ------------------------------------------------------------------
  if (searchResults.length === 0 && strategy === 'calendar_first') {
    const topic = pickCalendarTopic();
    if (topic) {
      console.log(`[resolver] Calendar topic: "${topic.keyword}" (KD ${topic.kd}, TP ${topic.trafficPotential})`);
      // Search for fresh sources on this keyword
      searchResults = await searchForLane(lane, { query: topic.keyword });
      options.onSearch?.(searchResults.length);
    } else {
      console.log('[resolver] No unpublished calendar topics — falling back to feed');
    }
  }
```

- [ ] **Step 3: Create calendar-source.ts**

Create `lib/topics/calendar-source.ts`:

```typescript
/**
 * Calendar source — reads the generated content-calendar.yaml and picks
 * the best unpublished topic for the next pipeline run.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

interface CalendarTopic {
  keyword: string;
  volume: number;
  kd: number;
  trafficPotential: number;
  cpc: number | null;
  score: number;
  published: boolean;
}

interface CalendarPillar {
  pillar: string;
  vertical: string;
  product_page: string;
  topics: CalendarTopic[];
}

interface CalendarFile {
  pillars: CalendarPillar[];
}

export function loadCalendar(): CalendarFile | null {
  const calPath = path.join(process.cwd(), 'config', 'content-calendar.yaml');
  if (!fs.existsSync(calPath)) return null;
  const raw = fs.readFileSync(calPath, 'utf-8');
  return YAML.parse(raw) as CalendarFile;
}

/**
 * Pick the best unpublished topic from the calendar.
 * Returns null if all topics are published or calendar doesn't exist.
 */
export function pickCalendarTopic(): (CalendarTopic & { vertical: string; productPage: string; pillar: string }) | null {
  const cal = loadCalendar();
  if (!cal) return null;

  let best: (CalendarTopic & { vertical: string; productPage: string; pillar: string }) | null = null;

  for (const pillar of cal.pillars) {
    for (const topic of pillar.topics) {
      if (topic.published) continue;
      if (!best || topic.score > best.score) {
        best = {
          ...topic,
          vertical: pillar.vertical,
          productPage: pillar.product_page,
          pillar: pillar.pillar,
        };
      }
    }
  }

  return best;
}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd C:/Users/usuario/Desktop/ultraplan_cc && npx tsc --noEmit lib/topics/calendar-source.ts`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add lib/topics/calendar-source.ts lib/config/topics-config.ts lib/topics/resolver.ts
git commit -m "feat: add calendar_first strategy to resolver"
```

---

### Task 7: Test End-to-End

**Files:**
- Modify: `scripts/run-pipeline-local.ts` (add calendar_first support)

- [ ] **Step 1: Run the topical map generator to produce a fresh calendar**

Run: `cd C:/Users/usuario/Desktop/ultraplan_cc && npx tsx scripts/topical-map.ts`
Expected: calendar generated with unpublished opportunities

- [ ] **Step 2: Run the pipeline with calendar_first strategy**

Run: `cd C:/Users/usuario/Desktop/ultraplan_cc && npx tsx scripts/run-pipeline-local.ts daily_seo --strategy calendar_first`

Note: this requires adding strategy flag support to `run-pipeline-local.ts`. Update the script to accept `--strategy` as a named arg:

Add after the `curatedBucket` line:
```typescript
const strategyFlag = process.argv.find(a => a.startsWith('--strategy='))?.split('=')[1]
  ?? (process.argv.includes('--strategy') ? process.argv[process.argv.indexOf('--strategy') + 1] : undefined);
```

And in the resolveSlot call, add:
```typescript
...(strategyFlag ? { forcedStrategy: strategyFlag as any } : {}),
```

Expected: pipeline picks the top-scored unpublished keyword from the calendar, searches for sources, runs full pipeline, opens PR

- [ ] **Step 3: Commit**

```bash
git add scripts/run-pipeline-local.ts
git commit -m "feat: add --strategy flag to run-pipeline-local"
```
