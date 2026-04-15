import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import type { Bundle } from '../bundle/types';

// ---------------------------------------------------------------------------
// Auto-linker — inserts internal + external links into rendered markdown
// Runs AFTER voice transform and gate checks, BEFORE final markdown render.
//
// Internal links: matched from config/internal_links.yaml keyword map
// External links: resolved from bundle source URLs (trade press citations)
// CTAs: injected at mid-article and end-of-article positions
// ---------------------------------------------------------------------------

// SEO best practice: 3-8 contextual internal links for a 2000-word post.
// More than 8 dilutes link equity per target and triggers "over-optimization"
// heuristics. Previous value of 15 was producing posts with 17 internal links
// (PR #14). Lowered to 8. Increase only with good reason.
const MAX_INTERNAL_LINKS = 8;
const MAX_EXTERNAL_LINKS_PER_POST = 10;

interface LinkEntry {
  url: string;
  anchor: string;
  keywords: string[];
  type?: string;
}

interface LinkConfig {
  pages: LinkEntry[];
  blog: LinkEntry[];
}

let cachedConfig: LinkConfig | null = null;

function loadLinkConfig(): LinkConfig {
  if (cachedConfig) return cachedConfig;
  const raw = fs.readFileSync(
    path.join(process.cwd(), 'config', 'internal_links.yaml'),
    'utf-8',
  );
  cachedConfig = yaml.parse(raw) as LinkConfig;
  return cachedConfig;
}

/**
 * Find the best internal link for a paragraph based on keyword matching.
 * Returns null if no match or the link was already used.
 */
function findBestInternalLink(
  text: string,
  usedUrls: Set<string>,
  config: LinkConfig,
): LinkEntry | null {
  const lower = text.toLowerCase();
  const allLinks = [...config.pages, ...config.blog];

  let bestMatch: LinkEntry | null = null;
  let bestScore = 0;

  for (const entry of allLinks) {
    if (usedUrls.has(entry.url)) continue;

    let score = 0;
    for (const kw of entry.keywords) {
      if (lower.includes(kw.toLowerCase())) score++;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = entry;
    }
  }

  return bestScore > 0 ? bestMatch : null;
}

/**
 * Insert a markdown link into a paragraph at the first occurrence of a keyword.
 * Only links once per paragraph — finds the best keyword match and wraps it.
 */
function insertInternalLink(text: string, entry: LinkEntry): string {
  // Find which keyword appears in the text
  const lower = text.toLowerCase();
  for (const kw of entry.keywords) {
    const idx = lower.indexOf(kw.toLowerCase());
    if (idx !== -1) {
      // Find the actual case-preserved text at that position
      const original = text.slice(idx, idx + kw.length);
      // Only replace the first occurrence
      return (
        text.slice(0, idx) +
        `[${original}](https://www.visquanta.com${entry.url})` +
        text.slice(idx + kw.length)
      );
    }
  }
  // Fallback: append as a natural reference
  return text;
}

/**
 * Build a source attribution map from the bundle for external links.
 * Returns source_id → { url, siteName }
 */
function buildSourceMap(bundle: Bundle): Map<string, { url: string; siteName: string }> {
  const map = new Map<string, { url: string; siteName: string }>();
  for (const src of bundle.sources) {
    const domain = src.domain.replace(/^www\./, '');
    const parts = domain.split('.');
    const siteName = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    map.set(src.source_id, { url: src.url, siteName });
  }
  return map;
}

// Varied attribution phrases to avoid repetition
const ATTRIBUTION_PHRASES = [
  (name: string, url: string) => `[according to ${name}](${url})`,
  (name: string, url: string) => `[as reported by ${name}](${url})`,
  (name: string, url: string) => `[per ${name}](${url})`,
  (name: string, url: string) => `[research from ${name}](${url})`,
  (name: string, url: string) => `[${name} reports](${url})`,
  (name: string, url: string) => `[data from ${name}](${url})`,
  (name: string, url: string) => `[${name} found](${url})`,
  (name: string, url: string) => `[a ${name} analysis shows](${url})`,
];

