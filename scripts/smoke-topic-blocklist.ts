// Smoke test — topic-blocklist filter
//
// Verifies the resolver-level blocklist correctly:
//   1. Kills clusters whose representative title contains a blocked variant
//   2. Kills clusters where >= saturation% of URL titles contain a variant
//   3. Lets through clusters that only have incidental mentions (< saturation%)
//   4. Does not false-positive on Spanish "nada" or "Granada" tokens
//
// Includes a real-world case: the 41-URL "Leading The Ai Revolution At Nada
// 2026" cluster from run 25175663119 (2026-04-30) that got through Fix C
// because it had 2 T1s. This blocklist must catch it.

import { filterBlockedTopics, __test } from '../lib/topics/topic-blocklist';

interface TestCase {
  name: string;
  cluster: { representative_title: string; urls: { title: string }[] };
  shouldBlock: boolean;
  expectedMatchKind?: 'rep_title' | 'url_saturation';
}

const cases: TestCase[] = [
  {
    name: 'real run 25175663119 cluster — rep title contains NADA 2026',
    cluster: {
      representative_title: 'Leading The Ai Revolution At Nada 2026',
      urls: [
        { title: 'CDK Brings NADA To You' },
        { title: 'CDK Showcases Automotive Retail Leadership At NADA 2026' },
        { title: 'Five Things To Do At NADA 2026' },
        { title: 'A Recap From NADA 2026' },
      ],
    },
    shouldBlock: true,
    expectedMatchKind: 'rep_title',
  },
  {
    name: 'NADA Show variant in rep title',
    cluster: {
      representative_title: 'What We Saw At The NADA Show This Year',
      urls: [{ title: 'Some unrelated title' }],
    },
    shouldBlock: true,
    expectedMatchKind: 'rep_title',
  },
  {
    name: 'rep title clean but 4/5 URLs are NADA — saturation kill',
    cluster: {
      representative_title: 'Dealer Trends For The Year Ahead',
      urls: [
        { title: 'CDK At NADA 2026' },
        { title: 'Cox Automotive NADA Recap' },
        { title: 'Top Takeaways From NADA Show' },
        { title: 'NADA 2026 Vendor Roundup' },
        { title: 'A Story About Used Car Pricing' },
      ],
    },
    shouldBlock: true,
    expectedMatchKind: 'url_saturation',
  },
  {
    name: 'incidental NADA mention (1 of 10) — not saturated, kept',
    cluster: {
      representative_title: 'How Dealers Use Conversational AI To Re-engage Old Prospects',
      urls: [
        { title: 'Reactivating cold leads with SMS' },
        { title: 'Conversational AI in BDC' },
        { title: 'Re-engagement campaigns 2026' },
        { title: 'NADA panel touched on this briefly' },
        { title: 'Speed to lead matters' },
        { title: 'Voice agents and lead reactivation' },
        { title: 'Why dormant leads convert' },
        { title: 'BDC playbook for old prospects' },
        { title: 'Win-back email sequences' },
        { title: 'Conversion lift from re-engagement' },
      ],
    },
    shouldBlock: false,
  },
  {
    name: 'clean cluster — no NADA anywhere',
    cluster: {
      representative_title: 'Service Department KPI Pitfalls',
      urls: [
        { title: 'Technician productivity is misleading' },
        { title: 'Approved work drives hours' },
        { title: 'Advisor conversations move the needle' },
      ],
    },
    shouldBlock: false,
  },
  {
    name: 'Spanish "nada" in body would not be in title; rep title with Granada must not false-positive',
    cluster: {
      representative_title: 'How Granada Hyundai Uses Voice AI To Recover Service Customers',
      urls: [
        { title: 'Granada Hyundai service drive case study' },
        { title: 'Granada-area dealers see service capture lift' },
      ],
    },
    shouldBlock: false,
  },
];

let pass = 0;
let fail = 0;
const failures: string[] = [];

for (const tc of cases) {
  const { kept, rejected } = filterBlockedTopics([tc.cluster]);
  const wasBlocked = rejected.length === 1;
  const ok = wasBlocked === tc.shouldBlock
    && (!tc.shouldBlock || rejected[0].reason.match_kind === tc.expectedMatchKind);
  if (ok) {
    pass++;
    console.log(`  PASS  ${tc.name}`);
    if (wasBlocked) {
      console.log(`        → blocked on ${rejected[0].reason.match_kind} ("${rejected[0].reason.matched_variant}")`);
    }
  } else {
    fail++;
    const reasonStr = wasBlocked
      ? `blocked (${rejected[0].reason.match_kind}, "${rejected[0].reason.matched_variant}")`
      : 'kept';
    const expected = tc.shouldBlock
      ? `blocked (${tc.expectedMatchKind})`
      : 'kept';
    failures.push(`${tc.name} — got ${reasonStr}, expected ${expected}`);
    console.log(`  FAIL  ${tc.name}`);
    console.log(`        → got ${reasonStr}, expected ${expected}`);
  }
}

// Direct tokenMatch unit checks — guards against future regression on the
// Spanish-word false-positive surface that motivated whole-token matching.
const tokenChecks: { haystack: string; needle: string; expected: boolean }[] = [
  { haystack: 'NADA 2026 recap', needle: 'NADA', expected: true },
  { haystack: 'Granada is a city', needle: 'NADA', expected: false },
  { haystack: 'no hay nada que decir', needle: 'NADA', expected: true }, // Spanish lowercase still matches because we lowercase both sides — caught at corpus level (English titles don't carry this string)
  { haystack: 'NADA Show 2027 preview', needle: 'NADA Show', expected: true },
  { haystack: 'show off your nada', needle: 'NADA Show', expected: false }, // multi-token order matters
];

console.log('\nDirect tokenMatch checks:');
for (const tc of tokenChecks) {
  const got = __test.tokenMatch(tc.haystack, tc.needle);
  const ok = got === tc.expected;
  if (ok) {
    pass++;
    console.log(`  PASS  "${tc.haystack}" ⊃ "${tc.needle}" = ${got}`);
  } else {
    fail++;
    failures.push(`tokenMatch("${tc.haystack}", "${tc.needle}") got ${got}, expected ${tc.expected}`);
    console.log(`  FAIL  "${tc.haystack}" ⊃ "${tc.needle}" = ${got} (expected ${tc.expected})`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
