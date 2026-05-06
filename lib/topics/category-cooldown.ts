// ---------------------------------------------------------------------------
// Category cooldown — content strategy §cooldown
//
// Reads config/categories.yaml + scans merged posts on site main, returns
// which categories are currently blocked (recent post within cooldown_days)
// vs available. Available categories are sorted by editorial_weight desc
// so the resolver picks the highest-priority available category first.
//
// Categorization model (per the 2026-04-18 design):
//   - Explicit: post frontmatter carries `category_id: reputation` (new
//     pipeline posts will set this)
//   - Heuristic fallback: legacy posts without category_id get categorized
//     from tags + slug patterns. Wrong classification on a handful of old
//     posts won't break the system — cooldown becomes slightly noisy, new
//     posts are always explicit going forward.
//
// Intentionally does NOT use the existing content/blog `category:
// {slug, title}` field because that maps to lane (daily-seo / listicle /
// etc.), not to our product-aligned category taxonomy.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import matter from 'gray-matter';

// ---------------------------------------------------------------------------
// Config types — mirror the shape of config/categories.yaml
// ---------------------------------------------------------------------------

export interface CategoryConfig {
  id: string;
  name: string;
  description: string;
  cooldown_days: number;
  editorial_weight: number;
  cta: { url: string; label: string; product: string };
  relevant_sources: string[];
}

interface CategoriesFile {
  sources: Record<string, { name: string; tier: 1 | 2 | 3 | 4; url: string; sitemap_path: string | null; freshness: string; notes?: string }>;
  categories: Record<string, Omit<CategoryConfig, 'id'>>;
  rules: {
    research_density: { min_primary_sources: number; min_quotes_per_source: number };
    mirror_originate_split: { mirror_per_week: number; originate_per_week: number };
    skip_if_thin: boolean;
    freshness: { tier1_window_days: number; tier2_window_days: number; tier4_window_days: number };
  };
}

let cachedConfig: CategoriesFile | null = null;

function loadConfig(): CategoriesFile {
  if (cachedConfig) return cachedConfig;
  const p = path.join(process.cwd(), 'config', 'categories.yaml');
  const raw = fs.readFileSync(p, 'utf-8');
  cachedConfig = yaml.parse(raw) as CategoriesFile;
  return cachedConfig;
}

export function getCategoryConfig(id: string): CategoryConfig | null {
  const cfg = loadConfig();
  const c = cfg.categories[id];
  if (!c) return null;
  return { id, ...c };
}

export function listCategories(): CategoryConfig[] {
  const cfg = loadConfig();
  return Object.entries(cfg.categories).map(([id, c]) => ({ id, ...c }));
}

// ---------------------------------------------------------------------------
// Categorization — explicit frontmatter OR heuristic fallback
// ---------------------------------------------------------------------------

interface ParsedFrontmatter {
  category_id?: string;
  category?: { slug?: string; title?: string };
  tags?: Array<{ slug?: string; title?: string }> | string[];
  slug?: string;
  title?: string;
}

/**
 * Map a post's frontmatter to one of the 7 category IDs. Explicit
 * `category_id` wins; otherwise a heuristic on slug + title only.
 *
 * Falls back to `industry_trends` for posts that don't match any pattern.
 *
 * Deliberately does NOT use the `tags` array — daily_seo/weekly_authority/
 * listicle all inject lane-bucket tags like `service-drive`, `automation`,
 * `dealership-operations` that would swamp every post into service_drive
 * or obscure other signals. Slug + title capture topic intent cleanly
 * because both are derived from the headline.
 *
 * Order runs from under-covered/specific categories first to broad/over-
 * covered last. That's intentional: when a slug contains both "review"
 * and "lead-response-time", reputation wins because it's the narrower
 * editorial frame.
 */
