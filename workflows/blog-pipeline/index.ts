import type { Bundle } from '../../lib/bundle/types';
import { generateOutline } from '../../lib/stages/outline';
import { draftParagraphs } from '../../lib/stages/paragraph-draft';
import { checkRephraseDistances } from '../../lib/stages/rephrase-distance';
import { voiceTransform } from '../../lib/stages/voice-transform';
import { runWithRetry } from '../../lib/gates/retry-loop';
import { runMultiOptionImagePipeline, type ImagePipelineResult, type MultiOptionImageResult } from '../../lib/image/pipeline';
import { renderChart } from '../../lib/image/chart-renderer';
import { createDraftPR } from '../../lib/github';
import { logRun, logBlocked, extractGateScores, type RunRecord } from '../../lib/admin/run-logger';
import { notifyPipelineBlocked, notifyPRCreationFailed, notifyPipelineComplete } from '../../lib/notify';
import { withRetry } from '../../lib/retry';
import { insertExternalLinks, insertInternalLinks, buildMidArticleCTA, buildRelatedPosts } from '../../lib/stages/auto-linker';
import { insertBrandLinks } from '../../lib/stages/brand-links';
import { routeAuthorForPost } from '../../lib/authors';
import { insertToolEmbeds } from '../../lib/stages/embed-tools';
import { slugifyHeadline } from '../../lib/topics/cluster';
import { findAvailableSlug, SlugCollisionError, checkPostOverlap, PostOverlapError } from '../../lib/topics/dedup';
import { runPreflight } from '../../lib/preflight/validate-config';
import { runSeoAeoGate } from '../../lib/gates/seo-aeo';
import { callLLMStructured } from '../../lib/llm/openrouter';
import { ALLOWED_ENTITIES, type TopicalEntity } from '../../lib/entities';
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
  // Retry once if the first attempt comes back outside 125-158 chars. The
  // SEO gate wants 120-160 for full pass and we want margin — a meta
  // description that lands at 119 or 161 tanks the check for a single
  // character, which is avoidable by validating and regenerating.
  const inRange = (s: string) => s.length >= 125 && s.length <= 158;

  async function attempt(attemptNum: number): Promise<string> {
    const lengthHint = attemptNum === 0
      ? 'Exactly 130-155 characters (not 120, not 160 — aim for the middle of the 130-155 band)'
      : 'You returned a previous attempt with wrong length. Aim for EXACTLY 140 characters, hard-count them, no shorter than 130, no longer than 155.';
    const result = await callLLMStructured<{ metaDescription: string }>({
      system: [
        'You write meta descriptions for blog posts about car dealership operations.',
        'Rules:',
        `- ${lengthHint}`,
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
          metaDescription: { type: 'string', description: 'The meta description, 130-155 characters' },
        },
        required: ['metaDescription'],
      },
      parse: (raw) => {
        const obj = raw as Record<string, unknown>;
        let desc = String(obj.metaDescription ?? '').trim();
        if (desc.length > 160) desc = desc.slice(0, 157).replace(/\s+\S*$/, '') + '...';
        return { metaDescription: desc };
      },
      maxTokens: 256,
      temperature: 0.5,
    });
    return result.metaDescription;
  }

  try {
    let desc = await attempt(0);
    if (!inRange(desc)) {
      console.warn(`[pipeline]   meta description out of range (${desc.length} chars), retrying`);
      desc = await attempt(1);
    }
    return desc;
  } catch {
    // Fallback to old truncation if LLM fails entirely
    const fallback = openingText.slice(0, 155);
    return fallback.length > 152 ? fallback.slice(0, 152).replace(/\s+\S*$/, '') + '...' : fallback;
  }
}

function cleanDashChars(text: string): string {
  return text.replace(/\s*[\u2013\u2014]\s*/g, ' - ');
}

