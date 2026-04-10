import 'dotenv/config';
import { config } from 'dotenv';
config({ path: '.env.local', override: true });

import Replicate from 'replicate';
import { writeFile, mkdir } from 'node:fs/promises';

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN! });
const prompt = 'Professional editorial photograph for a business blog about automotive dealerships adopting modern technology. Clean composition, natural lighting, shallow depth of field. No text overlays.';

async function testModel(name: string, model: string, input: Record<string, unknown>) {
  console.log(`\nTesting ${name}...`);
  const t = Date.now();
  try {
    const output = await replicate.run(model as `${string}/${string}`, { input });
    console.log(`  raw output type: ${typeof output}, isArray: ${Array.isArray(output)}`);

    const first = Array.isArray(output) ? output[0] : output;
    console.log(`  first type: ${typeof first}, constructor: ${first?.constructor?.name}`);

    if (first && typeof first === 'object') {
      console.log(`  keys: ${Object.keys(first).join(', ')}`);
    }

    let buf: Buffer;
    if (first && typeof first === 'object' && 'url' in first) {
      const urlVal = (first as any).url;
      const url = typeof urlVal === 'function' ? urlVal.call(first) : String(urlVal);
      console.log(`  fetching URL: ${String(url).slice(0, 100)}...`);
      const res = await fetch(String(url));
      buf = Buffer.from(await res.arrayBuffer());
    } else if (typeof first === 'string' && first.startsWith('http')) {
      console.log(`  fetching string URL: ${first.slice(0, 100)}...`);
      const res = await fetch(first);
      buf = Buffer.from(await res.arrayBuffer());
    } else {
      console.log(`  unexpected output: ${String(first).slice(0, 200)}`);
      return;
    }

    await mkdir('tmp', { recursive: true });
    const filename = `tmp/test-${name.toLowerCase().replace(/\s+/g, '-')}.webp`;
    await writeFile(filename, buf);
    console.log(`  SUCCESS: ${buf.length} bytes, ${Date.now() - t}ms → ${filename}`);
  } catch (e: any) {
    console.error(`  FAIL: ${e.message}`);
  }
}

async function main() {
  await testModel('Flux-2-Pro', 'black-forest-labs/flux-2-pro', {
    prompt, aspect_ratio: '16:9', output_format: 'webp', output_quality: 90,
  });

  await testModel('Recraft-V4', 'recraft-ai/recraft-v4', {
    prompt, size: '1820x1024', output_format: 'webp',
  });

  await testModel('Flux-Schnell', 'black-forest-labs/flux-schnell', {
    prompt, aspect_ratio: '16:9', output_format: 'webp', output_quality: 90,
  });
}

main().catch(e => console.error('FATAL:', e.message));
