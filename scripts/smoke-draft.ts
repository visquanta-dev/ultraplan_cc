/* eslint-disable no-console */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { scrapeMany } from '../lib/sources/firecrawl';
import { assembleBundle } from '../lib/bundle/assemble';
import { generateOutline } from '../lib/stages/outline';
import { draftParagraphs } from '../lib/stages/paragraph-draft';
import { checkRephraseDistances, partitionByDistance } from '../lib/stages/rephrase-distance';
import { voiceTransform } from '../lib/stages/voice-transform';
import type { ScrapedInput } from '../lib/bundle/types';

// ---------------------------------------------------------------------------
// scripts/smoke-draft.ts
// The "see content" milestone — Step 5 of Phase 1.
// Runs the complete Phase 1 pipeline end to end:
//   1. scrape 3 allowlisted URLs (Firecrawl)
//   2. assemble research bundle (pure code)
//   3. generate outline (Claude — LLM call 1)
//   4. draft paragraphs bound to source quotes (Claude — LLM call 2)
//   5. rephrase-distance check (local embeddings, no API call)
//   6. voice transform (Claude — LLM call 3)
//   7. write markdown file to tmp/drafts/<slug>.md with SEObot-compatible frontmatter
//
// Requires: FIRECRAWL_API_KEY, ANTHROPIC_API_KEY in .env.local
// Usage:    npx tsx scripts/smoke-draft.ts
// ---------------------------------------------------------------------------

const TEST_URLS = [
  'https://www.automotivenews.com/dealers',
  'https://www.wardsauto.com/dealers',
  'https://www.autoremarketing.com/',
];

const TEST_TOPIC_SLUG = 'after-hours-ai-coverage';
const TEST_LANE = 'daily_seo' as const;
const TEST_WORD_COUNT = { min: 1000, max: 1400 };

function slugifyForFile(slug: string): string {
  return slug.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
}

