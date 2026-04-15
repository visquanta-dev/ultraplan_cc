import type { FeedArticle } from './crawl-index';

// ---------------------------------------------------------------------------
// Relevance filter — cheap pre-scrape culling
//
// Discovered article URLs from crawl-index can contain off-topic posts — a
// vendor blog's index page mixes product launches, HR posts, event recaps,
// etc. Running a full scrape on all of them wastes Firecrawl credits and
// drags the clustering step down.
//
// This filter takes the raw discovered list + the target lane's query
// keywords, scores each URL by slug-keyword overlap, and returns the top-N
// most relevant. The scoring is deterministic + allocation-free — no LLM
// calls, no network, just string matching.
//
// Why slug-only (not fetched title/description): we want the filter to run
// BEFORE any scrape, including metadata scrapes. Slugs are surprisingly
// informative for article-shaped URLs — most vendor blogs slugify the
// headline, so "/blog/voice-ai-dealership-bdc-2026" contains essentially
// the same keywords a headline fetch would return, for zero network cost.
// ---------------------------------------------------------------------------

// Lane-specific keyword banks. Kept in sync with the spirit of LANE_QUERIES
// in lib/topics/search.ts but broken down to individual scoring tokens (the
// search.ts queries are whole-phrase queries; this file scores single words).
const LANE_KEYWORDS: Record<string, string[]> = {
  daily_seo: [
    'dealership', 'dealer', 'automotive', 'service', 'bdc', 'rooftop',
    'voice', 'chat', 'lead', 'follow-up', 'technology', 'digital',
    'retail', 'fixed-ops', 'customer', 'phone', 'missed', 'call',
    'appointment', 'scheduling', 'automation', 'ai', 'agent',
  ],
  weekly_authority: [
    'dealer', 'principal', 'leadership', 'management', 'strategy',
    'industry', 'trends', 'market', 'inventory', 'profit', 'margin',
    'operations', 'floor', 'sales', 'gm', 'coo', 'executive', 'opinion',
    'commentary', 'analysis', 'benchmark',
  ],
  monthly_anonymized_case: [
    'case', 'study', 'results', 'metrics', 'implementation', 'rollout',
    'before', 'after', 'conversion', 'close', 'show', 'rate', 'lift',
    'revenue', 'roi', 'improved', 'increase', 'reduction', 'success',
  ],
};

function tokenize(str: string): string[] {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s/-]/g, ' ')
    .split(/[\s/-]+/)
    .filter((w) => w.length >= 3);
}

/**
 * Extract scoring tokens from a URL + optional title + optional description.
 * Hostname gives brand signal, path segments give slug tokens, and when
 * Firecrawl /v2/map provides title/description we blend those in too —
 * they're much richer than a slug for matching lane keywords.
 */
function articleTokens(article: { url: string; title?: string; description?: string }): Set<string> {
  try {
    const parsed = new URL(article.url);
    const host = parsed.hostname.replace(/^www\./, '');
    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    const parts = [host, ...pathSegments, article.title ?? '', article.description ?? ''];
    return new Set(tokenize(parts.join(' ')));
  } catch {
    return new Set();
  }
}

/**
 * Score a single article against a keyword bank. Each keyword match adds
 * 1 point; multi-word keywords like "follow-up" count when any sub-token
 * matches. Uses URL + title + description when available — an article with
 * a rich title "Why BDCs are shifting to voice agents" scores much higher
 * than one with a cryptic slug like "/2026/04/15/post-1234".
 */
export function scoreArticle(article: { url: string; title?: string; description?: string }, keywords: string[]): number {
  const tokens = articleTokens(article);
  let score = 0;
  for (const kw of keywords) {
    const kwTokens = tokenize(kw);
    for (const kt of kwTokens) {
      if (tokens.has(kt)) {
        score++;
        break;
      }
    }
  }
  return score;
}

/**
 * Filter a discovered-article list to the top-N most relevant for a lane.
 *
 * Default topN picks: daily_seo=8, weekly_authority=12, monthly_anonymized_case=6.
 * The resolver uses this before clustering so the downstream cluster stage
 * has a tighter, more coherent set of URLs to group.
 */
export function filterByRelevance(
  articles: FeedArticle[],
  lane: string,
  options: { topN?: number; extraKeywords?: string[] } = {},
): FeedArticle[] {
  const defaultTopN: Record<string, number> = {
    daily_seo: 8,
    weekly_authority: 12,
    monthly_anonymized_case: 6,
  };
  const topN = options.topN ?? defaultTopN[lane] ?? 8;

  const keywords = [
    ...(LANE_KEYWORDS[lane] ?? LANE_KEYWORDS.daily_seo),
    ...(options.extraKeywords ?? []),
  ];

  const scored = articles
    .map((article) => ({ article, score: scoreArticle(article, keywords) }))
    .filter((s) => s.score > 0) // drop zero-relevance articles entirely
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, topN).map((s) => s.article);
}

/**
 * Debug helper: return the scored list with scores visible, for log output
 * and telemetry. Not used on the hot path.
 */
export function scoreAndRank(
  articles: FeedArticle[],
  lane: string,
): Array<{ article: FeedArticle; score: number }> {
  const keywords = LANE_KEYWORDS[lane] ?? LANE_KEYWORDS.daily_seo;
  return articles
    .map((article) => ({ article, score: scoreArticle(article, keywords) }))
    .sort((a, b) => b.score - a.score);
}
