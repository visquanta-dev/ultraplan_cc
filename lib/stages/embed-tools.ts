import {
  classifyCalculatorEmbed,
  findCalculatorBySlug,
  MIN_CONFIDENCE,
  type ClassifyInput,
} from './classify-embed';

// ---------------------------------------------------------------------------
// Contextual tool/calculator embed inserter
//
// Replaces the old keyword-substring scanner. Now:
//   1. Asks classify-embed.ts for the single best calculator (or null) based
//      on headline + section headings + intro — not body paragraph text.
//   2. Drops the embed only if the classifier confidence ≥ MIN_CONFIDENCE.
//   3. Places the marker at a section boundary roughly 55–65% through the
//      post (after a heading, never mid-paragraph), so it feels editorial
//      rather than stapled on.
//   4. Hard cap: ONE calculator per post. Less is more.
// ---------------------------------------------------------------------------

export interface EmbedContext {
  headline: string;
  sectionHeadings: string[];
  /** First ~2–3 paragraphs of the article body, joined. */
  introText: string;
}

export interface EmbedResult {
  parts: string[];
  inserted: string[];
  skipped?: { reason: string; confidence: number; slug: string | null };
}

/**
 * Find the index of the section break closest to ~60% through the post.
 * `bodyParts` is structured by workflows/blog-pipeline/index.ts as:
 *   [heading, paragraphs, "", heading, paragraphs, "", ...]
 * so empty strings mark section boundaries. We return the index AFTER a
 * boundary that lands near the target fraction, or -1 if we can't find one.
 */
function findSectionBoundaryAt(bodyParts: string[], fraction: number): number {
  const boundaries: number[] = [];
  for (let i = 0; i < bodyParts.length; i++) {
    if (bodyParts[i].trim() === '') boundaries.push(i + 1);
  }
  if (boundaries.length === 0) return -1;

  // Skip the very first (after intro) and very last (before FAQ) — pick
  // something in the middle third.
  const usable = boundaries.slice(1, Math.max(boundaries.length - 1, 2));
  if (usable.length === 0) return boundaries[Math.floor(boundaries.length / 2)];

  const target = Math.floor(usable.length * fraction);
  return usable[Math.min(target, usable.length - 1)];
}

/**
 * Classify + insert a single calculator embed, or no-op. Async because the
 * classifier makes an LLM call. Non-fatal on any failure — we'd rather ship
 * a post without an embed than block the whole pipeline.
 */
export async function insertToolEmbeds(
  bodyParts: string[],
  context: EmbedContext,
): Promise<EmbedResult> {
  const result = [...bodyParts];

  let classification;
  try {
    const input: ClassifyInput = {
      headline: context.headline,
      sectionHeadings: context.sectionHeadings,
      introText: context.introText,
    };
    classification = await classifyCalculatorEmbed(input);
  } catch (err) {
    console.warn(
      '[embed-tools] classifier failed (non-fatal):',
      (err as Error).message,
    );
    return { parts: result, inserted: [] };
  }

  if (!classification.slug) {
    return {
      parts: result,
      inserted: [],
      skipped: {
        reason: classification.reason || 'no fit',
        confidence: classification.confidence,
        slug: null,
      },
    };
  }

  if (classification.confidence < MIN_CONFIDENCE) {
    console.log(
      `[embed-tools] skipping ${classification.slug} — confidence ${classification.confidence.toFixed(2)} < ${MIN_CONFIDENCE}`,
    );
    return {
      parts: result,
      inserted: [],
      skipped: {
        reason: `below confidence threshold: ${classification.reason}`,
        confidence: classification.confidence,
        slug: classification.slug,
      },
    };
  }

  const calc = findCalculatorBySlug(classification.slug);
  if (!calc) {
    console.warn(
      `[embed-tools] classifier returned unknown slug "${classification.slug}"`,
    );
    return { parts: result, inserted: [] };
  }

  const insertIdx = findSectionBoundaryAt(result, 0.6);
  if (insertIdx === -1) {
    console.warn('[embed-tools] no section boundary found — skipping embed');
    return { parts: result, inserted: [] };
  }

  const marker = `\n{{calculator:${calc.slug}}}\n`;
  result.splice(insertIdx, 0, marker);

  console.log(
    `[embed-tools] inserted ${calc.label} at section boundary (confidence ${classification.confidence.toFixed(2)}): ${classification.reason}`,
  );

  return {
    parts: result,
    inserted: [calc.label],
  };
}
