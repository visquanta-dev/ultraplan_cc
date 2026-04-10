import type { Bundle } from '../../lib/bundle/types';
import { generateOutline } from '../../lib/stages/outline';
import { draftParagraphs } from '../../lib/stages/paragraph-draft';
import { checkRephraseDistances } from '../../lib/stages/rephrase-distance';
import { voiceTransform } from '../../lib/stages/voice-transform';
import { runWithRetry } from '../../lib/gates/retry-loop';
import { runImagePipeline } from '../../lib/image/pipeline';
import { createDraftPR } from '../../lib/github';
import { logRun, logBlocked, extractGateScores, type RunRecord } from '../../lib/admin/run-logger';
import { notifyPipelineBlocked, notifyPRCreationFailed, notifyPipelineComplete } from '../../lib/notify';
import { withRetry } from '../../lib/retry';
import { insertExternalLinks, insertInternalLinks, buildMidArticleCTA, buildRelatedPosts } from '../../lib/stages/auto-linker';
import matter from 'gray-matter';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Blog pipeline workflow — spec §8-10
// The full end-to-end pipeline: bundle → outline → draft → gates → image
// → PR → notify. Called by the cron trigger or manually.
//
// In production this would use Vercel Workflow (WDK) for durable execution
// with step.run() and step.waitForEvent(). For now it's a plain async
// function that runs synchronously — WDK wrapping is a config change,
// not a logic change, once the @vercel/workflow SDK stabilizes.
// ---------------------------------------------------------------------------

export interface PipelineInput {
  bundle: Bundle;
  wordCount: { min: number; max: number };
}

export interface PipelineResult {
  slug: string;
  lane: string;
  verdict: 'published' | 'blocked' | 'failed';
  prUrl?: string;
  prNumber?: number;
  error?: string;
  durationMs: number;
}

/**
 * Run the full blog pipeline end-to-end.
 */
