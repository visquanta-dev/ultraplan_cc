/**
 * Run the full blog pipeline locally - same code path as the cron route,
 * but free from serverless timeouts. Opens a real PR on success.
 *
 * Usage:
 *   npx tsx scripts/run-pipeline-local.ts [lane] [curatedBucket]
 *   npx tsx scripts/run-pipeline-local.ts daily_seo --max-attempts=2
 *
 *   Signal-driven attempts exclude earlier failed clusters within the same
 *   process. That lets GitHub Actions try the next viable topic without
 *   weakening any content gate.
 */
import '../lib/load-env';
import fs from 'node:fs';
import { resolveSlot, resolveOriginate, type ResolvedSlot } from '../lib/topics/resolver';
import { runBlogPipeline } from '../workflows/blog-pipeline';
import { getLaneWordCount, type Lane, type SourceStrategy } from '../lib/config/topics-config';
import { runPreflight } from '../lib/preflight/validate-config';

const VALID_LANES: Lane[] = ['daily_seo', 'weekly_authority', 'monthly_anonymized_case', 'listicle'];
const lane = (process.argv[2] as Lane) ?? 'daily_seo';
const curatedBucket = process.argv[3]?.startsWith('--') ? undefined : process.argv[3] ?? undefined;
const strategyFlag = process.argv.find(a => a.startsWith('--strategy='))?.split('=')[1]
  ?? (process.argv.includes('--strategy') ? process.argv[process.argv.indexOf('--strategy') + 1] : undefined);
const maxAttemptsFlag = process.argv.find(a => a.startsWith('--max-attempts='))?.split('=')[1]
  ?? (process.argv.includes('--max-attempts') ? process.argv[process.argv.indexOf('--max-attempts') + 1] : undefined)
  ?? process.env.MAX_PIPELINE_ATTEMPTS;

// Originate path detection - either inline seed or seed-file reference.
const originateSeedFile = process.env.ORIGINATE_SEED_FILE;
const originateSeedInline = process.env.ORIGINATE_SEED;
const originateCategory = process.env.ORIGINATE_CATEGORY || undefined;
let originateSeed: string | undefined;
if (originateSeedFile) {
  try {
    originateSeed = fs.readFileSync(originateSeedFile, 'utf-8').trim();
  } catch (err) {
    const message = `[local] failed to read ORIGINATE_SEED_FILE=${originateSeedFile}: ${err instanceof Error ? err.message : String(err)}`;
    console.error(message);
    fs.writeFileSync('pipeline-result.json', JSON.stringify({
      slug: 'unknown',
      lane,
      verdict: 'failed',
      error: message,
      durationMs: 0,
    }));
    process.exit(1);
  }
} else if (originateSeedInline) {
  originateSeed = originateSeedInline.trim();
}

if (!VALID_LANES.includes(lane)) {
  const message = `Unknown lane: ${lane}. Valid: ${VALID_LANES.join(', ')}`;
  console.error(message);
  fs.writeFileSync('pipeline-result.json', JSON.stringify({
    slug: 'unknown',
    lane,
    verdict: 'failed',
    error: message,
    durationMs: 0,
  }));
  process.exit(1);
}

const wordCount = getLaneWordCount(lane);
const startedAt = Date.now();
const requestedMaxAttempts = Math.max(1, Math.min(5, Number.parseInt(maxAttemptsFlag ?? '1', 10) || 1));
const maxAttempts = originateSeed || curatedBucket ? 1 : requestedMaxAttempts;

function writePipelineResult(result: Record<string, unknown>): void {
  fs.writeFileSync('pipeline-result.json', JSON.stringify(result));
}

