import { config } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// lib/load-env.ts
// Explicitly loads environment variables from .env.local (preferred) or .env.
// Next.js auto-loads .env.local, but standalone Node scripts (smoke-*) use
// plain dotenv, which defaults to .env only. Importing this module as the
// FIRST import in a script ensures process.env is populated before any
// other module reads it.
//
// Usage (must be the first import):
//   import '../lib/load-env';
//   import { scrape } from '../lib/sources/firecrawl';
// ---------------------------------------------------------------------------

const cwd = process.cwd();
const candidates = ['.env.local', '.env'];

for (const name of candidates) {
  const p = path.join(cwd, name);
  if (fs.existsSync(p)) {
    config({ path: p, override: false });
  }
}
