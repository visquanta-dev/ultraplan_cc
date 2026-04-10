import type { Bundle } from '../bundle/types';
import type { TransformedParagraph } from '../stages/voice-transform';
import type { GateParagraphFinding, GateResult } from './types';
import { callLLMStructured, MODELS } from '../llm/openrouter';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Gate d — Originality (spec §6)
// Primary pass: n-gram overlap check. For each paragraph, compute the
//   fraction of its 5-grams that appear verbatim in any single source's
//   quotes. Threshold: <20% overlap with any single source.
//
// Secondary pass: GPT-5 judge scores "creative distance" 1–10. Catches
//   cases where the LLM restructured source sentences without adding
//   analytical value. Minimum passing score: 7.
// ---------------------------------------------------------------------------

const MAX_OVERLAP = 0.20; // 20% of paragraph n-grams matching one source
const NGRAM_SIZE = 5;
const MIN_ORIGINALITY_SCORE = 7;

/**
 * Tokenize text into lowercase words, stripping punctuation.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/**
 * Extract all n-grams of the given size from a token array.
 * Returns a Set of space-joined n-gram strings for fast lookup.
 */
function extractNgrams(tokens: string[], n: number): Set<string> {
  const ngrams = new Set<string>();
  for (let i = 0; i <= tokens.length - n; i++) {
    ngrams.add(tokens.slice(i, i + n).join(' '));
  }
  return ngrams;
}

/**
 * Compute the maximum n-gram overlap ratio between a single paragraph
 * and any single source in the bundle.
 *
 * For each source, concatenates all quote texts and compares 5-grams.
 * Returns the worst (highest) overlap and which source caused it.
 */
export function computeMaxOverlap(
  paragraphText: string,
  bundle: Bundle,
): { maxOverlap: number; worstSourceId: string | null } {
  const paraTokens = tokenize(paragraphText);
  if (paraTokens.length < NGRAM_SIZE) {
    return { maxOverlap: 0, worstSourceId: null };
  }

  const paraNgrams = extractNgrams(paraTokens, NGRAM_SIZE);
  const paraTotal = paraNgrams.size;
  if (paraTotal === 0) {
    return { maxOverlap: 0, worstSourceId: null };
  }

  let maxOverlap = 0;
  let worstSourceId: string | null = null;

  for (const source of bundle.sources) {
    const sourceText = source.quotes.map((q) => q.text).join(' ');
    const sourceTokens = tokenize(sourceText);
    const sourceNgrams = extractNgrams(sourceTokens, NGRAM_SIZE);

    let matched = 0;
    for (const ng of paraNgrams) {
      if (sourceNgrams.has(ng)) matched++;
    }

    const overlap = matched / paraTotal;
    if (overlap > maxOverlap) {
      maxOverlap = overlap;
      worstSourceId = source.source_id;
    }
  }

  return { maxOverlap, worstSourceId };
}

// ---------------------------------------------------------------------------
// GPT-5 originality judge (second pass)
// ---------------------------------------------------------------------------

const ORIGINALITY_PROMPT_PATH = path.join(
  process.cwd(),
  'workflows',
  'blog-pipeline',
  'prompts',
  'gates',
  'originality-judge.md',
);

interface OriginalityJudgeResponse {
  score: number;
  reasons: string[];
  worst_paragraph_indices: number[];
}

const ORIGINALITY_SCHEMA = {
  type: 'object',
  required: ['score', 'reasons', 'worst_paragraph_indices'],
  properties: {
    score: { type: 'integer', minimum: 1, maximum: 10 },
    reasons: { type: 'array', items: { type: 'string' } },
    worst_paragraph_indices: { type: 'array', items: { type: 'integer', minimum: 0 } },
  },
};

/**
 * GPT-5 scores the draft's "creative distance" from source material.
 * Are paragraphs just rearranged quotes, or does the author add analysis?
 */
