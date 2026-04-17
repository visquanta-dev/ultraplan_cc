// ---------------------------------------------------------------------------
// Topical map generator — expands seed keywords via Ahrefs, clusters into
// pillar/subtopic groups, deduplicates against published content, scores by
// opportunity, and writes a content calendar YAML file.
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import {
  matchingTerms,
  relatedTerms,
  checkUsage,
  type AhrefsKeyword,
} from './ahrefs-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TopicEntry {
  keyword: string;
  volume: number;
  difficulty: number;
  trafficPotential: number;
  cpc: number | null;
  score: number; // trafficPotential / (difficulty + 10)
  vertical: string;
  productPage: string;
  published: boolean;
  pillar: string; // the seed keyword this was expanded from
}

export interface PillarGroup {
  pillar: string;
  vertical: string;
  productPage: string;
  topics: TopicEntry[]; // sorted by score descending
  bestScore: number;
  totalTrafficPotential: number;
}

export interface ContentCalendar {
  generatedAt: string;
  unitsUsedBefore: number;
  unitsUsedAfter: number;
  pillars: PillarGroup[]; // sorted by bestScore descending
}

interface SeedKeywordsConfig {
  version: number;
  verticals: Record<
    string,
    {
      product_page: string;
      seeds: string[];
      max_kd: number;
      min_volume: number;
    }
  >;
}

export interface GenerateOptions {
  onSeed?: (vertical: string, seed: string) => void;
  onExpand?: (seed: string, count: number) => void;
  onComplete?: (pillars: PillarGroup[], topics: TopicEntry[]) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..', '..');

function slugToWords(slug: string): Set<string> {
  return new Set(
    slug
      .replace(/\.md$/, '')
      .split(/[-_]+/)
      .map((w) => w.toLowerCase())
      .filter(Boolean),
  );
}

function loadPublishedSlugs(): Set<string>[] {
  const slugSets: Set<string>[] = [];

  const blogDir = path.resolve(ROOT, '..', 'site', 'content', 'blog');
  const draftsDir = path.resolve(ROOT, 'tmp', 'drafts');

  for (const dir of [blogDir, draftsDir]) {
    try {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
        for (const file of files) {
          slugSets.push(slugToWords(file));
        }
      }
    } catch {
      // directory doesn't exist or isn't readable — skip gracefully
    }
  }

  return slugSets;
}

function isPublished(keyword: string, slugSets: Set<string>[]): boolean {
  const kwWords = keyword
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (kwWords.length === 0) return false;

  for (const slugWords of slugSets) {
    let overlap = 0;
    for (const w of kwWords) {
      if (slugWords.has(w)) overlap++;
    }
    if (overlap / kwWords.length >= 0.6) return true;
  }

  return false;
}

