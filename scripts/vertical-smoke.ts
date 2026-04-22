import { runVerticalDisciplineGate, findAudienceAnchorMatches } from '../lib/gates/vertical-discipline';
import type { TransformedParagraph } from '../lib/stages/voice-transform';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

function para(text: string): TransformedParagraph {
  return {
    text,
    section_index: 0,
    source_id: 'smoke',
    anchor_quote_id: 'smoke',
  } as TransformedParagraph;
}

async function runCase(label: string, paragraphs: TransformedParagraph[], expectPass: boolean) {
  const result = await runVerticalDisciplineGate(paragraphs);
  const ok = result.passed === expectPass;
  const tag = ok ? 'OK ' : 'FAIL';
  console.log(`[${tag}] ${label}`);
  console.log(`       passed=${result.passed} expected=${expectPass}`);
  console.log(`       ${result.summary}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  console.log('=== Positive cases (should PASS) ===\n');

  await runCase(
    'dealership + BDC in opener',
    [
      para(
        'Dealerships across the country are watching web leads age out before a BDC rep ever picks up the phone. Six months ago one midwest store put a stopwatch on it.',
      ),
      para('The result: 74% of inbound leads were cold before anyone replied.'),
    ],
    true,
  );

  await runCase(
    'fixed ops + service advisor',
    [
      para(
        'In 2026, fixed ops is where the margin is. A service advisor has maybe 90 seconds to turn a write-up into a repair order before the customer walks.',
      ),
    ],
    true,
  );

  await runCase(
    'F&I and showroom',
    [
      para(
        'On the showroom floor, the F&I desk is the last stop before the money closes. That is where dealership gross lives or dies.',
      ),
    ],
    true,
  );

  console.log('\n=== Negative cases (should FAIL) ===\n');

  await runCase(
    'generic business opener — no audience anchor',
    [
      para(
        'Businesses across every industry are discovering that slow response times cost them revenue. Teams that reply first tend to win the deal.',
      ),
      para(
        'Our data shows that companies using automated follow-up capture more of the pipeline than those still relying on manual outreach.',
      ),
    ],
    false,
  );

  await runCase(
    'generic AI fluff opener',
    [
      para(
        'Artificial intelligence is reshaping customer engagement across every sector. Organizations that embrace automation are pulling ahead of their peers.',
      ),
    ],
    false,
  );

  console.log('\n=== Audit: opening ~200 words of every post on site main ===\n');

  const blogDir = path.join(process.env.USERPROFILE ?? '', 'Desktop', 'final site', 'content', 'blog');
  if (!fs.existsSync(blogDir)) {
    console.log(`  (skipped — ${blogDir} not found)`);
    return;
  }

  const files = fs.readdirSync(blogDir).filter((f) => f.endsWith('.md'));
  let pass = 0;
  let fail = 0;
  const failures: string[] = [];

  for (const file of files) {
    const raw = fs.readFileSync(path.join(blogDir, file), 'utf-8');
    const parsed = matter(raw);
    const body = parsed.content.slice(0, 2000);
    const matches = findAudienceAnchorMatches(body);
    if (matches.length > 0) {
      pass++;
    } else {
      fail++;
      failures.push(file);
    }
  }

  console.log(`  PASS: ${pass} / ${files.length} posts have an anchor term in the first ~2000 chars`);
  console.log(`  FAIL: ${fail} / ${files.length}`);
  if (failures.length > 0) {
    console.log('\n  Posts that would be flagged by the gate today:');
    for (const f of failures.slice(0, 20)) {
      console.log(`    - ${f}`);
    }
    if (failures.length > 20) console.log(`    ... and ${failures.length - 20} more`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