async function runOriginalityJudge(
  paragraphs: TransformedParagraph[],
  bundle: Bundle,
): Promise<OriginalityJudgeResponse> {
  const system = fs.readFileSync(ORIGINALITY_PROMPT_PATH, 'utf-8');

  const sourceQuotes = bundle.sources
    .map(
      (s) =>
        `### Source: ${s.domain} (${s.source_id})\n${s.quotes.map((q) => `- "${q.text}"`).join('\n')}`,
    )
    .join('\n\n');

  const numberedBody = paragraphs
    .map((p, i) => `### Paragraph ${i}\n\n${p.text}`)
    .join('\n\n');

  const user = `## Source Quotes\n\n${sourceQuotes}\n\n---\n\n## Draft Paragraphs\n\n${numberedBody}`;

  return await callLLMStructured<OriginalityJudgeResponse>({
    system,
    user,
    schema: ORIGINALITY_SCHEMA,
    model: MODELS.JUDGE,
    maxTokens: 2048,
    temperature: 0.2,
    parse: (raw: unknown): OriginalityJudgeResponse => {
      if (!raw || typeof raw !== 'object') {
        throw new Error('[originality-judge] response was not an object');
      }
      const obj = raw as Record<string, unknown>;
      if (typeof obj.score !== 'number' || !Number.isInteger(obj.score) || obj.score < 1 || obj.score > 10) {
        throw new Error('[originality-judge] score must be an integer 1-10');
      }
      const reasons = Array.isArray(obj.reasons)
        ? obj.reasons.filter((r): r is string => typeof r === 'string')
        : [];
      const worst = Array.isArray(obj.worst_paragraph_indices)
        ? obj.worst_paragraph_indices.filter((i): i is number => typeof i === 'number' && Number.isInteger(i) && i >= 0)
        : [];
      return { score: obj.score, reasons, worst_paragraph_indices: worst };
    },
  });
}

// ---------------------------------------------------------------------------
// Gate d entry point
// ---------------------------------------------------------------------------

/**
 * Run gate d: n-gram overlap primary pass + GPT-5 originality judge.
 * Gate passes if BOTH:
 *   (1) no paragraph exceeds 20% n-gram overlap with any single source
 *   (2) GPT-5 originality score >= 7
 */
export async function runOriginalityGate(
  paragraphs: TransformedParagraph[],
  bundle: Bundle,
): Promise<GateResult> {
  // N-gram primary pass
  const findings: GateParagraphFinding[] = paragraphs.map((para, i) => {
    const { maxOverlap, worstSourceId } = computeMaxOverlap(para.text, bundle);
    const passed = maxOverlap < MAX_OVERLAP;
    return {
      paragraph_index: i,
      passed,
      score: Math.round(maxOverlap * 100),
      reason: !passed
        ? `${Math.round(maxOverlap * 100)}% n-gram overlap with ${worstSourceId}`
        : undefined,
    };
  });

  const ngramPassed = findings.every((f) => f.passed);
  const worstOverlap = Math.max(...findings.map((f) => f.score ?? 0));

  // GPT-5 originality judge — run unconditionally for full diagnostics
  const judge = await runOriginalityJudge(paragraphs, bundle);

  // Mark judge-flagged paragraphs
  if (judge.score < MIN_ORIGINALITY_SCORE) {
    for (const idx of judge.worst_paragraph_indices) {
      if (idx >= 0 && idx < findings.length) {
        findings[idx].passed = false;
        findings[idx].reason = findings[idx].reason
          ? `${findings[idx].reason}; originality judge target (score ${judge.score}/10)`
          : `originality judge target (score ${judge.score}/10)`;
      }
    }
  }

  const judgePassed = judge.score >= MIN_ORIGINALITY_SCORE;
  const allPassed = ngramPassed && judgePassed;
  const failingIndices = findings.filter((f) => !f.passed).map((f) => f.paragraph_index);

  let summary: string;
  if (allPassed) {
    summary = `n-gram: worst ${worstOverlap}% (< ${MAX_OVERLAP * 100}%) | originality judge: ${judge.score}/10`;
  } else if (!ngramPassed && !judgePassed) {
    summary = `n-gram: worst ${worstOverlap}% (>= ${MAX_OVERLAP * 100}%) | originality judge: ${judge.score}/10 (< ${MIN_ORIGINALITY_SCORE}). ${judge.reasons.slice(0, 3).join('; ')}`;
  } else if (!ngramPassed) {
    summary = `n-gram: worst ${worstOverlap}% (>= ${MAX_OVERLAP * 100}%) | originality judge: ${judge.score}/10 OK`;
  } else {
    summary = `n-gram: worst ${worstOverlap}% OK | originality judge: ${judge.score}/10 (< ${MIN_ORIGINALITY_SCORE}). ${judge.reasons.slice(0, 3).join('; ')}`;
  }

  return {
    gate: 'originality',
    passed: allPassed,
    aggregate_score: judge.score,
    paragraph_findings: findings,
    summary,
    retriable: true,
    failing_paragraph_indices: failingIndices,
  };
}
