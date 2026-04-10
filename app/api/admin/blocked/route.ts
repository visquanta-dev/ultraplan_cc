import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '../../../../lib/admin/auth';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Admin API: Blocked drafts — spec §8
// Returns drafts that failed gates with failure reason. Includes a
// manual override endpoint (POST) for rare escape-hatch approvals.
//
// NOTE: Uses local filesystem for dev. Phase 13 swaps to Vercel Blob
// or Supabase for serverless-compatible persistent storage.
// ---------------------------------------------------------------------------

const BLOCKED_DIR = path.join(process.cwd(), 'data', 'blocked');

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  if (!fs.existsSync(BLOCKED_DIR)) {
    return NextResponse.json({ blocked: [] });
  }

  const files = fs.readdirSync(BLOCKED_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse();

  const blocked = files.map((f) => {
    const content = fs.readFileSync(path.join(BLOCKED_DIR, f), 'utf-8');
    return JSON.parse(content);
  });

  return NextResponse.json({ blocked, count: blocked.length });
}

/**
 * POST: Manual override — force-approve a blocked draft.
 * Body: { slug: string, reason: string }
 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const body = await request.json() as { slug?: string; reason?: string };
  if (!body.slug || !body.reason) {
    return NextResponse.json(
      { error: 'slug and reason are required' },
      { status: 400 },
    );
  }

  const blockedFile = path.join(BLOCKED_DIR, `${body.slug}.json`);
  if (!fs.existsSync(blockedFile)) {
    return NextResponse.json(
      { error: `No blocked draft found for slug: ${body.slug}` },
      { status: 404 },
    );
  }

  // Move from blocked to runs with override flag
  const draft = JSON.parse(fs.readFileSync(blockedFile, 'utf-8'));
  draft.manual_override = {
    approved_at: new Date().toISOString(),
    reason: body.reason,
  };

  const runsDir = path.join(process.cwd(), 'data', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(
    path.join(runsDir, `${body.slug}.json`),
    JSON.stringify(draft, null, 2),
  );
  fs.unlinkSync(blockedFile);

  return NextResponse.json({
    overridden: true,
    slug: body.slug,
    reason: body.reason,
  });
}
