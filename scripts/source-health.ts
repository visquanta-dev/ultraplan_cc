/**
 * Source health smoke test.
 *
 * Checks the configured sitemap signal sources without LLM calls, Firecrawl
 * scrapes, or PR creation. Use this before adding sources to production.
 *
 * Usage:
 *   npx tsx scripts/source-health.ts
 */
import '../lib/load-env';

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { isAllowed } from '../lib/sources/allowlist';
import { isCompetitorOutbound } from '../lib/sources/link-policy';
import { loadFeedSources } from '../lib/sources/crawl-index';

type Tier = 1 | 2 | 3 | 4;

interface SourceConfig {
  name: string;
  tier: Tier;
  url: string;
  sitemap_path: string | null;
  freshness: 'daily' | 'weekly' | 'on_demand';
  article_path_hints?: string[];
  exclude_path_hints?: string[];
}

interface CategoriesConfig {
  sources: Record<string, SourceConfig>;
  rules?: {
    freshness?: {
      tier1_window_days?: number;
      tier2_window_days?: number;
      tier4_window_days?: number;
    };
  };
}

interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

const UA = 'Mozilla/5.0 (compatible; UltraPlanSourceHealth/1.0; +https://visquanta.com)';

function parseUrlBlocks(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  const urlBlockRe = /<url[^>]*>([\s\S]*?)<\/url>/g;
  let match: RegExpExecArray | null;
  while ((match = urlBlockRe.exec(xml)) !== null) {
    const loc = /<loc>([^<]+)<\/loc>/.exec(match[1])?.[1]?.trim();
    const lastmod = /<lastmod>([^<]+)<\/lastmod>/.exec(match[1])?.[1]?.trim() ?? null;
    if (loc) entries.push({ loc, lastmod });
  }
  return entries;
}

function parseSitemapIndex(xml: string): string[] {
  const urls: string[] = [];
  const blockRe = /<sitemap[^>]*>([\s\S]*?)<\/sitemap>/g;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(xml)) !== null) {
    const loc = /<loc>([^<]+)<\/loc>/.exec(match[1])?.[1]?.trim();
    if (loc) urls.push(loc);
  }
  return urls;
}

async function fetchSitemap(url: string, depth = 0): Promise<SitemapEntry[]> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const xml = await res.text();
  if (/<sitemapindex\b/i.test(xml) && depth < 2) {
    const parent = new URL(url);
    const children = parseSitemapIndex(xml)
      .map((child) => {
        try {
          const u = new URL(child);
          if (u.hostname !== parent.hostname) {
            u.protocol = parent.protocol;
            u.hostname = parent.hostname;
          }
          return u.toString();
        } catch {
          return child;
        }
      })
      .slice(0, 8);

    const merged: SitemapEntry[] = [];
    for (const child of children) {
      try {
        merged.push(...await fetchSitemap(child, depth + 1));
      } catch {
        // Keep the health check resilient; the row summary will show low yield.
      }
    }
    return merged;
  }
  return parseUrlBlocks(xml);
}

async function discoverSitemapsFromRobots(origin: string): Promise<string[]> {
  try {
    const res = await fetch(`${origin.replace(/\/+$/, '')}/robots.txt`, {
      headers: { 'User-Agent': UA },
    });
    if (!res.ok) return [];
    const txt = await res.text();
    return [...txt.matchAll(/^\s*Sitemap:\s*(\S+)\s*$/gim)].map((m) => m[1]);
  } catch {
    return [];
  }
}

async function resolveSitemapEntries(source: SourceConfig): Promise<SitemapEntry[]> {
  const origin = source.url.replace(/\/+$/, '');
  const attempts: string[] = [];
  if (source.sitemap_path) attempts.push(origin + source.sitemap_path);

  const robots = await discoverSitemapsFromRobots(origin);
  const ranked = robots.sort((a, b) => {
    const score = (u: string) => {
      if (/post[-_]?sitemap/i.test(u)) return 3;
      if (/(article|news|blog)/i.test(u)) return 2;
      if (/sitemap\.xml$/i.test(u)) return 1;
      return 0;
    };
    return score(b) - score(a);
  });
  for (const r of ranked) {
    if (!attempts.includes(r)) attempts.push(r);
  }

  const root = `${origin}/sitemap.xml`;
  if (!attempts.includes(root)) attempts.push(root);

  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      const entries = await fetchSitemap(attempt);
      if (entries.length > 0) return entries;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'no sitemap entries'));
}

