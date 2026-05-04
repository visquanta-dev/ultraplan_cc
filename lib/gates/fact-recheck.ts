import type { Bundle, Source } from '../bundle/types';
import type { TransformedParagraph } from '../stages/voice-transform';
import type { GateParagraphFinding, GateResult } from './types';
import { scrape } from '../sources/firecrawl';
import { callLLMStructured, MODELS } from '../llm/openrouter';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Gate b — Fact recheck (spec §6)
// The most expensive gate. For each paragraph:
//   1. Find the source URL it cites (via source_id → bundle.sources)
//   2. Re-scrape that URL via Firecrawl (cached per-source within a run)
//   3. Ask GPT-5: "Does this re-scraped text still support the claim
//      made in this paragraph?"
//
// Pass criterion: every paragraph claim must be supported by the current
// source corpus. This is intentionally strict: "no source = no sentence" is
// the core publishing contract.
// ---------------------------------------------------------------------------

const MIN_SUPPORT_RATIO = 1;

// ---------------------------------------------------------------------------
// Source re-scraping with per-run cache
// ---------------------------------------------------------------------------

/**
 * Re-scrape each unique source URL once, returning a map of source_id
 * to the freshly scraped text. Sources that fail to scrape get an error
 * entry instead.
 */
async function rescrapeSourcesOnce(
  sources: Source[],
): Promise<Map<string, { text: string } | { error: string }>> {
  const cache = new Map<string, { text: string } | { error: string }>();

  for (const source of sources) {
    if (cache.has(source.source_id)) continue;
    try {
      const article = await scrape(source.url);
      cache.set(source.source_id, { text: article.rawText });
    } catch (err) {
      cache.set(source.source_id, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return cache;
}

// ---------------------------------------------------------------------------
// GPT-5 fact-check judge
// ---------------------------------------------------------------------------

const FACT_CHECK_PROMPT_PATH = path.join(
  process.cwd(),
  'workflows',
  'blog-pipeline',
  'prompts',
  'gates',
  'fact-check-judge.md',
);

interface FactCheckJudgeResponse {
  supported: boolean;
  confidence: number;
  reason: string;
}

const FACT_CHECK_SCHEMA = {
  type: 'object',
  required: ['supported', 'confidence', 'reason'],
  properties: {
    supported: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string' },
  },
};

/**
 * Ask GPT-5 whether any of the re-scraped source texts support the claim
 * made in a single paragraph. Returns structured verdict.
 *
 * Key design decision: the judge sees ALL bundle sources, not just the
 * one the paragraph is anchored to. The drafter routinely synthesizes
 * claims across multiple sources (e.g. headline stat from source A,
 * supporting detail from source B), and matching against a single
 * anchor quote was rejecting valid synthesis. Matching against the full
 * bundle lets the judge find the claim wherever in the research it was
 * grounded, which is how a human fact-checker would actually work.
 */
async function judgeParagraphClaim(
  paragraphText: string,
  originalQuote: string,
  bundleSourceBlocks: string[],
  systemPrompt: string,
): Promise<FactCheckJudgeResponse> {
  // Keep enough context for current Firecrawl markdown. The old 8k total cap
  // created false negatives when supporting text appeared after the intro.
  const MAX_TOTAL_CHARS = 30000;
  const perSource = Math.floor(MAX_TOTAL_CHARS / Math.max(bundleSourceBlocks.length, 1));
  const trimmed = bundleSourceBlocks.map((block) => block.slice(0, perSource));

  const user = [
    '## Anchor quote from bundle (original context)',
    `"${originalQuote}"`,
    '',
    '## Paragraph being fact-checked',
    paragraphText,
    '',
    '## All re-scraped bundle sources (the claim must be supported by AT LEAST ONE)',
    trimmed.join('\n\n---\n\n'),
  ].join('\n');

  return await callLLMStructured<FactCheckJudgeResponse>({
    system: systemPrompt,
    user,
    schema: FACT_CHECK_SCHEMA,
    model: MODELS.JUDGE,
    maxTokens: 1024,
    temperature: 0.1,
    parse: (raw: unknown): FactCheckJudgeResponse => {
      if (!raw || typeof raw !== 'object') {
        throw new Error('[fact-check-judge] response was not an object');
      }
      const obj = raw as Record<string, unknown>;
      if (typeof obj.supported !== 'boolean') {
        throw new Error('[fact-check-judge] supported must be boolean');
      }
      const confidence =
        typeof obj.confidence === 'number' ? obj.confidence : 0.5;
      const reason =
        typeof obj.reason === 'string' ? obj.reason : 'no reason given';
      return { supported: obj.supported, confidence, reason };
    },
  });
}

// ---------------------------------------------------------------------------
// Gate b entry point
// ---------------------------------------------------------------------------

/**
 * Run gate b: re-scrape cited sources and verify claims still hold.
 * Pass criterion: ≥95% of paragraphs supported.
 */
export async function runFactRecheckGate(
  paragraphs: TransformedParagraph[],
  bundle: Bundle,
): Promise<GateResult> {
  // Build source lookup
  const sourceMap = new Map(bundle.sources.map((s) => [s.source_id, s]));

  // Re-scrape ALL bundle sources — not just the ones individual paragraphs
  // anchor to. The judge evaluates each paragraph against the full bundle
  // so cross-source synthesis stays valid. (Previously we only re-scraped
  // cited sources, but that meant a paragraph could be rejected because
  // its supporting stat lived in a source no paragraph in this draft
  // happened to anchor to.)
  const rescraped = await rescrapeSourcesOnce(bundle.sources);

  // Pre-build the list of labeled source text blocks that will be passed
  // to the judge for every paragraph. Each block names its source so the
  // judge can cite which one matched in its reason.
  const bundleSourceBlocks: string[] = [];
  for (const source of bundle.sources) {
    const cached = rescraped.get(source.source_id);
    if (cached && !('error' in cached)) {
      bundleSourceBlocks.push(`SOURCE: ${source.source_id} (${source.url})\n${cached.text}`);
    }
  }

  // Load the judge prompt
  const systemPrompt = fs.readFileSync(FACT_CHECK_PROMPT_PATH, 'utf-8');

  // Judge each paragraph
  const findings: GateParagraphFinding[] = [];

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    const source = sourceMap.get(para.source_id);
    const quote = source?.quotes.find(
      (q) => q.quote_id === para.anchor_quote_id,
    );

    // If source or quote missing, fail this paragraph (structural issue)
    if (!source || !quote) {
      findings.push({
        paragraph_index: i,
        passed: false,
        reason: `source ${para.source_id} or quote ${para.anchor_quote_id} not found in bundle`,
      });
      continue;
    }

    // If every bundle source failed to re-scrape, we can't verify anything.
    // Fail closed so source outages and allowlist mistakes cannot become a
    // pass-all fact gate.
    if (bundleSourceBlocks.length === 0) {
      findings.push({
        paragraph_index: i,
        passed: false,
        reason: 'all bundle sources unavailable for re-scrape — cannot verify claim',
      });
      continue;
    }

    // Ask GPT-5 if the claim is supported by ANY of the bundle's sources
    const verdict = await judgeParagraphClaim(
      para.text,
      quote.text,
      bundleSourceBlocks,
      systemPrompt,
    );

    findings.push({
      paragraph_index: i,
      passed: verdict.supported,
      score: Math.round(verdict.confidence * 100),
      reason: verdict.supported ? undefined : verdict.reason,
    });
  }

  const supported = findings.filter((f) => f.passed).length;
  const total = findings.length;
  const ratio = total > 0 ? supported / total : 1;
  const passed = ratio >= MIN_SUPPORT_RATIO;
  const failingIndices = findings
    .filter((f) => !f.passed)
    .map((f) => f.paragraph_index);

  const summary = passed
    ? `${supported}/${total} claims supported (${Math.round(ratio * 100)}% >= ${MIN_SUPPORT_RATIO * 100}%)`
    : `${supported}/${total} claims supported (${Math.round(ratio * 100)}% < ${MIN_SUPPORT_RATIO * 100}%). Failed: ${failingIndices.join(', ')}`;

  return {
    gate: 'fact-recheck',
    passed,
    aggregate_score: Math.round(ratio * 100),
    paragraph_findings: findings,
    summary,
    retriable: true,
    failing_paragraph_indices: failingIndices,
  };
}