function normalizeHeadlineForSeo(headline: string): string {
  let cleaned = cleanDashChars(headline).replace(/\s+/g, ' ').trim();
  if (cleaned.length > 60) {
    cleaned = cleaned.slice(0, 60).replace(/\s+\S*$/, '').replace(/[,:;!?-]+$/g, '').trim();
  }
  if (cleaned.length < 30 && !/\bdealer|dealership|BDC|fixed ops|service\b/i.test(cleaned)) {
    const suffix = ' for Dealerships';
    if (cleaned.length + suffix.length <= 60) cleaned += suffix;
  }
  return cleaned || headline.trim();
}

function normalizeMetaDescriptionForSeo(description: string, headline: string, openingText: string): string {
  let cleaned = cleanDashChars(description).replace(/\s+/g, ' ').trim();
  if (cleaned.length >= 120 && cleaned.length <= 160) return cleaned;

  const opening = cleanDashChars(openingText)
    .replace(/\[[^\]]+\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  cleaned = `${headline}: ${opening}`.replace(/\s+/g, ' ').trim();
  if (cleaned.length > 155) {
    cleaned = cleaned.slice(0, 155).replace(/\s+\S*$/, '').replace(/[,:;!?-]+$/g, '').trim();
  }
  while (cleaned.length < 120) {
    const addition = cleaned.length < 95
      ? ' See the dealer numbers, risks, and next steps for 2026.'
      : ' Built for dealer operators in 2026.';
    if (cleaned.length + addition.length > 160) break;
    cleaned += addition;
  }
  return cleaned;
}

const SEO_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'do', 'does', 'this', 'that',
  'these', 'those', 'still', 'why', 'how', 'what', 'here', 'after',
]);

function headlineTokens(headline: string): string[] {
  return headline
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !SEO_STOPWORDS.has(w))
    .slice(0, 3);
}

function sentenceSplit(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
}

