/**
 * Generate blog posts and save locally (no images, no PR).
 * Usage: npx tsx scripts/generate-local.ts [count]
 */
import 'dotenv/config';
import { config } from 'dotenv';
config({ path: '.env.local', override: true });

import { resolveSlot } from '../lib/topics/resolver';
import { insertExternalLinks, insertInternalLinks, buildMidArticleCTA, buildRelatedPosts } from '../lib/stages/auto-linker';
import { generateOutline } from '../lib/stages/outline';
import { draftParagraphs } from '../lib/stages/paragraph-draft';
import { checkRephraseDistances } from '../lib/stages/rephrase-distance';
import { voiceTransform } from '../lib/stages/voice-transform';
import { runWithRetry } from '../lib/gates/retry-loop';
import { writeFile, mkdir } from 'node:fs/promises';
import matter from 'gray-matter';

const count = parseInt(process.argv[2] ?? '5', 10);
const lanes = ['daily_seo', 'weekly_authority', 'daily_seo', 'daily_seo', 'weekly_authority'] as const;

const LANE_TITLES: Record<string, string> = {
  daily_seo: 'Industry Insights',
  weekly_authority: 'Leadership',
  monthly_anonymized_case: 'Case Studies',
};

async function generateOne(index: number, lane: typeof lanes[number]) {
  console.log(`\n--- Post ${index + 1}/${count} (${lane}) ---\n`);

  const { bundle } = await resolveSlot(lane);
  const wordCount = lane === 'weekly_authority' ? { min: 1200, max: 1800 } : { min: 1000, max: 1400 };

  console.log(`  Topic: "${bundle.topic_slug}" — ${bundle.sources.length} sources, ${bundle.sources.reduce((n, s) => n + s.quotes.length, 0)} quotes`);

  const outline = await generateOutline(bundle, wordCount);
  console.log(`  Headline: "${outline.headline}"`);

  const drafted = await draftParagraphs(outline, bundle, wordCount);
  await checkRephraseDistances(drafted.paragraphs, bundle);
  const transformed = await voiceTransform(drafted.paragraphs);

  const { report, paragraphs: final } = await runWithRetry(
    { paragraphs: transformed.paragraphs, bundle, outline, attempt: 1 },
    { onRetryStart: (a, idx) => console.log(`  retry ${a}: paragraphs [${idx.join(', ')}]`) },
  );
  console.log(`  Gates: ${report.verdict} (${report.attempt - 1} retries)`);

  if (report.verdict === 'blocked') {
    console.log(`  BLOCKED — skipping`);
    return null;
  }

  // Strip citations, em dashes, and dedup
  function stripCitations(text: string) { return text.replace(/\s*\(src_\d+\)/g, ''); }
  function stripEmDashes(text: string) { return text.replace(/\s*—\s*/g, ' - ').replace(/\s*–\s*/g, ' - '); }
  function sentences(text: string) { return new Set(text.split(/[.!?]+/).map(s => s.trim().toLowerCase()).filter(s => s.length > 20)); }

  const deduped = final.filter((p, i) => {
    const s = sentences(p.text);
    for (let j = 0; j < i; j++) {
      const prev = sentences(final[j].text);
      let overlap = 0;
      for (const x of s) { if (prev.has(x)) overlap++; }
      if (s.size > 0 && overlap / s.size > 0.6) return false;
    }
    return true;
  });

  // External links: convert (src_XXX) to inline source links
  const withExtLinks = insertExternalLinks(deduped, bundle);

  // Render by section
  const bodyBySection = new Map<number, string[]>();
  for (const p of withExtLinks) {
    const arr = bodyBySection.get(p.section_index) ?? [];
    arr.push(stripEmDashes(stripCitations(p.text)));
    bodyBySection.set(p.section_index, arr);
  }

  // Internal links
  for (const [idx, paras] of bodyBySection.entries()) {
    bodyBySection.set(idx, insertInternalLinks(paras));
  }

  const sectionCount = outline.sections.length;
  const midPoint = Math.floor(sectionCount / 2);

  const parts: string[] = [];
  outline.sections.forEach((s, i) => {
    parts.push(`## ${s.heading}\n`);
    parts.push((bodyBySection.get(i) ?? []).join('\n\n'));
    if (i === midPoint) parts.push(buildMidArticleCTA());
    parts.push('');
  });

  // Related posts
  const related = buildRelatedPosts(parts.join('\n'));
  if (related) parts.push(related);

  const firstPara = stripCitations(deduped[0]?.text ?? '');
  const meta = firstPara.length > 155 ? firstPara.slice(0, 152).replace(/\s+\S*$/, '') + '...' : firstPara;

  const md = matter.stringify(parts.join('\n'), {
    title: outline.headline,
    slug: bundle.topic_slug,
    metaDescription: meta,
    publishedAt: new Date().toISOString().split('T')[0],
    published: false,
    category: { slug: lane.replace(/_/g, '-'), title: LANE_TITLES[lane] ?? 'Article' },
    author: 'VisQuanta Team',
  });

  const dir = 'tmp/drafts';
  await mkdir(dir, { recursive: true });
  const file = `${dir}/${bundle.topic_slug}-${Date.now().toString(36)}.md`;
  await writeFile(file, md);
  console.log(`  Saved: ${file} (${md.split(/\s+/).length} words)`);
  return file;
}

async function main() {
  console.log(`=== Generating ${count} blog posts locally ===`);
  const files: string[] = [];

  for (let i = 0; i < count; i++) {
    try {
      const file = await generateOne(i, lanes[i % lanes.length]);
      if (file) files.push(file);
    } catch (e: any) {
      console.error(`  ERROR: ${e.message}`);
    }
  }

  console.log(`\n=== Done: ${files.length}/${count} posts saved ===`);
  files.forEach(f => console.log(`  ${f}`));
}

main().catch(e => console.error('FATAL:', e.message));
