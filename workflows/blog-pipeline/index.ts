import type { Bundle } from '../../lib/bundle/types';
import { generateOutline } from '../../lib/stages/outline';
import { draftParagraphs } from '../../lib/stages/paragraph-draft';
import { checkRephraseDistances } from '../../lib/stages/rephrase-distance';
import { voiceTransform } from '../../lib/stages/voice-transform';
import { runWithRetry } from '../../lib/gates/retry-loop';
import { runImagePipeline, type ImagePipelineResult } from '../../lib/image/pipeline';
import { createDraftPR } from '../../lib/github';
import { logRun, logBlocked, extractGateScores, type RunRecord } from '../../lib/admin/run-logger';
import { notifyPipelineBlocked, notifyPRCreationFailed, notifyPipelineComplete } from '../../lib/notify';
import { withRetry } from '../../lib/retry';
import { insertExternalLinks, insertInternalLinks, buildMidArticleCTA, buildRelatedPosts } from '../../lib/stages/auto-linker';
import { enrichContent, renderTLDR, renderTable, renderFAQ, renderFAQSchema, insertTables } from '../../lib/stages/enrich-content';
import { insertToolEmbeds } from '../../lib/stages/embed-tools';
import { slugifyHeadline } from '../../lib/topics/cluster';
import { runPreflight } from '../../lib/preflight/validate-config';
import { runSeoAeoGate } from '../../lib/gates/seo-aeo';
import { callLLMStructured } from '../../lib/llm/openrouter';
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

/**
 * Generate an LLM-crafted meta description optimized for SERP click-through
 * and AI engine snippet extraction. Replaces the old first-paragraph truncation.
 */
