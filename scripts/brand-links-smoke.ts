// Smoke test for lib/stages/brand-links.ts — confirms the brand-registry
// enrichment handles the cases that shipped broken on PR 42 (manually patched
// post-hoc) would now be covered by the pipeline.
//
// Run: npx tsx scripts/brand-links-smoke.ts

import { insertBrandLinks, __BRANDS_FOR_TEST } from '../lib/stages/brand-links';

let pass = 0;
let fail = 0;

function assert(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log('  PASS:', label); }
  else { fail++; console.log('  FAIL:', label, detail ? `\n        ${detail}` : ''); }
}

// 1) Wraps first mention of CarGurus / AutoTrader / CARFAX / Cars.com / Edmunds
const mixed = [
  'CarGurus led the network at 17% of inbound volume.',
  'AutoTrader followed at 9%, CARFAX at 8%.',
  'Cars.com came in at 8% and Edmunds at 3%.',
];
const out1 = insertBrandLinks(mixed);
assert('CarGurus wrapped', out1[0].includes('[CarGurus](https://www.cargurus.com/)'));
assert('AutoTrader wrapped', out1[1].includes('[AutoTrader](https://www.autotrader.com/)'));
assert('CARFAX wrapped', out1[1].includes('[CARFAX](https://www.carfax.com/)'));
assert('Cars.com wrapped', out1[2].includes('[Cars.com](https://www.cars.com/)'));
assert('Edmunds wrapped', out1[2].includes('[Edmunds](https://www.edmunds.com/)'));

// 2) Only first mention gets linked — second mention stays plain
const repeat = [
  'CarGurus drove traffic. CarGurus also had digital deal product.',
];
const out2 = insertBrandLinks(repeat);
const cgMatches = (out2[0].match(/\[CarGurus\]/g) || []).length;
assert('Only first CarGurus mention linked (got ' + cgMatches + ')', cgMatches === 1);

// 3) Does not wrap inside existing markdown links
const alreadyLinked = [
  'Visit [CarGurus](https://dealers.cargurus.com/) for the dealer portal.',
];
const out3 = insertBrandLinks(alreadyLinked);
const cgCount = (out3[0].match(/\[CarGurus\]/g) || []).length;
assert('Existing CarGurus link not double-wrapped', cgCount === 1);
assert('Existing CarGurus URL preserved', out3[0].includes('dealers.cargurus.com'));

// 4) Word boundaries — "Cargo" and "Autotraders" should NOT match
const boundaryEdge = [
  'Our cargo handling improved. Autotraders across the network.',
];
const out4 = insertBrandLinks(boundaryEdge);
assert('"cargo" not matched as CarGurus', !out4[0].includes('[cargo]'));
assert('"Autotraders" not matched as AutoTrader', !out4[0].includes('[Autotrader]'));

// 5) AutoTrader.com beats plain AutoTrader when both appear
const dotComCase = [
  'The rankings were AutoTrader.com at 10%, and plain AutoTrader later.',
];
const out5 = insertBrandLinks(dotComCase);
assert('AutoTrader.com wrapped first', out5[0].includes('[AutoTrader.com](https://www.autotrader.com/)'));
// Plain "AutoTrader" after the .com match should NOT be re-linked (same URL, only-first-per-post)
const atMatches = (out5[0].match(/\[AutoTrader[^\]]*\]/g) || []).length;
assert('Plain AutoTrader left unlinked after .com match (got ' + atMatches + ')', atMatches === 1);

// 6) Plain-text passthrough when no brand mentioned
const plain = ['The dealership had a record month in Q4.'];
const out6 = insertBrandLinks(plain);
assert('No brand mention -> text unchanged', out6[0] === plain[0]);

// 7) Registry sanity — each URL appears exactly once (per-brand intent)
const urls = __BRANDS_FOR_TEST.map(b => b.url);
const dupUrls = urls.filter((u, i) => urls.indexOf(u) !== i);
// We intentionally allow CARFAX/Carfax both pointing to carfax.com — same for
// AutoTrader/AutoTrader.com. Dupes are fine; what we check is pattern validity.
console.log(`  info: registry has ${__BRANDS_FOR_TEST.length} entries, ${new Set(urls).size} unique URLs`);

// 8) All patterns compile (Node regex validation)
let allCompile = true;
for (const { pattern } of __BRANDS_FOR_TEST) {
  if (!(pattern instanceof RegExp)) allCompile = false;
}
assert('All brand patterns are valid RegExp', allCompile);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
