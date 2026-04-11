// ---------------------------------------------------------------------------
// Keyword scorer — Ahrefs integration for topic selection
// Checks cluster keywords against Ahrefs for volume, difficulty, and
// traffic potential. Returns a score that the resolver uses to rank clusters.
//
// Score formula: traffic_potential / (difficulty + 10)
// Higher = more attractive topic (high traffic, low competition)
// ---------------------------------------------------------------------------

const AHREFS_MCP_BASE = 'https://mcp.ahrefs.com'; // placeholder — called via MCP in production

export interface KeywordMetrics {
  keyword: string;
  volume: number;
  difficulty: number;
  trafficPotential: number;
  intents: {
    informational: boolean;
    commercial: boolean;
    transactional: boolean;
  };
}

export interface ClusterScore {
  clusterLabel: string;
  keywords: KeywordMetrics[];
  bestKeyword: KeywordMetrics | null;
  /** Score: higher = better opportunity. traffic_potential / (difficulty + 10) */
  score: number;
  /** Whether any keyword has commercial or transactional intent */
  hasCommercialIntent: boolean;
}

/**
 * Score a list of keywords using Ahrefs data.
 * Called via the pipeline's Node.js runtime — makes HTTP calls to the
 * Ahrefs API v3 directly (not via MCP, since MCP is session-based).
 *
 * Falls back gracefully: if Ahrefs is unavailable, returns neutral scores
 * so the pipeline can still run based on source diversity alone.
 */
export async function scoreKeywords(
  keywords: string[],
  options: { country?: string } = {},
): Promise<KeywordMetrics[]> {
  const { country = 'US' } = options;

  // Ahrefs API v3 endpoint
  const apiToken = process.env.AHREFS_API_TOKEN;
  if (!apiToken) {
    console.warn('[keyword-scorer] AHREFS_API_TOKEN not set — skipping keyword scoring');
    return keywords.map((kw) => ({
      keyword: kw,
      volume: 0,
      difficulty: 50,
      trafficPotential: 0,
      intents: { informational: true, commercial: false, transactional: false },
    }));
  }

  try {
    const keywordsParam = keywords.slice(0, 10).join(',');
    const selectFields = 'keyword,volume,difficulty,traffic_potential,intents';

    const url = new URL('https://api.ahrefs.com/v3/keywords-explorer/overview');
    url.searchParams.set('select', selectFields);
    url.searchParams.set('country', country);
    url.searchParams.set('keywords', keywordsParam);
    url.searchParams.set('limit', '10');

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      console.warn(`[keyword-scorer] Ahrefs returned ${response.status} — falling back to neutral scores`);
      return neutralScores(keywords);
    }

    const body = await response.json() as {
      keywords?: Array<{
        keyword: string;
        volume: number | null;
        difficulty: number | null;
        traffic_potential: number | null;
        intents: Record<string, boolean> | null;
      }>;
    };

    if (!body.keywords || body.keywords.length === 0) {
      return neutralScores(keywords);
    }

    return body.keywords.map((kw) => ({
      keyword: kw.keyword,
      volume: kw.volume ?? 0,
      difficulty: kw.difficulty ?? 50,
      trafficPotential: kw.traffic_potential ?? 0,
      intents: {
        informational: kw.intents?.informational ?? true,
        commercial: kw.intents?.commercial ?? false,
        transactional: kw.intents?.transactional ?? false,
      },
    }));
  } catch (err) {
    console.warn('[keyword-scorer] Ahrefs call failed:', (err as Error).message);
    return neutralScores(keywords);
  }
}

/**
 * Score a topic cluster by checking its keywords against Ahrefs.
 */
export async function scoreCluster(
  clusterLabel: string,
  clusterKeywords: string[],
): Promise<ClusterScore> {
  const metrics = await scoreKeywords(clusterKeywords);

  // Find the best keyword by score: traffic_potential / (difficulty + 10)
  let bestKeyword: KeywordMetrics | null = null;
  let bestScore = 0;

  for (const kw of metrics) {
    const kwScore = kw.trafficPotential / (kw.difficulty + 10);
    if (kwScore > bestScore) {
      bestScore = kwScore;
      bestKeyword = kw;
    }
  }

  // Overall cluster score is the best keyword's score
  const score = bestScore;
  const hasCommercialIntent = metrics.some(
    (kw) => kw.intents.commercial || kw.intents.transactional,
  );

  return {
    clusterLabel,
    keywords: metrics,
    bestKeyword,
    score,
    hasCommercialIntent,
  };
}

function neutralScores(keywords: string[]): KeywordMetrics[] {
  return keywords.map((kw) => ({
    keyword: kw,
    volume: 0,
    difficulty: 50,
    trafficPotential: 0,
    intents: { informational: true, commercial: false, transactional: false },
  }));
}