async function generateMetaDescription(headline: string, openingText: string): Promise<string> {
  try {
    const result = await callLLMStructured<{ metaDescription: string }>({
      system: [
        'You write meta descriptions for blog posts about car dealership operations.',
        'Rules:',
        '- Exactly 120-155 characters (this is critical for SERP display)',
        '- Start with a concrete benefit, stat, or question that makes a dealer GM click',
        '- Include the core topic keyword naturally',
        '- End with implicit value (what they will learn or gain)',
        '- No hype words: no "revolutionary", "game-changing", "unlock", "supercharge"',
        '- No brand name (VisQuanta) — this is editorial, not promotional',
        '- Write for humans first, search engines second',
      ].join('\n'),
      user: `Headline: ${headline}\n\nOpening content: ${openingText.slice(0, 800)}`,
      schema: {
        type: 'object',
        properties: {
          metaDescription: { type: 'string', description: 'The meta description, 120-155 characters' },
        },
        required: ['metaDescription'],
      },
      parse: (raw) => {
        const obj = raw as Record<string, unknown>;
        let desc = String(obj.metaDescription ?? '').trim();
        // Hard cap at 160 chars as safety net
        if (desc.length > 160) desc = desc.slice(0, 157).replace(/\s+\S*$/, '') + '...';
        return { metaDescription: desc };
      },
      maxTokens: 256,
      temperature: 0.6,
    });
    return result.metaDescription;
  } catch {
    // Fallback to old truncation if LLM fails
    const fallback = openingText.slice(0, 155);
    return fallback.length > 152 ? fallback.slice(0, 152).replace(/\s+\S*$/, '') + '...' : fallback;
  }
}

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
  const clusterSlug = bundle.topic_slug; // working ID until the headline exists
  let slug = clusterSlug; // reassigned from headline after Step 1
  const lane = bundle.lane;

  // Preflight integrity check — throws loudly if any scaffolded surface
  // is still empty. Fails BEFORE we spend any LLM tokens so a broken
  // config can't waste money or ship garbage. See lib/preflight for
  // the current list of checks.
  runPreflight();

  console.log(`[pipeline] Starting: ${clusterSlug} (${lane})`);

  try {
    // Step 1: Generate outline
    console.log('[pipeline] Step 1/7: Generating outline');
    const outline = await generateOutline(bundle, input.wordCount);
    console.log(`[pipeline]   headline: "${outline.headline}"`);

    // Re-derive the post slug from the headline. The cluster slug (e.g.
    // "dealerships-dealership-2026") is a keyword bag from the resolver and
    // makes for ugly URLs; a headline slug is keyword-dense and readable.
    // Every downstream consumer (images, frontmatter, PR, dedup record)
    // uses this from here on.
    slug = slugifyHeadline(outline.headline);
    console.log(`[pipeline]   post slug: ${slug} (was cluster slug: ${clusterSlug})`);

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
    let imageResult: ImagePipelineResult;
    try {
      imageResult = await runImagePipeline(slug, lane, outline.headline, sectionHeadings, {
        onImageStart: (type, idx) => console.log(`[pipeline]   generating ${type} ${idx}...`),
        onImageResult: (type, idx, passed, attempt) =>
          console.log(`[pipeline]   ${type} ${idx}: ${passed ? 'PASS' : 'FAIL'} (attempt ${attempt})`),
      }, finalParagraphs.map(p => p.text).join('\n\n'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[pipeline]   image pipeline threw (${msg}) — degrading to empty result, hero will fall back`);
      imageResult = { paths: [], altTexts: {}, gateResults: [], allPassed: false, blockedImages: ['hero.webp'] };
    }

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

    // Internal links: scan rendered paragraphs and insert contextual links.
    // One call over the flat paragraph list so the 8-link cap applies per-post,
    // not per-section (which is how posts were shipping with 14+ internal links).
    const flatTexts: string[] = [];
    const flatSections: number[] = [];
    for (const [sIdx, paras] of bodyBySection.entries()) {
      for (const p of paras) {
        flatTexts.push(p);
        flatSections.push(sIdx);
      }
    }
    const linkedTexts = insertInternalLinks(flatTexts);
    bodyBySection.clear();
    linkedTexts.forEach((text, i) => {
      const sIdx = flatSections[i];
      const arr = bodyBySection.get(sIdx) ?? [];
      arr.push(text);
      bodyBySection.set(sIdx, arr);
    });

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

    // Enrichment: TL;DR, tables, FAQ
    console.log('[pipeline] Step 5c/7: Enriching content (TL;DR + tables + FAQ)');
    try {
      const articleText = bodyParts.join('\n');
      const enriched = await enrichContent(articleText, bundle, outline.headline);

      // Insert TL;DR at the very top of the body, BEFORE the first H2.
      // LLMs (Google AI Overviews, ChatGPT, Perplexity, Claude) extract the
      // first block of prose under an article headline as the primary answer
      // candidate for AI search queries, so the summary needs to live above
      // any section heading. Formatted as a markdown blockquote with an
      // explicit "TL;DR:" label — the label is a convention LLMs recognize
      // and the blockquote marks it visually distinct from body prose.
      if (enriched.tldr) {
        bodyParts.unshift(`> **TL;DR:** ${stripEmDashes(enriched.tldr)}\n`);
      }

      // Insert tables at target positions
      if (enriched.tables.length > 0) {
        const headings = outline.sections.map(s => s.heading);
        const withTables = insertTables(bodyParts, enriched.tables, headings);
        bodyParts.length = 0;
        bodyParts.push(...withTables);
      }

      // Append FAQ before Related Reading
      if (enriched.faqs.length > 0) {
        const cleanFaqs = enriched.faqs.map(f => ({
          question: stripEmDashes(f.question),
          answer: stripEmDashes(f.answer),
        }));
        bodyParts.push(renderFAQ(cleanFaqs));
        // Embed FAQPage JSON-LD schema for Google rich results + AI engine consumption
        bodyParts.push(renderFAQSchema(cleanFaqs));
      }

      console.log(`[pipeline]   enriched: ${enriched.tables.length} tables, ${enriched.faqs.length} FAQs`);
    } catch (err) {
      console.warn('[pipeline]   enrichment failed (non-fatal):', (err as Error).message);
    }

    // Insert contextual calculator/tool embed via topic classifier
    console.log('[pipeline] Step 5d/7: Classifying + inserting tool embed');
    const introText = dedupedParagraphs
      .slice(0, 3)
      .map((p) => stripEmDashes(stripCitations(p.text)))
      .join(' ');
    const embedResult = await insertToolEmbeds(bodyParts, {
      headline: outline.headline,
      sectionHeadings: outline.sections.map((s) => s.heading),
      introText,
    });
    bodyParts.length = 0;
    bodyParts.push(...embedResult.parts);
    if (embedResult.inserted.length > 0) {
      console.log(`[pipeline]   embedded: ${embedResult.inserted.join(', ')}`);
    } else if (embedResult.skipped) {
      console.log(
        `[pipeline]   no embed: ${embedResult.skipped.reason} (slug=${embedResult.skipped.slug ?? 'null'}, conf=${embedResult.skipped.confidence.toFixed(2)})`,
      );
    }

    // Append related posts section
    const relatedPosts = buildRelatedPosts(bodyParts.join('\n'));
    if (relatedPosts) bodyParts.push(relatedPosts);

    const body = bodyParts.join('\n');

    // Calculate reading time
    const wordCount2 = body.split(/\s+/).filter(Boolean).length;
    const readingTime = Math.max(1, Math.ceil(wordCount2 / 200));

    // Generate LLM-crafted meta description for SERP + AI snippet extraction
    const metaDescription = await generateMetaDescription(
      outline.headline,
      dedupedParagraphs.slice(0, 4).map(p => stripEmDashes(stripCitations(p.text))).join(' '),
    );

    const LANE_TITLES: Record<string, string> = {
      daily_seo: 'Industry Insights',
      weekly_authority: 'Leadership',
      monthly_anonymized_case: 'Case Studies',
    };

    const LANE_TAGS: Record<string, Array<{ slug: string; title: string }>> = {
      daily_seo: [
        { slug: 'dealership-operations', title: 'Dealership Operations' },
        { slug: 'service-drive', title: 'Service Drive' },
        { slug: 'automation', title: 'Automation' },
      ],
      weekly_authority: [
        { slug: 'leadership', title: 'Leadership' },
        { slug: 'dealer-principal', title: 'Dealer Principal' },
        { slug: 'dealership-operations', title: 'Dealership Operations' },
      ],
      monthly_anonymized_case: [
        { slug: 'case-study', title: 'Case Study' },
        { slug: 'dealership-operations', title: 'Dealership Operations' },
        { slug: 'results', title: 'Results' },
      ],
    };

    // Resolve the hero image path from the actual file the image pipeline
    // wrote to disk (which now uses the real format's extension, not a
    // hardcoded .webp).
    //
    // If the image pipeline couldn't produce a hero (all retries failed
    // the image gates), fall back to an EXISTING site image rather than
    // pointing at a slug-specific path that was never written. Previously
    // the fallback was /images/blog/${slug}/hero.webp — which looks right
    // but points at a file that doesn't exist, resulting in a broken img
    // tag on the live post. Using a known-good existing image means the
    // post still ships with something visible instead of a 404'd hero.
    //
    // The fallback path below MUST exist on the site repo. Currently
    // using /images/wireframes/6.jpeg because it's already referenced
    // by getPostFeaturedImage() as a category fallback and is present on
    // disk. If that image moves, update this fallback too.
    const FALLBACK_HERO_PATH = '/images/wireframes/6.jpeg';
    const heroRelPath = imageResult.paths.find((p) => p.includes('hero.'));
    let heroFrontmatterPath: string;
    let usedHeroFallback = false;
    if (heroRelPath) {
      heroFrontmatterPath = '/' + heroRelPath.replace(/^public[/\\]/, '').replace(/\\/g, '/');
    } else {
      heroFrontmatterPath = FALLBACK_HERO_PATH;
      usedHeroFallback = true;
      console.warn(
        `[pipeline]   WARNING: no hero image generated (all ${imageResult.blockedImages.length} attempts blocked by image gates). Falling back to ${FALLBACK_HERO_PATH}. Replace manually before merge.`,
      );
    }

    const frontmatter = {
      title: stripEmDashes(outline.headline),
      slug,
      metaDescription,
      image: heroFrontmatterPath,
      readingTime,
      publishedAt: new Date().toISOString().split('T')[0],
      updatedAt: new Date().toISOString().split('T')[0],
      published: true,
      category: { slug: lane.replace(/_/g, '-'), title: LANE_TITLES[lane] ?? 'Article' },
      tags: LANE_TAGS[lane] ?? [],
      author: 'VisQuanta Team',
    };

    const markdownContent = matter.stringify(body, frontmatter);

    // Step 5e/7: SEO + AEO gate
    // Runs a deterministic rubric against the finished markdown. Tiered
    // enforcement: >=85% passes silently, 70-84% adds a warning label,
    // <70% demotes verdict to blocked. This is the layer that makes
    // "10/10 going forward" actually enforceable.
    console.log('[pipeline] Step 5e/7: Running SEO + AEO gate');
    const seoAeoResult = await runSeoAeoGate({
      markdown: markdownContent,
      outline,
      paragraphs: finalParagraphs,
      frontmatter: {
        title: frontmatter.title,
        slug: frontmatter.slug,
        metaDescription: frontmatter.metaDescription,
        image: frontmatter.image,
      },
    });
    const seoAeoScore = seoAeoResult.aggregate_score ?? 0;
    console.log(`[pipeline]   SEO+AEO: ${seoAeoResult.summary}`);
    for (const f of seoAeoResult.paragraph_findings) {
      if (!f.passed) console.log(`[pipeline]     x  ${f.reason}`);
    }

    const seoAeoBlocked = seoAeoScore < 70;
    const seoAeoWarning = seoAeoScore >= 70 && seoAeoScore < 85;

    if (seoAeoBlocked) {
      console.error(
        `[pipeline]   SEO+AEO score ${seoAeoScore}% is below blocking threshold (70%). Refusing to ship.`,
      );
      const blockRecord: RunRecord = {
        slug,
        lane,
        status: 'blocked',
        verdict: 'blocked',
        created_at: new Date().toISOString(),
        gate_scores: { ...extractGateScores(report), 'seo-aeo': seoAeoScore },
        gate_report: report,
        duration_ms: Date.now() - startTime,
        error: `SEO+AEO score ${seoAeoScore}% below blocking threshold`,
      };
      await logBlocked(blockRecord);
      await notifyPipelineBlocked(slug, lane, `SEO+AEO score ${seoAeoScore}% below blocking threshold`);
      return {
        slug,
        lane,
        verdict: 'blocked',
        error: `SEO+AEO score ${seoAeoScore}% below blocking threshold`,
        durationMs: Date.now() - startTime,
      };
    }

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
          heroFallbackUsed: usedHeroFallback,
          seoAeoScore,
          seoAeoWarning,
          metadata: {
            gate_scores: { ...extractGateScores(report), 'seo-aeo': seoAeoScore },
            retries,
            image_count: imageResult.paths.length,
            blocked_images: imageResult.blockedImages,
            hero_fallback_used: usedHeroFallback,
            seo_aeo_score: seoAeoScore,
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