const SKIP_URL_PATTERNS = [
  /\/(tag|tags)\//i,
  /\/(category|categories)\//i,
  /\/author\//i,
  /\/page\/\d+/i,
  /\/feed\/?$/i,
  /\/wp-(content|admin|login|includes)\//i,
  /\.(xml|rss)$/i,
  /\/(privacy|terms|cookie|contact|about|careers|team|pricing|demo|book[- ]demo|request[- ]demo|reviews|retail|partners?|resources?|events?|affiliate|requirements)\/?$/i,
  /\/search\/?/i,
  /#/,
];

function looksLikeSignalContent(url: string, source: SourceConfig): boolean {
  if (SKIP_URL_PATTERNS.some((re) => re.test(url))) return false;
  try {
    const parsed = new URL(url);
    const pathLower = parsed.pathname.toLowerCase();
    if (source.article_path_hints?.length) {
      if (!source.article_path_hints.some((hint) => pathLower.includes(hint.toLowerCase()))) return false;
    }
    if (source.exclude_path_hints?.length) {
      if (source.exclude_path_hints.some((hint) => pathLower.includes(hint.toLowerCase()))) return false;
    }
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2) {
      const only = parts[0] ?? '';
      return /-|_/.test(only) && only.length >= 20;
    }
    const last = parts[parts.length - 1];
    if (!/-|_/.test(last) && last.length < 20) return false;
    return true;
  } catch {
    return false;
  }
}

function freshnessWindow(source: SourceConfig, config: CategoriesConfig): number {
  if (source.tier === 1) return config.rules?.freshness?.tier1_window_days ?? 30;
  if (source.tier === 2) return config.rules?.freshness?.tier2_window_days ?? 30;
  if (source.tier === 4) return config.rules?.freshness?.tier4_window_days ?? 14;
  return 90;
}

function formatDate(ms: number): string {
  return ms > 0 ? new Date(ms).toISOString().slice(0, 10) : '-';
}

async function checkSource(id: string, source: SourceConfig, config: CategoriesConfig) {
  const windowDays = freshnessWindow(source, config);
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  try {
    const entries = await resolveSitemapEntries(source);
    const content = entries.filter((entry) => looksLikeSignalContent(entry.loc, source));
    const fresh = content.filter((entry) => {
      if (!entry.lastmod) return source.tier !== 3;
      const ts = Date.parse(entry.lastmod);
      return Number.isNaN(ts) || ts >= cutoff;
    });
    const newest = Math.max(0, ...content.map((entry) => entry.lastmod ? Date.parse(entry.lastmod) : 0).filter((n) => !Number.isNaN(n)));
    const offAllowlist = fresh.filter((entry) => !isAllowed(entry.loc)).length;
    return {
      id,
      tier: `T${source.tier}`,
      policy: isCompetitorOutbound(source.url) ? 'no-link' : 'link-ok',
      total: entries.length,
      content: content.length,
      fresh: fresh.length,
      newest: formatDate(newest),
      offAllowlist,
      status: offAllowlist > 0 ? 'WARN' : fresh.length > 0 ? 'OK' : 'THIN',
      note: '',
    };
  } catch (err) {
    return {
      id,
      tier: `T${source.tier}`,
      policy: isCompetitorOutbound(source.url) ? 'no-link' : 'link-ok',
      total: 0,
      content: 0,
      fresh: 0,
      newest: '-',
      offAllowlist: 0,
      status: 'FAIL',
      note: err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80),
    };
  }
}

async function main() {
  const configPath = path.join(process.cwd(), 'config', 'categories.yaml');
  const config = YAML.parse(fs.readFileSync(configPath, 'utf-8')) as CategoriesConfig;
  const entries = Object.entries(config.sources);

  console.log('=== UltraPlan source health ===');
  console.log(`FIRECRAWL_API_KEY: ${process.env.FIRECRAWL_API_KEY ? 'SET' : 'MISSING'}`);
  console.log(`Signal sources: ${entries.length}`);
  console.log(`Feed sources: ${loadFeedSources().length}`);
  console.log('');

  const rows = [];
  for (const [id, source] of entries) {
    rows.push(await checkSource(id, source, config));
  }

  rows.sort((a, b) => {
    const order = { FAIL: 0, WARN: 1, THIN: 2, OK: 3 } as Record<string, number>;
    return order[a.status] - order[b.status] || a.id.localeCompare(b.id);
  });

  console.table(rows);

  const ok = rows.filter((r) => r.status === 'OK').length;
  const thin = rows.filter((r) => r.status === 'THIN').length;
  const fail = rows.filter((r) => r.status === 'FAIL').length;
  const noLink = rows.filter((r) => r.policy === 'no-link').length;
  console.log(`Summary: ${ok} OK, ${thin} thin, ${fail} failed, ${noLink} no-link competitor/adjacent sources.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
