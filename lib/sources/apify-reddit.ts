import { getAllowedSubreddits } from './allowlist';

// ---------------------------------------------------------------------------
// Apify Reddit scraper wrapper — spec §3 stage 2
// Signal-only source. Reddit posts/comments are used to detect which topics
// are heating up in dealer communities over the last 48 hours. Quotes from
// Reddit NEVER appear verbatim in published drafts — this data feeds the
// clustering step, not the bundle assembler.
//
// Uses Apify's reddit-scraper actor via the run-sync-get-dataset-items
// endpoint for simplicity. Docs:
// https://docs.apify.com/api/v2#/reference/actors/run-actor-synchronously-with-input-and-get-dataset-items
// ---------------------------------------------------------------------------

const APIFY_API_BASE = 'https://api.apify.com/v2';
const REDDIT_ACTOR_ID = 'trudax~reddit-scraper-lite';

export interface RedditPost {
  subreddit: string;
  title: string;
  body: string;
  url: string;
  author: string | null;
  createdAt: string;
  upvotes: number;
  commentCount: number;
}

interface ApifyRedditItem {
  communityName?: string;
  title?: string;
  body?: string;
  url?: string;
  username?: string;
  createdAt?: string;
  upVotes?: number;
  numberOfComments?: number;
  dataType?: string;
}

/**
 * Scrape the last 48 hours of posts from one allowlisted subreddit.
 * Subreddits not in config/sources.yaml's reddit.subreddits list are refused.
 *
 * @throws if the subreddit is not allowlisted or the Apify API call fails.
 */
export async function scrapeSubreddit(
  subreddit: string,
  options: { maxPosts?: number; hoursBack?: number } = {},
): Promise<RedditPost[]> {
  const allowed = getAllowedSubreddits();
  if (!allowed.includes(subreddit)) {
    throw new Error(
      `[apify-reddit] refused: "${subreddit}" is not in config/sources.yaml reddit.subreddits.`,
    );
  }

  const apiToken = process.env.APIFY_API_TOKEN ?? process.env.APIFY_TOKEN;
  if (!apiToken) {
    throw new Error('[apify-reddit] APIFY_API_TOKEN/APIFY_TOKEN is not set. Add it to .env.local.');
  }

  const { maxPosts = 50, hoursBack = 48 } = options;

  const runUrl = `${APIFY_API_BASE}/acts/${REDDIT_ACTOR_ID}/run-sync-get-dataset-items?token=${apiToken}`;

  const response = await fetch(runUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startUrls: [{ url: `https://www.reddit.com/r/${subreddit}/new/` }],
      maxItems: maxPosts,
      maxPostCount: maxPosts,
      maxComments: 0, // signal step only needs posts, not comment threads
      scrollTimeout: 40,
      skipComments: true,
      skipUserPosts: true,
      skipCommunity: false,
      searchPosts: true,
      searchComments: false,
      searchCommunities: false,
      searchUsers: false,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `[apify-reddit] run failed: ${response.status} ${response.statusText} — ${text}`,
    );
  }

  const items = (await response.json()) as ApifyRedditItem[];

  const cutoffMs = Date.now() - hoursBack * 60 * 60 * 1000;

  return items
    .filter((item) => item.dataType !== 'comment' && item.title)
    .map((item): RedditPost => ({
      subreddit,
      title: item.title ?? '',
      body: item.body ?? '',
      url: item.url ?? '',
      author: item.username ?? null,
      createdAt: item.createdAt ?? '',
      upvotes: item.upVotes ?? 0,
      commentCount: item.numberOfComments ?? 0,
    }))
    .filter((post) => {
      if (!post.createdAt) return true;
      const t = new Date(post.createdAt).getTime();
      return Number.isFinite(t) ? t >= cutoffMs : true;
    });
}

/**
 * Scrape all allowlisted subreddits in parallel. Per-subreddit errors are
 * isolated so one broken sub doesn't fail the whole signal step.
 */
export async function scrapeAllSubreddits(
  options: { maxPostsPerSub?: number; hoursBack?: number } = {},
): Promise<Array<{ subreddit: string; posts: RedditPost[]; error?: string }>> {
  const subs = getAllowedSubreddits();
  const results = await Promise.all(
    subs.map(async (subreddit) => {
      try {
        const posts = await scrapeSubreddit(subreddit, {
          maxPosts: options.maxPostsPerSub,
          hoursBack: options.hoursBack,
        });
        return { subreddit, posts };
      } catch (err) {
        return {
          subreddit,
          posts: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  return results;
}
