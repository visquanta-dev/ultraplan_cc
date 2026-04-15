import { NextRequest, NextResponse } from 'next/server';
import { getLaneWordCount, type Lane } from '../../../../lib/config/topics-config';

export const maxDuration = 800;

// ---------------------------------------------------------------------------
// Cron trigger — fires daily at 06:00 CT via Vercel Cron.
// resolveLane() maps the current weekday to one of three editorial lanes.
// Word counts come from config/topics.yaml (single source of truth) via
// lib/config/topics-config.ts — do not hardcode them here.
//
// Cadence (7 posts/week):
//   Mon, Tue, Thu, Fri, Sun → daily_seo
//   Wed, Sat                → weekly_authority
//   1st Fri of month        → monthly_anonymized_case (displaces Fri daily)
// ---------------------------------------------------------------------------

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
  const wordCount = getLaneWordCount(lane);

  console.log(`[cron] Triggered — lane: ${lane}, word count: ${wordCount.min}-${wordCount.max}`);

  // Run the full pipeline: topic discovery → scrape → bundle → draft → gates → PR
  // Dynamic imports so module-load errors surface as JSON, not Next.js /500.
  let stage = 'import:resolver';
  try {
    const { resolveSlot } = await import('../../../../lib/topics/resolver');
    stage = 'import:pipeline';
    const { runBlogPipeline } = await import('../../../../workflows/blog-pipeline');

    stage = 'resolveSlot';
    const { bundle } = await resolveSlot(lane);

    stage = 'runBlogPipeline';
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
    const stack = err instanceof Error ? err.stack?.split('\n').slice(0, 8).join('\n') : undefined;
    console.error(`[cron] Failed at stage=${stage}: ${message}`);

    return NextResponse.json(
      {
        triggered: true,
        lane,
        wordCount,
        failedAt: stage,
        error: message,
        stack,
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
