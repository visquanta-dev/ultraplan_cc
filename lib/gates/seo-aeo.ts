import type { GateResult, GateParagraphFinding } from './types';
import type { Outline } from '../stages/outline';
import type { TransformedParagraph } from '../stages/voice-transform';

// ---------------------------------------------------------------------------
// Gate f — SEO + AEO optimization rubric
//
// Runs a deterministic 40-point rubric against the finished draft (after
// voice-transform but before PR creation) and returns a score. Every check
// is either pass/fail (1 point) or partial credit (0.5/1 point). The gate
// is "retriable" in the sense that the retry loop could regenerate failing
// paragraphs — but most checks aren't paragraph-level, they're post-level,
// so the retry will probably not fix them. Intended enforcement: tiered.
//   - score 100% -> passed
//   - anything below 100% -> blocked before PR creation
//
// Spec source: the 40-point checklist negotiated in the Phase 2 audit.
// Adding/removing checks: edit the `checks` array below. Every check is
// self-contained and self-scoring — keep them deterministic where possible,
// reserve LLM judges for the 3 checks that truly need them.
// ---------------------------------------------------------------------------

// Inputs — the gate is called against the FINISHED markdown, frontmatter,
// and paragraph list (so it can count sentences, inspect headings, etc.).
export interface SeoAeoInput {
  /** The full rendered markdown (frontmatter + body). */
  markdown: string;
  /** The outline this post was built from — gives us the headline and
   *  section structure without re-parsing from markdown. */
  outline: Outline;
  /** Finished paragraphs (post voice-transform). */
  paragraphs: TransformedParagraph[];
  /** Frontmatter fields already computed by the pipeline. */
  frontmatter: {
    title: string;
    slug: string;
    metaDescription: string;
    image: string;
  };
}

// ---------------------------------------------------------------------------
// Check result shape — every check returns 0..1 score + a reason.
// ---------------------------------------------------------------------------

interface CheckResult {
  id: string;
  category: 'seo' | 'aeo';
  weight: number; // usually 1, max 2 for critical items
  score: number; // 0 .. weight
  passed: boolean;
  reason: string;
}

type Check = (input: SeoAeoInput) => CheckResult;

// ---------------------------------------------------------------------------
// Helper parsers
// ---------------------------------------------------------------------------

function stripFrontmatter(markdown: string): string {
  const m = markdown.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return m ? m[1] : markdown;
}

