import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '../../../../lib/admin/auth';

// ---------------------------------------------------------------------------
// Admin API: Trigger a new pipeline run via GitHub workflow_dispatch.
// Replaces the `gh workflow run` CLI so operators can fire runs from the
// admin dashboard without touching the terminal.
// ---------------------------------------------------------------------------

const REPO = 'visquanta-dev/ultraplan_cc';
const WORKFLOW = 'daily-blog.yml';

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const body = await request.json().catch(() => ({}));
  const lane = typeof body.lane === 'string' ? body.lane : 'daily_seo';
  const strategy = typeof body.strategy === 'string' ? body.strategy : 'calendar_first';
  const curated_bucket =
    typeof body.curated_bucket === 'string' && body.curated_bucket.trim().length > 0
      ? body.curated_bucket.trim()
      : undefined;

  const token = process.env.GITHUB_PAT ?? process.env.GH_PAT;
  if (!token) {
    return NextResponse.json(
      { error: 'GITHUB_PAT / GH_PAT not configured in env' },
      { status: 500 },
    );
  }

  const inputs: Record<string, string> = { lane, strategy };
  if (curated_bucket) inputs.curated_bucket = curated_bucket;

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
      body: JSON.stringify({ ref: 'main', inputs }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json(
      { error: `GitHub API ${res.status}: ${text}` },
      { status: 502 },
    );
  }

  // workflow_dispatch returns 204 No Content with no run id — we point the
  // user at the Actions page for the workflow; the new run will appear there
  // within ~2 seconds.
  return NextResponse.json({
    ok: true,
    lane,
    strategy,
    curated_bucket: curated_bucket ?? null,
    message: 'Run triggered. Check the Actions tab for progress.',
    actionsUrl: `https://github.com/${REPO}/actions/workflows/${WORKFLOW}`,
  });
}
