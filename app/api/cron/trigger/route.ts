import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Cron trigger — spec §9-10
// Receives Vercel Cron fires (Mon/Wed/Fri 06:00 CT) and dispatches the
// blog pipeline workflow. In Phase 10 this will use Vercel Workflow (WDK);
// for now it validates the cron secret and logs the trigger.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  // Verify cron secret (Vercel sets this header on cron invocations)
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  const day = now.toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone: 'America/Chicago',
  });

  // Determine which lane to run based on day of week
  // Mon/Fri → daily_seo, Wed → weekly_authority
  // 1st Friday of month → monthly_anonymized_case (replaces daily_seo)
  let lane: string;

  const dayOfWeek = now.toLocaleDateString('en-US', {
    weekday: 'short',
    timeZone: 'America/Chicago',
  });

  if (dayOfWeek === 'Wed') {
    lane = 'weekly_authority';
  } else if (dayOfWeek === 'Fri') {
    // Check if first Friday of month
    const chicagoDate = new Date(
      now.toLocaleString('en-US', { timeZone: 'America/Chicago' }),
    );
    lane = chicagoDate.getDate() <= 7
      ? 'monthly_anonymized_case'
      : 'daily_seo';
  } else {
    lane = 'daily_seo';
  }

  console.log(`[cron] Triggered on ${day} — lane: ${lane}`);

  // TODO(phase-10): Start Vercel Workflow with lane parameter
  // For now, return the resolved lane so we can verify cron logic works

  return NextResponse.json({
    triggered: true,
    lane,
    day,
    timestamp: now.toISOString(),
    message: 'Vercel Workflow dispatch will be wired in Phase 10',
  });
}
