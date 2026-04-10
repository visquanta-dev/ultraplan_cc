import fs from 'node:fs';
import path from 'node:path';
import type { TransformedParagraph } from '../stages/voice-transform';
import type { GateParagraphFinding, GateResult } from './types';
import { callLLMStructured, MODELS } from '../llm/openrouter';

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

// ---------------------------------------------------------------------------
// Slop-in-spirit LLM second pass
// ---------------------------------------------------------------------------

const SLOP_IN_SPIRIT_PROMPT_PATH = path.join(
  process.cwd(),
  'workflows',
  'blog-pipeline',
  'prompts',
  'gates',
  'slop-in-spirit.md',
);
const MIN_SLOP_SCORE = 8;

interface SlopInSpiritResponse {
  score: number;
  reasons: string[];
  worst_paragraph_indices: number[];
}

const SLOP_IN_SPIRIT_SCHEMA = {
  type: 'object',
  required: ['score', 'reasons', 'worst_paragraph_indices'],
  properties: {
    score: { type: 'integer', minimum: 1, maximum: 10 },
    reasons: { type: 'array', items: { type: 'string' } },
    worst_paragraph_indices: { type: 'array', items: { type: 'integer', minimum: 0 } },
  },
};

/**
 * Call Claude Opus 4.6 to score the post's "slop in spirit" on 1–10.
 * Minimum passing score is 8 per spec §6.
 */
async function runSlopInSpiritPass(
  paragraphs: TransformedParagraph[],
): Promise<SlopInSpiritResponse> {
  const system = fs.readFileSync(SLOP_IN_SPIRIT_PROMPT_PATH, 'utf-8');
  const numberedBody = paragraphs
    .map((p, i) => `### Paragraph ${i}\n\n${p.text}`)
    .join('\n\n');

  return await callLLMStructured<SlopInSpiritResponse>({
    system,
    user: numberedBody,
    schema: SLOP_IN_SPIRIT_SCHEMA,
    model: MODELS.DRAFTER,
    maxTokens: 2048,
    temperature: 0.2,
    parse: (raw: unknown): SlopInSpiritResponse => {
      if (!raw || typeof raw !== 'object') {
        throw new Error('[slop-in-spirit] response was not an object');
      }
      const obj = raw as Record<string, unknown>;
      if (typeof obj.score !== 'number' || !Number.isInteger(obj.score) || obj.score < 1 || obj.score > 10) {
        throw new Error('[slop-in-spirit] score must be an integer 1-10');
      }
      const reasons = Array.isArray(obj.reasons) ? obj.reasons.filter((r): r is string => typeof r === 'string') : [];
      const worst = Array.isArray(obj.worst_paragraph_indices)
        ? obj.worst_paragraph_indices.filter((i): i is number => typeof i === 'number' && Number.isInteger(i) && i >= 0)
        : [];
      return { score: obj.score, reasons, worst_paragraph_indices: worst };
    },
  });
}

/**
 * Run gate c: regex primary pass + slop-in-spirit LLM second pass.
 * Gate passes if BOTH:
 *   (1) zero banned phrase hits across all paragraphs
 *   (2) slop-in-spirit score >= 8
 */
export async function runSlopLexiconGate(
  paragraphs: TransformedParagraph[],
): Promise<GateResult> {
  // Regex primary pass
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

  const regexPassed = findings.every((f) => f.passed);
  const totalMatches = findings.reduce((sum, f) => sum + (f.matched?.length ?? 0), 0);

  // LLM second pass — only run if the regex pass caught nothing, or run
  // anyway to get diagnostic info? Per spec §6, both must pass. We run it
  // unconditionally so a gate-fail report has complete information about
  // both dimensions.
  const spirit = await runSlopInSpiritPass(paragraphs);

  // Mark LLM-worst paragraphs as failed if the score is below threshold
  if (spirit.score < MIN_SLOP_SCORE) {
    for (const idx of spirit.worst_paragraph_indices) {
      if (idx >= 0 && idx < findings.length) {
        findings[idx].passed = false;
        findings[idx].reason = findings[idx].reason
          ? `${findings[idx].reason}; slop-in-spirit target (score ${spirit.score}/10)`
          : `slop-in-spirit target (score ${spirit.score}/10)`;
      }
    }
  }

  const spiritPassed = spirit.score >= MIN_SLOP_SCORE;
  const allPassed = regexPassed && spiritPassed;
  const failingIndices = findings.filter((f) => !f.passed).map((f) => f.paragraph_index);

  let summary: string;
  if (allPassed) {
    summary = `regex: 0 hits across ${paragraphs.length} paragraphs | slop-in-spirit: ${spirit.score}/10`;
  } else if (!regexPassed && !spiritPassed) {
    summary = `regex: ${totalMatches} banned phrase hits in ${failingIndices.length} paragraphs | slop-in-spirit: ${spirit.score}/10 (< ${MIN_SLOP_SCORE}). Reasons: ${spirit.reasons.slice(0, 3).join('; ')}`;
  } else if (!regexPassed) {
    summary = `regex: ${totalMatches} banned phrase hits in ${failingIndices.length} paragraphs | slop-in-spirit: ${spirit.score}/10 OK`;
  } else {
    summary = `regex: 0 hits OK | slop-in-spirit: ${spirit.score}/10 (< ${MIN_SLOP_SCORE}). Reasons: ${spirit.reasons.slice(0, 3).join('; ')}`;
  }

  return {
    gate: 'slop-lexicon',
    passed: allPassed,
    aggregate_score: spirit.score,
    paragraph_findings: findings,
    summary,
    retriable: true,
    failing_paragraph_indices: failingIndices,
  };
}
