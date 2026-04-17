import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

// ---------------------------------------------------------------------------
// topics.yaml loader — single source of truth for lane config
//
// Before this module existed, word counts and cadence were duplicated across:
//   - config/topics.yaml   (documentation, nothing read it)
//   - app/api/cron/trigger/route.ts     (real cron word counts)
//   - scripts/run-pipeline-local.ts     (local dev word counts)
//   - lib/topics/resolver.ts            (source_strategy)
//
// The three code paths drifted: topics.yaml said daily_seo 1000-1400 words
// but the cron shipped 1800-2200. This loader makes topics.yaml the
// authoritative source — every consumer imports from here, no hardcoded
// word counts anywhere else.
// ---------------------------------------------------------------------------

export type Lane = 'daily_seo' | 'weekly_authority' | 'monthly_anonymized_case' | 'listicle';

export type SourceStrategy = 'feed_first' | 'curated_first' | 'search_first' | 'calendar_first';

export interface LaneConfig {
  cadence: string;
  funnel_target: string;
  source_strategy: SourceStrategy;
  word_count: { min: number; max: number };
}

interface TopicsYaml {
  version: string;
  timezone: string;
  lanes: Record<Lane, LaneConfig>;
}

let cached: TopicsYaml | null = null;

function load(): TopicsYaml {
  if (cached) return cached;
  const raw = fs.readFileSync(path.join(process.cwd(), 'config', 'topics.yaml'), 'utf-8');
  cached = YAML.parse(raw) as TopicsYaml;
  return cached;
}

export function getLaneConfig(lane: Lane): LaneConfig {
  const cfg = load();
  const lc = cfg.lanes[lane];
  if (!lc) throw new Error(`[topics-config] unknown lane: ${lane}`);
  return lc;
}

export function getLaneWordCount(lane: Lane): { min: number; max: number } {
  return getLaneConfig(lane).word_count;
}

export function getLaneStrategy(lane: Lane): SourceStrategy {
  return getLaneConfig(lane).source_strategy ?? 'curated_first';
}

export function getTimezone(): string {
  return load().timezone ?? 'America/Chicago';
}
