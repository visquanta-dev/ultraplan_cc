import fs from 'node:fs';
import path from 'node:path';
import type { TransformedParagraph } from '../stages/voice-transform';
import type { GateParagraphFinding, GateResult } from './types';

// ---------------------------------------------------------------------------
// Gate c — Slop lexicon (spec §6)
// Primary pass: case-insensitive regex scan of every paragraph against
//               config/voice/banned.txt. Zero hits allowed.
//
// Secondary pass (added in a subsequent commit): Claude Opus 4.6 scoring
//               "slop in spirit" on a 1–10 rubric. Catches vague filler
//               and vendor-speak that's not in the regex list.
//
// For now this module only implements the regex primary pass. The LLM
// second pass lands in the next commit.
// ---------------------------------------------------------------------------

const BANNED_PATH = path.join(process.cwd(), 'config', 'voice', 'banned.txt');

let cachedPhrases: string[] | null = null;
let cachedRegexes: RegExp[] | null = null;

/**
 * Load phrases from config/voice/banned.txt, stripping comments and
 * blank lines. Cached so repeated gate runs don't re-read the file.
 */
function loadBannedPhrases(): string[] {
  if (cachedPhrases) return cachedPhrases;
  const raw = fs.readFileSync(BANNED_PATH, 'utf-8');
  cachedPhrases = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  return cachedPhrases;
}

/**
 * Compile one case-insensitive whole-ish-phrase regex per banned phrase.
 * We use word boundaries on the outside only; interior characters are
 * treated literally (hyphens in "AI-driven" must match as-is).
 */
function getBannedRegexes(): RegExp[] {
  if (cachedRegexes) return cachedRegexes;
  const phrases = loadBannedPhrases();
  cachedRegexes = phrases.map((phrase) => {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Loose boundary — phrase can be surrounded by whitespace, punctuation,
    // or string edges. We avoid \b because it fails for hyphenated phrases.
    return new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=[^A-Za-z0-9]|$)`, 'i');
  });
  return cachedRegexes;
}

/**
 * Find every banned phrase that appears in the given text. Returns an
 * array of the ORIGINAL phrase strings that matched (not the regex sources).
 */
export function findBannedMatches(text: string): string[] {
  const regexes = getBannedRegexes();
  const phrases = loadBannedPhrases();
  const matches: string[] = [];
  regexes.forEach((re, i) => {
    if (re.test(text)) {
      matches.push(phrases[i]);
    }
  });
  return matches;
}

/**
 * Run the regex primary pass of gate c over every paragraph. Any
 * paragraph with one or more matches fails. Gate c overall passes only
 * if zero paragraphs have any match.
 */
export async function runSlopLexiconGate(
  paragraphs: TransformedParagraph[],
): Promise<GateResult> {
  const findings: GateParagraphFinding[] = paragraphs.map((para, i) => {
    const matched = findBannedMatches(para.text);
    return {
      paragraph_index: i,
      passed: matched.length === 0,
      matched: matched.length > 0 ? matched : undefined,
      reason:
        matched.length > 0
          ? `contains banned phrase(s): ${matched.join(', ')}`
          : undefined,
    };
  });

  const allPassed = findings.every((f) => f.passed);
  const failingIndices = findings.filter((f) => !f.passed).map((f) => f.paragraph_index);
  const totalMatches = findings.reduce((sum, f) => sum + (f.matched?.length ?? 0), 0);

  return {
    gate: 'slop-lexicon',
    passed: allPassed,
    aggregate_score: totalMatches,
    paragraph_findings: findings,
    summary: allPassed
      ? `0 banned phrase hits across ${paragraphs.length} paragraphs`
      : `${totalMatches} banned phrase hits in ${failingIndices.length} paragraphs`,
    retriable: true,
    failing_paragraph_indices: failingIndices,
  };
}
