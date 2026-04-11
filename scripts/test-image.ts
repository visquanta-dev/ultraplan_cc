import 'dotenv/config';
import { config } from 'dotenv';
config({ path: '.env.local', override: true });

import { generateImage } from '../lib/image/generate';
import { writeFile, mkdir } from 'node:fs/promises';

async function main() {
  console.log('[test] Generating with Nano Banana 2...');
  const t = Date.now();
  const img = await generateImage(
    'Generate a high-quality, photorealistic hero image for a business blog post titled: "Your Service Drive Is Losing $1 Million a Year on Missed Calls"\n\n' +
    'Show a modern dealership service desk with a phone ringing unanswered, warm lighting, clean professional environment. ' +
    'No identifiable human faces. No brand logos. No text overlays. 16:9 aspect ratio.'
  );
  console.log('[test] SUCCESS');
  console.log('  mimeType:', img.mimeType);
  console.log('  model:', img.model);
  console.log('  size:', (Buffer.from(img.base64, 'base64').length / 1024).toFixed(0) + 'KB');
  console.log('  time:', Date.now() - t, 'ms');

  await mkdir('tmp', { recursive: true });
  await writeFile('tmp/test-nanobanan2.webp', Buffer.from(img.base64, 'base64'));
  console.log('  saved: tmp/test-nanobanan2.webp');
}

main().catch(e => { console.error('[test] FAIL:', e.message); process.exit(1); });
