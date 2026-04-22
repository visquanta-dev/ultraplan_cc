import fs from 'node:fs';
import path from 'node:path';
import type { TransformedParagraph } from '../stages/voice-transform';
import type { GateParagraphFinding, GateResult } from './types';

// ---------------------------------------------------------------------------
// Gate f — Vertical discipline (2026-04-22)
//
// Rule: the first ~200 words of every post must contain at least one term
// from config/voice/audience_anchors.txt. Zero matches = fail. The post
// reads generic — it could run on any vendor blog in any vertical.
// visquanta.com writes for franchise auto dealers; that audience must be
// visible up front or the post fails the swap test.
//
// Pattern mirrors slop-lexicon: load the list once, compile cheap
// case-insensitive regexes with loose word boundaries so F&I and hyphenated
// terms still match. Pure code, no LLM call, runs after trace-back so it
// short-circuits generic drafts before any expensive gates run.
// ---------------------------------------------------------------------------

const ANCHORS_PATH = path.join(process.cwd(), 'config', 'voice', 'audience_anchors.txt');
const OPENING_WORD_BUDGET = 200;

let cachedAnchors: string[] | null = null;
let cachedRegexes: RegExp[] | null = null;

function loadAudienceAnchors(): string[] {
  if (cachedAnchors) return cachedAnchors;
  const raw = fs.readFileSync(ANCHORS_PATH, 'utf-8');
  cachedAnchors = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  return cachedAnchors;
}

function getAudienceAnchorRegexes(): RegExp[] {
  if (cachedRegexes) return cachedRegexes;
  const anchors = loadAudienceAnchors();
  cachedRegexes = anchors.map((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=[^A-Za-z0-9]|$)`, 'i');
  });
  return cachedRegexes;
}

/**
 * Returns every anchor term that appears in `text`. Case-insensitive.
 * Exported so other stages (e.g. originate-path preflight) can reuse the
 * same detection without re-importing the regex construction.
 */
export function findAudienceAnchorMatches(text: string): string[] {
  const regexes = getAudienceAnchorRegexes();
  const anchors = loadAudienceAnchors();
  const matches: string[] = [];
  regexes.forEach((re, i) => {
    if (re.test(text)) matches.push(anchors[i]);
  });
  return matches;
}

/**
 * Collect paragraphs from the start of the post until we've covered roughly
 * OPENING_WORD_BUDGET words. We always include at least one paragraph even
 * if the first is already over budget, so very dense leads still get
 * inspected.
 */
function collectOpening(paragraphs: TransformedParagraph[]): {
  text: string;
  paragraphIndices: number[];
} {
  const opening: string[] = [];
  const indices: number[] = [];
  let wordCount = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    const paraText = paragraphs[i].text;
    opening.push(paraText);
    indices.push(i);
    wordCount += paraText.split(/\s+/).filter(Boolean).length;
    if (wordCount >= OPENING_WORD_BUDGET) break;
  }
  return { text: opening.join('\n\n'), paragraphIndices: indices };
}

/**
 * Run gate f: scan the opening ~200 words for dealer-audience anchor terms.
 * At least one match required to pass.
 */
export async function runVerticalDisciplineGate(
  paragraphs: TransformedParagraph[],
): Promise<GateResult> {
  if (paragraphs.length === 0) {
    return {
      gate: 'vertical-discipline',
      passed: false,
      paragraph_findings: [],
      summary: 'no paragraphs to inspect',
      retriable: false,
      failing_paragraph_indices: [],
    };
  }

  const { text, paragraphIndices } = collectOpening(paragraphs);
  const matches = findAudienceAnchorMatches(text);
  const passed = matches.length > 0;

  const findings: GateParagraphFinding[] = paragraphIndices.map((idx) => ({
    paragraph_index: idx,
    passed,
    matched: passed ? matches : undefined,
    reason: passed
      ? undefined
      : 'opening ~200 words contain no dealer-audience anchor terms (see config/voice/audience_anchors.txt)',
  }));

  return {
    gate: 'vertical-discipline',
    passed,
    paragraph_findings: findings,
    summary: passed
      ? `opening anchors: ${matches.slice(0, 4).join(', ')}${matches.length > 4 ? ` (+${matches.length - 4})` : ''}`
      : 'opening ~200 words lack any dealer-audience anchor term — post reads generic',
    retriable: true,
    failing_paragraph_indices: passed ? [] : paragraphIndices,
  };
}
