import type { GateReport } from '../gates/types';
import { writeJson, listByPrefix, readJson } from '../storage/blob';

// ---------------------------------------------------------------------------
// Run logger — Phase 13 → Phase 14 (Vercel Blob)
// Persists pipeline run results to Vercel Blob for the admin dashboard.
// ---------------------------------------------------------------------------

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

/**
 * Save a completed run (passed gates, PR created).
 */
export async function logRun(record: RunRecord): Promise<void> {
  const filename = `${record.created_at.split('T')[0]}-${record.slug}.json`;
  await writeJson(`runs/${filename}`, record);
}

/**
 * Save a blocked draft (gate failure after retry exhaustion).
 */
export async function logBlocked(record: RunRecord): Promise<void> {
  await writeJson(`blocked/${record.slug}.json`, record);
}

/**
 * List recent runs from Blob storage.
 */
export async function listRuns(limit = 100): Promise<RunRecord[]> {
  const blobs = await listByPrefix('runs/', { limit });
  const runs: RunRecord[] = [];
  for (const blob of blobs) {
    const record = await readJson<RunRecord>(blob.pathname);
    if (record) runs.push(record);
  }
  // Sort newest first
  runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return runs;
}

/**
 * List blocked drafts from Blob storage.
 */
export async function listBlocked(): Promise<RunRecord[]> {
  const blobs = await listByPrefix('blocked/');
  const blocked: RunRecord[] = [];
  for (const blob of blobs) {
    const record = await readJson<RunRecord>(blob.pathname);
    if (record) blocked.push(record);
  }
  blocked.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return blocked;
}

/**
 * Get a single blocked draft by slug.
 */
export async function getBlocked(slug: string): Promise<RunRecord | null> {
  return readJson<RunRecord>(`blocked/${slug}.json`);
}

/**
 * Move a blocked draft to runs (manual override).
 */
export async function overrideBlocked(
  slug: string,
  reason: string,
): Promise<RunRecord | null> {
  const draft = await getBlocked(slug);
  if (!draft) return null;

  draft.manual_override = {
    approved_at: new Date().toISOString(),
    reason,
  };

  await writeJson(`runs/${slug}.json`, draft);

  // Delete the blocked entry
  const blockedBlobs = await listByPrefix(`blocked/${slug}.json`);
  for (const blob of blockedBlobs) {
    const { deleteBlob } = await import('../storage/blob');
    await deleteBlob(blob.url);
  }

  return draft;
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