function plainText(markdown: string): string {
  return cleanDashChars(markdown)
    .replace(/\[[^\]]+\]\([^)]+\)/g, '$1')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function decapitalize(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function splitLongSentence(sentence: string): string {
  if (wordCount(sentence) <= 32) return sentence;

  const patterns = [
    /,\s+(and|but|because|while|which|so|then|where|when)\s+/i,
    /\s+(because|while|which|where|when)\s+/i,
    /;\s+/,
    /:\s+/,
    /\s+-\s+/,
  ];

  for (const pattern of patterns) {
    const match = sentence.match(pattern);
    if (!match || match.index === undefined) continue;

    const left = sentence.slice(0, match.index).trim();
    let right = sentence.slice(match.index + match[0].length).trim();
    right = right.replace(/^(and|but|so|then)\s+/i, '');
    if (wordCount(left) >= 8 && wordCount(right) >= 8) {
      return `${left}. ${capitalize(splitLongSentence(right))}`;
    }
  }

  return sentence;
}

function enforceReadableSentences(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => splitLongSentence(sentence.trim()))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSeoOpening(headline: string, opening: string): string {
  const tokens = headlineTokens(headline);
  const first100 = opening.split(/\s+/).slice(0, 100).join(' ').toLowerCase();
  const matched = tokens.filter((t) => first100.includes(t)).length;
  const hasNumber = /\d/.test(opening);
  if (matched >= 2 && hasNumber) return enforceReadableSentences(opening);

  const prefix = `In 2026, the core answer behind "${headline}" is operational:`;
  return enforceReadableSentences(`${prefix} ${decapitalize(opening.trim())}`);
}

function isQuestionHeadingText(heading: string): boolean {
  const first = heading.replace(/[#\s]+/, '').split(/\s/)[0]?.toLowerCase() ?? '';
  return heading.trim().endsWith('?') ||
    ['what', 'why', 'how', 'when', 'where', 'which', 'who', 'is', 'are', 'does', 'do', 'can', 'should', 'will'].includes(first);
}

function topicPhraseFromHeadline(headline: string): string {
  const words = headline
    .replace(/[$%]/g, '')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !SEO_STOPWORDS.has(w.toLowerCase()))
    .slice(0, 5);
  return words.join(' ') || 'the dealership issue';
}

function normalizeRenderedHeadings(headline: string, headings: string[], lane: string): string[] {
  const topic = topicPhraseFromHeadline(headline);
  if (lane === 'listicle') {
    const rendered = headings.map((h) => cleanDashChars(h));
    const hasWhatIs = rendered.some((h) => /\bwhat\s+is\b/i.test(h));
    if (!hasWhatIs && rendered.length > 0) {
      const introIdx = rendered.findIndex((h) => !/^\d+\.\s+/.test(h.trim()));
      const idx = introIdx >= 0 ? introIdx : 0;
      const number = rendered[idx].match(/^(\d+\.\s+)/)?.[1] ?? '';
      rendered[idx] = `${number}What is ${topic}?`;
    }
    return rendered;
  }

  let questionCount = headings.filter(isQuestionHeadingText).length;
  const hasWhatIs = headings.some((h) => /\bwhat\s+is\b/i.test(h));

  return headings.map((raw, idx) => {
    const heading = cleanDashChars(raw);
    if (idx === 0 && !hasWhatIs) {
      if (!isQuestionHeadingText(heading)) questionCount += 1;
      return `What is ${topic}?`;
    }
    if (questionCount >= 4 || isQuestionHeadingText(heading)) return heading;

    questionCount += 1;
    const base = heading.replace(/[?!.]+$/g, '').trim();
    const templates = [
      `Why does ${base} matter to dealers?`,
      `How should dealers read ${base}?`,
      `What should dealers do about ${base}?`,
      `When does ${base} start costing the store?`,
    ];
    return templates[idx % templates.length];
  });
}

function fallbackSubsections(heading: string, count: number): string[] {
  const base = heading.replace(/[?!.]+$/g, '').replace(/^(what|why|how|when|where|which|who|is|are|does|do|can|should|will)\s+/i, '').trim();
  return [
    `Dealer impact`,
    `Evidence behind ${base || 'the pattern'}`,
    `What to measure next`,
  ].slice(0, Math.max(1, Math.min(3, count)));
}

function renderSectionWithSubsections(heading: string, subsections: string[] | undefined, paragraphs: string[]): string {
  const parts = [`## ${heading}\n`];
  if (paragraphs.length === 0) return parts.join('\n');

  const h3s = (subsections && subsections.length > 0 ? subsections : fallbackSubsections(heading, paragraphs.length))
    .map((h) => cleanDashChars(h))
    .slice(0, Math.max(1, Math.min(3, paragraphs.length)));

  paragraphs.forEach((paragraph, idx) => {
    const h3 = h3s[Math.min(idx, h3s.length - 1)];
    if (idx < h3s.length) parts.push(`### ${h3}\n`);
    parts.push(paragraph);
    parts.push('');
  });
  return parts.join('\n');
}

function buildKeyTakeaways(paragraphs: string[]): string {
  const sentences = paragraphs.flatMap((p) => sentenceSplit(plainText(p)).slice(0, 1));
  const dealerSentences = sentences.filter((s) => /\bdealer|dealership|BDC|service|lead|store|rooftop|customer/i.test(s));
  const bullets: string[] = [];
  for (const sentence of [...dealerSentences, ...sentences]) {
    if (!bullets.includes(sentence)) bullets.push(sentence);
    if (bullets.length === 5) break;
  }
  if (bullets.length < 5) return '';
  return ['', '### Key Takeaways', '', ...bullets.map((b) => `- ${b}`), ''].join('\n');
}

function sourceNameById(bundle: Bundle): Map<string, string> {
  const map = new Map<string, string>();
  for (const source of bundle.sources) {
    const domain = source.domain.replace(/^www\./, '');
    const siteName = domain.split('.')[0] || domain;
    map.set(source.source_id, siteName.charAt(0).toUpperCase() + siteName.slice(1));
  }
  return map;
}

function escapeTableCell(text: string): string {
  return plainText(text).replace(/\|/g, '/').slice(0, 180);
}

function buildEvidenceTable(paragraphs: Array<{ text: string; section_index: number; source_id?: string }>, outline: { sections: Array<{ heading: string }> }, bundle: Bundle): string {
  const sources = sourceNameById(bundle);
  const rows = paragraphs.slice(0, 6).map((p) => {
    const heading = outline.sections[p.section_index]?.heading ?? 'Dealer operations';
    const sentence = sentenceSplit(plainText(p.text))[0] ?? plainText(p.text);
    return [
      escapeTableCell(heading),
      escapeTableCell(sentence),
      escapeTableCell(sources.get(p.source_id ?? '') ?? p.source_id ?? 'Source'),
    ];
  });
  if (rows.length < 4) return '';

  const header = '| Dealer question | Evidence anchor | Source |';
  const separator = '| --- | --- | --- |';
  return [
    '',
    '### Evidence Map',
    '',
    header,
    separator,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
    '',
  ].join('\n');
}

function buildFaqSection(headline: string, paragraphs: string[]): string {
  const answers = paragraphs
    .flatMap((p) => sentenceSplit(p))
    .filter((s) => plainText(s).split(/\s+/).length >= 12)
    .map(enforceReadableSentences)
    .slice(0, 5);
  if (answers.length < 5) return '';

  const topic = topicPhraseFromHeadline(headline).toLowerCase();
  const questions = [
    `What should dealers take from ${topic}?`,
    `How does this change BDC or showroom follow-up?`,
    `What numbers should a general manager watch first?`,
    `When does this become an ROI problem?`,
    `How should a dealership act on this in 2026?`,
  ];

  return [
    '',
    '## Frequently Asked Questions',
    '',
    ...questions.map((q, i) => [`### ${q}`, '', answers[i], ''].join('\n')),
  ].join('\n');
}

function choosePostEntities(text: string): TopicalEntity[] {
  const lower = text.toLowerCase();
  const picks = ['Car dealership'];
  if (/review|reputation|csi|satisfaction/.test(lower)) picks.push('Reputation management', 'Customer review');
  else if (/service|fixed ops|advisor|repair/.test(lower)) picks.push('Automobile repair shop', 'Customer experience');
  else if (/lead|bdc|sms|follow-up|crm/.test(lower)) picks.push('Lead generation', 'Customer relationship management');
  else if (/call|voice|phone/.test(lower)) picks.push('Voice user interface', 'Call centre');
  else if (/cost|payroll|salary|budget|margin|roi|return on investment|\$|profit/.test(lower)) picks.push('Return on investment', 'Call centre');
  else picks.push('Automotive industry', 'Business process automation');

  const byName = new Map(ALLOWED_ENTITIES.map((e) => [e.name, e]));
  const out: TopicalEntity[] = [];
  for (const name of picks) {
    const entity = byName.get(name);
    if (entity && !out.some((e) => e.sameAs === entity.sameAs)) out.push(entity);
  }
  return out.slice(0, 3);
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
    outline.headline = normalizeHeadlineForSeo(outline.headline);
    console.log(`[pipeline]   headline: "${outline.headline}"`);

    // Re-derive the post slug from the headline. The cluster slug (e.g.
    // "dealerships-dealership-2026") is a keyword bag from the resolver and
    // makes for ugly URLs; a headline slug is keyword-dense and readable.
    // Every downstream consumer (images, frontmatter, PR, dedup record)
    // uses this from here on.
    slug = slugifyHeadline(outline.headline);
    console.log(`[pipeline]   post slug: ${slug} (was cluster slug: ${clusterSlug})`);

    // Headline-slug collision guard. Cluster-level dedup runs before the
    // outline exists, so it can't catch the case where two different clusters
    // produce the same headline-derived slug. On collision the pipeline
    // ABORTS rather than auto-suffixing -v{N} — clean URLs are non-negotiable
    // (see 2026-04-17 post-mortem where two -v2 slugs shipped to production
    // because Vercel Blob carried ghost entries from earlier failed runs).
    try {
      const resolved = await findAvailableSlug(slug);
      slug = resolved.slug;
    } catch (err) {
      if (err instanceof SlugCollisionError) {
        console.warn(`[pipeline]   slug collision on "${err.collidedSlug}" — aborting this run cleanly`);
        const abortRecord: RunRecord = {
          slug: err.collidedSlug,
          lane: bundle.lane,
          status: 'blocked',
          verdict: 'blocked',
          created_at: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
          error: err.message,
          gate_scores: {},
          gate_report: { verdict: 'blocked', attempt: 0, results: [] } as unknown as RunRecord['gate_report'],
        };
        await logBlocked(abortRecord);
        return {
          slug: err.collidedSlug,
          lane: bundle.lane,
          verdict: 'blocked',
          error: 'slug collision — topic already published; next run picks a different cluster',
          durationMs: Date.now() - startTime,
        };
      }
      throw err;
    }

    // Step 2: Draft paragraphs
    console.log('[pipeline] Step 2/7: Drafting paragraphs');
    const drafted = await draftParagraphs(outline, bundle, input.wordCount);
    console.log(`[pipeline]   paragraphs: ${drafted.paragraphs.length}`);

    // Step 3: Rephrase distance check
    console.log('[pipeline] Step 3/7: Checking rephrase distances');
    const draftDistances = await checkRephraseDistances(drafted.paragraphs, bundle);
    const draftDistanceFailures = draftDistances.filter((d) => !d.in_band);
    if (draftDistanceFailures.length > 0) {
      console.warn(
        `[pipeline]   draft rephrase-distance warnings before voice transform (${draftDistanceFailures.length}/${draftDistances.length}); trace-back gate will enforce after voice transform`,
      );
    }

    // Step 4: Voice transform
    console.log('[pipeline] Step 4/7: Voice transform');
    const transformed = await voiceTransform(drafted.paragraphs);

    // Step 5: Hard gates with retry loop
    console.log('[pipeline] Step 5/7: Running gates with retry');
    const { report, paragraphs: finalParagraphs, retries } = await runWithRetry(
      { paragraphs: transformed.paragraphs, bundle, outline, attempt: 1 },
      {
        onGateStart: (gate) => console.log(`[pipeline]   gate: ${gate}...`),
        onGateFinish: (r) => {
          const failing = r.failing_paragraph_indices.length
            ? ` failing=[${r.failing_paragraph_indices.join(', ')}]`
            : '';
          console.log(`[pipeline]   ${r.gate}: ${r.passed ? 'PASS' : 'FAIL'} — ${r.summary}${failing}`);
        },
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

    // Step 6: Generate hero image
    // Two paths: if the outline emitted a `chart:` block (stat-hero posts),
    // render the editorial chart PNG via chart-renderer. Otherwise run the
    // multi-option metaphor image pipeline. The chart path short-circuits
    // the whole metaphor/Pexels stack — no AI image generation, no gates,
    // no overlay compositing. Malformed chart specs are already rejected
    // upstream by validateChartSpec in the outline parser.
    console.log('[pipeline] Step 6/7: Generating images');
    const sectionHeadings = outline.sections.map((s) => s.heading);
    const articleText = finalParagraphs.map(p => p.text).join('\n\n');

    let imageResult: ImagePipelineResult;
    let multiImageResult: MultiOptionImageResult | null = null;
    let chartRelPath: string | null = null;

    if (outline.chart) {
      console.log(`[pipeline]   chart path: ${outline.chart.type} (${outline.chart.data.length} pts)`);
      try {
        // Strip em-dashes from every chart-visible string. The drafter pipeline
        // does this for body prose but the chart spec bypasses that normalizer;
        // without this step, em-dashes render verbatim in the PNG and violate
        // the voice rule enforced by seo/no-em-dashes.
        const cleanedChart = {
          ...outline.chart,
          headline: stripEmDashes(outline.chart.headline),
          source: outline.chart.source ? stripEmDashes(outline.chart.source) : undefined,
          data: outline.chart.data.map((d) => ({
            ...d,
            label: stripEmDashes(d.label),
            ...(d.valueLabel ? { valueLabel: stripEmDashes(d.valueLabel) } : {}),
          })),
        };
        const chartPng = await renderChart(cleanedChart);
        const chartDir = path.join(process.cwd(), 'public', 'images', 'blog', slug);
        fs.mkdirSync(chartDir, { recursive: true });
        const chartAbsPath = path.join(chartDir, 'chart-hero.png');
        fs.writeFileSync(chartAbsPath, chartPng);
        chartRelPath = `public/images/blog/${slug}/chart-hero.png`;
        const chartLabel = outline.chart.data[0]?.valueLabel ?? String(outline.chart.data[0]?.value ?? '');
        const altText = `${chartLabel} - ${outline.chart.headline}${outline.chart.source ? ` (${outline.chart.source})` : ''}`;
        imageResult = {
          paths: [chartRelPath],
          altTexts: { [chartRelPath]: altText },
          gateResults: [],
          allPassed: true,
          blockedImages: [],
        };
      } catch (err) {
        // Chart rendering must succeed — malformed specs are caught upstream
        // so a failure here means a rendering bug (sharp, SVG, I/O). Hard-fail
        // so the PR doesn't open with a missing hero.
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : '';
        console.error(`[pipeline]   chart render FAILED: ${msg}\n${stack ?? ''}`);
        throw new Error(`Chart render failed (${msg}). Check chart-renderer + sharp install.`);
      }
    } else {
      // Use headline as overlay text — enrichment (TL;DR) happens in Step 5c
      // which runs AFTER this step, so enriched.tldr is not available here.
      const overlayText = outline.headline;

      try {
        multiImageResult = await runMultiOptionImagePipeline(
          slug, lane, outline.headline, sectionHeadings,
          overlayText,
          undefined,
          {
            onImageStart: (type, idx) => console.log(`[pipeline]   generating ${type} ${idx}...`),
            onImageResult: (type, idx, passed, attempt) =>
              console.log(`[pipeline]   ${type} ${idx}: ${passed ? 'PASS' : 'FAIL'} (attempt ${attempt})`),
          },
          articleText,
        );

        // Build a compatible ImagePipelineResult from the first successful option
        // so the rest of the pipeline (hero path in frontmatter) still works
        const firstOption = multiImageResult.options[0];
        imageResult = {
          paths: firstOption ? [firstOption.path] : [],
          altTexts: firstOption ? { [firstOption.path]: firstOption.altText } : {},
          gateResults: [],
          allPassed: multiImageResult.options.length > 0,
          blockedImages: multiImageResult.options.length === 0 ? ['hero.webp'] : [],
        };
      } catch (err) {
        // Previously this catch swallowed image errors and let the PR ship with
        // no images — the failure mode that produced PR 39 (branch committed
        // markdown only, zero image files). Surface the error so the outer
        // pipeline catch marks the run failed and no broken PR opens.
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : '';
        console.error(`[pipeline]   image pipeline FAILED: ${msg}\n${stack ?? ''}`);
        throw new Error(`Image pipeline failed (${msg}). Check image model ID and OpenRouter status before retrying.`);
      }

      if (!imageResult.allPassed) {
        // All gate retries exhausted but the pipeline produced *something*. Log
        // loudly so reviewers know before merge — the fallback hero path below
        // (FALLBACK_HERO_PATH) will kick in if no hero was salvageable.
        console.error(`[pipeline]   ${imageResult.blockedImages.length} images blocked after all retries — continuing with available`);
      }
    }

    // Step 7: Create GitHub PR
    console.log('[pipeline] Step 7/7: Creating GitHub PR');

    // Strip remaining (src_XXX) citation markers
    function stripCitations(text: string): string {
      return text.replace(/\s*\(src_\d+\)/g, '');
    }

    // Replace em dashes with regular dashes
    function stripEmDashes(text: string): string {
      return cleanDashChars(text);
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
    const sanitizedParagraphs = withExternalLinks.map((para) => ({
      ...para,
      text: enforceReadableSentences(stripEmDashes(stripCitations(para.text))),
    }));
    const introSource = sanitizedParagraphs[0];
    const introParagraph = introSource
      ? buildSeoOpening(outline.headline, introSource.text)
      : '';

    // Render markdown by section
    const bodyBySection = new Map<number, string[]>();
    for (const para of sanitizedParagraphs.slice(1)) {
      const sIdx: number = para.section_index;
      const arr = bodyBySection.get(sIdx) ?? [];
      arr.push(para.text);
      bodyBySection.set(sIdx, arr);
    }

    // Internal links: scan rendered paragraphs and insert contextual links.
    // One call over the flat paragraph list so the 8-link cap applies per-post,
    // not per-section (which is how posts were shipping with 14+ internal links).
    const flatTexts: string[] = [];
    const flatSections: number[] = [];
    const flatSources: Array<string | undefined> = [];
    for (const [sIdx, paras] of bodyBySection.entries()) {
      for (const p of paras) {
        flatTexts.push(p);
        flatSections.push(sIdx);
        const source = sanitizedParagraphs.slice(1).find((para) => para.section_index === sIdx && para.text === p)?.source_id;
        flatSources.push(source);
      }
    }
    const linkedTexts = insertBrandLinks(insertInternalLinks(flatTexts));
    const linkedParagraphs: Array<{ text: string; section_index: number; source_id?: string }> = [];
    bodyBySection.clear();
    linkedTexts.forEach((text, i) => {
      const sIdx = flatSections[i];
      linkedParagraphs.push({ text, section_index: sIdx, source_id: flatSources[i] });
      const arr = bodyBySection.get(sIdx) ?? [];
      arr.push(text);
      bodyBySection.set(sIdx, arr);
    });

    const sectionCount = outline.sections.length;
    const midPoint = Math.floor(sectionCount / 2);
    const renderedHeadings = normalizeRenderedHeadings(
      outline.headline,
      outline.sections.map((s) => s.heading),
      lane,
    );
    const allRenderedParagraphs = [
      introParagraph,
      ...linkedParagraphs.map((p) => p.text),
    ].filter((p) => p.trim().length > 0);

    const bodyParts: string[] = [];
    if (introParagraph) {
      bodyParts.push(introParagraph);
      bodyParts.push('');
    }
    const keyTakeaways = buildKeyTakeaways(allRenderedParagraphs);
    if (keyTakeaways) bodyParts.push(keyTakeaways);

    outline.sections.forEach((section, i) => {
      const paras = bodyBySection.get(i) ?? [];
      bodyParts.push(renderSectionWithSubsections(renderedHeadings[i] ?? stripEmDashes(section.heading), section.subsections, paras));

      if (i === 0) {
        const evidenceTable = buildEvidenceTable(
          [
            ...(introSource ? [{ text: introParagraph || introSource.text, section_index: introSource.section_index, source_id: introSource.source_id }] : []),
            ...linkedParagraphs,
          ],
          outline,
          bundle,
        );
        if (evidenceTable) bodyParts.push(evidenceTable);
      }

      // Insert mid-article CTA after the middle section. Routed by the
      // bundle's category_id so a reputation post pitches Reputation
      // Management (not the Speed-to-Lead fallback). Falls back to the
      // Speed-to-Lead copy when category_id is missing (legacy bundles
      // or the curated path before it populates category).
      if (i === midPoint) {
        bodyParts.push(buildMidArticleCTA(bundle.category_id));
      }
      bodyParts.push('');
    });

    const faqSection = buildFaqSection(outline.headline, allRenderedParagraphs);
    if (faqSection) bodyParts.push(faqSection);

    const postEntities = choosePostEntities(bodyParts.join('\n'));
    console.log(
      `[pipeline] Step 5c/7: Added source-bound SEO/AEO sections (keyTakeaways=${Boolean(keyTakeaways)}, faq=${Boolean(faqSection)}, entities=${postEntities.length})`,
    );

    // Insert contextual calculator/tool embed via topic classifier
    console.log('[pipeline] Step 5d/7: Classifying + inserting tool embed');
    const introText = dedupedParagraphs
      .slice(0, 3)
      .map((p) => stripEmDashes(stripCitations(p.text)))
      .join(' ');
    const embedResult = await insertToolEmbeds(bodyParts, {
      headline: outline.headline,
      sectionHeadings: renderedHeadings,
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

    let body = cleanDashChars(bodyParts.join('\n'));

    // Post-draft overlap gate — catches the CSI-style cannibalization where
    // two posts share 3+ entities or citation fingerprints despite different
    // slugs. Runs after body assembly so citation fingerprints are
    // extractable. Throws PostOverlapError on hit; the outer pipeline catch
    // records it as blocked + notifies.
    try {
      await checkPostOverlap({
        title: stripEmDashes(outline.headline),
        entities: postEntities,
        body,
      });
    } catch (err) {
      if (err instanceof PostOverlapError) {
        console.error(`[pipeline]   POST OVERLAP: ${err.reason} (matched ${err.matchedSlug})`);
        throw err;
      }
      // Other errors from dedup are non-fatal — log and continue
      console.warn(`[pipeline]   post-overlap check errored (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    // Inject chart image inline — placed before the first H2 so it appears
    // right after the intro paragraph. Listing card uses the same PNG via
    // frontmatter.image (Option A per the design). If the post didn't emit
    // a chart spec, body passes through untouched.
    if (outline.chart && chartRelPath) {
      const publicChartPath = '/' + chartRelPath.replace(/^public[/\\]/, '').replace(/\\/g, '/');
      const altLabel = outline.chart.data[0]?.valueLabel ?? String(outline.chart.data[0]?.value ?? '');
      const alt = `${altLabel} ${outline.chart.headline}`.replace(/"/g, '');
      const chartMd = `![${alt}](${publicChartPath})\n`;
      const firstH2 = body.indexOf('\n## ');
      if (firstH2 !== -1) {
        body = body.slice(0, firstH2 + 1) + chartMd + body.slice(firstH2 + 1);
      } else {
        // No H2 in body — shouldn't happen for a well-formed post, but prepend
        // rather than drop the chart silently.
        body = chartMd + body;
        console.warn('[pipeline]   chart injected at body start — no H2 found for inline placement');
      }
    }

    body = cleanDashChars(body);

    // Calculate reading time
    const wordCount2 = body.split(/\s+/).filter(Boolean).length;
    const readingTime = Math.max(1, Math.ceil(wordCount2 / 200));

    // Generate LLM-crafted meta description for SERP + AI snippet extraction
    const metaSeed = dedupedParagraphs.slice(0, 4).map(p => stripEmDashes(stripCitations(p.text))).join(' ');
    const metaDescription = normalizeMetaDescriptionForSeo(
      await generateMetaDescription(outline.headline, metaSeed),
      outline.headline,
      metaSeed,
    );

    const LANE_TITLES: Record<string, string> = {
      daily_seo: 'Industry Insights',
      weekly_authority: 'Leadership',
      monthly_anonymized_case: 'Case Studies',
      listicle: 'Guides & Roundups',
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
      listicle: [
        { slug: 'roundup', title: 'Roundup' },
        { slug: 'guide', title: 'Guide' },
        { slug: 'dealership-operations', title: 'Dealership Operations' },
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
    // Multi-option pipeline: use the first option's path as the default hero.
    // The user will pick their preferred option in the PR and rename it.
    const heroRelPath = imageResult.paths.find((p) => p.includes('hero'))
      ?? multiImageResult?.options[0]?.path;
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
      author: routeAuthorForPost({
        lane,
        tags: LANE_TAGS[lane] ?? [],
        categorySlug: lane.replace(/_/g, '-'),
      }),
      entities: postEntities,
      hide_hero: true,
    };

    const markdownContent = matter.stringify(body, frontmatter);

    // Step 5e/7: SEO + AEO gate
    // Runs a deterministic rubric against the finished markdown. This is
    // strict now: anything below 100% blocks before PR creation.
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

    const seoAeoBlocked = seoAeoScore < 100;
    const seoAeoWarning = false;

    if (seoAeoBlocked) {
      console.error(
        `[pipeline]   SEO+AEO score ${seoAeoScore}% is below blocking threshold (100%). Refusing to ship.`,
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

    // Collect image files for PR — include all multi-option paths so every
    // candidate (base + overlay variants) gets uploaded to the PR branch.
    const allImagePaths = multiImageResult
      ? multiImageResult.allPaths
      : imageResult.paths;
    const images = allImagePaths.map((relPath) => ({
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
          imageOptions: multiImageResult?.options,
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
