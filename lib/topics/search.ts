import { getAllowlistedDomains } from '../sources/allowlist';

// ---------------------------------------------------------------------------
// Topic search — Firecrawl /v2/search
// Discovers recent articles on allowlisted domains about dealership topics.
// Returns raw search results for the clustering step.
// ---------------------------------------------------------------------------

const FIRECRAWL_API_BASE = 'https://api.firecrawl.dev/v2';

export interface SearchResult {
  url: string;
  title: string;
  description: string;
  publishedAt: string | null;
}

interface FirecrawlSearchItem {
  url?: string;
  title?: string;
  description?: string;
  position?: number;
  metadata?: {
    publishedTime?: string;
    title?: string;
    description?: string;
  };
}

interface FirecrawlSearchResponse {
  success: boolean;
  data?: FirecrawlSearchItem[] | { web?: FirecrawlSearchItem[] };
  error?: string;
}

/**
 * Search for recent articles across allowlisted domains using Firecrawl.
 * Builds site: queries to restrict results to trusted sources only.
 */
export async function searchRecentArticles(
  query: string,
  options: { limit?: number } = {},
): Promise<SearchResult[]> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error('[search] FIRECRAWL_API_KEY not set');

  const { limit = 20 } = options;
  const domains = [...getAllowlistedDomains()];

  // Firecrawl search supports site: operators. We batch domains into
  // chunks of 5 to avoid overly long queries and do parallel searches.
  const chunks: string[][] = [];
  for (let i = 0; i < domains.length; i += 5) {
    chunks.push(domains.slice(i, i + 5));
  }

  const allResults: SearchResult[] = [];

  for (const chunk of chunks) {
    const siteFilter = chunk.map((d) => `site:${d}`).join(' OR ');
    const fullQuery = `(${siteFilter}) ${query}`;

    const response = await fetch(`${FIRECRAWL_API_BASE}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: fullQuery,
        limit: Math.ceil(limit / chunks.length),
        scrapeOptions: { formats: [] }, // metadata only, no full scrape
      }),
    });

    if (!response.ok) {
      console.warn(`[search] Firecrawl search returned ${response.status} for chunk — skipping`);
      continue;
    }

    const body = (await response.json()) as FirecrawlSearchResponse;
    if (!body.success || !body.data) continue;

    // Firecrawl v2 returns data as { web: [...] } or as a flat array
    const items: FirecrawlSearchItem[] = Array.isArray(body.data)
      ? body.data
      : (body.data.web ?? []);

    for (const item of items) {
      if (!item.url) continue;
      allResults.push({
        url: item.url,
        title: item.title ?? item.metadata?.title ?? '',
        description: item.description ?? item.metadata?.description ?? '',
        publishedAt: item.metadata?.publishedTime ?? null,
      });
    }
  }

  return allResults.slice(0, limit);
}

/** Lane-specific search queries. */
const LANE_QUERIES: Record<string, string[]> = {
  daily_seo: [
    'dealership AI technology 2026',
    'auto dealer digital retailing',
    'car dealership service technology',
  ],
  weekly_authority: [
    'dealer principal leadership automotive retail',
    'car dealer management strategy',
    'automotive retail industry trends',
  ],
  monthly_anonymized_case: [
    'dealership case study results',
    'auto dealer technology implementation',
    'car dealer service improvement metrics',
  ],
};

/**
 * Run searches appropriate for a specific editorial lane.
 * Returns deduplicated results across all lane-specific queries.
 */
export async function searchForLane(
  lane: string,
  options: { limit?: number } = {},
): Promise<SearchResult[]> {
  const queries = LANE_QUERIES[lane] ?? LANE_QUERIES.daily_seo;
  const { limit = 20 } = options;

  const resultsByUrl = new Map<string, SearchResult>();

  for (const query of queries) {
    const results = await searchRecentArticles(query, {
      limit: Math.ceil(limit / queries.length),
    });
    for (const r of results) {
      if (!resultsByUrl.has(r.url)) resultsByUrl.set(r.url, r);
    }
  }

  return [...resultsByUrl.values()].slice(0, limit);
}
