import { runSeoAeoGate } from '../lib/gates/seo-aeo';
import fs from 'node:fs';
import matter from 'gray-matter';
import path from 'node:path';

/**
 * Quick smoke test for the SEO/AEO gate. Reads a blog post markdown from
 * the given path, fakes an Outline from its H2s, and runs the gate.
 * Prints score + all findings.
 *
 * Usage: npx tsx scripts/smoke-seo-aeo.ts <path-to-md>
 */

const file = process.argv[2];
if (!file) {
  console.error('Usage: npx tsx scripts/smoke-seo-aeo.ts <path-to-md>');
  process.exit(1);
}

const raw = fs.readFileSync(file, 'utf-8');
const { data, content } = matter(raw);
const h2s = (content.match(/^## (.+)$/gm) || []).map((h) => h.replace(/^## /, ''));
const outline = {
  headline: data.title ?? '',
  sections: h2s.map((h) => ({ heading: h, intent: '', anchor_quotes: [] })),
} as unknown as Parameters<typeof runSeoAeoGate>[0]['outline'];

(async () => {
  const result = await runSeoAeoGate({
    markdown: raw,
    outline,
    paragraphs: [],
    frontmatter: {
      title: data.title ?? '',
      slug: data.slug ?? path.basename(file, '.md'),
      metaDescription: data.metaDescription ?? '',
      image: data.image ?? '',
    },
  });
  console.log('\n=== ' + path.basename(file) + ' ===');
  console.log(result.summary);
  console.log();
  for (const f of result.paragraph_findings) {
    console.log((f.passed ? '[PASS]' : '[FAIL]') + ' ' + f.reason);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
