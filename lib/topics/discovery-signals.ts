import fs from 'node:fs';
import path from 'node:path';
import { scrapeAllSubreddits } from '../sources/apify-reddit';
import { scrapeGoogleTrends } from '../sources/apify-google-trends';
import { categorizePost } from './category-cooldown';

export interface DiscoverySignalSummary {
  fetched_at: string;
  modes: { reddit: boolean; google_trends: boolean };
  reddit_posts: number;
  trends_terms: number;
  category_boosts: Record<string, number>;
  examples: Array<{ source: 'reddit' | 'google_trends'; category: string; text: string }>;
  errors: string[];
}

const CACHE_PATH = path.join(process.cwd(), 'tmp', 'discovery-signals-cache.json');
const CACHE_TTL_HOURS = 12;

const GOOGLE_TREND_TERMS: Record<string, string[]> = {
  lead_reactivation: [
    'dealership lead reactivation',
    'automotive CRM leads',
    'unsold car leads',
  ],
  speed_to_lead: [
    'dealership speed to lead',
    'car dealer lead response',
    'automotive BDC',
  ],
  service_drive: [
    'dealership service scheduling',
    'fixed ops dealership',
    'service advisor dealership',
  ],
  web_capture: [
    'dealership website chat',
    'automotive digital retail',
    'car dealer website leads',
  ],
  reputation: [
    'dealership reviews',
    'car dealer reputation management',
    'automotive CSI',
  ],
  inventory: [
    'used car inventory',
    'dealership inventory management',
    'used car prices',
  ],
  industry_trends: [
    'automotive industry',
    'car dealership',
    'automotive retail',
  ],
};

function readCache(modes: DiscoverySignalSummary['modes']): DiscoverySignalSummary | null {
  if (!fs.existsSync(CACHE_PATH)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')) as DiscoverySignalSummary;
    if (parsed.modes?.reddit !== modes.reddit || parsed.modes?.google_trends !== modes.google_trends) {
      return null;
    }
    const age = Date.now() - Date.parse(parsed.fetched_at);
    return age <= CACHE_TTL_HOURS * 60 * 60 * 1000 ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(summary: DiscoverySignalSummary): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(summary, null, 2));
  } catch (err) {
    console.warn('[discovery] cache write failed:', err instanceof Error ? err.message : err);
  }
}

function addBoost(boosts: Record<string, number>, category: string, amount: number): void {
  boosts[category] = Number(((boosts[category] ?? 0) + amount).toFixed(3));
}

function hasApifyToken(): boolean {
  return Boolean(process.env.APIFY_API_TOKEN ?? process.env.APIFY_TOKEN);
}

function isDealerOpsPainSignal(text: string): boolean {
  return /\b(dealer(ship)?|sales\s*(manager|person|consultant|professional)|service\s*(advisor|department|drive|lane)|fixed[-\s]?ops|bdc|crm|internet\s*sales|lead\s*(response|handling|management|provider)|web\s*lead|missed\s*call|appointment|follow[-\s]?up|show\s*rate|close\s*rate|review|reputation|csi|phone|text|sms|chat|after[-\s]?hours)\b/i.test(text);
}

export async function collectDiscoverySignals(
  options: {
    bypassCache?: boolean;
    includeReddit?: boolean;
    includeGoogleTrends?: boolean;
  } = {},
): Promise<DiscoverySignalSummary> {
  const modes = {
    reddit: options.includeReddit ?? true,
    google_trends: options.includeGoogleTrends ?? true,
  };

  if (!hasApifyToken()) {
    return {
      fetched_at: new Date().toISOString(),
      modes,
      reddit_posts: 0,
      trends_terms: 0,
      category_boosts: {},
      examples: [],
      errors: ['APIFY_API_TOKEN/APIFY_TOKEN not set'],
    };
  }

  if (!options.bypassCache) {
    const cached = readCache(modes);
    if (cached) return cached;
  }

  const boosts: Record<string, number> = {};
  const examples: DiscoverySignalSummary['examples'] = [];
  const errors: string[] = [];
  let redditPosts = 0;
  let trendsTerms = 0;

  if (modes.reddit) {
    const reddit = await scrapeAllSubreddits({ maxPostsPerSub: 8, hoursBack: 72 });
    for (const result of reddit) {
      if (result.error) errors.push(`${result.subreddit}: ${result.error}`);
      for (const post of result.posts) {
        const text = `${post.title} ${post.body}`;
        if (!isDealerOpsPainSignal(text)) continue;
        const category = categorizePost({ title: text });
        if (category === 'inventory' || category === 'industry_trends') continue;
        const engagement = Math.min(1.5, Math.log10(Math.max(1, post.upvotes + post.commentCount + 1)) / 2);
        addBoost(boosts, category, 0.12 + engagement);
        redditPosts++;
        if (examples.length < 12) {
          examples.push({ source: 'reddit', category, text: post.title.slice(0, 120) });
        }
      }
    }
  }

  if (modes.google_trends) {
    const terms = Object.values(GOOGLE_TREND_TERMS).flat();
    try {
      const trendSignals = await scrapeGoogleTrends(terms, {
        geo: 'US',
        viewedFrom: 'us',
        timeRange: 'today 3-m',
        maxItems: 40,
      });
      trendsTerms = trendSignals.length;
      for (const signal of trendSignals) {
        const text = [signal.term, ...signal.relatedQueries, ...signal.relatedTopics].join(' ');
        const category = categorizePost({ title: text });
        const relatedBonus = Math.min(1.5, (signal.relatedQueries.length + signal.relatedTopics.length) / 20);
        addBoost(boosts, category, 0.4 + relatedBonus);
        if (examples.length < 12) {
          examples.push({ source: 'google_trends', category, text: signal.term });
        }
      }
    } catch (err) {
      errors.push(`google_trends: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const summary: DiscoverySignalSummary = {
    fetched_at: new Date().toISOString(),
    modes,
    reddit_posts: redditPosts,
    trends_terms: trendsTerms,
    category_boosts: boosts,
    examples,
    errors,
  };
  writeCache(summary);
  return summary;
}