function extractBody(markdown: string): string {
  return stripFrontmatter(markdown);
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function extractH2s(body: string): string[] {
  return [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
}

function extractH3s(body: string): string[] {
  return [...body.matchAll(/^### (.+)$/gm)].map((m) => m[1].trim());
}

function firstBodyParagraph(body: string): string {
  // Skip leading H2s, TL;DR blockquotes, and whitespace to find the first
  // prose paragraph of actual body content.
  const lines = body.split('\n');
  let inBlockquote = false;
  let collecting = false;
  const collected: string[] = [];
  for (const line of lines) {
    if (line.startsWith('> ')) {
      inBlockquote = true;
      continue;
    }
    if (line.startsWith('#')) {
      if (collecting) break;
      continue;
    }
    if (line.trim() === '') {
      if (collecting) break;
      inBlockquote = false;
      continue;
    }
    if (!inBlockquote) {
      collecting = true;
      collected.push(line);
    }
  }
  return collected.join(' ').trim();
}

function isQuestionHeading(h: string): boolean {
  const leaders = ['what', 'why', 'how', 'when', 'where', 'which', 'who', 'is', 'are', 'does', 'do', 'can', 'should', 'will'];
  const first = h.replace(/[#\s]+/, '').split(/\s/)[0]?.toLowerCase() ?? '';
  return h.trim().endsWith('?') || leaders.includes(first);
}

// ---------------------------------------------------------------------------
// Checks (20 SEO + 20 AEO = 40 total points)
// ---------------------------------------------------------------------------

const checks: Check[] = [
  // -------------------- SEO 1: title length --------------------
  (input) => {
    const len = input.frontmatter.title.length;
    const passed = len >= 30 && len <= 60;
    return {
      id: 'seo/title-length',
      category: 'seo',
      weight: 1,
      score: passed ? 1 : 0,
      passed,
      reason: `title is ${len} chars (target 30-60)`,
    };
  },

  // -------------------- SEO 2: meta description length --------------------
  (input) => {
    const len = input.frontmatter.metaDescription.length;
    const passed = len >= 120 && len <= 160;
    return {
      id: 'seo/meta-description-length',
      category: 'seo',
      weight: 1,
      score: passed ? 1 : len >= 100 && len <= 170 ? 0.5 : 0,
      passed,
      reason: `meta description is ${len} chars (target 120-160)`,
    };
  },

  // -------------------- SEO 3: slug quality --------------------
  (input) => {
    const slug = input.frontmatter.slug;
    const tooLong = slug.length > 70;
    // Require a 3+ letter repeated word between dashes, anchored on both
    // sides so single-letter transitions across dashes ("vs-sales" → s-s)
    // don't false-positive. Matches truly duplicated words like
    // "sales-sales" or "dealer-dealers" without eating "vs-sales".
    const hasRepeats = /(?:^|-)([a-z]{3,})-\1(?:-|$)/.test(slug);
    const passed = !tooLong && !hasRepeats && slug === slug.toLowerCase();
    return {
      id: 'seo/slug-quality',
      category: 'seo',
      weight: 1,
      score: passed ? 1 : 0,
      passed,
      reason: passed
        ? `slug "${slug}" is clean`
        : `slug issues: ${tooLong ? 'too long ' : ''}${hasRepeats ? 'repeated word ' : ''}`,
    };
  },

  // -------------------- SEO 4: primary keyword in first 100 words --------------------
  (input) => {
    const body = extractBody(input.markdown);
    const firstPara = firstBodyParagraph(body);
    const first100 = firstPara.split(/\s+/).slice(0, 100).join(' ').toLowerCase();
    // Derive the primary keyword from the headline: drop stopwords, take 2-3
    // most substantive words and check if they all appear in first100.
    const stopwords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'is', 'are', 'do', 'does', 'this', 'that', 'these', 'those', 'still', 'are', 'why', 'how', 'what']);
    const headlineTokens = input.frontmatter.title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !stopwords.has(w));
    const topTokens = headlineTokens.slice(0, 3);
    const matched = topTokens.filter((t) => first100.includes(t));
    const passed = matched.length >= 2;
    return {
      id: 'seo/primary-keyword-in-intro',
      category: 'seo',
      weight: 1,
      score: matched.length >= 2 ? 1 : matched.length === 1 ? 0.5 : 0,
      passed,
      reason: `${matched.length}/${topTokens.length} primary keywords (${topTokens.join(', ')}) in first 100 body words`,
    };
  },

  // -------------------- SEO 5: H2/H3 hierarchy --------------------
  (input) => {
    const body = extractBody(input.markdown);
    const h2s = extractH2s(body);
    const h3s = extractH3s(body);
    const passed = h2s.length >= 5 && h3s.length >= h2s.length; // avg 1+ H3 per H2
    return {
      id: 'seo/heading-hierarchy',
      category: 'seo',
      weight: 1,
      score: passed ? 1 : h2s.length >= 4 ? 0.5 : 0,
      passed,
      reason: `${h2s.length} H2s, ${h3s.length} H3s (target: >=5 H2, >=1 H3 per H2)`,
    };
  },

  // -------------------- SEO 6: word count --------------------
  (input) => {
    const body = extractBody(input.markdown);
    const wc = countWords(body);
    const ranges: Record<string, { min: number; max: number; softMin: number; softMax: number }> = {
      daily_seo: { min: 1500, max: 3000, softMin: 1200, softMax: 3500 },
      weekly_authority: { min: 2000, max: 3400, softMin: 1800, softMax: 3700 },
      monthly_anonymized_case: { min: 2500, max: 3800, softMin: 2200, softMax: 4200 },
      listicle: { min: 1800, max: 2600, softMin: 1600, softMax: 3000 },
    };
    const range = ranges[input.outline.lane] ?? ranges.daily_seo;
    const passed = wc >= range.min && wc <= range.max;
    return {
      id: 'seo/word-count',
      category: 'seo',
      weight: 1,
      score: passed ? 1 : wc >= range.softMin && wc <= range.softMax ? 0.5 : 0,
      passed,
      reason: `${wc} words (target ${range.min}-${range.max} for ${input.outline.lane})`,
    };
  },

  // -------------------- SEO 7: internal links (body + structural) --------------------
  (input) => {
    const body = extractBody(input.markdown);
    const internal = [...body.matchAll(/\]\(https?:\/\/[^)]*visquanta\.com[^)]*\)/g)];
    const count = internal.length;
    // Target 3-15 — the inline auto-linker caps at 8, but Related Reading
    // adds 2-3, mid-article CTA adds 1, and FAQ/body might include 1-2
    // more via keyword matching. Calculator/tool embeds can add one more.
    const passed = count >= 3 && count <= 15;
    return {
      id: 'seo/internal-link-count',
      category: 'seo',
      weight: 1,
      score: passed ? 1 : count >= 2 && count <= 18 ? 0.5 : 0,
      passed,
      reason: `${count} internal links (target 3-15)`,
    };
  },

  // -------------------- SEO 8: external links 2-6 --------------------
  (input) => {
    const body = extractBody(input.markdown);
    const all = [...body.matchAll(/\]\((https?:\/\/[^)]+)\)/g)];
    const external = all.filter((m) => !m[1].includes('visquanta.com'));
    const count = external.length;
    const passed = count >= 2 && count <= 8;
    return {
      id: 'seo/external-link-count',
      category: 'seo',
      weight: 1,
      score: passed ? 1 : count >= 1 && count <= 10 ? 0.5 : 0,
      passed,
      reason: `${count} external links (target 2-8)`,
    };
  },

  // -------------------- SEO 9: image present in frontmatter --------------------
  (input) => {
    const img = input.frontmatter.image;
    const passed = Boolean(img) && img.startsWith('/') && /\.(png|jpe?g|webp)$/i.test(img);
    return {
      id: 'seo/image-present',
      category: 'seo',
      weight: 1,
      score: passed ? 1 : 0,
      passed,
      reason: passed ? `hero image: ${img}` : 'hero image missing or wrong format',
    };
  },

  // -------------------- SEO 10: tables present --------------------
  (input) => {
    const body = extractBody(input.markdown);
    const tableLines = [...body.matchAll(/^\|/gm)].length;
    const passed = tableLines >= 6; // at least one table with 6+ rows, or two smaller
    return {
      id: 'seo/structured-data-tables',
      category: 'seo',
      weight: 1,
      score: passed ? 1 : tableLines >= 3 ? 0.5 : 0,
      passed,
      reason: `${tableLines} table rows (target >=6)`,
    };
  },

  // -------------------- SEO 11: no em dashes --------------------
  (input) => {
    const body = extractBody(input.markdown);
    const count = (body.match(/—/g) || []).length;
    const passed = count === 0;
    return {
      id: 'seo/no-em-dashes',
      category: 'seo',
      weight: 0.5,
      score: passed ? 0.5 : 0,
      passed,
      reason: passed ? 'no em dashes' : `${count} em dashes found (use hyphens)`,
    };
  },

  // -------------------- SEO 12: no banned AI vocab --------------------
  (input) => {
    const body = extractBody(input.markdown);
    const banned = [
      'AI-driven',
      'AI-powered',
      'AI-enabled',
      'AI-first',
      'AI-native',
      'AI-ready',
      'harness AI',
      'leverage AI',
      'the power of AI',
      'AI is transforming',
      'AI is reshaping',
    ];
    const found = banned.filter((b) => new RegExp(b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(body));
    const passed = found.length === 0;
    return {
      id: 'seo/no-banned-ai-vocab',
      category: 'seo',
      weight: 0.5,
      score: passed ? 0.5 : 0,
      passed,
      reason: passed ? 'no banned AI vocab' : `found: ${found.join(', ')}`,
    };
  },

  // -------------------- SEO 13: lane target keyword in headline --------------------
  (input) => {
    // Approximate: the headline must contain at least one keyword that matches
    // the rendered H2s after final markdown normalization.
    const headline = input.frontmatter.title.toLowerCase();
    const body = extractBody(input.markdown);
    const sectionWords = extractH2s(body)
      .filter((h) => !/frequently asked|related reading/i.test(h))
      .flatMap((h) => h.toLowerCase().split(/\s+/))
      .filter((w) => w.length >= 4);
    const matches = sectionWords.filter((w) => headline.includes(w));
    const passed = matches.length >= 1;
    return {
      id: 'seo/keyword-headline-section-consistency',
      category: 'seo',
      weight: 1,
      score: passed ? 1 : 0,
      passed,
      reason: passed
        ? `headline shares ${matches.length} keyword(s) with section headings`
        : 'headline and section headings have no keyword overlap',
    };
  },

  // -------------------- AEO 1: Key Takeaway block at top --------------------
  (input) => {
    // Accept EITHER format near top of body:
    //   (a) "### Key Takeaways" bullet block (current default, shipped 2026-04-18)
    //   (b) "> **Key Takeaway:** ..." blockquote (legacy, kept for older posts)
    // The blockquote was dropped for new pipeline posts because it duplicated
    // the bullet list. Both are high-value AEO extraction targets, so either
    // satisfies the check.
    const body = extractBody(input.markdown).trimStart();
    const topLines = body.split('\n').slice(0, 30);
    const hasBulletBlock = topLines.some((l) => /^###\s+Key Takeaways\b/i.test(l));
    const blockquoteLine = topLines.find((l) => l.startsWith('> '));
    const hasBlockquote =
      blockquoteLine !== undefined &&
      /\*\*(Key Takeaway|The Bottom Line|TL;DR)/i.test(blockquoteLine);
    const passed = hasBulletBlock || hasBlockquote;
    const which = hasBulletBlock ? 'bullet' : hasBlockquote ? 'blockquote' : 'none';
    return {
      id: 'aeo/tldr-block-at-top',
      category: 'aeo',
      weight: 2, // double-weighted because it's the highest-leverage AEO signal
      score: passed ? 2 : 0,
      passed,
      reason: passed
        ? `Key Takeaways block present near top of body (${which})`
        : 'no Key Takeaways bullet block or blockquote near top of body - LLMs will not reliably extract a summary',
    };
  },

  // -------------------- AEO 2: question-phrased H2s --------------------
  (input) => {
    const body = extractBody(input.markdown);
    const h2s = extractH2s(body);
    // Exclude the FAQ heading itself from this count — it's always "Frequently Asked Questions"
    const contentH2s = h2s.filter((h) => !/frequently asked|related reading/i.test(h));
    const questionH2s = contentH2s.filter(isQuestionHeading);
    const target = input.outline.lane === 'listicle' ? 3 : 4;
    const passed = questionH2s.length >= target;
    return {
      id: 'aeo/question-phrased-h2s',
      category: 'aeo',
      weight: 2, // double-weighted
      score: passed ? 2 : questionH2s.length >= 2 ? 1 : 0,
      passed,
      reason: `${questionH2s.length}/${contentH2s.length} content H2s are question-phrased (target >=${target})`,
    };
  },

  // -------------------- AEO 3: FAQ section present --------------------
  (input) => {
    const body = extractBody(input.markdown);
    // Locate the FAQ H2 by line-start match, then slice the section out of
    // the body manually. The previous regex approach used a lookahead with
    // `$` that collapsed to end-of-line under the `m` flag, which returned
    // zero H3s even when the section had six. Slicing is more robust.
    const faqH2Match = body.match(/^## .*frequently asked.*$/im);
    let faqH3s = 0;
    if (faqH2Match && faqH2Match.index !== undefined) {
      const afterFaq = body.slice(faqH2Match.index + faqH2Match[0].length);
      const nextH2 = afterFaq.match(/\n## /);
      const faqSection = nextH2 && nextH2.index !== undefined ? afterFaq.slice(0, nextH2.index) : afterFaq;
      faqH3s = (faqSection.match(/^### .+\?\s*$/gm) || []).length;
    }
    const hasFaqH2 = Boolean(faqH2Match);
    const passed = hasFaqH2 && faqH3s >= 5;
    return {
      id: 'aeo/faq-section',
      category: 'aeo',
      weight: 1,
      score: passed ? 1 : hasFaqH2 && faqH3s >= 3 ? 0.5 : 0,
      passed,
      reason: hasFaqH2
        ? `FAQ section present with ${faqH3s} question H3s (target >=5)`
        : 'no FAQ section found',
    };
  },

  // -------------------- AEO 4: first-body-para answers the headline --------------------
  (input) => {
    // Weak heuristic: first body paragraph should mention a number, statistic,
    // or noun phrase that also appears in the headline. This approximates
    // "direct answer in first 100 words".
    const body = extractBody(input.markdown);
    const firstPara = firstBodyParagraph(body);
    const hasNumber = /\d+(\.\d+)?%?/.test(firstPara);
    const wc = firstPara.split(/\s+/).length;
    const passed = hasNumber && wc >= 40 && wc <= 200;
    return {
      id: 'aeo/first-para-direct-answer',
      category: 'aeo',
      weight: 1,
      score: passed ? 1 : (hasNumber || (wc >= 30 && wc <= 250)) ? 0.5 : 0,
      passed,
      reason: `first body para: ${wc} words, ${hasNumber ? 'has' : 'no'} numeric anchor`,
    };
  },

  // -------------------- AEO 5: what-is definitional section --------------------
  (input) => {
    const body = extractBody(input.markdown);
    const hasWhatIs = /^##.*\bwhat\s+is\b/im.test(body);
    const passed = hasWhatIs;
    return {
      id: 'aeo/what-is-section',
      category: 'aeo',
      weight: 1,
      score: passed ? 1 : 0,
      passed,
      reason: passed ? 'explicit What is [topic] section found' : 'no "What is [topic]" section',
    };
  },

  // -------------------- AEO 6: external citation density --------------------
  (input) => {
    const body = extractBody(input.markdown);
    const externalLinks = [...body.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].filter(
      (m) => !m[1].includes('visquanta.com'),
    ).length;
    const sections = input.outline.sections.length;
    // Target: at least one external citation per 2 sections
    const passed = externalLinks >= Math.ceil(sections / 2);
    return {
      id: 'aeo/citation-density',
      category: 'aeo',
      weight: 1,
      score: passed ? 1 : externalLinks >= 1 ? 0.5 : 0,
      passed,
      reason: `${externalLinks} external citations across ${sections} sections`,
    };
  },

  // -------------------- AEO 7: Flesch reading ease proxy (sentence length) --------------------
  (input) => {
    const body = extractBody(input.markdown)
      .replace(/^#.+$/gm, '')
      .replace(/^\|.+\|$/gm, '')
      .replace(/^>\s.+$/gm, '')
      .replace(/\[[^\]]+\]\([^)]+\)/g, '$1')
      .replace(/[*_`]/g, '');
    const sentences = body.split(/[.!?]+\s/).map((s) => s.trim()).filter((s) => s.length > 10);
    if (sentences.length === 0) {
      return { id: 'aeo/readability', category: 'aeo', weight: 1, score: 0, passed: false, reason: 'no parseable sentences' };
    }
    const avgWords = sentences.reduce((sum, s) => sum + s.split(/\s+/).length, 0) / sentences.length;
    const longSentences = sentences.filter((s) => s.split(/\s+/).length > 35).length;
    // Target: avg 12-25 words, fewer than 15% of sentences over 35 words.
    // Gate-passed technical dealer posts often carry longer stat clauses;
    // this catches true walls of text without blocking sourced specificity.
    const avgOK = avgWords >= 12 && avgWords <= 25;
    const longRatio = longSentences / sentences.length;
    const passed = avgOK && longRatio < 0.15;
    return {
      id: 'aeo/readability',
      category: 'aeo',
      weight: 1,
      score: passed ? 1 : avgOK || longRatio < 0.25 ? 0.5 : 0,
      passed,
      reason: `avg sentence ${avgWords.toFixed(1)} words, ${longSentences}/${sentences.length} over 35 words`,
    };
  },

  // -------------------- AEO 8: lists for scannability --------------------
  (input) => {
    const body = extractBody(input.markdown);
    const lists = (body.match(/^[-*] /gm) || []).length + (body.match(/^\d+\. /gm) || []).length;
    const passed = lists >= 5;
    return {
      id: 'aeo/list-items',
      category: 'aeo',
      weight: 0.5,
      score: passed ? 0.5 : lists >= 3 ? 0.25 : 0,
      passed,
      reason: `${lists} list items (target >=5)`,
    };
  },

  // -------------------- AEO 9: stat attribution --------------------
  (input) => {
    const body = extractBody(input.markdown);
    // Count distinct percent stats — repeated references to the same stat
    // shouldn't each require their own attribution. Use a rough dedupe by
    // stat value.
    const statMatches = [...body.matchAll(/\b(\d+(?:\.\d+)?)%/g)];
    const uniqueStats = new Set(statMatches.map((m) => m[1])).size;
    const attributions = (body.match(/according to|survey|study|report|research|found that|cited by|per\b/gi) || []).length;
    // Target: attribution markers at >= 30% of unique stat values
    const passed = uniqueStats === 0 || attributions >= Math.ceil(uniqueStats * 0.3);
    return {
      id: 'aeo/stat-attribution',
      category: 'aeo',
      weight: 1,
      score: passed ? 1 : attributions >= Math.ceil(uniqueStats * 0.15) ? 0.5 : 0,
      passed,
      reason: `${uniqueStats} unique stats (${statMatches.length} mentions), ${attributions} attribution markers`,
    };
  },

  // -------------------- AEO 10: no stale year references --------------------
  (input) => {
    const body = extractBody(input.markdown);
    const currentYear = new Date().getFullYear();
    // Count distinct stale years (2019 through currentYear - 3). One
    // historical reference is legitimate framing ("since 2022, dealers
    // have..."); three or more distinct old years means the post is
    // rooted in outdated data and should be rewritten. The old rule
    // treated any stale reference as a failure, which punished honest
    // historical comparison writing.
    const staleYears: number[] = [];
    for (let y = 2019; y < currentYear - 2; y++) {
      const re = new RegExp(`\\b${y}\\b`, 'g');
      const matches = (body.match(re) || []).length;
      if (matches > 0) staleYears.push(y);
    }
    const passed = staleYears.length <= 1;
    return {
      id: 'aeo/no-stale-years',
      category: 'aeo',
      weight: 1,
      score:
        staleYears.length === 0
          ? 1
          : staleYears.length === 1
          ? 1 // one historical reference is healthy context
          : staleYears.length === 2
          ? 0.5
          : 0,
      passed,
      reason:
        staleYears.length === 0
          ? 'no stale year references'
          : staleYears.length === 1
          ? `one stale year reference (${staleYears[0]}) — treated as historical context`
          : `references to stale years: ${staleYears.join(', ')}`,
    };
  },

  // -------------------- AEO 11: short quotable sentences present --------------------
  (input) => {
    const body = extractBody(input.markdown)
      .replace(/^#.+$/gm, '')
      .replace(/^\|.+\|$/gm, '')
      .replace(/^>\s.+$/gm, '')
      .replace(/\[[^\]]+\]\([^)]+\)/g, '$1')
      .replace(/[*_`]/g, '');
    const sentences = body.split(/[.!?]+\s/).map((s) => s.trim());
    const shortQuotable = sentences.filter((s) => {
      const w = s.split(/\s+/).length;
      return w >= 6 && w <= 15;
    }).length;
    const passed = shortQuotable >= 3;
    return {
      id: 'aeo/quotable-sentences',
      category: 'aeo',
      weight: 0.5,
      score: passed ? 0.5 : shortQuotable >= 2 ? 0.25 : 0,
      passed,
      reason: `${shortQuotable} short (6-15 word) sentences available for LLM quoting (target >=3)`,
    };
  },

  // -------------------- AEO: listicle word count (lane-gated) --------------------
  // Listicle prompt targets 1800-2400. The CSI listicle we audited shipped at
  // ~3800 words — prompt-only enforcement didn't hold. This is the gate that
  // locks it down. weight=0 for non-listicle so the check is a no-op there.
  (input) => {
    if (input.outline.lane !== 'listicle') {
      return { id: 'aeo/listicle-word-count', category: 'aeo', weight: 0, score: 0, passed: true, reason: 'not a listicle (skipped)' };
    }
    const body = extractBody(input.markdown);
    const wc = countWords(body);
    const passed = wc >= 1800 && wc <= 2400;
    return {
      id: 'aeo/listicle-word-count',
      category: 'aeo',
      weight: 2,
      score: passed ? 2 : wc >= 1600 && wc <= 2800 ? 1 : 0,
      passed,
      reason: `listicle body is ${wc} words (target 1800-2400)`,
    };
  },

  // -------------------- AEO: listicle numbered H2 count matches title N --------------------
  // "7 Ways..." MUST produce exactly 7 numbered H2s. Prompt-only enforcement
  // passed on the CSI test but we want the hard guarantee. Lane-gated.
  (input) => {
    if (input.outline.lane !== 'listicle') {
      return { id: 'aeo/listicle-h2-count', category: 'aeo', weight: 0, score: 0, passed: true, reason: 'not a listicle (skipped)' };
    }
    const titleN = parseInt(input.frontmatter.title.match(/^\d+/)?.[0] ?? '0', 10);
    const body = extractBody(input.markdown);
    const numberedH2s = [...body.matchAll(/^## \d+\.\s+/gm)];
    const count = numberedH2s.length;
    const passed = titleN > 0 && count === titleN;
    return {
      id: 'aeo/listicle-h2-count',
      category: 'aeo',
      weight: 2,
      score: passed ? 2 : 0,
      passed,
      reason: `title promises ${titleN || '??'}, body has ${count} numbered H2s`,
    };
  },

  // -------------------- AEO: listicle question-heading ratio --------------------
  // The CSI listicle had 7/7 numbered H2s phrased as questions. That repetition
  // becomes its own AI tell. Cap at 50%. Lane-gated.
  (input) => {
    if (input.outline.lane !== 'listicle') {
      return { id: 'aeo/listicle-question-ratio', category: 'aeo', weight: 0, score: 0, passed: true, reason: 'not a listicle (skipped)' };
    }
    const body = extractBody(input.markdown);
    const numberedH2s = [...body.matchAll(/^## (\d+\.\s+.+)$/gm)].map((m) => m[1]);
    if (numberedH2s.length === 0) {
      return { id: 'aeo/listicle-question-ratio', category: 'aeo', weight: 1, score: 0, passed: false, reason: 'no numbered H2s to evaluate' };
    }
    const questionCount = numberedH2s.filter((h) => h.trim().endsWith('?')).length;
    const ratio = questionCount / numberedH2s.length;
    const passed = ratio <= 0.5;
    return {
      id: 'aeo/listicle-question-ratio',
      category: 'aeo',
      weight: 1,
      score: passed ? 1 : ratio <= 0.7 ? 0.5 : 0,
      passed,
      reason: `${questionCount}/${numberedH2s.length} (${Math.round(ratio * 100)}%) numbered H2s phrased as questions (target <=50%)`,
    };
  },
];

// ---------------------------------------------------------------------------
// Gate entry point
// ---------------------------------------------------------------------------

const MAX_SCORE = 20; // computed from check weights below
const PASS_THRESHOLD = 1; // 100% required before PR creation

export async function runSeoAeoGate(
  input: SeoAeoInput,
): Promise<GateResult> {
  const results = checks.map((c) => c(input));

  const totalScore = results.reduce((sum, r) => sum + r.score, 0);
  const maxScore = results.reduce((sum, r) => sum + r.weight, 0);
  const ratio = maxScore > 0 ? totalScore / maxScore : 0;
  const passed = ratio >= PASS_THRESHOLD;

  const findings: GateParagraphFinding[] = results.map((r, i) => ({
    paragraph_index: i, // using index as a stable id for the check
    passed: r.passed,
    score: r.weight > 0 ? Math.round((r.score / r.weight) * 100) / 100 : 1,
    reason: `[${r.id}] ${r.reason}`,
  }));

  const failing = results.filter((r) => !r.passed).map((r) => r.id);
  const summary = `SEO+AEO score ${totalScore.toFixed(1)}/${maxScore.toFixed(1)} (${Math.round(ratio * 100)}%)${failing.length > 0 ? ` — failed: ${failing.join(', ')}` : ''}`;

  return {
    gate: 'seo-aeo',
    passed,
    aggregate_score: Math.round(ratio * 100),
    paragraph_findings: findings,
    summary,
    retriable: false, // most SEO/AEO checks aren't paragraph-level, regen won't fix them
    failing_paragraph_indices: [],
  };
}

// Export for use by preflight and admin dashboard
export { checks as seoAeoChecks, MAX_SCORE, PASS_THRESHOLD };
