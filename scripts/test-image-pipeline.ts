import 'dotenv/config';
import { config } from 'dotenv';
config({ path: '.env.local', override: true });

import { runImagePipeline } from '../lib/image/pipeline';

async function main() {
  console.log('[test] Running full image pipeline (Flux 2 Pro)...\n');

  const result = await runImagePipeline(
    'test-image-pipeline',
    'daily_seo',
    'What Happens to Your Leads Between 6 PM and 8 AM',
    ['The After-Hours Gap', 'Where the Budget Goes', 'Automated Coverage', 'Measuring Results', 'Stop Treating It Like an Experiment'],
    {
      onImageStart: (type, idx) => console.log(`  generating ${type} ${idx}...`),
      onImageResult: (type, idx, passed, attempt) =>
        console.log(`  ${type} ${idx}: ${passed ? 'PASS' : 'FAIL'} (attempt ${attempt})`),
    },
  );

  console.log('\n=== Image Pipeline Results ===');
  console.log(`  images generated: ${result.paths.length}`);
  console.log(`  all passed: ${result.allPassed}`);
  console.log(`  blocked: ${result.blockedImages.join(', ') || 'none'}`);

  for (const gr of result.gateResults) {
    console.log(`\n  ${gr.type} ${gr.index} (${gr.attempts} attempts):`);
    console.log(`    sanity:  ${gr.result.sanityCheck.passed ? 'PASS' : 'FAIL'}`);
    console.log(`    banned:  ${gr.result.bannedContent.passed ? 'PASS' : 'FAIL'} ${gr.result.bannedContent.violations.join('; ') || ''}`);
    console.log(`    brand:   ${gr.result.brandFit.passed ? 'PASS' : 'FAIL'} score=${gr.result.brandFit.score}`);
  }
}

main().catch(e => console.error('FAIL:', e.message));
