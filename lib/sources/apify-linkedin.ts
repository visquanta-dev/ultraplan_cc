import { getAllowedLinkedInHashtags } from './allowlist';

// ---------------------------------------------------------------------------
// Apify LinkedIn dealer principals wrapper — spec §3 stage 2
// Exclusively used by the weekly_authority lane's opinion_on_signal strategy
// (spec §4). Scrapes posts from allowlisted hashtags where dealer principals
// are actively reacting to industry events — controversial posts are the
// best raw material for the weekly MoFu piece.
//
// LinkedIn is noisy and frequently rate-limited, so this wrapper is
// pessimistic: every call funnels through Apify's harvestapi~linkedin-post-
// search actor, which handles session + captcha rotation for us.
// Docs: https://apify.com/harvestapi/linkedin-post-search
// ---------------------------------------------------------------------------

const APIFY_API_BASE = 'https://api.apify.com/v2';
const LINKEDIN_POSTS_ACTOR_ID = 'harvestapi~linkedin-post-search';

export interface LinkedInPost {
  author: string;
  authorHeadline: string | null;
  content: string;
  url: string;
  postedAt: string;
  reactions: number;
  comments: number;
  hashtag: string; // which hashtag the post was found under
}

interface ApifyLinkedInItem {
  author?: { name?: string; headline?: string };
  text?: string;
  url?: string;
  postedAt?: string;
  reactionsCount?: number;
  commentsCount?: number;
}

/**
 * Scrape recent LinkedIn posts under a single allowlisted hashtag. Hashtags
 * not in config/sources.yaml's linkedin_dealer_principals.hashtags list are
 * refused.
 */
export async function scrapeHashtag(
  hashtag: string,
  options: { maxPosts?: number; sortBy?: 'relevance' | 'date' } = {},
): Promise<LinkedInPost[]> {
  const allowed = getAllowedLinkedInHashtags();
  if (!allowed.includes(hashtag)) {
    throw new Error(
      `[apify-linkedin] refused: "${hashtag}" is not in config/sources.yaml linkedin_dealer_principals.hashtags.`,
    );
  }

  const apiToken = process.env.APIFY_API_TOKEN;
  if (!apiToken) {
    throw new Error('[apify-linkedin] APIFY_API_TOKEN is not set. Add it to .env.local.');
  }

  const { maxPosts = 30, sortBy = 'date' } = options;

  const runUrl = `${APIFY_API_BASE}/acts/${LINKEDIN_POSTS_ACTOR_ID}/run-sync-get-dataset-items?token=${apiToken}`;

  const response = await fetch(runUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // Strip the leading # if present — the actor expects a plain query
      query: hashtag.replace(/^#/, ''),
      maxItems: maxPosts,
      sortBy,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `[apify-linkedin] run failed: ${response.status} ${response.statusText} — ${text}`,
    );
  }

  const items = (await response.json()) as ApifyLinkedInItem[];

  return items
    .filter((item) => item.text && item.text.trim().length > 0)
    .map((item): LinkedInPost => ({
      author: item.author?.name ?? '',
      authorHeadline: item.author?.headline ?? null,
      content: item.text ?? '',
      url: item.url ?? '',
      postedAt: item.postedAt ?? '',
      reactions: item.reactionsCount ?? 0,
      comments: item.commentsCount ?? 0,
      hashtag,
    }));
}

/**
 * Scrape all allowlisted hashtags in parallel with per-hashtag error isolation.
 */
export async function scrapeAllHashtags(
  options: { maxPostsPerHashtag?: number; sortBy?: 'relevance' | 'date' } = {},
): Promise<Array<{ hashtag: string; posts: LinkedInPost[]; error?: string }>> {
  const hashtags = getAllowedLinkedInHashtags();
  const results = await Promise.all(
    hashtags.map(async (hashtag) => {
      try {
        const posts = await scrapeHashtag(hashtag, {
          maxPosts: options.maxPostsPerHashtag,
          sortBy: options.sortBy,
        });
        return { hashtag, posts };
      } catch (err) {
        return {
          hashtag,
          posts: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  return results;
}
