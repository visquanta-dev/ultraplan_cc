import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

// ---------------------------------------------------------------------------
// Allowlist loader — spec §2 principle 2
// Reads config/sources.yaml and exposes a single isAllowed(url) helper that
// every scraper wrapper calls before hitting the network.
// ---------------------------------------------------------------------------

interface SourcesConfig {
  trade_press: { domains: string[] };
  regulatory: { domains: string[] };
  reddit: { subreddits: string[] };
  linkedin_dealer_principals: { profiles: string[]; hashtags: string[] };
  enforcement: {
    strict_mode: boolean;
    respect_robots_txt: boolean;
    rate_limit_per_host_rpm: number;
  };
}

let cachedConfig: SourcesConfig | null = null;

function loadConfig(): SourcesConfig {
  if (cachedConfig) return cachedConfig;
  const configPath = path.join(process.cwd(), 'config', 'sources.yaml');
  const raw = fs.readFileSync(configPath, 'utf-8');
  cachedConfig = YAML.parse(raw) as SourcesConfig;
  return cachedConfig;
}

/**
 * Returns the full set of allowlisted domains across all source categories.
 */
export function getAllowlistedDomains(): Set<string> {
  const config = loadConfig();
  return new Set<string>([
    ...config.trade_press.domains,
    ...config.regulatory.domains,
  ]);
}

/**
 * Returns the list of subreddits that are allowed as signal sources.
 */
export function getAllowedSubreddits(): string[] {
  return loadConfig().reddit.subreddits;
}

/**
 * Returns the LinkedIn hashtags allowed for dealer principal scraping.
 */
export function getAllowedLinkedInHashtags(): string[] {
  return loadConfig().linkedin_dealer_principals.hashtags;
}

/**
 * Checks whether a URL's hostname is in the allowlist.
 * Returns `true` if allowed, `false` otherwise. Never throws.
 * Strict mode is always on per spec §2 principle 2.
 */
export function isAllowed(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    const domains = getAllowlistedDomains();
    // Accept exact match and subdomain match (e.g. "www.automotivenews.com"
    // matches allowlist entry "automotivenews.com")
    for (const allowed of domains) {
      if (hostname === allowed || hostname.endsWith(`.${allowed}`)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Refuses a URL if it's off-list. Throws a clear error with the offending
 * hostname so callers fail fast at scrape time.
 */
export function assertAllowed(url: string): void {
  if (!isAllowed(url)) {
    const { hostname } = new URL(url);
    throw new Error(
      `[allowlist] refused: ${hostname} is not in config/sources.yaml. ` +
        `Add it to trade_press.domains or regulatory.domains to allow scraping.`,
    );
  }
}
