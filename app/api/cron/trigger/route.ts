import { NextRequest, NextResponse } from 'next/server';
import { resolveSlot } from '../../../../lib/topics/resolver';
import { runBlogPipeline } from '../../../../workflows/blog-pipeline';

// ---------------------------------------------------------------------------
// Cron trigger — spec §9-10, hardened in Phase 13
// Receives Vercel Cron fires (Mon/Wed/Fri 06:00 CT), resolves lane,
// discovers a topic, and dispatches the blog pipeline end-to-end.
//
// Full flow: cron → search → cluster → scrape → bundle → pipeline → PR
// ---------------------------------------------------------------------------

type Lane = 'daily_seo' | 'weekly_authority' | 'monthly_anonymized_case';

const WORD_COUNTS: Record<Lane, { min: number; max: number }> = {
  daily_seo: { min: 1800, max: 2200 },
  weekly_authority: { min: 2200, max: 2800 },
  monthly_anonymized_case: { min: 2500, max: 3200 },
};

function resolveLane(): Lane {
  const now = new Date();
  const dayOfWeek = now.toLocaleDateString('en-US', {
    weekday: 'short',
    timeZone: 'America/Chicago',
  });

  // Wednesday + Saturday: leadership / authority content
  if (dayOfWeek === 'Wed' || dayOfWeek === 'Sat') return 'weekly_authority';

  // First Friday of the month: case study
  if (dayOfWeek === 'Fri') {
    const chicagoDate = new Date(
      now.toLocaleString('en-US', { timeZone: 'America/Chicago' }),
    );
    if (chicagoDate.getDate() <= 7) return 'monthly_anonymized_case';
  }

  // All other days: daily SEO content
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

  // Run the full pipeline: topic discovery → scrape → bundle → draft → gates → PR
  // This runs within the function's 300s timeout via Fluid Compute.
  try {
    const { bundle } = await resolveSlot(lane);

    const result = await runBlogPipeline({ bundle, wordCount });

    console.log(`[cron] Pipeline finished — verdict: ${result.verdict}, slug: ${result.slug}`);

    return NextResponse.json({
      triggered: true,
      lane,
      wordCount,
      slug: result.slug,
      verdict: result.verdict,
      prUrl: result.prUrl,
      durationMs: result.durationMs,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cron] Pipeline failed: ${message}`);

    return NextResponse.json(
      {
        triggered: true,
        lane,
        wordCount,
        error: message,
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
