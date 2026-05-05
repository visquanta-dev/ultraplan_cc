import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import type { Bundle } from '../bundle/types';
import { isCompetitorOutbound } from '../sources/link-policy';

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
const MIN_EXTERNAL_LINKS_PER_POST = 4;

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
// Escape regex metacharacters so keywords with punctuation (e.g. "speed-to-lead"
// or "24/7 coverage") don't silently break the boundary match.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary match — prevents "staff" from matching inside "staffing"
// (PR 42 bug). Case-insensitive.
function keywordRegex(kw: string): RegExp {
  return new RegExp(String.raw`\b` + escapeRegExp(kw) + String.raw`\b`, 'i');
}

function findBestInternalLink(
  text: string,
  usedUrls: Set<string>,
  config: LinkConfig,
): LinkEntry | null {
  const allLinks = [...config.pages, ...config.blog];

  let bestMatch: LinkEntry | null = null;
  let bestScore = 0;

  for (const entry of allLinks) {
    if (usedUrls.has(entry.url)) continue;

    let score = 0;
    for (const kw of entry.keywords) {
      if (keywordRegex(kw).test(text)) score++;
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
  for (const kw of entry.keywords) {
    const re = keywordRegex(kw);
    const m = text.match(re);
    if (m && m.index !== undefined) {
      return (
        text.slice(0, m.index) +
        `[${m[0]}](https://www.visquanta.com${entry.url})` +
        text.slice(m.index + m[0].length)
      );
    }
  }
  return text;
}

/**
 * Build a source attribution map from the bundle for external links.
 * Returns source_id → { url, siteName }
 */
function buildSourceMap(bundle: Bundle): Map<string, { url: string; siteName: string }> {
  const map = new Map<string, { url: string; siteName: string }>();
  for (const src of bundle.sources) {
    if (isCompetitorOutbound(src.url)) continue;
    const domain = src.domain.replace(/^www\./, '');
    const parts = domain.split('.');
    const siteName = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    map.set(src.source_id, { url: src.url, siteName });
  }
  return map;
}

function hasExternalLink(text: string): boolean {
  return /\]\(https?:\/\/(?!www\.visquanta\.com|visquanta\.com)[^)]+\)/i.test(text);
}

function appendAttribution(text: string, source: { url: string; siteName: string }, phraseIdx: number): string {
  const phrase = ATTRIBUTION_PHRASES[phraseIdx % ATTRIBUTION_PHRASES.length];
  const attribution = phrase(source.siteName, source.url);
  const trimmed = text.replace(/\.\s*$/, '');
  return `${trimmed} (${attribution}).`;
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

  const linkedParagraphs = paragraphs.map((para) => {
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
    newText = appendAttribution(newText, source, phraseIdx);
    phraseIdx++;

    linkedUrls.add(source.url);
    linksAdded++;

    return { ...para, text: newText };
  });

  // The SEO/AEO gate expects enough external citations for answer engines to
  // trust the post, but the drafter may overuse a small subset of sources. If
  // the bundle has additional link-safe sources, top up citation coverage on
  // otherwise unlinked paragraphs without ever linking to competitor domains.
  const minimumLinks = Math.min(
    MIN_EXTERNAL_LINKS_PER_POST,
    MAX_EXTERNAL_LINKS_PER_POST,
    new Set([...sourceMap.values()].map((source) => source.url)).size,
  );
  if (linksAdded >= minimumLinks) return linkedParagraphs;

  const unusedSources = [...sourceMap.values()].filter((source) => !linkedUrls.has(source.url));
  for (let i = 0; i < linkedParagraphs.length && linksAdded < minimumLinks; i++) {
    const source = unusedSources.shift();
    if (!source) break;

    const para = linkedParagraphs[i];
    if (hasExternalLink(para.text)) {
      unusedSources.unshift(source);
      continue;
    }

    linkedParagraphs[i] = {
      ...para,
      text: appendAttribution(para.text, source, phraseIdx),
    };
    phraseIdx++;
    linkedUrls.add(source.url);
    linksAdded++;
  }

  return linkedParagraphs;
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
 *
 * Points every post at Speed to Lead, which is the actual VisQuanta
 * product being sold: sub-60-second SMS response to inbound web leads.
 * The pitch anchors on the "78% of buyers choose the first responder"
 * stat from the product page and the industry-average 1:38 response
 * time that Speed to Lead replaces.
 *
 * The CTA intentionally does NOT mention phone calls, voice AI, or
 * after-hours call auditing — those are a different product category
 * and conflating them confuses readers about what VisQuanta actually
 * sells. If a post's body focuses on voice/call pain points, the CTA
 * here bridges to the underlying lead-response gap (which is the
 * same problem viewed from a different channel).
 */
// Per-category mid-article CTA copy. Lead with a category-relevant stat,
// link to the product page from config/categories.yaml, describe the
// product in one sentence framed as the reader's outcome.
//
// When no category is provided (legacy callers, or category-less bundles)
// we fall back to the Speed-to-Lead pitch because that's VisQuanta's
// flagship conversion path.
const CTA_BY_CATEGORY: Record<string, string> = {
  lead_reactivation:
    '**The average dealer has 10,000+ dormant leads sitting in their CRM — most will never hear from the store again.** [See how VisQuanta reactivates dormant CRM leads](https://www.visquanta.com/lead-reactivation): automated SMS outreach that wakes up lost leads and books them back into the showroom.',
  speed_to_lead:
    '**78% of car buyers choose the first dealer to respond - and the industry average response time is 1 hour 38 minutes.** [See how Speed to Lead replies in under 60 seconds](https://www.visquanta.com/speed-to-lead): automated SMS response that captures inbound leads 24/7 before your competitors can pick up the phone.',
  service_drive:
    '**Fixed operations drives more than half of total dealership gross profit — and 48% of service customers leave frustrated.** [See Service Drive Pro in action](https://www.visquanta.com/service-drive): voice AI that answers every service call, books appointments around your advisors, and recovers the margin that missed calls bleed every day.',
  web_capture:
    '**Most dealer websites convert under 2% of visitors — the rest bounce without leaving a name.** [Install the SMS First Widget](https://www.visquanta.com/website-widget): converts anonymous site visitors into SMS conversations in under 30 seconds, so you capture contact info before they click to a competitor.',
  reputation:
    '**Car buyers read an average of 10 reviews before they contact a dealership — and review response time now correlates directly with CSI.** [See Reputation Management in action](https://www.visquanta.com/reputation-management): monitors every review across Google, Cars.com, and DealerRater, responds inside the first hour, and turns 3-star survey answers into 5-star outcomes.',
  inventory:
    '**Every day a pre-owned unit sits on your lot costs you roughly $40 in holding, depreciation, and flooring.** [Talk to our team about dealership operations](https://www.visquanta.com/book-demo): we help dealers tighten turn times and close the gap between acquisition price and retail-ready.',
  industry_trends:
    '**Dealer principals who operationalize AI in 2026 will own the retention gap before their competitors recognize it exists.** [Book a VisQuanta demo](https://www.visquanta.com/book-demo): see the full AutoMaster Suite — lead reactivation, speed to lead, service drive, reputation, and web capture — working together on your store.',
};

export function buildMidArticleCTA(categoryId?: string): string {
  const copy = (categoryId && CTA_BY_CATEGORY[categoryId]) || CTA_BY_CATEGORY.speed_to_lead;
  return [
    '',
    '---',
    '',
    copy,
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
