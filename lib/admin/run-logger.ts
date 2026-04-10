import fs from 'node:fs';
import path from 'node:path';
import type { GateReport } from '../gates/types';

// ---------------------------------------------------------------------------
// Run logger — Phase 13
// Persists pipeline run results to data/runs/ for the admin dashboard.
// NOTE: Local filesystem for dev. Swap to Vercel Blob for production.
// ---------------------------------------------------------------------------

const RUNS_DIR = path.join(process.cwd(), 'data', 'runs');
const BLOCKED_DIR = path.join(process.cwd(), 'data', 'blocked');

export interface RunRecord {
  slug: string;
  lane: string;
  status: 'published' | 'blocked' | 'pending_review' | 'failed_silent';
  verdict: string;
  created_at: string;
  gate_scores: Record<string, number | undefined>;
  gate_report: GateReport;
  pr_url?: string;
  pr_number?: number;
  error?: string;
  duration_ms?: number;
  manual_override?: { approved_at: string; reason: string };
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Save a completed run (passed gates, PR created).
 */
export function logRun(record: RunRecord): void {
  ensureDir(RUNS_DIR);
  const filename = `${record.created_at.split('T')[0]}-${record.slug}.json`;
  fs.writeFileSync(
    path.join(RUNS_DIR, filename),
    JSON.stringify(record, null, 2),
  );
}

/**
 * Save a blocked draft (gate failure after retry exhaustion).
 */
export function logBlocked(record: RunRecord): void {
  ensureDir(BLOCKED_DIR);
  const filename = `${record.slug}.json`;
  fs.writeFileSync(
    path.join(BLOCKED_DIR, filename),
    JSON.stringify(record, null, 2),
  );
}

/**
 * Build gate scores map from a GateReport.
 */
export function extractGateScores(report: GateReport): Record<string, number | undefined> {
  const scores: Record<string, number | undefined> = {};
  for (const result of report.results) {
    scores[result.gate] = result.aggregate_score;
  }
  return scores;
}
