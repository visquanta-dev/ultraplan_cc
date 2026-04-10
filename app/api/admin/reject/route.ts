import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '../../../../lib/admin/auth';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Admin API: Rejection log viewer — spec §8
// Reads data/rejection_log.jsonl and returns structured entries.
// NOTE: Uses local filesystem for dev. Phase 13 swaps to persistent storage.
// ---------------------------------------------------------------------------

const REJECTION_LOG_PATH = path.join(process.cwd(), 'data', 'rejection_log.jsonl');

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  if (!fs.existsSync(REJECTION_LOG_PATH)) {
    return NextResponse.json({ rejections: [], count: 0 });
  }

  const raw = fs.readFileSync(REJECTION_LOG_PATH, 'utf-8');
  const rejections = raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try { return JSON.parse(line); }
      catch { return null; }
    })
    .filter(Boolean)
    .reverse(); // newest first

  return NextResponse.json({ rejections, count: rejections.length });
}
