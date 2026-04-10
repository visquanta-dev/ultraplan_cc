import type { Bundle } from '../bundle/types';
import type { Outline } from '../stages/outline';
import type { TransformedParagraph } from '../stages/voice-transform';
import {
  type GateResult,
  type GateReport,
  type GateVerdict,
  computeVerdict,
  collectFailingParagraphIndices,
} from './types';
import { runTraceBackGate } from './trace-back';
import { runSlopLexiconGate } from './slop-lexicon';
import { runAnonymizationGate } from './anonymization';

// ---------------------------------------------------------------------------
// Gate orchestrator — spec §6
// Runs the five hard gates in cheapest-to-most-expensive order so cheap
// failures short-circuit before we pay for expensive ones (especially
// gate b's re-scraping costs). Anonymization (gate e) is run second
// because it's zero-tolerance and pointless to continue on a leak.
//
// Execution order:
//   1. trace-back       — pure code, free, structural sanity check
//   2. anonymization    — regex + cheap LLM, zero tolerance → short-circuit
//   3. slop-lexicon     — regex + cheap LLM
//   4. originality      — n-gram + GPT-5 judge
//   5. fact-recheck     — re-scrape + GPT-5 judge (most expensive)
//
// Each gate is still a placeholder at this point. Subsequent commits in
// Phase 2 replace these placeholders with real implementations.
// ---------------------------------------------------------------------------

export interface OrchestratorContext {
  paragraphs: TransformedParagraph[];
  bundle: Bundle;
  outline: Outline;
  headlineAndMeta?: {
    title: string;
    metaDescription: string;
  };
  /**
   * Which attempt this is (for GateReport.attempt). Starts at 1.
   */
  attempt?: number;
}

// Placeholder gate functions — replaced by real implementations in
// subsequent commits (Steps 2–6 of Phase 2).

function placeholderGate(
  gate: GateResult['gate'],
  retriable: boolean,
): GateResult {
  return {
    gate,
    passed: true,
    aggregate_score: undefined,
    paragraph_findings: [],
    summary: `${gate} placeholder — real implementation pending`,
    retriable,
    failing_paragraph_indices: [],
  };
}

async function runGateA(ctx: OrchestratorContext): Promise<GateResult> {
  return runTraceBackGate(ctx.paragraphs, ctx.bundle, ctx.outline);
}

async function runGateB(_ctx: OrchestratorContext): Promise<GateResult> {
  return placeholderGate('fact-recheck', true);
}

async function runGateC(ctx: OrchestratorContext): Promise<GateResult> {
  return runSlopLexiconGate(ctx.paragraphs);
}

async function runGateD(_ctx: OrchestratorContext): Promise<GateResult> {
  return placeholderGate('originality', true);
}

async function runGateE(ctx: OrchestratorContext): Promise<GateResult> {
  return runAnonymizationGate(ctx.paragraphs, ctx.headlineAndMeta);
}

// ---------------------------------------------------------------------------

export interface OrchestratorOptions {
  /**
   * Logger injected by the caller so smoke-draft scripts can stream per-gate
   * progress without the orchestrator taking a dependency on stdout.
   */
  onGateStart?: (gate: GateResult['gate']) => void;
  onGateFinish?: (result: GateResult) => void;
}

/**
 * Run all five gates in the cheapest-to-most-expensive order, short-circuit
 * on gate e (anonymization) failure, aggregate into a GateReport.
 *
 * Short-circuit behavior:
 *  - Gate a fails → still run all other gates (we want the full picture
 *    for the admin dashboard)
 *  - Gate e fails → stop immediately and mark the draft blocked, no point
 *    running b/c/d after a client-name leak
 *  - Any other failure → still run remaining gates, verdict decides retry
 */
export async function runAllGates(
  ctx: OrchestratorContext,
  options: OrchestratorOptions = {},
): Promise<GateReport> {
  const results: GateResult[] = [];
  const attempt = ctx.attempt ?? 1;

  async function run(
    gate: GateResult['gate'],
    runner: (ctx: OrchestratorContext) => Promise<GateResult>,
  ): Promise<GateResult> {
    options.onGateStart?.(gate);
    const result = await runner(ctx);
    options.onGateFinish?.(result);
    results.push(result);
    return result;
  }

  // 1. Trace-back (cheapest)
  await run('trace-back', runGateA);

  // 2. Anonymization — zero tolerance, short-circuit on failure
  const gateE = await run('anonymization', runGateE);
  if (!gateE.passed) {
    return {
      attempt,
      verdict: 'blocked',
      results,
      failing_paragraph_indices: [],
      blocked_reason: `Gate e (anonymization) failed: ${gateE.summary}`,
      generated_at: new Date().toISOString(),
    };
  }

  // 3. Slop lexicon
  await run('slop-lexicon', runGateC);

  // 4. Originality
  await run('originality', runGateD);

  // 5. Fact recheck (most expensive)
  await run('fact-recheck', runGateB);

  const verdict: GateVerdict = computeVerdict(results);
  const failingIndices = collectFailingParagraphIndices(results);

  return {
    attempt,
    verdict,
    results,
    failing_paragraph_indices: failingIndices,
    generated_at: new Date().toISOString(),
  };
}
