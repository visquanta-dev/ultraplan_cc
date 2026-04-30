// ---------------------------------------------------------------------------
// Topic blocklist — resolver-level kill list (2026-04-30)
//
// Reads config/topic_blocklist.yaml and rejects clusters whose representative
// title (or saturated share of URL titles) contains a blocked variant.
//
// Sits BEFORE dedup in resolveSlot — blocked topics never reach the dedup
// gate, so they don't consume retry budget and don't surface as "rejected
// for keyword overlap" in logs.
//
// For client-name leaks at draft time, see lib/gates/anonymization.ts +
// config/clients_blocklist.yaml. Different layer, different concern.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import type { TopicCluster } from './cluster';

interface BlockedTerm {
  term: string;
  reason: string;
  variants: string[];
}

interface TopicBlocklist {
  version: number;
  blocked_terms: BlockedTerm[];
  enforcement: {
    match_mode: 'case_insensitive_token';
    reject_on_rep_title: boolean;
    url_title_saturation_pct: number;
  };
}

let cached: TopicBlocklist | null = null;

export function loadTopicBlocklist(configPath?: string): TopicBlocklist {
  if (cached && !configPath) return cached;
  const file = configPath ?? path.join(process.cwd(), 'config', 'topic_blocklist.yaml');
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = yaml.parse(raw) as TopicBlocklist;
  if (!configPath) cached = parsed;
  return parsed;
}

// Whole-word token match. Splits the haystack on non-alphanumerics, lowercases
// both sides, checks for an exact token match against the variant. This stops
// the Spanish word "nada" inside body copy or the substring "nada" inside
// "Granada" from triggering a NADA acronym block.
function tokenMatch(haystack: string, variant: string): boolean {
  const tokens = haystack.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const variantTokens = variant.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (variantTokens.length === 0) return false;
  // Look for variantTokens as a contiguous run inside tokens.
  for (let i = 0; i <= tokens.length - variantTokens.length; i++) {
    let ok = true;
    for (let j = 0; j < variantTokens.length; j++) {
      if (tokens[i + j] !== variantTokens[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

interface ClusterLike {
  label?: string;
  representative_title?: string;
  urls?: { title: string }[];
}

export interface BlockedClusterReason {
  cluster_label: string;
  matched_term: string;
  matched_variant: string;
  match_kind: 'rep_title' | 'url_saturation';
  saturation_pct?: number;
}

/**
 * Filter clusters against the topic blocklist.
 *
 * Accepts either competitor-signal `TopicCluster` (has `representative_title`
 * + `urls[]`) or legacy `TopicCluster` (has `label` + `urls[]`). Both shapes
 * are walked; whichever one is populated is used for matching.
 */
export function filterBlockedTopics<T extends ClusterLike>(
  clusters: T[],
  blocklistOverride?: TopicBlocklist,
): { kept: T[]; rejected: { cluster: T; reason: BlockedClusterReason }[] } {
  const blocklist = blocklistOverride ?? loadTopicBlocklist();
  const kept: T[] = [];
  const rejected: { cluster: T; reason: BlockedClusterReason }[] = [];

  for (const cluster of clusters) {
    const repTitle = cluster.representative_title ?? cluster.label ?? '';
    const urlTitles = cluster.urls?.map((u) => u.title) ?? [];
    let blockReason: BlockedClusterReason | null = null;

    outer: for (const blocked of blocklist.blocked_terms) {
      for (const variant of blocked.variants) {
        if (blocklist.enforcement.reject_on_rep_title && tokenMatch(repTitle, variant)) {
          blockReason = {
            cluster_label: repTitle,
            matched_term: blocked.term,
            matched_variant: variant,
            match_kind: 'rep_title',
          };
          break outer;
        }

        if (urlTitles.length > 0) {
          const matchCount = urlTitles.filter((t) => tokenMatch(t, variant)).length;
          const pct = (matchCount / urlTitles.length) * 100;
          if (pct >= blocklist.enforcement.url_title_saturation_pct) {
            blockReason = {
              cluster_label: repTitle,
              matched_term: blocked.term,
              matched_variant: variant,
              match_kind: 'url_saturation',
              saturation_pct: Math.round(pct),
            };
            break outer;
          }
        }
      }
    }

    if (blockReason) {
      rejected.push({ cluster, reason: blockReason });
    } else {
      kept.push(cluster);
    }
  }

  return { kept, rejected };
}

// Test seam — pure function exposed so the smoke script can call it
// without disk I/O.
export const __test = { tokenMatch };
