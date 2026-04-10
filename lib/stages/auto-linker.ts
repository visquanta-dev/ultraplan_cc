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

const MAX_INTERNAL_LINKS = 15;
const MAX_EXTERNAL_LINKS_PER_POST = 20;

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

/**
 * Insert external source links into paragraphs.
 * Finds (src_XXX) markers in the raw text and converts them to inline links.
 * Call this BEFORE stripping citations.
 */
export function insertExternalLinks<T extends { text: string }>(
  paragraphs: T[],
  bundle: Bundle,
): T[] {
  const sourceMap = buildSourceMap(bundle);
  let externalCount = 0;

  return paragraphs.map((para) => {
    if (externalCount >= MAX_EXTERNAL_LINKS_PER_POST) return para;

    // Find all (src_XXX) markers in this paragraph
    const srcPattern = /\(src_(\d+)\)/g;
    let match: RegExpExecArray | null;
    let newText = para.text;
    const replacements: Array<{ marker: string; link: string }> = [];

    while ((match = srcPattern.exec(para.text)) !== null) {
      if (externalCount >= MAX_EXTERNAL_LINKS_PER_POST) break;

      const srcId = `src_${match[1]}`;
      const source = sourceMap.get(srcId);
      if (source) {
        // First occurrence: turn into a linked attribution
        replacements.push({
          marker: match[0],
          link: `, [according to ${source.siteName}](${source.url})`,
        });
        externalCount++;
      }
    }

    // Apply all replacements (multiple external links per paragraph OK)
    for (const rep of replacements) {
      newText = newText.replace(rep.marker, rep.link);
    }
    // Strip any remaining unresolved markers
    newText = newText.replace(/\s*\(src_\d+\)/g, '');

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
    '**Ready to stop losing revenue to missed calls?** [Schedule a strategy call](https://www.visquanta.com/book-demo) with the VisQuanta team — we\'ll audit your after-hours coverage and show you exactly where the gaps are.',
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
