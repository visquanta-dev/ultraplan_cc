import { assertAllowed } from './allowlist';

// ---------------------------------------------------------------------------
// Firecrawl wrapper — spec §3 stage 2
// Thin wrapper around the Firecrawl v2 HTTP API. Enforces the allowlist
// BEFORE any network call so off-list URLs never touch the wire.
//
// We deliberately use fetch() instead of the @mendable/firecrawl-js SDK to
// keep the dependency tree small and avoid SDK version drift.
// Docs: https://docs.firecrawl.dev/api-reference/endpoint/scrape
// ---------------------------------------------------------------------------

const FIRECRAWL_API_BASE = 'https://api.firecrawl.dev/v2';

export interface ScrapedArticle {
  title: string;
  publishedAt: string | null;
  rawText: string;
  canonicalUrl: string;
  author: string | null;
  html: string;
}

interface FirecrawlScrapeResponse {
  success: boolean;
  data?: {
    markdown?: string;
    html?: string;
    metadata?: {
      title?: string;
      description?: string;
      author?: string;
      publishedTime?: string;
      ogTitle?: string;
      sourceURL?: string;
      url?: string;
    };
  };
  error?: string;
}

/**
 * Scrape a single article URL via Firecrawl. Rejects off-list URLs before
 * any network request. Returns a normalized ScrapedArticle.
 *
 * @throws if the URL is off-list, Firecrawl returns an error, or the API
 *   key is missing from the environment.
 */
export async function scrape(url: string): Promise<ScrapedArticle> {
  assertAllowed(url);

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    throw new Error(
      '[firecrawl] FIRECRAWL_API_KEY is not set. Add it to .env.local.',
    );
  }

  const response = await fetch(`${FIRECRAWL_API_BASE}/scrape`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ['markdown', 'html'],
      onlyMainContent: true,
      waitFor: 500,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `[firecrawl] scrape failed: ${response.status} ${response.statusText} — ${text}`,
    );
  }

  const body = (await response.json()) as FirecrawlScrapeResponse;
  if (!body.success || !body.data) {
    throw new Error(`[firecrawl] scrape returned unsuccessful: ${body.error ?? 'unknown'}`);
  }

  const { data } = body;
  const meta = data.metadata ?? {};

  return {
    title: meta.title ?? meta.ogTitle ?? '',
    publishedAt: meta.publishedTime ?? null,
    rawText: data.markdown ?? '',
    canonicalUrl: meta.sourceURL ?? meta.url ?? url,
    author: meta.author ?? null,
    html: data.html ?? '',
  };
}

/**
 * Scrape multiple URLs in parallel with bounded concurrency. Off-list URLs
 * are filtered out before any network call.
 */
export async function scrapeMany(
  urls: string[],
  concurrency = 3,
): Promise<Array<{ url: string; article?: ScrapedArticle; error?: string }>> {
  const results: Array<{ url: string; article?: ScrapedArticle; error?: string }> = [];
  const queue = [...urls];

  async function worker() {
    while (queue.length > 0) {
      const url = queue.shift();
      if (!url) return;
      try {
        const article = await scrape(url);
        results.push({ url, article });
      } catch (err) {
        results.push({
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, worker);
  await Promise.all(workers);
  return results;
}