/**
 * Insert external source links into paragraphs.
 *
 * NEW behavior (replaced the broken legacy marker-based version):
 *
 * Each paragraph carries a `source_id` in its metadata (guaranteed by the
 * paragraph-draft stage's JSON schema). For every paragraph whose source
 * hasn't been linked yet, append a natural attribution link at the END of
 * the paragraph text ("per Autonews", "according to CBT News", etc.). Each
 * unique source URL is linked only ONCE per post — subsequent paragraphs
 * citing the same source get no link (cleaner prose, avoids spam). The
 * whole post is capped at MAX_EXTERNAL_LINKS_PER_POST total.
 *
 * Why the rewrite: the old implementation scanned text for `(src_NNN)`
 * inline markers that neither the drafter nor the voice transform ever
 * produces, so it was a silent no-op — every post shipped with zero
 * external links despite having a bundle of real source URLs to cite.
 * The new implementation uses the source_id metadata that's already on
 * every paragraph, so it works regardless of whether the drafter ever
 * writes inline attributions.
 */
export function insertExternalLinks<
  T extends { text: string; source_id?: string },
>(paragraphs: T[], bundle: Bundle): T[] {
  const sourceMap = buildSourceMap(bundle);
  const linkedUrls = new Set<string>();
  let phraseIdx = 0;
  let linksAdded = 0;

  return paragraphs.map((para) => {
    // First: strip any legacy markers that may still be in old drafts
    let newText = para.text.replace(/\s*\(src_\d+\)/g, '');

    // Skip if no source_id metadata or cap already hit
    if (!para.source_id || linksAdded >= MAX_EXTERNAL_LINKS_PER_POST) {
      return { ...para, text: newText };
    }

    const source = sourceMap.get(para.source_id);
    if (!source || linkedUrls.has(source.url)) {
      return { ...para, text: newText };
    }

    // Append a natural attribution link at the end of the paragraph.
    // Use varied phrases to avoid "according to X" repetition across
    // paragraphs. The trailing-period detection keeps punctuation clean.
    const phrase = ATTRIBUTION_PHRASES[phraseIdx % ATTRIBUTION_PHRASES.length];
    phraseIdx++;
    const attribution = phrase(source.siteName, source.url);

    // Drop any trailing period, append attribution phrase in parens, replace period
    const trimmed = newText.replace(/\.\s*$/, '');
    newText = `${trimmed} (${attribution}).`;

    linkedUrls.add(source.url);
    linksAdded++;

    return { ...para, text: newText };
  });
}

/**
 * Insert internal links into rendered paragraphs.
 * Scans each paragraph for keyword matches and inserts contextual links.
 */
export function insertInternalLinks(
  paragraphs: string[],
): string[] {
  const config = loadLinkConfig();
  const usedUrls = new Set<string>();
  let linkCount = 0;

  return paragraphs.map((text) => {
    if (linkCount >= MAX_INTERNAL_LINKS) return text;
    // Skip paragraphs that already have links
    if (text.includes('](')) return text;

    const match = findBestInternalLink(text, usedUrls, config);
    if (match) {
      usedUrls.add(match.url);
      linkCount++;
      return insertInternalLink(text, match);
    }
    return text;
  });
}

/**
 * Generate a mid-article CTA block.
 */
export function buildMidArticleCTA(): string {
  return [
    '',
    '---',
    '',
    '**Ready to stop losing revenue to missed calls?** [Schedule a strategy call](https://www.visquanta.com/book-demo) with the VisQuanta team - we\'ll audit your after-hours coverage and show you exactly where the gaps are.',
    '',
    '---',
    '',
  ].join('\n');
}

/**
 * Generate a related posts section from the internal link config.
 * Picks the 3 most relevant blog posts based on the article content.
 */
export function buildRelatedPosts(articleText: string): string {
  const config = loadLinkConfig();
  const lower = articleText.toLowerCase();

  const scored = config.blog
    .map((entry) => {
      let score = 0;
      for (const kw of entry.keywords) {
        if (lower.includes(kw.toLowerCase())) score++;
      }
      return { ...entry, score };
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (scored.length === 0) return '';

  const links = scored
    .map((e) => `- [${e.anchor}](https://www.visquanta.com${e.url})`)
    .join('\n');

  return [
    '',
    '## Related Reading',
    '',
    links,
    '',
  ].join('\n');
}
