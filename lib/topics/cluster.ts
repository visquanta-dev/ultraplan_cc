import type { SearchResult } from './search';

// ---------------------------------------------------------------------------
// Topic clustering — spec §3 stage 3
// Groups search results by keyword overlap to find trending clusters.
// Pure code, no LLM. Picks the cluster with the most sources covering it
// within the search window.
// ---------------------------------------------------------------------------

export interface TopicCluster {
  /** Human-readable label derived from the most common keywords */
  label: string;
  /** URL-safe slug for this cluster */
  slug: string;
  /** Articles in this cluster */
  articles: SearchResult[];
  /** Signal strength: how many distinct sources cover this topic */
  sourceCount: number;
  /** Representative keywords found across articles */
  keywords: string[];
}

// Stop words to exclude from keyword extraction
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'this', 'that', 'these', 'those',
  'it', 'its', 'not', 'no', 'so', 'as', 'if', 'how', 'what', 'when',
  'where', 'who', 'which', 'than', 'then', 'more', 'most', 'very',
  'just', 'also', 'about', 'up', 'out', 'all', 'into', 'over', 'new',
  'says', 'said', 'one', 'two', 'three', 'first', 'last', 'after',
  'before', 'now', 'some', 'any', 'each', 'every', 'other', 'our',
  'their', 'your', 'his', 'her', 'my', 'we', 'they', 'you', 'he',
  'she', 'get', 'make', 'like', 'use', 'way', 'many', 'much', 'well',
  'back', 'only', 'come', 'take', 'even', 'good', 'give', 'most',
  'through', 'between', 'still', 'here', 'there', 'while', 'why',
]);

/**
 * Extract meaningful keywords from title + description text.
 * Returns lowercase tokens with stop words removed.
 */
function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

/**
 * Extract hostname without www prefix for domain deduplication.
 */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Convert a keyword label into a URL-safe slug.
 */
function toSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

const SLUG_STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'for', 'to', 'and', 'or', 'but',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'this', 'that',
  'these', 'those', 'with', 'from', 'as', 'by', 'your', 'you', 'our', 'we',
  'its', 'it', 'their', 'they', 'how', 'why', 'what', 'when', 'which',
]);

/**
 * Build a URL-safe slug from a blog post headline. Unlike toSlug (which is
 * used for cluster keyword labels), this strips common English stopwords so
 * the resulting URL is keyword-dense and SEO-friendly, and clamps to 60 chars.
 *
 * Example: "74% of Dealers Are Buying Voice Agents in 2026"
 *       →  "74-dealers-buying-voice-agents-2026"
 */
export function slugifyHeadline(headline: string): string {
  const tokens = headline
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !SLUG_STOPWORDS.has(t));

  // Assemble, then clamp to 60 chars without cutting a word in half.
  let slug = '';
  for (const token of tokens) {
    const next = slug ? `${slug}-${token}` : token;
    if (next.length > 60) break;
    slug = next;
  }
  return slug || toSlug(headline); // fallback if stopword filter emptied everything
}

/**
 * Cluster search results by keyword overlap. Returns clusters sorted by
 * signal strength (most sources first).
 *
 * Algorithm:
 * 1. Extract keywords from every article's title + description
 * 2. Count keyword frequency across all articles
 * 3. Pick the top keywords as cluster seeds
 * 4. Assign each article to the cluster whose seed keyword appears most
 *    in its text
 * 5. Merge small clusters (<2 articles) into the nearest larger one
 */
export function clusterArticles(
  articles: SearchResult[],
  options: { maxClusters?: number } = {},
): TopicCluster[] {
  const { maxClusters = 5 } = options;

  if (articles.length === 0) return [];
  if (articles.length <= 2) {
    // Not enough to cluster — return one cluster with all articles
    const allKeywords = articles.flatMap((a) =>
      extractKeywords(`${a.title} ${a.description}`),
    );
    const label = topN(allKeywords, 3).join(' ');
    return [{
      label,
      slug: toSlug(label),
      articles,
      sourceCount: new Set(articles.map((a) => extractDomain(a.url))).size,
      keywords: topN(allKeywords, 5),
    }];
  }

  // Step 1: Build keyword → article index
  const articleKeywords = articles.map((a) => ({
    article: a,
    keywords: extractKeywords(`${a.title} ${a.description}`),
  }));

  // Step 2: Global keyword frequency
  const globalFreq = new Map<string, number>();
  for (const { keywords } of articleKeywords) {
    const unique = new Set(keywords);
    for (const kw of unique) {
      globalFreq.set(kw, (globalFreq.get(kw) ?? 0) + 1);
    }
  }

  // Filter to keywords appearing in 2+ articles (trending signal)
  const trendingKeywords = [...globalFreq.entries()]
    .filter(([, count]) => count >= 2)
    .sort(([, a], [, b]) => b - a)
    .map(([kw]) => kw)
    .slice(0, maxClusters * 2);

  if (trendingKeywords.length === 0) {
    // No overlap — return one big cluster
    const allKw = articleKeywords.flatMap((ak) => ak.keywords);
    const label = topN(allKw, 3).join(' ');
    return [{
      label,
      slug: toSlug(label),
      articles,
      sourceCount: new Set(articles.map((a) => extractDomain(a.url))).size,
      keywords: topN(allKw, 5),
    }];
  }

  // Step 3: Pick seed keywords (spaced apart to avoid synonyms)
  const seeds = pickSeeds(trendingKeywords, maxClusters);

  // Step 4: Assign articles to nearest seed
  const clusters = new Map<string, SearchResult[]>();
  for (const seed of seeds) clusters.set(seed, []);

  for (const { article, keywords } of articleKeywords) {
    let bestSeed = seeds[0];
    let bestCount = 0;
    for (const seed of seeds) {
      const count = keywords.filter((k) => k === seed).length;
      if (count > bestCount) {
        bestCount = count;
        bestSeed = seed;
      }
    }
    clusters.get(bestSeed)!.push(article);
  }

  // Step 5: Build TopicCluster objects, merge empties
  const result: TopicCluster[] = [];
  for (const [seed, clusterArticles] of clusters) {
    if (clusterArticles.length === 0) continue;

    const allKw = clusterArticles.flatMap((a) =>
      extractKeywords(`${a.title} ${a.description}`),
    );
    const kws = topN(allKw, 5);
    const label = kws.slice(0, 3).join(' ');
    const domains = new Set(clusterArticles.map((a) => extractDomain(a.url)));

    result.push({
      label,
      slug: toSlug(label),
      articles: clusterArticles,
      sourceCount: domains.size,
      keywords: kws,
    });
  }

  // Sort by source count descending (most diverse coverage = strongest signal)
  result.sort((a, b) => b.sourceCount - a.sourceCount || b.articles.length - a.articles.length);

  return result.slice(0, maxClusters);
}

/** Pick up to N seed keywords that aren't substrings of each other. */
function pickSeeds(sorted: string[], max: number): string[] {
  const seeds: string[] = [];
  for (const kw of sorted) {
    if (seeds.length >= max) break;
    if (seeds.some((s) => s.includes(kw) || kw.includes(s))) continue;
    seeds.push(kw);
  }
  return seeds.length > 0 ? seeds : [sorted[0]];
}

/** Return the top-N most frequent strings. */
function topN(words: string[], n: number): string[] {
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  return [...freq.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, n)
    .map(([w]) => w);
}
