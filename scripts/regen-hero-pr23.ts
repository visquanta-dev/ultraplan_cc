/**
 * One-off: regenerate the hero image for PR #23
 * (half-dealers-now-nail-15-minute-lead-response) and upload it to the
 * PR branch via the GitHub API. The original run hit the image gate
 * 3 times and shipped with a wireframe fallback.
 *
 * Uses a deliberate wide dealership scene prompt (not the "close-up
 * detail" format the image agent picked for the original run) to
 * maximize brand-fit and minimize banned-content violations.
 *
 * Usage: npx tsx scripts/regen-hero-pr23.ts
 */
import 'dotenv/config';
import { config } from 'dotenv';
config({ path: '.env.cron.tmp', override: true });

import { generateImage } from '../lib/image/generate';
import sharp from 'sharp';

const PROMPT = `Generate a photorealistic editorial hero image for a business blog post titled: "Why Do Half of Dealers Now Nail a 15-Minute Lead Response?"

Scene: A wide-angle interior view of a modern car dealership BDC (Business Development Center) workspace during the day. Three empty desks arranged in a row, each with a dark laptop screen showing a generic inbox layout (no readable text, no brand logos), a slim office phone, and a small wall-mounted timer clock showing "14:30" above each desk. Large windows in the background show out-of-focus dealership service bays and a row of silhouetted cars. Warm editorial lighting, soft daylight from the windows, shallow depth of field with the middle desk in sharp focus. Professional automotive editorial photography style, 16:9 aspect ratio.

Rules:
- Photorealistic, 16:9 aspect ratio
- No identifiable human faces or people visible
- No brand logos, car badges, or dealership signage visible
- No readable text on the screens, phones, or walls
- Warm professional lighting, editorial photography feel
- Composition should feel like a real dealership workspace photograph
- The desks and timer clocks are the focal subject — convey "response time" visually`;

async function main() {
  console.log('[regen-pr23] Prompt head:', PROMPT.slice(0, 140) + '...');
  console.log('[regen-pr23] Calling image model...');
  const img = await generateImage(PROMPT);

  const buf = Buffer.from(img.base64, 'base64');
  console.log(`[regen-pr23] Received ${img.mimeType}, ${(buf.length / 1024).toFixed(0)}KB`);

  console.log('[regen-pr23] Converting to WebP (quality 82)...');
  const webp = await sharp(buf).webp({ quality: 82 }).toBuffer();
  console.log(`[regen-pr23] WebP ${(webp.length / 1024).toFixed(0)}KB`);

  const token = process.env.GITHUB_PAT;
  if (!token) throw new Error('GITHUB_PAT not set');

  const branch = 'ultraplan/2026-04-15-half-dealers-now-nail-15-minute-lead-response-mo03q1s9';
  const slugDir = 'half-dealers-now-nail-15-minute-lead-response';
  const filePath = `public/images/blog/${slugDir}/hero.webp`;
  const repo = 'visquanta-dev/site';

  // Check if the hero file already exists on the PR branch (it will if the
  // fallback wireframe was copied; will not if only frontmatter references
  // the wireframe path without copying).
  const getRes = await fetch(
    `https://api.github.com/repos/${repo}/contents/${filePath}?ref=${branch}`,
    { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'uc' } },
  );

  let sha: string | undefined;
  if (getRes.ok) {
    const existing = (await getRes.json()) as { sha: string };
    sha = existing.sha;
    console.log('[regen-pr23] Existing SHA:', sha);
  } else if (getRes.status === 404) {
    console.log('[regen-pr23] No existing hero on branch — creating fresh');
  } else {
    throw new Error(`Get existing failed: ${getRes.status} ${await getRes.text()}`);
  }

  const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath}`, {
    method: 'PUT',
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'uc',
    },
    body: JSON.stringify({
      message: 'fix: regenerate hero image for PR #23 (BDC workspace scene)',
      content: webp.toString('base64'),
      ...(sha ? { sha } : {}),
      branch,
    }),
  });
  if (!putRes.ok) throw new Error(`PUT failed: ${putRes.status} ${await putRes.text()}`);
  const result = (await putRes.json()) as { commit: { sha: string; html_url: string } };
  console.log('[regen-pr23] Committed:', result.commit.sha);
  console.log('[regen-pr23] Commit URL:', result.commit.html_url);
  console.log('[regen-pr23] DONE');
}

main().catch((e) => {
  console.error('FAIL:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
