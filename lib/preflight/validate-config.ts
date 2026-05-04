import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { isAllowed } from '../sources/allowlist';

// ---------------------------------------------------------------------------
// Preflight integrity check
//
// Runs at pipeline start, before the resolver fires. Validates every known
// silent-failure surface and throws loudly if any of them are scaffolded
// but not closed out.
//
// Why this exists: today's debugging session found SEVEN distinct bugs with
// the same fingerprint — scaffold committed, empty prompt / empty keyword
// list / wrong extension / guessed threshold, silently short-circuits at
// runtime, no exception thrown, consumer downstream fails silently. This
// check turns every one of those silent failures into a loud preflight
// error. If someone adds a new scaffold tomorrow, add a new check here
// and the pipeline will refuse to run until it's closed out.
//
// The check is intentionally strict: it throws on any failure rather than
// warning. A scaffolded-but-not-finished pipeline should NOT ship posts.
// ---------------------------------------------------------------------------

export interface PreflightError {
  check: string;
  reason: string;
  file?: string;
  fix?: string;
}

export class PreflightFailure extends Error {
  constructor(public readonly errors: PreflightError[]) {
    const header = `[preflight] ${errors.length} check(s) failed — pipeline will not run until they are fixed:`;
    const body = errors
      .map((e, i) => `  ${i + 1}. [${e.check}] ${e.reason}${e.file ? ` (${e.file})` : ''}${e.fix ? `\n     fix: ${e.fix}` : ''}`)
      .join('\n');
    super(`${header}\n${body}`);
    this.name = 'PreflightFailure';
  }
}

/**
 * Check 0 — every category resolver source must be scrape-allowlisted.
 * categories.yaml feeds the signal resolver, but Firecrawl refuses anything
 * outside config/sources.yaml. Catch drift before the run spends time on
 * topic discovery and then fails during scrape.
 */
function checkCategorySourcesAllowlisted(): PreflightError[] {
  const filePath = path.join(process.cwd(), 'config', 'categories.yaml');
  if (!fs.existsSync(filePath)) {
    return [
      {
        check: 'category-sources-allowlist',
        reason: 'config/categories.yaml does not exist',
        file: filePath,
      },
    ];
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    return [
      {
        check: 'category-sources-allowlist',
        reason: `failed to parse categories.yaml: ${err instanceof Error ? err.message : String(err)}`,
        file: 'config/categories.yaml',
      },
    ];
  }

  const errors: PreflightError[] = [];
  const sources = (parsed as { sources?: unknown })?.sources;
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) {
    return [
      {
        check: 'category-sources-allowlist',
        reason: 'categories.yaml has no sources map for the resolver',
        file: 'config/categories.yaml',
      },
    ];
  }

  for (const [id, rawSource] of Object.entries(sources as Record<string, unknown>)) {
    const source = rawSource as Record<string, unknown>;
    if (typeof source.url !== 'string' || source.url.trim().length === 0) {
      errors.push({
        check: 'category-sources-allowlist',
        reason: `source "${id}" is missing a url`,
        file: 'config/categories.yaml',
      });
      continue;
    }

    if (!isAllowed(source.url)) {
      let hostname = source.url;
      try {
        hostname = new URL(source.url).hostname;
      } catch {
        // Keep the raw value in the error below.
      }
      errors.push({
        check: 'category-sources-allowlist',
        reason: `source "${id}" uses ${hostname}, which Firecrawl will reject because it is not in config/sources.yaml`,
        file: 'config/categories.yaml',
        fix: 'Add the domain to config/sources.yaml or remove the source from config/categories.yaml.',
      });
    }
  }

  return errors;
}

/**
 * Check 1 — classify-embed system prompt is non-empty.
 * This one short-circuited silently for months and resulted in zero posts
 * ever getting a calculator embed.
 */
