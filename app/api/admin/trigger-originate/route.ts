import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '../../../../lib/admin/auth';

// ---------------------------------------------------------------------------
// Admin API: Trigger an ORIGINATE pipeline run — operator-voice seed drives
// the post instead of competitor signal.
//
// Accepts a text seed (3-5 sentences of first-hand observation) + category,
// base64-encodes the seed (GitHub workflow_dispatch inputs don't handle
// multi-line text cleanly), dispatches daily-blog.yml with the originate
// inputs. The workflow decodes and writes to a file; the pipeline runner
// reads ORIGINATE_SEED_FILE and routes to resolveOriginate().
// ---------------------------------------------------------------------------

const REPO = 'visquanta-dev/ultraplan_cc';
const WORKFLOW = 'daily-blog.yml';

const VALID_CATEGORIES = [
  'lead_reactivation',
  'speed_to_lead',
  'service_drive',
  'web_capture',
  'reputation',
  'inventory',
  'industry_trends',
];

const VALID_LANES = ['daily_seo', 'weekly_authority', 'monthly_anonymized_case', 'listicle'];

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const body = await request.json().catch(() => ({}));
  const seed = typeof body.seed === 'string' ? body.seed.trim() : '';
  const category = typeof body.category_id === 'string' ? body.category_id.trim() : '';
  const lane = typeof body.lane === 'string' ? body.lane : 'daily_seo';

  // Validation
  if (seed.length < 80) {
    return NextResponse.json(
      { error: 'seed is too short (min 80 chars) — aim for 3-5 sentences with a specific number or pattern.' },
      { status: 400 },
    );
  }
  if (seed.length > 2000) {
    return NextResponse.json(
      { error: 'seed is too long (max 2000 chars) — trim to 3-5 sentences.' },
      { status: 400 },
    );
  }
  const sentenceCount = seed.split(/(?<=[.!?])\s+/).filter((s: string) => s.trim().length >= 30).length;
  if (sentenceCount < 3) {
    return NextResponse.json(
      { error: `needs at least 3 substantive sentences (got ${sentenceCount}). Each sentence becomes a verbatim quote the drafter anchors to.` },
      { status: 400 },
    );
  }
  if (!VALID_CATEGORIES.includes(category)) {
    return NextResponse.json(
      { error: `invalid category_id "${category}". Valid: ${VALID_CATEGORIES.join(', ')}` },
      { status: 400 },
    );
  }
  if (!VALID_LANES.includes(lane)) {
    return NextResponse.json(
      { error: `invalid lane "${lane}". Valid: ${VALID_LANES.join(', ')}` },
      { status: 400 },
    );
  }

  const token = process.env.GITHUB_PAT ?? process.env.GH_PAT;
  if (!token) {
    return NextResponse.json({ error: 'GITHUB_PAT / GH_PAT not configured in env' }, { status: 500 });
  }

  // Base64-encode for clean workflow_dispatch input transport
  const seedB64 = Buffer.from(seed, 'utf-8').toString('base64');

  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          lane,
          originate_seed_b64: seedB64,
          originate_category: category,
        },
      }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: `GitHub API ${res.status}: ${text}` }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    lane,
    category,
    seed_chars: seed.length,
    sentence_count: sentenceCount,
    message: 'Originate run triggered. Check the Actions tab for progress.',
    actionsUrl: `https://github.com/${REPO}/actions/workflows/${WORKFLOW}`,
  });
}
