import { renderChart, validateChartSpec } from '../lib/image/chart-renderer';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

async function main() {
  const specs = [
    {
      type: 'delta' as const,
      headline: 'of service customers leave frustrated',
      data: [{ label: 'Cox Automotive Service Study 2023', value: 48, valueLabel: '48%' }],
      source: 'Cox Automotive',
    },
    {
      type: 'bar' as const,
      headline: 'First-service return rate: McGuire vs district',
      data: [
        { label: 'N. New Jersey', value: 65.8, valueLabel: '65.8%' },
        { label: 'New York zone', value: 64.4, valueLabel: '64.4%' },
        { label: "McGuire's", value: 80, valueLabel: '80%' },
      ],
      source: 'CDK Global',
    },
    {
      type: 'trendline' as const,
      headline: 'Average response time (minutes) by year',
      data: [
        { label: '2022', value: 98 },
        { label: '2023', value: 91 },
        { label: '2024', value: 78 },
        { label: '2025', value: 62 },
        { label: '2026', value: 48 },
      ],
      source: 'Dealer Teamwork',
    },
  ];

  const outDir = path.join(os.tmpdir(), 'chart-smoke');
  fs.mkdirSync(outDir, { recursive: true });

  for (const spec of specs) {
    const validated = validateChartSpec(spec);
    const png = await renderChart(validated);
    const out = path.join(outDir, `chart-${spec.type}.png`);
    fs.writeFileSync(out, png);
    console.log(`wrote ${out} (${png.length} bytes)`);
  }

  console.log('\n--- validator negative tests ---');
  const badSpecs: unknown[] = [
    { type: 'bar', headline: '', data: [] },
    { type: 'delta', headline: 'hi', data: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] },
    { type: 'trendline', headline: 'hi', data: [{ label: 'a', value: 1 }] },
    { type: 'other', headline: 'hi', data: [] },
  ];
  for (const bad of badSpecs) {
    try {
      validateChartSpec(bad);
      console.log(`FAIL: ${JSON.stringify(bad)} should have thrown`);
    } catch (err) {
      console.log(`OK rejected: ${(err as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