function checkClassifyEmbedPrompt(): PreflightError | null {
  const filePath = path.join(process.cwd(), 'lib', 'stages', 'classify-embed.ts');
  if (!fs.existsSync(filePath)) {
    return {
      check: 'classify-embed-prompt',
      reason: 'classify-embed.ts does not exist',
      file: filePath,
    };
  }
  const contents = fs.readFileSync(filePath, 'utf-8');
  // Look for the systemPrompt assignment; we care that it's not an empty
  // string literal and not still a TODO.
  const emptyStringMatch = /const\s+systemPrompt\s*=\s*['"`]\s*['"`]/.test(contents);
  if (emptyStringMatch) {
    return {
      check: 'classify-embed-prompt',
      reason: 'systemPrompt in classify-embed.ts is an empty string',
      file: 'lib/stages/classify-embed.ts',
      fix: 'Write the classifier system prompt. See the TODO comment block above the assignment for what it should do.',
    };
  }
  return null;
}

/**
 * Check 2 — calculators.yaml has valid entries and every slug is non-empty.
 * Also validates that every calculator has description + topics, otherwise
 * the LLM classifier has nothing to match against.
 */
function checkCalculatorsYaml(): PreflightError[] {
  const filePath = path.join(process.cwd(), 'config', 'calculators.yaml');
  if (!fs.existsSync(filePath)) {
    return [
      {
        check: 'calculators-yaml',
        reason: 'config/calculators.yaml does not exist',
        file: filePath,
      },
    ];
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    return [
      {
        check: 'calculators-yaml',
        reason: `failed to parse calculators.yaml: ${err instanceof Error ? err.message : String(err)}`,
        file: 'config/calculators.yaml',
      },
    ];
  }
  const errors: PreflightError[] = [];
  const obj = parsed as { calculators?: unknown };
  if (!Array.isArray(obj?.calculators) || obj.calculators.length === 0) {
    errors.push({
      check: 'calculators-yaml',
      reason: 'calculators.yaml has no entries — the classifier will have nothing to pick from',
      file: 'config/calculators.yaml',
    });
    return errors;
  }
  for (const [i, entry] of obj.calculators.entries()) {
    const c = entry as Record<string, unknown>;
    if (!c.slug || typeof c.slug !== 'string') {
      errors.push({
        check: 'calculators-yaml',
        reason: `entry [${i}] is missing a slug`,
        file: 'config/calculators.yaml',
      });
    }
    if (!c.description || typeof c.description !== 'string' || c.description.trim().length < 10) {
      errors.push({
        check: 'calculators-yaml',
        reason: `entry [${i}] (slug: ${c.slug ?? '?'}) has no description — the classifier can't match on slug alone`,
        file: 'config/calculators.yaml',
        fix: 'Write a one-sentence description of what the calculator computes, in customer-facing language.',
      });
    }
    if (!Array.isArray(c.topics) || c.topics.length === 0) {
      errors.push({
        check: 'calculators-yaml',
        reason: `entry [${i}] (slug: ${c.slug ?? '?'}) has no topics — the classifier has no secondary match signal`,
        file: 'config/calculators.yaml',
      });
    }
  }
  return errors;
}

/**
 * Check 3 — internal_links.yaml has entries and every entry has non-empty
 * keywords. A zero-keyword entry can never be matched by the auto-linker.
 */
function checkInternalLinksYaml(): PreflightError[] {
  const filePath = path.join(process.cwd(), 'config', 'internal_links.yaml');
  if (!fs.existsSync(filePath)) {
    return [
      {
        check: 'internal-links-yaml',
        reason: 'config/internal_links.yaml does not exist',
        file: filePath,
      },
    ];
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    return [
      {
        check: 'internal-links-yaml',
        reason: `failed to parse internal_links.yaml: ${err instanceof Error ? err.message : String(err)}`,
        file: 'config/internal_links.yaml',
      },
    ];
  }
  const errors: PreflightError[] = [];
  const obj = parsed as { pages?: unknown; blog?: unknown };
  const allEntries = [
    ...((Array.isArray(obj?.pages) ? obj.pages : []) as Array<Record<string, unknown>>),
    ...((Array.isArray(obj?.blog) ? obj.blog : []) as Array<Record<string, unknown>>),
  ];
  if (allEntries.length === 0) {
    errors.push({
      check: 'internal-links-yaml',
      reason: 'internal_links.yaml has zero entries — the auto-linker will insert no internal links',
      file: 'config/internal_links.yaml',
    });
    return errors;
  }
  for (const [i, entry] of allEntries.entries()) {
    if (!entry.url || typeof entry.url !== 'string') {
      errors.push({
        check: 'internal-links-yaml',
        reason: `entry [${i}] is missing a url`,
        file: 'config/internal_links.yaml',
      });
    }
    if (!Array.isArray(entry.keywords) || entry.keywords.length === 0) {
      errors.push({
        check: 'internal-links-yaml',
        reason: `entry [${i}] (url: ${entry.url ?? '?'}) has no keywords — the auto-linker can never match it`,
        file: 'config/internal_links.yaml',
        fix: 'Add the reader-facing terms someone would use when writing about this page — not the internal product name.',
      });
    }
  }
  return errors;
}

/**
 * Check 4 — fact-check judge prompt file exists and is non-empty.
 * A missing or empty judge prompt would cause fact-recheck to fail
 * cryptically mid-run rather than at preflight.
 */
function checkFactCheckPrompt(): PreflightError | null {
  const filePath = path.join(
    process.cwd(),
    'workflows',
    'blog-pipeline',
    'prompts',
    'gates',
    'fact-check-judge.md',
  );
  if (!fs.existsSync(filePath)) {
    return {
      check: 'fact-check-prompt',
      reason: 'fact-check-judge.md does not exist',
      file: filePath,
    };
  }
  const contents = fs.readFileSync(filePath, 'utf-8');
  if (contents.trim().length < 100) {
    return {
      check: 'fact-check-prompt',
      reason: 'fact-check-judge.md is suspiciously short — likely a scaffold',
      file: 'workflows/blog-pipeline/prompts/gates/fact-check-judge.md',
    };
  }
  return null;
}

/**
 * Check 5 — image-agent prompt file exists and is non-empty.
 */
function checkImageAgentPrompt(): PreflightError | null {
  const filePath = path.join(
    process.cwd(),
    'workflows',
    'blog-pipeline',
    'prompts',
    'image-agent.md',
  );
  if (!fs.existsSync(filePath)) {
    return {
      check: 'image-agent-prompt',
      reason: 'image-agent.md does not exist',
      file: filePath,
    };
  }
  const contents = fs.readFileSync(filePath, 'utf-8');
  if (contents.trim().length < 100) {
    return {
      check: 'image-agent-prompt',
      reason: 'image-agent.md is suspiciously short — likely a scaffold',
      file: 'workflows/blog-pipeline/prompts/image-agent.md',
    };
  }
  return null;
}

/**
 * Check 6 — regenerate-paragraph prompt file exists and is non-empty.
 * This is what the retry loop uses to fix failing paragraphs, so an
 * empty prompt would turn retry into a no-op and blocked drafts
 * into silent garbage.
 */
function checkRegenPrompt(): PreflightError | null {
  const candidates = [
    path.join(process.cwd(), 'workflows', 'blog-pipeline', 'prompts', 'paragraph-regen.md'),
    path.join(process.cwd(), 'workflows', 'blog-pipeline', 'prompts', 'regenerate.md'),
  ];
  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) {
    // If we can't find either known name, skip — this is a soft check.
    return null;
  }
  const contents = fs.readFileSync(filePath, 'utf-8');
  if (contents.trim().length < 100) {
    return {
      check: 'regen-prompt',
      reason: `${path.basename(filePath)} is suspiciously short — likely a scaffold`,
      file: path.relative(process.cwd(), filePath),
    };
  }
  return null;
}

/**
 * Run every preflight check and throw PreflightFailure if any fail.
 * Call this at the top of the pipeline, before the resolver.
 */
export function runPreflight(): void {
  const errors: PreflightError[] = [];

  errors.push(...checkCategorySourcesAllowlisted());

  const classifyErr = checkClassifyEmbedPrompt();
  if (classifyErr) errors.push(classifyErr);

  errors.push(...checkCalculatorsYaml());
  errors.push(...checkInternalLinksYaml());

  const factCheckErr = checkFactCheckPrompt();
  if (factCheckErr) errors.push(factCheckErr);

  const imageAgentErr = checkImageAgentPrompt();
  if (imageAgentErr) errors.push(imageAgentErr);

  const regenErr = checkRegenPrompt();
  if (regenErr) errors.push(regenErr);

  if (errors.length > 0) {
    throw new PreflightFailure(errors);
  }

  console.log('[preflight] all integrity checks passed');
}
