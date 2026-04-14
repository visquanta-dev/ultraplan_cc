// ---------------------------------------------------------------------------
// Gate types — spec §6 "The Five Hard Gates"
// Every gate produces a GateResult. The orchestrator aggregates the five
// results into a GateReport with an overall verdict. The drafter's retry
// loop uses these reports to decide whether to regenerate, block, or
// approve a draft.
// ---------------------------------------------------------------------------

/**
 * One of the five hard gates from spec §6.
 */
export type GateId = 'trace-back' | 'fact-recheck' | 'slop-lexicon' | 'originality' | 'anonymization' | 'seo-aeo';

/**
 * Per-paragraph finding. Most gates operate paragraph-by-paragraph so the
 * retry loop can regenerate just the failing paragraphs instead of the
 * whole post.
 */
export interface GateParagraphFinding {
  paragraph_index: number;
  passed: boolean;
  score?: number; // gate-specific numeric score (e.g. similarity, overlap, rating)
  reason?: string; // human-readable explanation if failed
  matched?: string[]; // e.g. banned phrases or client names found
}

/**
 * Result of running one gate. Gates either pass or fail; partial passes
 * are represented as `passed: false` with per-paragraph breakdown.
 */
export interface GateResult {
  /**
   * Which gate produced this result.
   */
  gate: GateId;

  /**
   * Did the gate pass overall? Based on the gate's own pass criterion.
   */
  passed: boolean;

  /**
   * Optional aggregate score for the whole draft (e.g. average similarity,
   * slop-in-spirit score). Used by the admin dashboard later.
   */
  aggregate_score?: number;

  /**
   * Per-paragraph findings. May be empty for gates that don't operate
   * paragraph-by-paragraph (e.g. anonymization scans frontmatter too).
   */
  paragraph_findings: GateParagraphFinding[];

  /**
   * Short human-readable summary for logs and the admin dashboard.
   */
  summary: string;

  /**
   * Whether failure on this gate is recoverable via retry. Gate e
   * (anonymization) is always `false` — anonymization leaks are
   * unrecoverable per spec §6.
   */
  retriable: boolean;

  /**
   * Indices of paragraphs that need to be regenerated if this gate failed
   * and the orchestrator decides to retry. Subset of the
   * `paragraph_findings` array.
   */
  failing_paragraph_indices: number[];

  /**
   * Raw cost tracking — tokens consumed, approximate USD cost. Logged for
   * awareness, never used as a selection criterion (spec §2 principle 5).
   */
  cost?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    usd?: number;
  };
}

/**
 * Overall verdict of running all five gates together.
 */
export type GateVerdict = 'passed' | 'retry' | 'blocked';

/**
 * Aggregated report across all five gates for one draft attempt.
 */
export interface GateReport {
  /**
   * Which draft attempt this report is for. First attempt is 1.
   */
  attempt: number;

  /**
   * Overall verdict:
   *  - `passed`: all five gates passed, draft is ready for PR review
   *  - `retry`: at least one retriable gate failed, orchestrator should
   *    regenerate failing paragraphs and re-run gates
   *  - `blocked`: gate e failed OR retry budget exhausted OR any gate
   *    failure cannot be rescued. Draft is permanently blocked.
   */
  verdict: GateVerdict;

  /**
   * Per-gate results in the order they were executed.
   */
  results: GateResult[];

  /**
   * Union of failing paragraph indices across all retriable failed gates.
   * The retry loop uses this to know which paragraphs to regenerate.
   */
  failing_paragraph_indices: number[];

  /**
   * Non-retriable failure reason if verdict === 'blocked'. Empty if passed
   * or retry.
   */
  blocked_reason?: string;

  /**
   * ISO 8601 timestamp when the report was produced.
   */
  generated_at: string;

  /**
   * Total rough cost across all gates in this attempt. Logged only.
   */
  total_cost?: {
    prompt_tokens: number;
    completion_tokens: number;
    usd: number;
  };
}

/**
 * Helper to compute the overall verdict from a set of gate results.
 * - If ANY gate failed with retriable=false → blocked
 * - If ALL gates passed → passed
 * - Otherwise → retry
 */
export function computeVerdict(results: GateResult[]): GateVerdict {
  const nonRetriableFailure = results.find((r) => !r.passed && !r.retriable);
  if (nonRetriableFailure) return 'blocked';
  if (results.every((r) => r.passed)) return 'passed';
  return 'retry';
}

/**
 * Helper to collect all failing paragraph indices across a set of gate
 * results. Deduped, sorted ascending.
 */
export function collectFailingParagraphIndices(results: GateResult[]): number[] {
  const set = new Set<number>();
  for (const r of results) {
    if (!r.passed && r.retriable) {
      for (const idx of r.failing_paragraph_indices) {
        set.add(idx);
      }
    }
  }
  return Array.from(set).sort((a, b) => a - b);
}
