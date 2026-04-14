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

  const systemPrompt = `You are an editorial classifier that decides which interactive calculator (if any) belongs inside a just-written dealership blog post.

You will receive:
- HEADLINE, SECTION HEADINGS, and INTRO — these define the post's true topic.
- CALCULATOR CATALOG — a list of calculators, each with a label, description, and topic tags.

Your job is to pick the single best-fitting calculator, or return null.

HOW TO DECIDE:
1. Infer the post's "aboutness" from the headline + section headings + intro ONLY. Body paragraphs can name-drop anything; topic is declared up top.
2. Compare that aboutness to each calculator's description and topics. Match on meaning, not on slug or keyword overlap. A post about "voice agent ROI in service" matches a calculator described as "revenue recovered by a voice agent answering missed service calls" even if the words aren't identical.
3. Pick the ONE calculator whose description most directly models the economic question a reader of this post is asking. If two are close, pick neither and return null.
4. LEAN HARD TOWARD NULL. A missing calculator is fine; a wrong calculator is worse than none. Only return a slug when the post is genuinely, centrally about that calculator's subject.

HARD RULES (never violate):
- Never pick powersports-profit on an automotive / franchise / luxury post. Powersports means ATV/UTV/motorcycle dealers only.
- Never pick independent-dealer on a franchise or OEM-focused post. Independent means non-franchise used-car lots only.
- Never pick dealer-roi unless the post is a broad "is dealership technology worth it" ROI piece AND no more specific calculator fits. It's a last-resort generic fallback.

CONFIDENCE SCORING:
- 0.90–1.00: the post's central thesis is the same question the calculator answers.
- 0.75–0.89: the post is clearly in this calculator's topical lane and a reader would reach for this tool.
- 0.60–0.74: plausible but not central. Return null instead — the pipeline threshold will reject this anyway.
- < 0.60: not a real match. Return null.

OUTPUT:
Return a JSON object with keys "slug", "confidence", "reason".
- slug: one of [${validSlugs.join(', ')}] or null
- confidence: a number between 0.0 and 1.0
- reason: one sentence explaining the editorial judgment in plain language a human editor would accept.`;

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
