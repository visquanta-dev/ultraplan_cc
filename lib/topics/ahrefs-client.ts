// ---------------------------------------------------------------------------
// Ahrefs v3 API client — shared low-level wrapper
//
// Used by: keyword-scorer, topical-map-generator, content-decay-detector
//
// Rate limit: 60 req/min, 50 units minimum per request
// Plan: Lite (25,000 units/month)
// ---------------------------------------------------------------------------

const AHREFS_BASE = 'https://api.ahrefs.com/v3';

// ---------------------------------------------------------------------------
// Response type interfaces
// ---------------------------------------------------------------------------

export interface AhrefsKeyword {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  traffic_potential: number | null;
  cpc: number | null;
  global_volume: number | null;
}

export interface MatchingTermsResponse {
  keywords: AhrefsKeyword[];
}

export interface RelatedTermsResponse {
  keywords: AhrefsKeyword[];
}

export interface KeywordOverviewResponse {
  keywords: AhrefsKeyword[];
}

export interface OrganicKeyword {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  position: number | null;
  traffic: number | null;
  url: string | null;
}

export interface OrganicKeywordsResponse {
  keywords: OrganicKeyword[];
}

export interface DomainRatingResponse {
  domain_rating: {
    domain: string;
    domain_rating: number | null;
    ahrefs_rank: number | null;
  };
}

export interface UsageResponse {
  unitsUsed: number;
  unitsLimit: number;
}

// ---------------------------------------------------------------------------
// Shared HTTP helper
// ---------------------------------------------------------------------------

async function ahrefsGet<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const token = process.env.AHREFS_API_TOKEN;
  if (!token) {
    throw new Error('[ahrefs-client] AHREFS_API_TOKEN is not set');
  }

  const url = new URL(`${AHREFS_BASE}/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `[ahrefs-client] ${endpoint} failed with status ${response.status}: ${body}`,
    );
  }

  return response.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Public API functions
// ---------------------------------------------------------------------------

export interface MatchingTermsOptions {
  country?: string;
  limit?: number;
  maxKD?: number;
}

/**
 * GET keywords-explorer/matching-terms
 * Returns keywords that match a seed keyword, filtered by KD.
 */
export async function matchingTerms(
  keyword: string,
  options: MatchingTermsOptions = {},
): Promise<MatchingTermsResponse> {
  const { country = 'us', limit = 30, maxKD = 30 } = options;

  return ahrefsGet<MatchingTermsResponse>('keywords-explorer/matching-terms', {
    select: 'keyword,volume,difficulty,traffic_potential,cpc,global_volume',
    country,
    keywords: keyword,
    limit: String(limit),
    where: `difficulty <= ${maxKD}`,
  });
}

export interface RelatedTermsOptions {
  country?: string;
  limit?: number;
  maxKD?: number;
}

/**
 * GET keywords-explorer/related-terms
 * Returns semantically related keywords, filtered by KD.
 */
export async function relatedTerms(
  keyword: string,
  options: RelatedTermsOptions = {},
): Promise<RelatedTermsResponse> {
  const { country = 'us', limit = 20, maxKD = 30 } = options;

  return ahrefsGet<RelatedTermsResponse>('keywords-explorer/related-terms', {
    select: 'keyword,volume,difficulty,traffic_potential,cpc,global_volume',
    country,
    keywords: keyword,
    limit: String(limit),
    where: `difficulty <= ${maxKD}`,
  });
}

export interface KeywordOverviewOptions {
  country?: string;
}

/**
 * GET keywords-explorer/overview
 * Returns metrics for up to 10 keywords (comma-joined).
 */
export async function keywordOverview(
  keywords: string[],
  options: KeywordOverviewOptions = {},
): Promise<KeywordOverviewResponse> {
  const { country = 'us' } = options;
  const keywordsParam = keywords.slice(0, 10).join(',');

  return ahrefsGet<KeywordOverviewResponse>('keywords-explorer/overview', {
    select: 'keyword,volume,difficulty,traffic_potential,cpc,global_volume',
    country,
    keywords: keywordsParam,
  });
}

export interface OrganicKeywordsOptions {
  country?: string;
  limit?: number;
}

/**
 * GET site-explorer/organic-keywords
 * Returns organic ranking keywords for a domain.
 */
export async function organicKeywords(
  domain: string,
  options: OrganicKeywordsOptions = {},
): Promise<OrganicKeywordsResponse> {
  const { country = 'us', limit = 50 } = options;

  return ahrefsGet<OrganicKeywordsResponse>('site-explorer/organic-keywords', {
    select: 'keyword,volume,difficulty,position,traffic,url',
    country,
    target: domain,
    mode: 'domain',
    limit: String(limit),
  });
}

/**
 * GET site-explorer/domain-rating
 * Returns the Domain Rating and Ahrefs Rank for a domain.
 */
export async function domainRating(domain: string): Promise<DomainRatingResponse> {
  return ahrefsGet<DomainRatingResponse>('site-explorer/domain-rating', {
    target: domain,
    mode: 'domain',
  });
}

/**
 * GET subscription-info/limits-and-usage
 * Returns units used and units limit for the current billing period.
 */
export async function checkUsage(): Promise<UsageResponse> {
  const raw = await ahrefsGet<Record<string, unknown>>(
    'subscription-info/limits-and-usage',
    {},
  );

  // Ahrefs returns something like { subscription: { usage: { api_units: { current, limit } } } }
  // Normalise into a flat shape regardless of exact nesting.
  const nested = raw as {
    subscription?: {
      usage?: {
        api_units?: { current?: number; limit?: number };
      };
    };
    usage?: { api_units?: { current?: number; limit?: number } };
    api_units_used?: number;
    api_units_limit?: number;
  };

  const units =
    nested.subscription?.usage?.api_units ??
    nested.usage?.api_units ??
    {};

  const unitsUsed =
    (units as { current?: number }).current ??
    nested.api_units_used ??
    0;

  const unitsLimit =
    (units as { limit?: number }).limit ??
    nested.api_units_limit ??
    25000;

  return { unitsUsed, unitsLimit };
}
