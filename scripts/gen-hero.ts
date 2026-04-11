import 'dotenv/config';
import { config } from 'dotenv';
config({ path: '.env.local', override: true });

import { generateImage } from '../lib/image/generate';
import { writeFile, mkdir } from 'node:fs/promises';

async function main() {
  console.log('Generating hero image...');
  const img = await generateImage(
    `Generate a photorealistic editorial hero image for a business blog post titled: "Dealerships Lose $1M a Year on Missed Calls - Here's the Fix"

Show a modern car dealership service department reception desk with a desk phone ringing (with a visible incoming call light), two computer monitors showing scheduling software, and an empty office chair - the call is going unanswered. Warm overhead lighting, clean professional environment. The scene should feel like a real service drive reception area that any dealer would recognize.

Rules:
- Photorealistic, 16:9 aspect ratio
- No identifiable human faces
- No brand logos or car badges
- No text overlays
- Sharp focus on the phone as the clear focal point`
  );

  console.log('Success:', img.mimeType, (Buffer.from(img.base64, 'base64').length / 1024).toFixed(0) + 'KB');
  await mkdir('tmp', { recursive: true });
  await writeFile('tmp/hero-missed-calls.jpg', Buffer.from(img.base64, 'base64'));
  console.log('Saved: tmp/hero-missed-calls.jpg');
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
