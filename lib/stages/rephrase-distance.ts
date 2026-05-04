import type { DraftedParagraph } from './paragraph-draft';
import type { Bundle } from '../bundle/types';

// ---------------------------------------------------------------------------
// Rephrase distance check — spec §5c
// For every drafted paragraph, compute cosine similarity between its text
// and the verbatim anchor quote. Allowed band: MIN ≤ similarity ≤ MAX.
//   > MAX → too close to source, plagiarism risk → regenerate
//   < MIN → too far from source, LLM drifted → regenerate
//
// Uses Voyage AI's voyage-3-large model via HTTPS (no native deps, works
// on Vercel Lambda). Previously used @xenova/transformers with a local
// MiniLM model, but that required libonnxruntime.so which isn't available
// in Vercel's Lambda runtime — crashes the pipeline at module load.
// ---------------------------------------------------------------------------

const MODEL_NAME = 'voyage-3-large';
// Spec band: too far from the quote is likely drift; too close is likely
// source-copying.
const MIN_DISTANCE = 0.40;
const MAX_DISTANCE = 0.85;

async function voyageEmbed(texts: string[]): Promise<Float32Array[]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error('[rephrase-distance] VOYAGE_API_KEY not set');
  }
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL_NAME,
      input: texts,
      input_type: 'document',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[rephrase-distance] Voyage API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return data.data.map((d) => new Float32Array(d.embedding));
}

/**
 * Cosine similarity of two vectors. Voyage embeddings are not guaranteed
 * to be L2-normalized, so we normalize in the denominator.
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`[rephrase-distance] vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
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
 * Batches all paragraphs + quotes into a single Voyage API call for
 * efficiency (one request instead of 2 per paragraph).
 */
export async function checkRephraseDistances(
  paragraphs: DraftedParagraph[],
  bundle: Bundle,
): Promise<DistanceResult[]> {
  const quoteText = new Map<string, string>();
  for (const source of bundle.sources) {
    for (const quote of source.quotes) {
      quoteText.set(quote.quote_id, quote.text);
    }
  }

  // Build the flat input array: [para_0, quote_0, para_1, quote_1, ...]
  const batch: string[] = [];
  for (let i = 0; i < paragraphs.length; i += 1) {
    const para = paragraphs[i];
    const quote = quoteText.get(para.anchor_quote_id);
    if (!quote) {
      throw new Error(
        `[rephrase-distance] paragraph ${i} references missing quote_id "${para.anchor_quote_id}"`,
      );
    }
    batch.push(para.text, quote);
  }

  if (batch.length === 0) return [];

  const embeddings = await voyageEmbed(batch);

  const results: DistanceResult[] = [];
  for (let i = 0; i < paragraphs.length; i += 1) {
    const paraEmbed = embeddings[i * 2];
    const quoteEmbed = embeddings[i * 2 + 1];
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
      anchor_quote_id: paragraphs[i].anchor_quote_id,
      similarity,
      in_band: inBand,
      reason,
    });
  }

  console.log(
    `[rephrase-distance] checked ${paragraphs.length} paragraphs, ` +
      `similarities: ${results.map((r) => r.similarity.toFixed(2)).join(', ')}`,
  );

  return results;
}

/**
 * Helper: partition paragraphs into in-band and out-of-band arrays.
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
