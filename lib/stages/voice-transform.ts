import fs from 'node:fs';
import path from 'node:path';
import { callLLMStructured, MODELS } from '../llm/openrouter';
import type { DraftedParagraph } from './paragraph-draft';

// ---------------------------------------------------------------------------
// Voice transform stage — spec §5d
// LLM call #3. Takes the drafted paragraphs (factual, anchored, in-band)
// and rewrites them in VisQuanta's published voice using the exemplars as
// few-shot examples. Citations and facts are preserved; only the prose
// changes.
//
// Per spec §5, this is the highest-risk step of v1 because voice fidelity
// cannot be objectively scored. The only feedback loop is human taste,
// surfaced through the rejection log and fed back into voice/exemplars.md
// and voice/voice_prompt.md.
// ---------------------------------------------------------------------------

export interface TransformedParagraph {
  text: string;
  section_index: number;
  source_id: string;
  anchor_quote_id: string;
}

export interface TransformedParagraphs {
  paragraphs: TransformedParagraph[];
}

const TRANSFORM_SCHEMA = {
  type: 'object',
  required: ['paragraphs'],
  properties: {
    paragraphs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['text', 'section_index', 'source_id', 'anchor_quote_id'],
        properties: {
          text: { type: 'string', minLength: 50 },
          section_index: { type: 'integer', minimum: 0 },
          source_id: { type: 'string', pattern: '^src_\\d{3}$' },
          anchor_quote_id: { type: 'string', pattern: '^src_\\d{3}_q\\d+$' },
        },
      },
    },
  },
};

function loadVoiceSystemPrompt(): string {
  const promptPath = path.join(process.cwd(), 'config', 'voice', 'voice_prompt.md');
  const exemplarsPath = path.join(process.cwd(), 'config', 'voice', 'exemplars.md');

  const voicePrompt = fs.readFileSync(promptPath, 'utf-8');
  const exemplars = fs.readFileSync(exemplarsPath, 'utf-8');

  // Append exemplars to the system prompt so Claude gets the full few-shot
  // context in one block.
  return `${voicePrompt}\n\n---\n\n# Exemplars\n\n${exemplars}`;
}

/**
 * Rewrite drafted paragraphs in VisQuanta's voice. Preserves:
 *  - paragraph count and order
 *  - source_id, anchor_quote_id, section_index on every paragraph
 *
 * Changes:
 *  - the text prose only
 */
export async function voiceTransform(
  draftedParagraphs: DraftedParagraph[],
): Promise<TransformedParagraphs> {
  const system = loadVoiceSystemPrompt();

  const user = JSON.stringify(
    {
      paragraphs: draftedParagraphs,
    },
    null,
    2,
  );

  return await callLLMStructured<TransformedParagraphs>({
    system,
    user,
    schema: TRANSFORM_SCHEMA,
    model: MODELS.DRAFTER,
    maxTokens: 8192,
    parse: (raw: unknown): TransformedParagraphs => {
      if (!raw || typeof raw !== 'object') {
        throw new Error('[voice-transform] response was not an object');
      }
      const obj = raw as Record<string, unknown>;
      if (!Array.isArray(obj.paragraphs)) {
        throw new Error('[voice-transform] response missing paragraphs array');
      }
      if (obj.paragraphs.length !== draftedParagraphs.length) {
        throw new Error(
          `[voice-transform] paragraph count mismatch: in=${draftedParagraphs.length}, out=${obj.paragraphs.length}. Voice transform must preserve paragraph count.`,
        );
      }

      const paragraphs: TransformedParagraph[] = obj.paragraphs.map((p, idx) => {
        if (!p || typeof p !== 'object') {
          throw new Error(`[voice-transform] paragraph ${idx} is not an object`);
        }
        const para = p as Record<string, unknown>;
        const original = draftedParagraphs[idx];

        if (typeof para.text !== 'string' || para.text.trim().length < 50) {
          throw new Error(`[voice-transform] paragraph ${idx} text missing or too short`);
        }

        // Preserve source/anchor/section metadata — the transform stage is
        // not allowed to change attribution. If Claude returns different
        // metadata we reject and fall back to the original values.
        if (
          para.source_id !== original.source_id ||
          para.anchor_quote_id !== original.anchor_quote_id ||
          para.section_index !== original.section_index
        ) {
          throw new Error(
            `[voice-transform] paragraph ${idx} metadata drifted: ` +
              `source ${String(para.source_id)}!=${original.source_id}, ` +
              `quote ${String(para.anchor_quote_id)}!=${original.anchor_quote_id}, ` +
              `section ${String(para.section_index)}!=${original.section_index}`,
          );
        }

        return {
          text: para.text,
          section_index: original.section_index,
          source_id: original.source_id,
          anchor_quote_id: original.anchor_quote_id,
        };
      });

      return { paragraphs };
    },
  });
}

/**
 * Build a voice-transform system prompt on demand. Exposed mainly for
 * tests and for the voice-tuning workflow to inspect the prompt without
 * calling the LLM.
 */
export function buildVoiceSystemPrompt(): string {
  return loadVoiceSystemPrompt();
}