export async function runBlogPipeline(input: PipelineInput): Promise<PipelineResult> {
  const startTime = Date.now();
  const { bundle } = input;
  const slug = bundle.topic_slug;
  const lane = bundle.lane;

  console.log(`[pipeline] Starting: ${slug} (${lane})`);

  try {
    // Step 1: Generate outline
    console.log('[pipeline] Step 1/7: Generating outline');
    const outline = await generateOutline(bundle, input.wordCount);
    console.log(`[pipeline]   headline: "${outline.headline}"`);

    // Step 2: Draft paragraphs
    console.log('[pipeline] Step 2/7: Drafting paragraphs');
    const drafted = await draftParagraphs(outline, bundle, input.wordCount);
    console.log(`[pipeline]   paragraphs: ${drafted.paragraphs.length}`);

    // Step 3: Rephrase distance check
    console.log('[pipeline] Step 3/7: Checking rephrase distances');
    await checkRephraseDistances(drafted.paragraphs, bundle);

    // Step 4: Voice transform
    console.log('[pipeline] Step 4/7: Voice transform');
    const transformed = await voiceTransform(drafted.paragraphs);

    // Step 5: Hard gates with retry loop
    console.log('[pipeline] Step 5/7: Running gates with retry');
    const { report, paragraphs: finalParagraphs, retries } = await runWithRetry(
      { paragraphs: transformed.paragraphs, bundle, outline, attempt: 1 },
      {
        onGateStart: (gate) => console.log(`[pipeline]   gate: ${gate}...`),
        onGateFinish: (r) => console.log(`[pipeline]   ${r.gate}: ${r.passed ? 'PASS' : 'FAIL'}`),
        onRetryStart: (attempt, indices) =>
          console.log(`[pipeline]   retry ${attempt}: regenerating paragraphs [${indices.join(', ')}]`),
      },
    );

    console.log(`[pipeline]   verdict: ${report.verdict} (${retries} retries)`);

    // If blocked, log and notify
    if (report.verdict === 'blocked') {
      const record: RunRecord = {
        slug,
        lane,
        status: 'blocked',
        verdict: report.verdict,
        created_at: new Date().toISOString(),
        gate_scores: extractGateScores(report),
        gate_report: report,
        duration_ms: Date.now() - startTime,
      };
      await logBlocked(record);
      await notifyPipelineBlocked(slug, lane, report.blocked_reason ?? 'Unknown');
      return {
        slug,
        lane,
        verdict: 'blocked',
        error: report.blocked_reason,
        durationMs: Date.now() - startTime,
      };
    }

    // Step 6: Generate images
    console.log('[pipeline] Step 6/7: Generating images');
    const sectionHeadings = outline.sections.map((s) => s.heading);
    const imageResult = await runImagePipeline(slug, lane, outline.headline, sectionHeadings, {
      onImageStart: (type, idx) => console.log(`[pipeline]   generating ${type} ${idx}...`),
      onImageResult: (type, idx, passed, attempt) =>
        console.log(`[pipeline]   ${type} ${idx}: ${passed ? 'PASS' : 'FAIL'} (attempt ${attempt})`),
    });

    if (!imageResult.allPassed) {
      console.warn(`[pipeline]   ${imageResult.blockedImages.length} images blocked — continuing with available`);
    }

    // Step 7: Create GitHub PR
    console.log('[pipeline] Step 7/7: Creating GitHub PR');

    // Strip remaining (src_XXX) citation markers
    function stripCitations(text: string): string {
      return text.replace(/\s*\(src_\d+\)/g, '');
    }

    // Replace em dashes with regular dashes
    function stripEmDashes(text: string): string {
      return text.replace(/\s*—\s*/g, ' - ').replace(/\s*–\s*/g, ' - ');
    }

    // Deduplicate paragraphs that share >60% of the same sentences
    function extractSentences(text: string): Set<string> {
      return new Set(
        text.split(/[.!?]+/).map(s => s.trim().toLowerCase()).filter(s => s.length > 20)
      );
    }

    const dedupedParagraphs = finalParagraphs.filter((para, i) => {
      const sentences = extractSentences(para.text);
      for (let j = 0; j < i; j++) {
        const prevSentences = extractSentences(finalParagraphs[j].text);
        let overlap = 0;
        for (const s of sentences) { if (prevSentences.has(s)) overlap++; }
        if (sentences.size > 0 && overlap / sentences.size > 0.6) {
          console.log(`[pipeline]   dedup: dropped paragraph ${i} (>60% overlap with ${j})`);
          return false;
        }
      }
      return true;
    });

    // External links: convert (src_XXX) markers into inline source links
    console.log('[pipeline] Step 5b/7: Inserting external + internal links');
    const withExternalLinks = insertExternalLinks(dedupedParagraphs, bundle);

    // Render markdown by section
    const bodyBySection = new Map<number, string[]>();
    for (const para of withExternalLinks) {
      const sIdx: number = para.section_index;
      const arr = bodyBySection.get(sIdx) ?? [];
      arr.push(stripEmDashes(stripCitations(para.text)));
      bodyBySection.set(sIdx, arr);
    }

    // Internal links: scan rendered paragraphs and insert contextual links
    for (const [sIdx, paras] of bodyBySection.entries()) {
      bodyBySection.set(sIdx, insertInternalLinks(paras));
    }

    const sectionCount = outline.sections.length;
    const midPoint = Math.floor(sectionCount / 2);

    const bodyParts: string[] = [];
    outline.sections.forEach((section, i) => {
      bodyParts.push(`## ${stripEmDashes(section.heading)}\n`);
      const paras = bodyBySection.get(i) ?? [];
      bodyParts.push(paras.join('\n\n'));

      // Insert mid-article CTA after the middle section
      if (i === midPoint) {
        bodyParts.push(buildMidArticleCTA());
      }
      bodyParts.push('');
    });

    // Append related posts section
    const relatedPosts = buildRelatedPosts(bodyParts.join('\n'));
    if (relatedPosts) bodyParts.push(relatedPosts);

    const body = bodyParts.join('\n');

    // Generate real meta description from headline + first paragraph
    const firstPara = stripCitations(dedupedParagraphs[0]?.text ?? '');
    const metaDescription = firstPara.length > 155
      ? firstPara.slice(0, 152).replace(/\s+\S*$/, '') + '...'
      : firstPara;

    const LANE_TITLES: Record<string, string> = {
      daily_seo: 'Industry Insights',
      weekly_authority: 'Leadership',
      monthly_anonymized_case: 'Case Studies',
    };

    const frontmatter = {
      title: stripEmDashes(outline.headline),
      slug,
      metaDescription,
      image: `/images/blog/${slug}/hero.webp`,
      publishedAt: new Date().toISOString().split('T')[0],
      published: false,
      category: { slug: lane.replace(/_/g, '-'), title: LANE_TITLES[lane] ?? 'Article' },
      author: 'VisQuanta Team',
    };

    const markdownContent = matter.stringify(body, frontmatter);

    // Collect image files for PR
    const images = imageResult.paths.map((relPath) => ({
      relativePath: relPath.replace(/\\/g, '/'),
      absolutePath: path.join(process.cwd(), relPath),
    }));

    // Create PR with retry
    const prResult = await withRetry(
      () =>
        createDraftPR({
          slug,
          lane,
          markdownContent,
          images,
          gateReport: report,
          bundle,
          metadata: {
            gate_scores: extractGateScores(report),
            retries,
            image_count: imageResult.paths.length,
            blocked_images: imageResult.blockedImages,
          },
        }),
      {
        maxAttempts: 3,
        onRetry: (attempt, err) =>
          console.warn(`[pipeline]   PR creation retry ${attempt}: ${err.message}`),
      },
    );

    console.log(`[pipeline]   PR created: ${prResult.prUrl}`);

    // Log successful run
    const record: RunRecord = {
      slug,
      lane,
      status: 'pending_review',
      verdict: report.verdict,
      created_at: new Date().toISOString(),
      gate_scores: extractGateScores(report),
      gate_report: report,
      pr_url: prResult.prUrl,
      pr_number: prResult.prNumber,
      duration_ms: Date.now() - startTime,
    };
    await logRun(record);

    await notifyPipelineComplete(slug, lane, prResult.prUrl);

    return {
      slug,
      lane,
      verdict: 'published',
      prUrl: prResult.prUrl,
      prNumber: prResult.prNumber,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[pipeline] Fatal error: ${error}`);

    await notifyPRCreationFailed(slug, error);

    const record: RunRecord = {
      slug,
      lane,
      status: 'failed_silent',
      verdict: 'blocked',
      created_at: new Date().toISOString(),
      gate_scores: {},
      gate_report: {
        attempt: 0,
        verdict: 'blocked',
        results: [],
        failing_paragraph_indices: [],
        blocked_reason: error,
        generated_at: new Date().toISOString(),
      },
      error,
      duration_ms: Date.now() - startTime,
    };
    await logBlocked(record);

    return {
      slug,
      lane,
      verdict: 'failed',
      error,
      durationMs: Date.now() - startTime,
    };
  }
}
