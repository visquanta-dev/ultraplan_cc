/* eslint-disable no-console */
import '../lib/load-env';
import { getSignalCandidates } from '../lib/topics/competitor-signal';
import { isCompetitorOutbound } from '../lib/sources/link-policy';

function argValue(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function yesFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const limit = Number.parseInt(argValue('limit', '20'), 10);
  const bypassCache = yesFlag('fresh');
  const includeDiscoverySignals = yesFlag('discovery');

  const result = await getSignalCandidates({
    limit: Number.isFinite(limit) && limit > 0 ? limit : 20,
    bypassCache,
    includeDiscoverySignals,
  });

  console.log('\n=== UltraPlan Topic Rank ===');
  console.log(`Fetched at: ${result.fetched_at}`);
  console.log(`Candidates: ${result.total_candidates}`);
  console.log(`Sources: ${result.sources_scraped} scraped, ${result.sources_failed} failed`);
  console.log(`Blocked categories: ${result.blocked_categories.join(', ') || 'none'}`);
  if (result.discovery_boosts) {
    console.log(`Discovery boosts: ${JSON.stringify(result.discovery_boosts)}`);
  }
  if (result.discovery_errors?.length) {
    console.log(`Discovery errors: ${result.discovery_errors.join(' | ')}`);
  }
  console.log();

  const rows = result.clusters.map((cluster, index) => {
    const distinctSources = new Set(cluster.urls.map((u) => u.source_id)).size;
    const linkableUrls = cluster.urls.filter((u) => !isCompetitorOutbound(u.url)).length;
    const noLinkUrls = cluster.urls.length - linkableUrls;
    return {
      rank: index + 1,
      score: Number(cluster.score.toFixed(2)),
      category: cluster.suggested_category,
      linkable_sources: cluster.linkable_source_count,
      no_link_sources: cluster.no_link_source_count,
      urls: cluster.urls.length,
      distinct_sources: distinctSources,
      linkable_urls: linkableUrls,
      no_link_urls: noLinkUrls,
      title: cluster.representative_title.slice(0, 86),
    };
  });

  console.table(rows);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
