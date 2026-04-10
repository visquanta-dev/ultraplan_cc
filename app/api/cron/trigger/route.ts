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
