import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { TransformedParagraph } from '../stages/voice-transform';
import type { GateParagraphFinding, GateResult } from './types';

// ---------------------------------------------------------------------------
// Gate e — Anonymization (spec §6)
// Case-insensitive substring match of every client name variant against
// the full draft body + headline/meta. Zero hits allowed, no exceptions.
// retriable=false — anonymization leaks are unrecoverable.
// ---------------------------------------------------------------------------

const BLOCKLIST_PATH = path.join(process.cwd(), 'config', 'clients_blocklist.yaml');

interface BlocklistEntry {
  name: string;
  variants: string[];
}

interface Blocklist {
  dealers: BlocklistEntry[];
  other_clients: BlocklistEntry[];
}

let cachedVariants: string[] | null = null;

/**
 * Load all client name variants from the blocklist YAML.
 * Cached after first load.
 */
function loadBlocklistVariants(): string[] {
  if (cachedVariants) return cachedVariants;
  const raw = fs.readFileSync(BLOCKLIST_PATH, 'utf-8');
  const parsed = YAML.parse(raw) as Blocklist;

  const variants: string[] = [];
  for (const group of [parsed.dealers, parsed.other_clients]) {
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      if (Array.isArray(entry.variants)) {
        variants.push(...entry.variants);
      }
    }
  }

  cachedVariants = variants;
  return cachedVariants;
}

/**
 * Find all client name variants that appear in the given text.
 * Case-insensitive substring match per the enforcement config.
 */
export function findClientNameMatches(text: string): string[] {
  const variants = loadBlocklistVariants();
  const lower = text.toLowerCase();
  return variants.filter((v) => lower.includes(v.toLowerCase()));
}

/**
 * Run gate e against the draft paragraphs and optional headline/meta.
 * Any match → immediate failure, retriable=false.
 */
export async function runAnonymizationGate(
  paragraphs: TransformedParagraph[],
  headlineAndMeta?: { title: string; metaDescription: string },
): Promise<GateResult> {
  const findings: GateParagraphFinding[] = paragraphs.map((para, i) => {
    const matched = findClientNameMatches(para.text);
    return {
      paragraph_index: i,
      passed: matched.length === 0,
      matched: matched.length > 0 ? matched : undefined,
      reason:
        matched.length > 0
          ? `client name leak: ${matched.join(', ')}`
          : undefined,
    };
  });

  // Also scan headline and meta description if provided
  const metaMatches: string[] = [];
  if (headlineAndMeta) {
    metaMatches.push(
      ...findClientNameMatches(headlineAndMeta.title),
      ...findClientNameMatches(headlineAndMeta.metaDescription),
    );
  }

  const bodyLeaks = findings.filter((f) => !f.passed);
  const totalLeaks = bodyLeaks.length + (metaMatches.length > 0 ? 1 : 0);
  const allPassed = totalLeaks === 0;

  const allMatched = [
    ...bodyLeaks.flatMap((f) => f.matched ?? []),
    ...metaMatches,
  ];
  const uniqueMatched = [...new Set(allMatched)];

  const summary = allPassed
    ? `0 client name leaks across ${paragraphs.length} paragraphs + meta`
    : `${uniqueMatched.length} client name(s) leaked: ${uniqueMatched.join(', ')}`;

  return {
    gate: 'anonymization',
    passed: allPassed,
    paragraph_findings: findings,
    summary,
    retriable: false, // spec §6: anonymization leaks are unrecoverable
    failing_paragraph_indices: findings
      .filter((f) => !f.passed)
      .map((f) => f.paragraph_index),
  };
}