async function main() {
  console.log('\n=== UltraPlan draft smoke test — Step 5 "see content" milestone ===\n');

  // --------------------------------------------------------------------
  // 1. Scrape
  // --------------------------------------------------------------------
  console.log(`[1/7] Scraping ${TEST_URLS.length} URLs`);
  const scraped = await scrapeMany(TEST_URLS, 2);
  const ok = scraped.filter((r) => r.article);
  console.log(`  scraped OK: ${ok.length}/${TEST_URLS.length}`);
  if (ok.length === 0) {
    console.error('  No URLs scraped successfully — aborting.');
    process.exit(1);
  }

  // --------------------------------------------------------------------
  // 2. Assemble bundle
  // --------------------------------------------------------------------
  console.log('[2/7] Assembling research bundle');
  const inputs: ScrapedInput[] = ok.map((r) => ({
    url: r.article!.canonicalUrl,
    title: r.article!.title,
    publishedAt: r.article!.publishedAt,
    rawText: r.article!.rawText,
  }));

  const bundle = assembleBundle(inputs, {
    lane: TEST_LANE,
    topic_slug: TEST_TOPIC_SLUG,
  });
  const totalQuotes = bundle.sources.reduce((sum, s) => sum + s.quotes.length, 0);
  console.log(`  bundle: ${bundle.sources.length} sources, ${totalQuotes} quotes`);

  // --------------------------------------------------------------------
  // 3. Outline (LLM 1)
  // --------------------------------------------------------------------
  console.log('[3/7] Generating outline (Claude Opus 4.6)');
  const outline = await generateOutline(bundle, TEST_WORD_COUNT);
  console.log(`  headline: "${outline.headline}"`);
  console.log(`  sections: ${outline.sections.length}`);
  outline.sections.forEach((s, i) => {
    console.log(`    ${i}. ${s.heading} (${s.anchor_quotes.length} anchors)`);
  });

  // --------------------------------------------------------------------
  // 4. Paragraph draft (LLM 2)
  // --------------------------------------------------------------------
  console.log('[4/7] Drafting paragraphs (Claude Opus 4.6)');
  const drafted = await draftParagraphs(outline, bundle, TEST_WORD_COUNT);
  console.log(`  paragraphs: ${drafted.paragraphs.length}`);

  // --------------------------------------------------------------------
  // 5. Rephrase distance check (local embeddings)
  // --------------------------------------------------------------------
  console.log('[5/7] Checking rephrase distances (local embeddings, no API)');
  const distances = await checkRephraseDistances(drafted.paragraphs, bundle);
  const { inBand, outOfBand } = partitionByDistance(drafted.paragraphs, distances);
  console.log(`  in band:     ${inBand.length}/${drafted.paragraphs.length}`);
  console.log(`  out of band: ${outOfBand.length}`);
  for (const issue of outOfBand) {
    console.log(`    - paragraph "${issue.paragraph.text.slice(0, 60)}..." → ${issue.reason}`);
  }
  // For Phase 1 we continue with the full set even if some paragraphs are
  // out of band — the regenerate loop is Phase 2.
  if (outOfBand.length > drafted.paragraphs.length / 2) {
    console.warn('  WARNING: more than half of paragraphs out of band — voice is probably drifting');
  }

  // --------------------------------------------------------------------
  // 6. Voice transform (LLM 3)
  // --------------------------------------------------------------------
  console.log('[6/7] Voice transform (Claude Opus 4.6, exemplar few-shot)');
  const transformed = await voiceTransform(drafted.paragraphs);
  console.log(`  transformed paragraphs: ${transformed.paragraphs.length}`);

  // --------------------------------------------------------------------
  // 7. Render to markdown with SEObot-compatible frontmatter
  // --------------------------------------------------------------------
  console.log('[7/7] Rendering markdown with frontmatter');
  const bodyBySection = new Map<number, string[]>();
  for (const para of transformed.paragraphs) {
    const arr = bodyBySection.get(para.section_index) ?? [];
    arr.push(para.text);
    bodyBySection.set(para.section_index, arr);
  }

  const bodyParts: string[] = [`# ${outline.headline}\n`];
  outline.sections.forEach((section, i) => {
    bodyParts.push(`## ${section.heading}\n`);
    const paras = bodyBySection.get(i) ?? [];
    bodyParts.push(paras.join('\n\n'));
    bodyParts.push('');
  });
  const body = bodyParts.join('\n');

  const frontmatter = {
    title: outline.headline,
    slug: TEST_TOPIC_SLUG,
    metaDescription: `Draft generated by UltraPlan Phase 1 smoke test from ${bundle.sources.length} sources.`,
    image: `/images/blog/${TEST_TOPIC_SLUG}/hero.webp`,
    publishedAt: new Date().toISOString().split('T')[0],
    published: false,
    category: { slug: 'ai', title: 'AI' },
    tags: [
      { slug: 'ai', title: 'AI' },
      { slug: 'after-hours', title: 'After Hours' },
    ],
    author: 'VisQuanta Team (UltraPlan draft)',
    ultraplan: {
      bundle_id: bundle.bundle_id,
      lane: bundle.lane,
      sources: bundle.sources.map((s) => ({ source_id: s.source_id, url: s.url })),
      out_of_band_paragraph_count: outOfBand.length,
    },
  };

  const fullMarkdown = matter.stringify(body, frontmatter);

  const outDir = path.join(process.cwd(), 'tmp', 'drafts');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${slugifyForFile(TEST_TOPIC_SLUG)}.md`);
  fs.writeFileSync(outPath, fullMarkdown);

  const wordCount = body.split(/\s+/).filter(Boolean).length;

  console.log();
  console.log('=== First draft complete ===');
  console.log(`  file:         ${outPath}`);
  console.log(`  word count:   ${wordCount} (target ${TEST_WORD_COUNT.min}-${TEST_WORD_COUNT.max})`);
  console.log(`  sections:     ${outline.sections.length}`);
  console.log(`  paragraphs:   ${transformed.paragraphs.length}`);
  console.log(`  sources:      ${bundle.sources.length}`);
  console.log(`  bundle saved: tmp/${bundle.bundle_id}.json (see smoke-bundle for format)`);
  console.log();
  console.log('Next: read the draft file and tell the pipeline whether voice passes.');
  console.log('If voice is not VisQuanta, iterate on config/voice/exemplars.md.');
  console.log();
}

main().catch((err) => {
  console.error('\nsmoke-draft failed:');
  console.error(err);
  process.exit(1);
});
