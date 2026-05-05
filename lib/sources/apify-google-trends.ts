// ---------------------------------------------------------------------------
// Apify Google Trends wrapper
//
// Signal-only source. Google Trends data is used to boost topic demand and
// related-query coverage. It is not used as a publishable source citation.
// ---------------------------------------------------------------------------

const APIFY_API_BASE = 'https://api.apify.com/v2';
const GOOGLE_TRENDS_ACTOR_ID = 'apify~google-trends-scraper';

export interface GoogleTrendSignal {
  term: string;
  relatedQueries: string[];
  relatedTopics: string[];
  rawItemCount: number;
}

type UnknownRecord = Record<string, unknown>;

function apiToken(): string {
  const token = process.env.APIFY_API_TOKEN ?? process.env.APIFY_TOKEN;
  if (!token) {
    throw new Error('[apify-trends] APIFY_API_TOKEN/APIFY_TOKEN is not set. Add it to .env.local.');
  }
  return token;
}

function textValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.trim()) out.push(value.trim());
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) textValues(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as UnknownRecord)) {
      if (/query|keyword|title|topic|name/i.test(key)) textValues(nested, out);
    }
  }
  return out;
}

function inferTerm(item: UnknownRecord, fallbackTerms: string[]): string {
  const direct = [
    item.searchTerm,
    item.searchTerms,
    item.term,
    item.query,
    item.keyword,
  ].find((value) => typeof value === 'string' && value.trim().length > 0);
  if (typeof direct === 'string') return direct.trim();

  const url = typeof item.url === 'string' ? item.url : typeof item.searchUrl === 'string' ? item.searchUrl : '';
  if (url) {
    try {
      const q = new URL(url).searchParams.get('q');
      if (q) return q.split(',')[0].trim();
    } catch {
      // ignore malformed actor output
    }
  }

  return fallbackTerms[0] ?? 'unknown';
}

export async function scrapeGoogleTrends(
  searchTerms: string[],
  options: {
    geo?: string;
    viewedFrom?: string;
    timeRange?: 'now 7-d' | 'today 1-m' | 'today 3-m' | 'today 5-y' | 'all';
    maxItems?: number;
  } = {},
): Promise<GoogleTrendSignal[]> {
  const terms = searchTerms.map((term) => term.trim()).filter(Boolean).slice(0, 10);
  if (terms.length === 0) return [];

  const runUrl = `${APIFY_API_BASE}/acts/${GOOGLE_TRENDS_ACTOR_ID}/run-sync-get-dataset-items?token=${apiToken()}`;
  const response = await fetch(runUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      searchTerms: terms,
      isMultiple: false,
      timeRange: options.timeRange ?? 'today 3-m',
      geo: options.geo ?? 'US',
      viewedFrom: options.viewedFrom ?? 'us',
      maxItems: options.maxItems ?? 25,
      maxConcurrency: 1,
      maxRequestRetries: 2,
      pageLoadTimeoutSecs: 60,
      skipDebugScreen: true,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `[apify-trends] run failed: ${response.status} ${response.statusText} - ${text}`,
    );
  }

  const items = (await response.json()) as UnknownRecord[];
  const byTerm = new Map<string, { relatedQueries: Set<string>; relatedTopics: Set<string>; rawItemCount: number }>();

  for (const item of items) {
    const term = inferTerm(item, terms);
    const bucket = byTerm.get(term) ?? {
      relatedQueries: new Set<string>(),
      relatedTopics: new Set<string>(),
      rawItemCount: 0,
    };
    bucket.rawItemCount++;

    const queries = [
      ...textValues(item.relatedQueries),
      ...textValues(item.relatedSearches),
      ...textValues(item.risingQueries),
      ...textValues(item.topQueries),
    ];
    const topics = [
      ...textValues(item.relatedTopics),
      ...textValues(item.risingTopics),
      ...textValues(item.topTopics),
    ];

    for (const query of queries) bucket.relatedQueries.add(query);
    for (const topic of topics) bucket.relatedTopics.add(topic);
    byTerm.set(term, bucket);
  }

  return [...byTerm.entries()].map(([term, bucket]) => ({
    term,
    relatedQueries: [...bucket.relatedQueries].slice(0, 20),
    relatedTopics: [...bucket.relatedTopics].slice(0, 20),
    rawItemCount: bucket.rawItemCount,
  }));
}
