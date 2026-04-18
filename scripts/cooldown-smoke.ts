import { getCategoryStatus, getAvailableCategories, categorizePost } from '../lib/topics/category-cooldown';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

console.log('=== Current category cooldown status ===\n');
const status = getCategoryStatus();
for (const c of status) {
  const tag = c.blocked ? '🔒 BLOCKED' : '🟢 OPEN';
  const reason = c.blocked_reason ?? (c.last_post ? `last post ${c.last_post.slug} ${c.last_post.daysAgo}d ago (cooldown ${c.cooldown_days}d)` : 'no prior posts');
  console.log(`${tag}  ${c.id.padEnd(20)} weight=${c.editorial_weight}  — ${reason}`);
}

console.log('\n=== Available categories (sorted by editorial_weight desc) ===\n');
for (const c of getAvailableCategories()) {
  console.log(`  ${c.id.padEnd(20)} weight=${c.editorial_weight}`);
}

console.log('\n=== Heuristic categorization audit — every post on site main ===\n');
const blogDir = path.join(process.env.USERPROFILE ?? '', 'Desktop', 'site', 'content', 'blog');
const files = fs.readdirSync(blogDir).filter((f) => f.endsWith('.md'));
const counts: Record<string, number> = {};
for (const file of files) {
  const raw = fs.readFileSync(path.join(blogDir, file), 'utf-8');
  const parsed = matter(raw);
  const cat = categorizePost(parsed.data);
  counts[cat] = (counts[cat] ?? 0) + 1;
  console.log(`  ${cat.padEnd(20)} ← ${file}`);
}
console.log('\n=== Distribution ===\n');
for (const [cat, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cat.padEnd(20)} ${count}`);
}
