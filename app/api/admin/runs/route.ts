import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '../../../../lib/admin/auth';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Admin API: Run history — spec §8
// Returns the last 90 days of pipeline runs with status, gate scores,
// timing, and costs.
// ---------------------------------------------------------------------------

const RUNS_DIR = path.join(process.cwd(), 'data', 'runs');

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  if (!fs.existsSync(RUNS_DIR)) {
    return NextResponse.json({ runs: [] });
  }

  const files = fs.readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, 100); // last 100 runs

  const runs = files.map((f) => {
    const content = fs.readFileSync(path.join(RUNS_DIR, f), 'utf-8');
    return JSON.parse(content);
  });

  return NextResponse.json({ runs, count: runs.length });
}
