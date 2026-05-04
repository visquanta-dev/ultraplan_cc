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
import { runOriginalityGate } from './originality';
import { runFactRecheckGate } from './fact-recheck';
import { runVerticalDisciplineGate } from './vertical-discipline';

// ---------------------------------------------------------------------------
// Gate orchestrator — spec §6 + 2026-04-22 vertical-discipline gate
// Runs gates in cheapest-to-most-expensive order so cheap failures
// short-circuit before we pay for expensive ones (especially gate b's
// re-scraping costs). Anonymization is zero-tolerance and pointless to
// continue on a leak.
//
// Execution order:
//   1.  trace-back            — pure code, free, structural sanity check
//   1b. vertical-discipline   — pure code, cheap regex on opening 200 words
//   2.  anonymization         — regex + cheap LLM, zero tolerance → short-circuit
//   3.  slop-lexicon          — regex + cheap LLM
//   4.  originality           — n-gram + GPT-5 judge
//   5.  fact-recheck          — re-scrape + GPT-5 judge (most expensive)
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

async function runGateA(ctx: OrchestratorContext): Promise<GateResult> {
  return runTraceBackGate(ctx.paragraphs, ctx.bundle, ctx.outline);
}

async function runGateB(ctx: OrchestratorContext): Promise<GateResult> {
  return runFactRecheckGate(ctx.paragraphs, ctx.bundle);
}

async function runGateC(ctx: OrchestratorContext): Promise<GateResult> {
  return runSlopLexiconGate(ctx.paragraphs);
}

async function runGateD(ctx: OrchestratorContext): Promise<GateResult> {
  return runOriginalityGate(ctx.paragraphs, ctx.bundle);
}

async function runGateE(ctx: OrchestratorContext): Promise<GateResult> {
  return runAnonymizationGate(ctx.paragraphs, ctx.headlineAndMeta);
}

async function runGateF(ctx: OrchestratorContext): Promise<GateResult> {
  return runVerticalDisciplineGate(ctx.paragraphs);
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

function buildReport(
  attempt: number,
  results: GateResult[],
  verdict: GateVerdict = computeVerdict(results),
  blockedReason?: string,
): GateReport {
  return {
    attempt,
    verdict,
    results,
    failing_paragraph_indices: collectFailingParagraphIndices(results),
    ...(blockedReason ? { blocked_reason: blockedReason } : {}),
    generated_at: new Date().toISOString(),
  };
}

/**
 * Run gates in the cheapest-to-most-expensive order, short-circuit
 * on gate e (anonymization) failure, aggregate into a GateReport.
 *
 * Short-circuit behavior:
 *  - Trace-back / vertical discipline fail → retry before paid gates.
 *  - Anonymization fails → block immediately.
 *  - Slop/originality fail → retry before fact recheck.
 *  - Fact recheck runs only after cheaper gates pass.
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
  const gateA = await run('trace-back', runGateA);
  if (!gateA.passed) {
    return buildReport(attempt, results, 'retry');
  }

  // 1b. Vertical discipline — pure regex, cheap, runs before anonymization
  // so generic-reading drafts fail fast before we pay for gate e's LLM call.
  const gateF = await run('vertical-discipline', runGateF);
  if (!gateF.passed) {
    return buildReport(attempt, results, 'retry');
  }

  // 2. Anonymization — zero tolerance, short-circuit on failure
  const gateE = await run('anonymization', runGateE);
  if (!gateE.passed) {
    return buildReport(attempt, results, 'blocked', `Gate e (anonymization) failed: ${gateE.summary}`);
  }

  // 3. Slop lexicon
  const gateC = await run('slop-lexicon', runGateC);
  if (!gateC.passed) {
    return buildReport(attempt, results, 'retry');
  }

  // 4. Originality
  const gateD = await run('originality', runGateD);
  if (!gateD.passed) {
    return buildReport(attempt, results, 'retry');
  }

  // 5. Fact recheck (most expensive)
  await run('fact-recheck', runGateB);

  return buildReport(attempt, results);
}
