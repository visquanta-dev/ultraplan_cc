/* eslint-disable no-console */
import '../lib/load-env';
import { collectDiscoverySignals } from '../lib/topics/discovery-signals';

function yesFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const summary = await collectDiscoverySignals({
    bypassCache: yesFlag('fresh'),
    includeReddit: !yesFlag('no-reddit'),
    includeGoogleTrends: !yesFlag('no-trends'),
  });

  console.log('\n=== UltraPlan Discovery Signals ===');
  console.log(`Fetched at: ${summary.fetched_at}`);
  console.log(`Reddit posts: ${summary.reddit_posts}`);
  console.log(`Google Trends terms: ${summary.trends_terms}`);
  console.log(`Category boosts: ${JSON.stringify(summary.category_boosts)}`);
  if (summary.errors.length) console.log(`Errors: ${summary.errors.join(' | ')}`);
  console.table(summary.examples);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
