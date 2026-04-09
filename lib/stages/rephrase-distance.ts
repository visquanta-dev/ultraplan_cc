import { pipeline, env } from '@xenova/transformers';
import type { DraftedParagraph } from './paragraph-draft';
import type { Bundle } from '../bundle/types';

// ---------------------------------------------------------------------------
// Rephrase distance check — spec §5c
// For every drafted paragraph, compute cosine similarity between its text
// and the verbatim anchor quote. Allowed band: 0.40 ≤ similarity ≤ 0.85.
//   > 0.85 → too close to source, plagiarism risk → regenerate
//   < 0.40 → too far from source, LLM drifted → regenerate
//
// Uses @xenova/transformers (local, no API call) with the all-MiniLM-L6-v2
// model (~23MB, already a de facto standard for sentence embeddings).
// ---------------------------------------------------------------------------

// Ship without remote model downloads in production — we bundle the model
// locally so CI/CD and Vercel functions don't stall on first request.
env.allowLocalModels = true;

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const MIN_DISTANCE = 0.4;
const MAX_DISTANCE = 0.85;

type FeatureExtractor = Awaited<ReturnType<typeof pipeline<'feature-extraction'>>>;

let cachedPipeline: FeatureExtractor | null = null;

async function getEmbedder(): Promise<FeatureExtractor> {
  if (cachedPipeline) return cachedPipeline;
  cachedPipeline = await pipeline('feature-extraction', MODEL_NAME);
  return cachedPipeline;
}

/**
 * Embed a single string and return a pooled, normalized vector.
 */
async function embed(text: string): Promise<Float32Array> {
  const extractor = await getEmbedder();
  const output = (await extractor(text, { pooling: 'mean', normalize: true })) as {
    data: Float32Array;
  };
  return output.data;
}

/**
 * Cosine similarity of two normalized embeddings. Because both vectors are
 * already L2-normalized, this reduces to the dot product.
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`[rephrase-distance] vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += a[i] * b[i];
  }
  return sum;
}

export interface DistanceResult {
  paragraph_index: number;
  anchor_quote_id: string;
  similarity: number;
  in_band: boolean;
  reason: 'ok' | 'too_close' | 'too_far';
}

/**
 * Check every paragraph's rephrase distance against its anchor quote.
 * Returns one result per paragraph. Caller decides what to do with
 * out-of-band paragraphs (typically: regenerate just those paragraphs).
 */
export async function checkRephraseDistances(
  paragraphs: DraftedParagraph[],
  bundle: Bundle,
): Promise<DistanceResult[]> {
  // Build quote lookup
  const quoteText = new Map<string, string>();
  for (const source of bundle.sources) {
    for (const quote of source.quotes) {
      quoteText.set(quote.quote_id, quote.text);
    }
  }

  const results: DistanceResult[] = [];
  for (let i = 0; i < paragraphs.length; i += 1) {
    const para = paragraphs[i];
    const quote = quoteText.get(para.anchor_quote_id);
    if (!quote) {
      // Should never happen — paragraph-draft stage validates this. But we
      // surface it clearly if upstream ever drops the ball.
      throw new Error(
        `[rephrase-distance] paragraph ${i} references missing quote_id "${para.anchor_quote_id}"`,
      );
    }

    const [paraEmbed, quoteEmbed] = await Promise.all([embed(para.text), embed(quote)]);
    const similarity = cosineSimilarity(paraEmbed, quoteEmbed);

    let reason: DistanceResult['reason'] = 'ok';
    let inBand = true;
    if (similarity > MAX_DISTANCE) {
      reason = 'too_close';
      inBand = false;
    } else if (similarity < MIN_DISTANCE) {
      reason = 'too_far';
      inBand = false;
    }

    results.push({
      paragraph_index: i,
      anchor_quote_id: para.anchor_quote_id,
      similarity,
      in_band: inBand,
      reason,
    });
  }

  return results;
}

/**
 * Helper: partition paragraphs into in-band and out-of-band arrays.
 * Useful for the regenerate loop: feed the out-of-band set back to the
 * paragraph drafter with a "tighten/loosen" hint.
 */
export function partitionByDistance(
  paragraphs: DraftedParagraph[],
  results: DistanceResult[],
): { inBand: DraftedParagraph[]; outOfBand: Array<{ paragraph: DraftedParagraph; reason: DistanceResult['reason'] }> } {
  const inBand: DraftedParagraph[] = [];
  const outOfBand: Array<{ paragraph: DraftedParagraph; reason: DistanceResult['reason'] }> = [];
  results.forEach((result, idx) => {
    if (result.in_band) {
      inBand.push(paragraphs[idx]);
    } else {
      outOfBand.push({ paragraph: paragraphs[idx], reason: result.reason });
    }
  });
  return { inBand, outOfBand };
}
