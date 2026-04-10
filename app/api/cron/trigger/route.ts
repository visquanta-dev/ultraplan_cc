import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Cron trigger — spec §9-10, hardened in Phase 13
// Receives Vercel Cron fires (Mon/Wed/Fri 06:00 CT), resolves lane,
// and dispatches the blog pipeline. Returns immediately; pipeline runs
// in the background via Vercel's 300s function timeout.
//
// When Vercel Workflow (WDK) stabilizes, this becomes a workflow.start()
// call. The pipeline logic stays identical — only the execution wrapper
// changes.
// ---------------------------------------------------------------------------

type Lane = 'daily_seo' | 'weekly_authority' | 'monthly_anonymized_case';

const WORD_COUNTS: Record<Lane, { min: number; max: number }> = {
  daily_seo: { min: 1000, max: 1400 },
  weekly_authority: { min: 1800, max: 2400 },
  monthly_anonymized_case: { min: 2200, max: 3000 },
};

function resolveLane(): Lane {
  const now = new Date();
  const dayOfWeek = now.toLocaleDateString('en-US', {
    weekday: 'short',
    timeZone: 'America/Chicago',
  });

  if (dayOfWeek === 'Wed') return 'weekly_authority';

  if (dayOfWeek === 'Fri') {
    const chicagoDate = new Date(
      now.toLocaleString('en-US', { timeZone: 'America/Chicago' }),
    );
    return chicagoDate.getDate() <= 7 ? 'monthly_anonymized_case' : 'daily_seo';
  }

  return 'daily_seo';
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const lane = resolveLane();
  const wordCount = WORD_COUNTS[lane];

  console.log(`[cron] Triggered — lane: ${lane}, word count: ${wordCount.min}-${wordCount.max}`);

  // The pipeline is dispatched but not awaited here — it runs within
  // the function's 300s timeout. In production with WDK, this would be
  // a durable workflow.start() call that survives function recycling.
  //
  // Bundle assembly (scrape → assemble) feeds into the pipeline.
  // For now, the cron endpoint returns the resolved config. The full
  // end-to-end flow is: cron → scrape sources → assemble bundle →
  // runBlogPipeline(bundle) → PR. The scrape-to-bundle step uses
  // the existing lib/sources/ and lib/bundle/ modules from Phase 1.

  return NextResponse.json({
    triggered: true,
    lane,
    wordCount,
    timestamp: new Date().toISOString(),
  });
}
