import type { Bundle, ScrapedInput, Source, Quote } from './types';

// ---------------------------------------------------------------------------
// Bundle assembler — spec §5a
// Pure code, no LLM. Takes an array of scraped articles and extracts 3–8
// verbatim factual quotes per article, assigns stable quote_ids, and returns
// a Bundle ready to hand to the drafting pipeline.
//
// Spec §5a specifies:
//   "factual sentences only, not opinion fluff"
//   "1–3 specific numbers/stats with sentence context"
// We implement that by scoring every sentence in the raw text and keeping
// the top-N by a score that rewards presence of numbers, percentages, and
// concrete nouns while penalizing hedging, opinion markers, and promotional
// language.
// ---------------------------------------------------------------------------

const MIN_QUOTES_PER_SOURCE = 3;
const MAX_QUOTES_PER_SOURCE = 8;
const MIN_SENTENCE_LEN = 40;
const MAX_SENTENCE_LEN = 400;

// Words that mark opinion/hedging/promotion and should be downweighted.
// Kept deliberately small — this is a heuristic, not a semantic classifier.
const DOWNWEIGHT_PATTERNS = [
  /\bI think\b/i,
  /\bI believe\b/i,
  /\bmay\b/i,
  /\bmight\b/i,
  /\bperhaps\b/i,
  /\bprobably\b/i,
  /\bamazing\b/i,
  /\bincredible\b/i,
  /\bgame[- ]chang/i,
  /\brevolutioniz/i,
  /\bbreakthrough\b/i,
  /\bexcit\w*/i,
  /\bthrilled\b/i,
];

/**
 * Split raw text into candidate sentences. We do a simple period-bound
 * split and then filter by length. Not perfect — "Inc." and "U.S." are
 * imperfectly handled — but good enough for quote candidate selection
 * because we're picking the best sentences, not all of them.
 */
function splitSentences(text: string): string[] {
  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();

  // Split on sentence-ending punctuation followed by whitespace and an
  // uppercase letter (common sentence boundary).
  const parts = normalized.split(/(?<=[.!?])\s+(?=[A-Z"])/);

  return parts
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_SENTENCE_LEN && s.length <= MAX_SENTENCE_LEN);
}

/**
 * Score a candidate sentence. Higher is better. Rewards numbers, percentages,
 * years, citation markers. Penalizes opinion/hedging language.
 */
function scoreSentence(sentence: string): number {
  let score = 0;

  // Presence of a percentage is a strong factual signal.
  if (/\d+\s*%|\d+\s*percent/i.test(sentence)) score += 5;

  // Presence of a dollar or number-with-unit is a factual signal.
  if (/\$\d/.test(sentence)) score += 4;
  if (/\d+(?:,\d{3})+/.test(sentence)) score += 3; // commas in large numbers
  if (/\b\d{4}\b/.test(sentence)) score += 2; // likely a year

  // Raw digit presence (small bonus)
  const digitMatches = sentence.match(/\d+/g);
  if (digitMatches) score += Math.min(digitMatches.length, 3);

  // "According to X", "X reported that" — strong citation signal
  if (/\baccording to\b/i.test(sentence)) score += 3;
  if (/\breported(?:ly)?\b/i.test(sentence)) score += 2;
  if (/\bsurvey(?:ed)?\b/i.test(sentence)) score += 2;
  if (/\bresearch\b/i.test(sentence)) score += 2;
  if (/\bstudy\b/i.test(sentence)) score += 2;

  // Downweight opinion and hedging
  for (const pattern of DOWNWEIGHT_PATTERNS) {
    if (pattern.test(sentence)) score -= 4;
  }

  // Slight preference for moderate-length sentences
  const lenScore = 1 - Math.abs(sentence.length - 150) / 200;
  score += Math.max(0, lenScore);

  return score;
}

/**
 * Classify a quote by type. Used for stat tracking in spec §5a example
 * bundle entries.
 */
function classifyQuote(sentence: string): Quote['type'] {
  if (/\d+\s*%|\d+\s*percent|\$\d|\d+(?:,\d{3})+/.test(sentence)) return 'stat';
  if (/\baccording to\b|\breported|\bresearch|\bstudy\b/i.test(sentence)) return 'claim';
  if (DOWNWEIGHT_PATTERNS.some((p) => p.test(sentence))) return 'opinion';
  return 'context';
}

/**
 * Extract 3–8 verbatim quotes from a scraped article, preferring high-scoring
 * factual sentences. Returns fewer than 3 only if the article has fewer than
 * 3 qualifying sentences total — the caller should skip sources with too few
 * quotes.
 */
function extractQuotes(sourceId: string, rawText: string): Quote[] {
  const sentences = splitSentences(rawText);
  if (sentences.length === 0) return [];

  // Score every sentence, sort descending, take top N.
  const scored = sentences
    .map((text) => ({ text, score: scoreSentence(text) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const picked = scored.slice(0, MAX_QUOTES_PER_SOURCE);

  return picked.map((s, index) => ({
    quote_id: `${sourceId}_q${index + 1}`,
    text: s.text,
    type: classifyQuote(s.text),
  }));
}

/**
 * Extract hostname from a URL, stripping 'www.' prefix. Returns empty string
 * if the URL is malformed (caller decides how to handle).
 */
function extractDomain(url: string): string {
  try {
    const { hostname } = new URL(url);
    return hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Assemble a Bundle from a set of scraped inputs. Sources that yield fewer
 * than MIN_QUOTES_PER_SOURCE are dropped — we cannot anchor paragraphs to
 * sources with insufficient evidence.
 *
 * @param inputs scraped articles from the source layer
 * @param meta bundle metadata (lane + topic_slug)
 * @returns a Bundle ready for the drafter
 */
export function assembleBundle(
  inputs: ScrapedInput[],
  meta: { lane: Bundle['lane']; topic_slug: string },
): Bundle {
  const sources: Source[] = [];

  inputs.forEach((input, index) => {
    const sourceId = `src_${String(index + 1).padStart(3, '0')}`;
    const quotes = extractQuotes(sourceId, input.rawText);

    if (quotes.length < MIN_QUOTES_PER_SOURCE) {
      // Skip — not enough evidence. The drafter needs every paragraph
      // anchored to a quote, so a source with 0–2 quotes is worse than
      // no source at all.
      return;
    }

    sources.push({
      source_id: sourceId,
      domain: extractDomain(input.url),
      url: input.url,
      title: input.title,
      published: input.publishedAt,
      quotes,
    });
  });

  if (sources.length === 0) {
    throw new Error(
      '[bundle] assembled bundle has zero sources — no input article had enough factual sentences to anchor drafting. Aborting run.',
    );
  }

  return {
    bundle_id: `bundle_${meta.topic_slug}_${Date.now()}`,
    lane: meta.lane,
    topic_slug: meta.topic_slug,
    assembled_at: new Date().toISOString(),
    sources,
  };
}
