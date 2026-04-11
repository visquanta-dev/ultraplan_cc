import 'dotenv/config';
import { config } from 'dotenv';
config({ path: '.env.local', override: true });

import fs from 'node:fs';
import path from 'node:path';
import { callLLMStructured } from '../lib/llm/openrouter';
import { generateImage } from '../lib/image/generate';
import { writeFile, mkdir } from 'node:fs/promises';

async function main() {
  // Load the image agent prompt
  const agentPrompt = fs.readFileSync(
    path.join(process.cwd(), 'workflows', 'blog-pipeline', 'prompts', 'image-agent.md'),
    'utf-8',
  );

  // Sample blog content
  const headline = 'Dealerships Lose $1M a Year on Missed Calls - Here\'s the Fix';
  const content = `The average dealership forfeits roughly $1 million in annual revenue from unreturned voicemails and misrouted calls. 86% of vehicles on the road are out of warranty, and 75% of consumers buy tires from whoever recommends them first, yet franchise stores capture only 8% of tire sales. Voice agents topped the technology investment list - 74% of dealers plan to deploy them. Early adopters saw appointment volumes climb 30%, BDC costs drop by a third, and listing engagement surge 67%. The national fixed absorption rate sits at 63.9% against a 100% target.`;

  console.log('[test] Running Image Agent...');
  const result = await callLLMStructured<{ format: string; reason: string; prompt: string }>({
    system: agentPrompt,
    user: `Read the following blog post and generate one image prompt following the rules exactly.\n\n# ${headline}\n\n${content}`,
    schema: {
      type: 'object',
      properties: {
        format: { type: 'string' },
        reason: { type: 'string' },
        prompt: { type: 'string' },
      },
      required: ['format', 'reason', 'prompt'],
    },
    parse: (raw) => {
      const obj = raw as Record<string, unknown>;
      return {
        format: String(obj.format ?? ''),
        reason: String(obj.reason ?? ''),
        prompt: String(obj.prompt ?? ''),
      };
    },
  });

  console.log(`\nFORMAT: ${result.format}`);
  console.log(`REASON: ${result.reason}`);
  console.log(`PROMPT: ${result.prompt}`);

  console.log('\n[test] Generating image with Nano Banana 2...');
  const img = await generateImage(result.prompt);
  console.log(`SUCCESS: ${img.mimeType}, ${(Buffer.from(img.base64, 'base64').length / 1024).toFixed(0)}KB`);

  await mkdir('tmp', { recursive: true });
  await writeFile('tmp/test-image-agent.jpg', Buffer.from(img.base64, 'base64'));
  console.log('Saved: tmp/test-image-agent.jpg');
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
