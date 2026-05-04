import type { Bundle } from '../bundle/types';
import type { TransformedParagraph } from '../stages/voice-transform';
import type { GateReport } from './types';
import { runAllGates, type OrchestratorContext, type OrchestratorOptions } from './orchestrator';
import { callLLMStructured, MODELS } from '../llm/openrouter';
import { voiceTransform } from '../stages/voice-transform';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Gate retry loop — spec §6
// When gates fail with retriable=true, regenerate only the failing
// paragraphs and re-run all gates. Repeat up to MAX_RETRIES times.
// If any attempt passes, return the passing report. If retries are
// exhausted, return the last report with verdict 'blocked'.
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3; // spec §6: at most 3 regeneration attempts

const REGEN_PROMPT_PATH = path.join(
  process.cwd(),
  'workflows',
  'blog-pipeline',
  'prompts',
  'paragraph-regen.md',
);

interface RegenParagraph {
  text: string;
  section_index: number;
  source_id: string;
  anchor_quote_id: string;
}

const REGEN_SCHEMA = {
  type: 'object',
  required: ['paragraphs'],
  properties: {
    paragraphs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['text', 'section_index', 'source_id', 'anchor_quote_id'],
        properties: {
          text: { type: 'string', minLength: 50 },
          section_index: { type: 'integer', minimum: 0 },
          source_id: { type: 'string' },
          anchor_quote_id: { type: 'string' },
        },
      },
    },
  },
};

/**
 * Re-draft specific paragraphs that failed gate checks. The LLM receives
 * the full post context (so it can maintain coherence) but is told to
 * only rewrite the flagged paragraphs.
 */
async function regenerateFailingParagraphs(
  allParagraphs: TransformedParagraph[],
  failingIndices: number[],
  bundle: Bundle,
  gateReport: GateReport,
): Promise<RegenParagraph[]> {
  const system = fs.readFileSync(REGEN_PROMPT_PATH, 'utf-8');

  // Build the failure context so the LLM knows WHY each paragraph failed
  const failureDetails = failingIndices.map((idx) => {
    const reasons = gateReport.results
      .flatMap((r) =>
        r.paragraph_findings
          .filter((f) => f.paragraph_index === idx && !f.passed)
          .map((f) => `[${r.gate}] ${f.reason ?? 'failed'}`)
      );
    return {
      index: idx,
      original_text: allParagraphs[idx].text,
      section_index: allParagraphs[idx].section_index,
      source_id: allParagraphs[idx].source_id,
      anchor_quote_id: allParagraphs[idx].anchor_quote_id,
      failure_reasons: reasons,
    };
  });

  const user = JSON.stringify(
    {
      full_post: allParagraphs.map((p, i) => ({
        index: i,
        text: p.text,
        section_index: p.section_index,
        source_id: p.source_id,
        anchor_quote_id: p.anchor_quote_id,
      })),
      failing_paragraphs: failureDetails,
      bundle,
    },
    null,
    2,
  );

  const result = await callLLMStructured<{ paragraphs: RegenParagraph[] }>({
    system,
    user,
    schema: REGEN_SCHEMA,
    model: MODELS.DRAFTER,
    maxTokens: 4096,
    parse: (raw: unknown) => {
      if (!raw || typeof raw !== 'object') {
        throw new Error('[paragraph-regen] response was not an object');
      }
      const obj = raw as Record<string, unknown>;
      if (!Array.isArray(obj.paragraphs)) {
        throw new Error('[paragraph-regen] missing paragraphs array');
      }
      return {
        paragraphs: obj.paragraphs.map((p) => {
          const para = p as Record<string, unknown>;
          return {
            text: String(para.text ?? ''),
            section_index: Number(para.section_index ?? 0),
            source_id: String(para.source_id ?? ''),
            anchor_quote_id: String(para.anchor_quote_id ?? ''),
          };
        }),
      };
    },
  });

  return result.paragraphs;
}

/**
 * Splice regenerated paragraphs back into the full array at the correct
 * indices. Returns a new array (does not mutate the original).
 */
function spliceParagraphs(
  original: TransformedParagraph[],
  regenerated: TransformedParagraph[],
  failingIndices: number[],
): TransformedParagraph[] {
  const result = [...original];
  for (let i = 0; i < failingIndices.length && i < regenerated.length; i++) {
    result[failingIndices[i]] = regenerated[i];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RetryLoopResult {
  /** The final gate report (from the passing attempt, or the last failed one) */
  report: GateReport;
  /** The final set of paragraphs (with any regenerated ones spliced in) */
  paragraphs: TransformedParagraph[];
  /** How many retry attempts were made (0 = passed on first try) */
  retries: number;
}

export interface RetryLoopOptions extends OrchestratorOptions {
  /** Max retry attempts. Defaults to MAX_RETRIES (3). */
  maxRetries?: number;
  /** Called when a retry starts. */
  onRetryStart?: (attempt: number, failingIndices: number[]) => void;
}

/**
 * Run all gates, and if retriable failures occur, regenerate the failing
 * paragraphs and re-run. Stops on pass, block, or retry budget exhaustion.
 */
export async function runWithRetry(
  ctx: OrchestratorContext,
  options: RetryLoopOptions = {},
): Promise<RetryLoopResult> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  let paragraphs = [...ctx.paragraphs];
  let retries = 0;

  // First run
  let report = await runAllGates(
    { ...ctx, paragraphs, attempt: 1 },
    options,
  );

  while (report.verdict === 'retry' && retries < maxRetries) {
    retries++;
    const failingIndices = report.failing_paragraph_indices;

    if (failingIndices.length === 0) {
      report = {
        ...report,
        verdict: 'blocked',
        blocked_reason: 'Gate requested retry but did not identify failing paragraph indices',
      };
      break;
    }

    options.onRetryStart?.(retries, failingIndices);

    // Regenerate failing paragraphs
    const regenRaw = await regenerateFailingParagraphs(
      paragraphs,
      failingIndices,
      ctx.bundle,
      report,
    );

    if (regenRaw.length !== failingIndices.length) {
      throw new Error(
        `[retry-loop] paragraph regen returned ${regenRaw.length} paragraphs for ${failingIndices.length} failing indices`,
      );
    }

    // Voice-transform the regenerated paragraphs
    const regenResult = await voiceTransform(
      regenRaw.map((p) => ({
        text: p.text,
        section_index: p.section_index,
        source_id: p.source_id,
        anchor_quote_id: p.anchor_quote_id,
      })),
    );
    const regenTransformed = regenResult.paragraphs;

    // Splice back
    paragraphs = spliceParagraphs(paragraphs, regenTransformed, failingIndices);

    // Re-run all gates
    report = await runAllGates(
      { ...ctx, paragraphs, attempt: retries + 1 },
      options,
    );
  }

  // If we exhausted retries and still failing, mark as blocked
  if (report.verdict === 'retry') {
    report = {
      ...report,
      verdict: 'blocked',
      blocked_reason: `Retry budget exhausted after ${maxRetries} attempts. Failing paragraphs: ${report.failing_paragraph_indices.join(', ')}`,
    };
  }

  return { report, paragraphs, retries };
}
