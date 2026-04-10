import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '../../../../lib/admin/auth';
import { listRuns } from '../../../../lib/admin/run-logger';

// ---------------------------------------------------------------------------
// Admin API: Run history — spec §8 (Vercel Blob storage)
// Returns the last 100 pipeline runs with status, gate scores, and timing.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const runs = await listRuns(100);
  return NextResponse.json({ runs, count: runs.length });
}