function writeFailureResult(error: unknown): void {
  writePipelineResult({
    slug: 'unknown',
    lane,
    verdict: 'failed',
    error: error instanceof Error ? error.message : String(error),
    durationMs: Date.now() - startedAt,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stamp(label: string) {
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[local +${secs}s] ${label}`);
}

async function main() {
  const mode = originateSeed ? 'originate' : curatedBucket ? 'curated' : 'signal';
  stamp(`Starting pipeline - lane: ${lane}, mode: ${mode}, word count: ${wordCount.min}-${wordCount.max}${curatedBucket ? `, bucket: ${curatedBucket}` : ''}${originateSeed ? `, seed: ${originateSeed.length} chars` : ''}, max attempts: ${maxAttempts}`);

  stamp('preflight: begin');
  runPreflight();

  const attemptedClusterSlugs = new Set<string>();
  const attempts: Array<Record<string, unknown>> = [];
  let resultToWrite: Record<string, unknown> | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    stamp(`attempt ${attempt}/${maxAttempts}: resolve begin`);

    let bundleResult: ResolvedSlot;
    try {
      bundleResult = originateSeed
        ? await resolveOriginate({
            seed: originateSeed,
            lane,
            ...(originateCategory ? { category_id: originateCategory } : {}),
          })
        : await resolveSlot(lane, {
            onSearch: (n) => stamp(`resolveSlot.onSearch: ${n} articles`),
            onCluster: (c) => stamp(`resolveSlot.onCluster: "${c.label}" (${c.articles.length} articles)`),
            onScrape: (total, ok) => stamp(`resolveSlot.onScrape: ${ok}/${total} succeeded`),
            excludeClusterSlugs: attemptedClusterSlugs,
            ...(curatedBucket ? { curatedBucket, forcedStrategy: 'curated_first' as const } : {}),
            ...(strategyFlag ? { forcedStrategy: strategyFlag as SourceStrategy } : {}),
          });
    } catch (err) {
      const message = errorMessage(err);
      stamp(`attempt ${attempt}/${maxAttempts}: resolve failed - ${message}`);
      attempts.push({
        attempt,
        phase: 'resolve',
        verdict: 'failed',
        error: message,
        durationMs: Date.now() - startedAt,
      });
      resultToWrite = resultToWrite
        ? { ...resultToWrite, attempts }
        : {
            slug: 'unknown',
            lane,
            verdict: 'failed',
            error: message,
            durationMs: Date.now() - startedAt,
            attempts,
          };
      break;
    }

    const { bundle } = bundleResult;
    attemptedClusterSlugs.add(bundle.topic_slug);
    stamp(`resolve done - bundle slug "${bundle.topic_slug}", ${bundle.sources.length} sources${bundle.originate_seed ? ', ORIGINATE mode' : ''}`);

    stamp(`attempt ${attempt}/${maxAttempts}: runBlogPipeline begin`);
    let result;
    try {
      result = await runBlogPipeline({ bundle, wordCount });
    } catch (err) {
      const message = errorMessage(err);
      stamp(`attempt ${attempt}/${maxAttempts}: runBlogPipeline failed - ${message}`);
      attempts.push({
        attempt,
        phase: 'pipeline',
        topic_slug: bundle.topic_slug,
        slug: 'unknown',
        verdict: 'failed',
        error: message,
        durationMs: Date.now() - startedAt,
      });
      resultToWrite = {
        slug: 'unknown',
        lane,
        verdict: 'failed',
        error: message,
        durationMs: Date.now() - startedAt,
        attempts,
      };
      if (attempt < maxAttempts) {
        stamp(`attempt ${attempt}/${maxAttempts}: pipeline failed; trying next candidate`);
        continue;
      }
      break;
    }
    stamp(`attempt ${attempt}/${maxAttempts}: runBlogPipeline done - verdict: ${result.verdict}`);

    attempts.push({
      attempt,
      topic_slug: bundle.topic_slug,
      slug: result.slug,
      verdict: result.verdict,
      ...(result.prUrl ? { prUrl: result.prUrl } : {}),
      ...(result.error ? { error: result.error } : {}),
      durationMs: result.durationMs,
    });

    resultToWrite = {
      ...result,
      attempts,
    } as unknown as Record<string, unknown>;

    if (result.verdict === 'published') break;
    if (attempt < maxAttempts) {
      stamp(`attempt ${attempt}/${maxAttempts}: not published (${result.verdict}); trying next candidate`);
    }
  }

  const finalResult = resultToWrite ?? {
    slug: 'unknown',
    lane,
    verdict: 'failed',
    error: 'No pipeline attempt completed',
    durationMs: Date.now() - startedAt,
    attempts,
  };

  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(finalResult, null, 2));
  console.log(`\nTotal wall time: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  // Write result to file for CI consumption (GitHub Actions reads this).
  writePipelineResult(finalResult);

  if (finalResult.verdict !== 'published') {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.error(`\n[local +${secs}s] FATAL: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  writeFailureResult(err);
  process.exit(1);
});
