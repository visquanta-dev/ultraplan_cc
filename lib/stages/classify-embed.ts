import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { callLLMStructured, MODELS } from '../llm/openrouter';

// ---------------------------------------------------------------------------
// Calculator embed classifier
// Replaces the old substring-scan approach in embed-tools.ts. Given a post's
// headline, outline section headings, and intro paragraph, asks an LLM to
// pick the single best-fitting calculator from config/calculators.yaml —
// or return null if nothing is a strong fit.
//
// Why LLM over keyword match: shallow substring matching on body paragraphs
// was picking up incidental mentions ("response time" in an onboarding post
// → Speed-to-Lead calc). Topic relevance is semantic, not lexical.
// ---------------------------------------------------------------------------

export interface CalculatorEntry {
  slug: string;
  component: string;
  url: string;
  label: string;
  description: string;
  topics: string[];
}

interface CalculatorCatalog {
  calculators: CalculatorEntry[];
}

export interface ClassifyInput {
  headline: string;
  sectionHeadings: string[];
  introText: string;
}

export interface ClassifyResult {
  slug: string | null;
  confidence: number;
  reason: string;
}

const CATALOG_PATH = path.join(process.cwd(), 'config', 'calculators.yaml');

let cachedCatalog: CalculatorEntry[] | null = null;

export function loadCalculatorCatalog(): CalculatorEntry[] {
  if (cachedCatalog) return cachedCatalog;
  const raw = fs.readFileSync(CATALOG_PATH, 'utf-8');
  const parsed = YAML.parse(raw) as CalculatorCatalog;
  if (!parsed?.calculators?.length) {
    throw new Error(`[classify-embed] Empty or malformed catalog at ${CATALOG_PATH}`);
  }
  cachedCatalog = parsed.calculators;
  return cachedCatalog;
}

export function findCalculatorBySlug(slug: string): CalculatorEntry | null {
  return loadCalculatorCatalog().find((c) => c.slug === slug) ?? null;
}

/**
 * Minimum confidence the classifier must return for us to embed a calculator.
 * Below this threshold, we embed nothing rather than force a weak match.
 * TODO(human): tune this as you see results in production.
 */
export const MIN_CONFIDENCE = 0.7;

function buildCatalogBlock(entries: CalculatorEntry[]): string {
  return entries
    .map(
      (c) =>
        `- slug: ${c.slug}\n  label: ${c.label}\n  description: ${c.description.trim()}\n  topics: ${c.topics.join(', ')}`,
    )
    .join('\n');
}

/**
 * Ask the LLM to pick the single best-fitting calculator for this post, or
 * return null. Returns { slug, confidence, reason }. Caller decides whether
 * to actually embed based on MIN_CONFIDENCE.
 */
export async function classifyCalculatorEmbed(
  input: ClassifyInput,
): Promise<ClassifyResult> {
  const catalog = loadCalculatorCatalog();
  const catalogBlock = buildCatalogBlock(catalog);
  const validSlugs = catalog.map((c) => c.slug);

  // TODO(human): write the classifier system prompt below.
  //
  // Context: this runs once per generated blog post, after draft + enrichment
  // but before PR. Its job is to decide which (if any) calculator from the
  // catalog is a STRONG topical fit for the post — not just a keyword-adjacent
  // mention. The old substring-based matcher put the Service Drive calc on
  // posts that mentioned "missed calls" once in passing; we want to stop that.
  //
  // The prompt should make the model:
  //   1. Read the headline + section headings + intro as the post's "aboutness"
  //      — body paragraphs can mention anything, but the topic is declared
  //      in headings and the first paragraph.
  //   2. Compare against each calculator's `description` + `topics`, not its
  //      slug. Slugs are identifiers, not meaning.
  //   3. Return { slug: <one of ${validSlugs.join(' | ')}> | null,
  //               confidence: 0.0–1.0,
  //               reason: one sentence of editorial justification }
  //   4. Lean toward returning null. "No calculator" is better than a weak
  //      match. Only return a slug if the post is GENUINELY about that topic.
  //   5. Never pick powersports-profit for automotive posts, never pick
  //      independent-dealer for franchise/OEM posts. These are hard rules.
  //
  // Also consider whether you want to tune MIN_CONFIDENCE above (0.7 is a
  // guess — raise it if you still see weak matches in production).
  const systemPrompt = '';

  if (!systemPrompt) {
    // Short-circuit until the human fills in the prompt. Returning null keeps
    // the pipeline green: posts just ship without an embed rather than crash.
    console.warn('[classify-embed] system prompt not yet defined — skipping embed');
    return { slug: null, confidence: 0, reason: 'classifier prompt not defined' };
  }

  const userPayload = [
    `HEADLINE: ${input.headline}`,
    '',
    'SECTION HEADINGS:',
    ...input.sectionHeadings.map((h) => `- ${h}`),
    '',
    'INTRO:',
    input.introText,
    '',
    'CALCULATOR CATALOG:',
    catalogBlock,
  ].join('\n');

  const schema = {
    type: 'object',
    required: ['slug', 'confidence', 'reason'],
    properties: {
      slug: {
        oneOf: [{ type: 'string', enum: validSlugs }, { type: 'null' }],
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason: { type: 'string' },
    },
  };

  return callLLMStructured<ClassifyResult>({
    system: systemPrompt + `\n\nVALID SLUGS: ${validSlugs.join(', ')} (or null).`,
    user: userPayload,
    schema,
    model: MODELS.JUDGE,
    temperature: 0.2,
    maxTokens: 400,
    parse: (raw) => {
      const r = raw as Partial<ClassifyResult>;
      const slug =
        r.slug === null || r.slug === undefined || r.slug === ''
          ? null
          : validSlugs.includes(r.slug)
            ? r.slug
            : null;
      const confidence =
        typeof r.confidence === 'number' && r.confidence >= 0 && r.confidence <= 1
          ? r.confidence
          : 0;
      const reason = typeof r.reason === 'string' ? r.reason : '';
      return { slug, confidence, reason };
    },
  });
}
