/* eslint-disable no-console */
import '../lib/load-env';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { generateOutline } from '../lib/stages/outline';
import { draftParagraphs } from '../lib/stages/paragraph-draft';
import { checkRephraseDistances, partitionByDistance } from '../lib/stages/rephrase-distance';
import { voiceTransform } from '../lib/stages/voice-transform';
import { runWithRetry } from '../lib/gates/retry-loop';
import type { Bundle } from '../lib/bundle/types';

// ---------------------------------------------------------------------------
// scripts/smoke-draft-synthetic.ts
// Hand-built bundle with real factual quotes from already-published automotive
// industry research. Bypasses the Firecrawl scrape step so we can prove the
// drafter pipeline (outline → paragraph draft → rephrase check → voice
// transform) works end-to-end with substantive content.
//
// Every quote here is a real statistic from a real source that appeared in
// visquanta.com's existing ai-roi-for-dealerships.md post. We're reusing the
// exact factual material for this test — no fabrication.
//
// This script exists because the original smoke-draft.ts pointed at section
// front URLs (e.g. automotivenews.com/dealers) which Firecrawl correctly
// scraped as navigation chrome. Finding three live deep article URLs for the
// real smoke test is deferred; meanwhile this proves the drafter works.
// ---------------------------------------------------------------------------

const TOPIC_SLUG = 'ai-roi-dealerships-90-days';
const LANE = 'daily_seo' as const;
const WORD_COUNT = { min: 1000, max: 1400 };

const BUNDLE: Bundle = {
  bundle_id: `bundle_${TOPIC_SLUG}_synthetic`,
  lane: LANE,
  topic_slug: TOPIC_SLUG,
  assembled_at: new Date().toISOString(),
  sources: [
    {
      source_id: 'src_001',
      domain: 'spyne.ai',
      url: 'https://www.spyne.ai/blogs/ai-automotive-market-sentiment-report-2026',
      title: 'Spyne 2026 U.S. Automotive Market Sentiment Report',
      published: '2026-02-10',
      quotes: [
        {
          quote_id: 'src_001_q1',
          text: '76% of dealers plan to increase their AI budgets in 2026, according to a survey of nearly 1,200 dealership leaders in Spyne\'s 2026 U.S. Automotive Market Sentiment Report.',
          type: 'stat',
        },
        {
          quote_id: 'src_001_q2',
          text: 'Dealerships that implemented AI saw a 33% reduction in BDC operating costs, a 25-30% lift in showroom appointments, and a 67% increase in online listing engagement across the first 90 days of deployment.',
          type: 'stat',
        },
        {
          quote_id: 'src_001_q3',
          text: 'Operations teams at AI-enabled stores reported saving 12-15 hours per week, translating directly into recovered staff capacity that was redirected to higher-leverage tasks.',
          type: 'stat',
        },
      ],
    },
    {
      source_id: 'src_002',
      domain: 'autoraptor.com',
      url: 'https://www.autoraptor.com/blog/ai-dealership-performance-2026',
      title: 'AutoRaptor 2026 Dealership AI Performance Benchmarks',
      published: '2026-02-24',
      quotes: [
        {
          quote_id: 'src_002_q1',
          text: 'Average lead response time dropped from 6.2 hours to 52 seconds after AI deployment, a 99.2% reduction, based on AutoRaptor\'s 2026 benchmark data across 340 dealerships.',
          type: 'stat',
        },
        {
          quote_id: 'src_002_q2',
          text: 'Lead conversion rate rose from 8.7% pre-AI to 13.4% after 90 days, a 54% relative improvement that translated into a drop in cost per acquisition from $723 to $447.',
          type: 'stat',
        },
        {
          quote_id: 'src_002_q3',
          text: 'Marketing teams at AI-enabled stores deployed 11 campaigns per month versus 3 pre-AI, while total marketing hours fell from 42 to 26 per week.',
          type: 'stat',
        },
      ],
    },
    {
      source_id: 'src_003',
      domain: 'coxautoinc.com',
      url: 'https://www.coxautoinc.com/market-insights/2026-dealer-sentiment/',
      title: 'Cox Automotive 2026 Dealer Sentiment Index',
      published: '2026-03-05',
      quotes: [
        {
          quote_id: 'src_003_q1',
          text: '74% of dealers cite AI voice agents as their top investment priority for 2026, yet 74% simultaneously worry about AI accuracy, according to Cox Automotive\'s 2026 Dealer Sentiment Index.',
          type: 'stat',
        },
        {
          quote_id: 'src_003_q2',
          text: '66% of dealership leaders say they need better education on what AI can realistically do before they feel comfortable expanding deployments beyond pilot programs.',
          type: 'stat',
        },
        {
          quote_id: 'src_003_q3',
          text: '100% of dealerships that deployed AI reported revenue increases over the past year, with 37% reporting 20-30% growth, 19% reporting 10-20% growth, and 18% reporting over 30% growth — zero dealerships reported a revenue decrease.',
          type: 'stat',
        },
        {
          quote_id: 'src_003_q4',
          text: 'Projected 25% reductions in profit per vehicle retailed in 2026 mean dealerships can no longer absorb the process inefficiencies that pre-AI operating models produced.',
          type: 'claim',
        },
      ],
    },
  ],
};

function slugifyForFile(slug: string): string {
  return slug.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
}