export function categorizePost(fm: ParsedFrontmatter): string {
  // 1. Explicit category_id — the post tells us what it is
  if (typeof fm.category_id === 'string' && fm.category_id.trim().length > 0) {
    return fm.category_id.trim();
  }

  // 2. Heuristic from slug + title only (tags excluded — see jsdoc)
  const slug = (fm.slug ?? '').toLowerCase();
  const title = (fm.title ?? '').toLowerCase();
  const haystack = `${slug} ${title}`;

  // Under-covered/narrow categories first.
  //
  // `\w*` suffix handles stem matches (reactivat → reactivation/reactivating).
  // `[- ]` matches hyphens OR spaces (slug dashes vs title spaces).
  // `\d+` catches variable digits (5-minute / 15-minute / 90-second window).
  if (/\b(reactivat\w*|dormant|old[- ]lead|stale[- ]lead|revive|re.?engage|crm.*reactivat)\b/.test(haystack)) {
    return 'lead_reactivation';
  }
  if (/\b(reputation|review\w*|feedback|star[- ]rating|google[- ]review\w*|online.*review\w*)\b/.test(haystack)) {
    return 'reputation';
  }
  if (/\b(inventory|pricing|turn[- ]time|pre[- ]owned|preowned|used[- ]car|manheim|wholesale|acquisition)\b/.test(haystack)) {
    return 'inventory';
  }
  if (/\b(widget|chatbot|chat[- ]bot|sms[- ]first|web[- ]chat|website[- ]chat|online[- ]form|form[- ]abandon)\b/.test(haystack)) {
    return 'web_capture';
  }

  // Over-covered broad categories after the narrow ones have had a chance
  if (/\b(service[- ]drive|service[- ]advisor|service[- ]retention|service[- ]department|service[- ]custom\w*|service[- ]schedul\w*|service[- ]capacity|service[- ]subscription\w*|service[- ]call\w*|fixed[- ]ops|missed[- ]call\w*|csi|voice[- ]agent)\b/.test(haystack)) {
    return 'service_drive';
  }
  if (/\b(speed[- ]to[- ]lead|\d+[- ]minute|lead[- ]response|web[- ]lead|follow[- ]up[- ]speed|first[- ]contact|lead[- ]loss|speed[- ]of[- ]response|bdc|lead[- ]generation|lead[- ]provider|inbound[- ]lead|lead[- ]handoff|sms.*text)\b/.test(haystack)) {
    return 'speed_to_lead';
  }

  // Default fallback — general industry coverage
  return 'industry_trends';
}

// ---------------------------------------------------------------------------
// Cooldown check against site main content
// ---------------------------------------------------------------------------

function findSiteBlogDir(): string | null {
  const candidates = [
    path.join(process.cwd(), 'site-checkout', 'content', 'blog'),
    path.join(process.cwd(), 'site', 'content', 'blog'),
    path.join(process.cwd(), '..', 'site', 'content', 'blog'),
    path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', 'Desktop', 'site', 'content', 'blog'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

interface MergedPostSummary {
  slug: string;
  publishedAt: string;
  categoryId: string;
}

function loadMergedPosts(): MergedPostSummary[] {
  const dir = findSiteBlogDir();
  if (!dir) return [];
  const posts: MergedPostSummary[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
      const parsed = matter(raw);
      const fm = parsed.data as ParsedFrontmatter;
      const publishedAt = typeof fm['publishedAt' as keyof ParsedFrontmatter] === 'string'
        ? (fm as unknown as { publishedAt: string }).publishedAt
        : '';
      if (!publishedAt) continue;
      posts.push({
        slug: file.replace(/\.md$/, ''),
        publishedAt,
        categoryId: categorizePost(fm),
      });
    } catch {
      // malformed file — skip, don't crash cooldown
    }
  }
  return posts;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CategoryStatus extends CategoryConfig {
  blocked: boolean;
  /** Present when blocked — last merged post of this category */
  last_post?: { slug: string; publishedAt: string; daysAgo: number };
  /** Human-readable reason, suitable for logs + dashboard display */
  blocked_reason?: string;
}

/**
 * Return every category with its current cooldown status. Blocked when
 * the most recent merged post of that category was less than cooldown_days
 * ago. Always returns the full set so callers can see why a category is
 * unavailable, not just what's available.
 */
export function getCategoryStatus(): CategoryStatus[] {
  const categories = listCategories();
  const posts = loadMergedPosts();
  const now = Date.now();

  return categories.map((cat) => {
    const recentInCategory = posts
      .filter((p) => p.categoryId === cat.id)
      .map((p) => ({ ...p, ts: Date.parse(p.publishedAt) }))
      .filter((p) => !Number.isNaN(p.ts))
      .sort((a, b) => b.ts - a.ts);

    const latest = recentInCategory[0];
    if (!latest) {
      return { ...cat, blocked: false };
    }

    const daysAgo = Math.floor((now - latest.ts) / (24 * 60 * 60 * 1000));
    const blocked = daysAgo < cat.cooldown_days;
    return {
      ...cat,
      blocked,
      last_post: { slug: latest.slug, publishedAt: latest.publishedAt, daysAgo },
      ...(blocked
        ? {
            blocked_reason: `last ${cat.name} post was ${latest.slug} (${daysAgo}d ago), cooldown is ${cat.cooldown_days}d`,
          }
        : {}),
    };
  });
}

/**
 * Return only the categories that are currently available (not in cooldown),
 * sorted by editorial_weight descending. Resolver calls this to decide which
 * categories it may draw a topic cluster from.
 */
export function getAvailableCategories(): CategoryStatus[] {
  return getCategoryStatus()
    .filter((c) => !c.blocked)
    .sort((a, b) => b.editorial_weight - a.editorial_weight);
}

/**
 * Test helper: reset the config cache so tests can mock categories.yaml.
 * Production code never needs this.
 */
export function __resetCacheForTests(): void {
  cachedConfig = null;
}