function toTopicEntry(
  kw: AhrefsKeyword,
  vertical: string,
  productPage: string,
  pillar: string,
  published: boolean,
): TopicEntry {
  const volume = kw.volume ?? 0;
  const difficulty = kw.difficulty ?? 0;
  const trafficPotential = kw.traffic_potential ?? 0;
  const score = trafficPotential / (difficulty + 10);

  return {
    keyword: kw.keyword,
    volume,
    difficulty,
    trafficPotential,
    cpc: kw.cpc,
    score: Math.round(score * 100) / 100,
    vertical,
    productPage,
    published,
    pillar,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

export async function generateTopicalMap(
  options: GenerateOptions = {},
): Promise<ContentCalendar> {
  // Load seed keywords config
  const configPath = path.resolve(ROOT, 'config', 'seed-keywords.yaml');
  const raw = fs.readFileSync(configPath, 'utf-8');
  const config = YAML.parse(raw) as SeedKeywordsConfig;

  // Check Ahrefs usage before starting
  const usageBefore = await checkUsage();

  // Load published slugs for dedup
  const slugSets = loadPublishedSlugs();

  // Collect all topics across verticals
  const allTopics: TopicEntry[] = [];

  for (const [verticalName, vertical] of Object.entries(config.verticals)) {
    for (let i = 0; i < vertical.seeds.length; i++) {
      const seed = vertical.seeds[i];

      options.onSeed?.(verticalName, seed);

      // Expand via Ahrefs — matching and related in parallel
      const [matchRes, relatedRes] = await Promise.all([
        matchingTerms(seed, { maxKD: vertical.max_kd, limit: 20 }),
        relatedTerms(seed, { maxKD: vertical.max_kd, limit: 10 }),
      ]);

      // Merge and deduplicate by keyword (case-insensitive)
      const seen = new Set<string>();
      const merged: AhrefsKeyword[] = [];

      for (const kw of [...matchRes.keywords, ...relatedRes.keywords]) {
        const lower = kw.keyword.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        merged.push(kw);
      }

      // Filter by min_volume
      const filtered = merged.filter(
        (kw) => (kw.volume ?? 0) >= vertical.min_volume,
      );

      options.onExpand?.(seed, filtered.length);

      // Convert to TopicEntry
      for (const kw of filtered) {
        const published = isPublished(kw.keyword, slugSets);
        allTopics.push(
          toTopicEntry(kw, verticalName, vertical.product_page, seed, published),
        );
      }

      // Rate limiting delay between seeds (skip after last seed)
      if (i < vertical.seeds.length - 1) {
        await delay(500);
      }
    }

    // Also delay between verticals
    await delay(500);
  }

  // Global dedup — keep highest-scoring entry for each keyword
  const globalMap = new Map<string, TopicEntry>();
  for (const topic of allTopics) {
    const lower = topic.keyword.toLowerCase();
    const existing = globalMap.get(lower);
    if (!existing || topic.score > existing.score) {
      globalMap.set(lower, topic);
    }
  }
  const dedupedTopics = Array.from(globalMap.values());

  // Group by pillar
  const pillarMap = new Map<string, TopicEntry[]>();
  for (const topic of dedupedTopics) {
    const key = topic.pillar;
    if (!pillarMap.has(key)) pillarMap.set(key, []);
    pillarMap.get(key)!.push(topic);
  }

  // Build PillarGroup array
  const pillars: PillarGroup[] = [];
  for (const [pillar, topics] of pillarMap) {
    // Sort topics by score descending
    topics.sort((a, b) => b.score - a.score);

    const first = topics[0];
    pillars.push({
      pillar,
      vertical: first.vertical,
      productPage: first.productPage,
      topics,
      bestScore: topics[0].score,
      totalTrafficPotential: topics.reduce(
        (sum, t) => sum + t.trafficPotential,
        0,
      ),
    });
  }

  // Sort pillars by bestScore descending
  pillars.sort((a, b) => b.bestScore - a.bestScore);

  // Check usage after
  const usageAfter = await checkUsage();

  const calendar: ContentCalendar = {
    generatedAt: new Date().toISOString(),
    unitsUsedBefore: usageBefore.unitsUsed,
    unitsUsedAfter: usageAfter.unitsUsed,
    pillars,
  };

  options.onComplete?.(pillars, dedupedTopics);

  return calendar;
}

// ---------------------------------------------------------------------------
// Write calendar to YAML
// ---------------------------------------------------------------------------

export function writeCalendar(calendar: ContentCalendar): string {
  const allTopics = calendar.pillars.flatMap((p) => p.topics);
  const unpublished = allTopics.filter((t) => !t.published);

  const output = {
    generated_at: calendar.generatedAt,
    ahrefs_units_used: calendar.unitsUsedAfter - calendar.unitsUsedBefore,
    total_topics: allTopics.length,
    total_unpublished: unpublished.length,
    pillars: calendar.pillars.map((pg) => ({
      pillar: pg.pillar,
      vertical: pg.vertical,
      product_page: pg.productPage,
      best_score: pg.bestScore,
      total_traffic_potential: pg.totalTrafficPotential,
      topics: pg.topics.map((t) => ({
        keyword: t.keyword,
        volume: t.volume,
        kd: t.difficulty,
        traffic_potential: t.trafficPotential,
        cpc: t.cpc,
        score: t.score,
        published: t.published,
      })),
    })),
  };

  const yamlStr = YAML.stringify(output, { lineWidth: 0 });
  const outPath = path.resolve(ROOT, 'config', 'content-calendar.yaml');
  fs.writeFileSync(outPath, yamlStr, 'utf-8');

  return outPath;
}
