import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '../../../../lib/admin/auth';
import { listBlocked, overrideBlocked } from '../../../../lib/admin/run-logger';

// ---------------------------------------------------------------------------
// Admin API: Blocked drafts — spec §8 (Vercel Blob storage)
// Returns drafts that failed gates. POST allows manual override.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const blocked = await listBlocked();
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

  const result = await overrideBlocked(body.slug, body.reason);
  if (!result) {
    return NextResponse.json(
      { error: `No blocked draft found for slug: ${body.slug}` },
      { status: 404 },
    );
  }

  return NextResponse.json({
    overridden: true,
    slug: body.slug,
    reason: body.reason,
  });
}
