import 'dotenv/config';
import { config } from 'dotenv';
config({ path: '.env.local', override: true });

import { generateImage } from '../lib/image/generate';

async function main() {
  console.log('[test-image] Generating...');
  const img = await generateImage('A clean, modern hero image for a blog post about automotive dealership technology. Minimal, professional, blue tones.');
  console.log('[test-image] SUCCESS');
  console.log('  mimeType:', img.mimeType);
  console.log('  model:', img.model);
  console.log('  base64 length:', img.base64.length);
}

main().catch(e => { console.error('[test-image] FAIL:', e.message); process.exit(1); });