async function main() {
  console.log('\n=== UltraPlan drafter smoke test (synthetic bundle) ===');
  console.log('Using hand-built bundle with real quotes from Spyne, AutoRaptor, and Cox Automotive.\n');

  console.log(`[1/6] Bundle ready: ${BUNDLE.sources.length} sources, ${BUNDLE.sources.reduce((s, src) => s + src.quotes.length, 0)} quotes`);

  // 1. Outline
  console.log('[2/6] Generating outline (Claude Opus 4.6 via OpenRouter)');
  const outline = await generateOutline(BUNDLE, WORD_COUNT);
  console.log(`  headline: "${outline.headline}"`);
  console.log(`  sections: ${outline.sections.length}`);
  outline.sections.forEach((s, i) => {
    console.log(`    ${i}. ${s.heading} (${s.anchor_quotes.length} anchors: ${s.anchor_quotes.join(', ')})`);
  });

  // 2. Paragraphs
  console.log('\n[3/6] Drafting paragraphs (Claude Opus 4.6 via OpenRouter)');
  const drafted = await draftParagraphs(outline, BUNDLE, WORD_COUNT);
  console.log(`  paragraphs: ${drafted.paragraphs.length}`);

  // 3. Rephrase distance
  console.log('\n[4/6] Checking rephrase distances (local embeddings)');
  const distances = await checkRephraseDistances(drafted.paragraphs, BUNDLE);
  const { inBand, outOfBand } = partitionByDistance(drafted.paragraphs, distances);
  console.log(`  in band:     ${inBand.length}/${drafted.paragraphs.length}`);
  console.log(`  out of band: ${outOfBand.length}`);
  distances.forEach((d, i) => {
    const marker = d.in_band ? '  ' : '❗';
    console.log(`  ${marker} paragraph ${i}: similarity=${d.similarity.toFixed(3)} (${d.reason})`);
  });

  // 4. Voice transform
  console.log('\n[5/6] Voice transform (Claude Opus 4.6 via OpenRouter)');
  const transformed = await voiceTransform(drafted.paragraphs);
  console.log(`  transformed paragraphs: ${transformed.paragraphs.length}`);

  // 5. Hard gates + retry loop (spec §6)
  console.log('\n[6/6] Running hard gates with retry loop');
  const { report: gateReport, paragraphs: finalParagraphs, retries } = await runWithRetry(
    { paragraphs: transformed.paragraphs, bundle: BUNDLE, outline, attempt: 1 },
    {
      onGateStart: (gate) => process.stdout.write(`  ${gate}... `),
      onGateFinish: (r) => console.log(`${r.passed ? 'PASS' : 'FAIL'} — ${r.summary}`),
      onRetryStart: (attempt, indices) =>
        console.log(`\n  --- Retry ${attempt}: regenerating paragraphs [${indices.join(', ')}] ---`),
    },
  );
  console.log(`\n  verdict: ${gateReport.verdict}`);
  console.log(`  retries: ${retries}`);
  if (gateReport.failing_paragraph_indices.length > 0) {
    console.log(`  failing paragraph indices: [${gateReport.failing_paragraph_indices.join(', ')}]`);
  }
  if (gateReport.blocked_reason) {
    console.log(`  blocked_reason: ${gateReport.blocked_reason}`);
  }

  // 6. Render (use final paragraphs from retry loop)
  const bodyBySection = new Map<number, string[]>();
  for (const para of finalParagraphs) {
    const arr = bodyBySection.get(para.section_index) ?? [];
    arr.push(para.text);
    bodyBySection.set(para.section_index, arr);
  }

  const bodyParts: string[] = [];
  outline.sections.forEach((section, i) => {
    bodyParts.push(`## ${section.heading}\n`);
    const paras = bodyBySection.get(i) ?? [];
    bodyParts.push(paras.join('\n\n'));
    bodyParts.push('');
  });
  const body = bodyParts.join('\n');

  const frontmatter = {
    title: outline.headline,
    slug: TOPIC_SLUG,
    metaDescription: `Draft generated by UltraPlan Phase 1 from ${BUNDLE.sources.length} real sources.`,
    image: `/images/blog/${TOPIC_SLUG}/hero.webp`,
    publishedAt: new Date().toISOString().split('T')[0],
    published: false,
    category: { slug: 'ai', title: 'AI' },
    tags: [
      { slug: 'ai', title: 'AI' },
      { slug: 'roi', title: 'ROI' },
      { slug: 'dealership-operations', title: 'Dealership Operations' },
    ],
    author: 'VisQuanta Team (UltraPlan draft)',
    ultraplan: {
      bundle_id: BUNDLE.bundle_id,
      lane: BUNDLE.lane,
      sources: BUNDLE.sources.map((s) => ({ source_id: s.source_id, domain: s.domain, url: s.url })),
      out_of_band_paragraph_count: outOfBand.length,
      synthetic: true,
    },
  };

  const fullMarkdown = matter.stringify(body, frontmatter);

  const outDir = path.join(process.cwd(), 'tmp', 'drafts');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${slugifyForFile(TOPIC_SLUG)}.md`);
  fs.writeFileSync(outPath, fullMarkdown);

  const wordCount = body.split(/\s+/).filter(Boolean).length;

  console.log();
  console.log('=== Draft complete ===');
  console.log(`  file:         ${outPath}`);
  console.log(`  word count:   ${wordCount} (target ${WORD_COUNT.min}-${WORD_COUNT.max})`);
  console.log(`  sections:     ${outline.sections.length}`);
  console.log(`  paragraphs:   ${finalParagraphs.length}`);
  console.log();
}

main().catch((err) => {
  console.error('\nsmoke-draft-synthetic failed:');
  console.error(err);
  process.exit(1);
});
