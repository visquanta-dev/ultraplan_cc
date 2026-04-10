import 'dotenv/config';
import { config } from 'dotenv';
config({ path: '.env.local', override: true });

import Replicate from 'replicate';
import { writeFile, mkdir } from 'node:fs/promises';

async function main() {
  const r = new Replicate({ auth: process.env.REPLICATE_API_TOKEN! });
  console.log('Running Flux 2 Pro...');

  const output = await r.run('black-forest-labs/flux-2-pro', {
    input: {
      prompt: 'Modern car dealership showroom, professional photograph, clean composition',
      aspect_ratio: '16:9',
      output_format: 'webp',
      output_quality: 90,
    },
  });

  console.log('Output type:', typeof output);
  console.log('Output constructor:', (output as any)?.constructor?.name);
  console.log('Output toString:', String(output).slice(0, 150));

  // FileOutput in replicate SDK is a ReadableStream with a custom toString
  // that returns the URL. We need to convert it.
  const url = String(output);
  console.log('URL:', url.slice(0, 150));

  if (url.startsWith('http')) {
    const res = await fetch(url);
    console.log('Fetch status:', res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir('tmp', { recursive: true });
    await writeFile('tmp/test-flux2pro.webp', buf);
    console.log('Written:', buf.length, 'bytes → tmp/test-flux2pro.webp');
  } else {
    // Try reading as stream
    const chunks: Buffer[] = [];
    for await (const chunk of output as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    const buf = Buffer.concat(chunks);
    await mkdir('tmp', { recursive: true });
    await writeFile('tmp/test-flux2pro.webp', buf);
    console.log('Written (stream):', buf.length, 'bytes → tmp/test-flux2pro.webp');
  }
}

main().catch(e => console.error('FAIL:', e.message, e.stack));
