import fs from 'node:fs';
import path from 'node:path';
import { callLLMStructured, MODELS } from '../llm/openrouter';
import type { Bundle } from '../bundle/types';
import type { Outline } from './outline';
import { buildRejectionFeedbackBlock } from './rejection-feedback';

// ---------------------------------------------------------------------------
// Paragraph drafting stage — spec §5c
// LLM call #2. Turns an outline into paragraphs, where every paragraph binds
// to exactly one source quote. Structural enforcement via schema + parse().
// ---------------------------------------------------------------------------

export interface DraftedParagraph {
  text: string;
  section_index: number;
  source_id: string;
  anchor_quote_id: string;
}

export interface DraftedParagraphs {
  paragraphs: DraftedParagraph[];
}

const PARAGRAPH_SCHEMA = {
  type: 'object',
  required: ['paragraphs'],
  properties: {
    paragraphs: {
      type: 'array',
      minItems: 8,
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

const MAX_DRAFT_ATTEMPTS = 3;

function loadSystemPrompt(): string {
  const promptPath = path.join(
    process.cwd(),
    'workflows',
    'blog-pipeline',
    'prompts',
    'paragraph-draft.md',
  );
  return fs.readFileSync(promptPath, 'utf-8');
}

/**
 * Build a Map<quote_id, {source_id, text}> for O(1) lookup during parsing.
 */
function indexBundleQuotes(bundle: Bundle): Map<string, { source_id: string; text: string }> {
  const index = new Map<string, { source_id: string; text: string }>();
  for (const source of bundle.sources) {
    for (const quote of source.quotes) {
      index.set(quote.quote_id, { source_id: source.source_id, text: quote.text });
    }
  }
  return index;
}

/**
 * Build a Map<section_index, Set<allowed_quote_ids>> enforcing rule 2:
 * a paragraph in section N can only use quote_ids from that section's
 * anchor_quotes.
 */
function indexSectionAnchors(outline: Outline): Map<number, Set<string>> {
  const index = new Map<number, Set<string>>();
  outline.sections.forEach((section, i) => {
    index.set(i, new Set(section.anchor_quotes));
  });
  return index;
}

function buildSectionQuoteContract(outline: Outline, bundle: Bundle): Array<{
  section_index: number;
  heading: string;
  allowed_quotes: Array<{ quote_id: string; source_id: string; text: string }>;
}> {
  const quoteIndex = indexBundleQuotes(bundle);
  return outline.sections.map((section, sectionIndex) => ({
    section_index: sectionIndex,
    heading: section.heading,
    allowed_quotes: section.anchor_quotes.map((quoteId) => {
      const quote = quoteIndex.get(quoteId);
      return {
        quote_id: quoteId,
        source_id: quote?.source_id ?? '',
        text: quote?.text ?? '',
      };
    }),
  }));
}

/**
 * Draft paragraphs for the outline. Every paragraph is required to:
 *  - bind to a quote_id that exists in the bundle,
 *  - use a quote_id from its section's approved anchor set,
 *  - have consistent source_id matching the quote's owning source.
 *
 * Parser throws immediately on violation so callers can retry or block.
 */
export async function draftParagraphs(
  outline: Outline,
  bundle: Bundle,
  wordCount: { min: number; max: number },
): Promise<DraftedParagraphs> {
  const baseSystem = loadSystemPrompt();
  const feedback = await buildRejectionFeedbackBlock();
  const system = feedback ? `${baseSystem}\n${feedback}` : baseSystem;
  const quoteIndex = indexBundleQuotes(bundle);
  const sectionAnchors = indexSectionAnchors(outline);

  function buildUser(previousError?: string): string {
    return JSON.stringify(
      {
        outline,
        section_quote_contract: buildSectionQuoteContract(outline, bundle),
        bundle,
        lane: bundle.lane,
        word_count: wordCount,
        ...(previousError
          ? {
              repair_instruction:
                `The previous draft was rejected: ${previousError}. Return a COMPLETE replacement paragraphs array. Every paragraph in section N must use only quote_ids from section_quote_contract[N].allowed_quotes.`,
            }
          : {}),
      },
      null,
      2,
    );
  }

  function parseDraft(raw: unknown): DraftedParagraphs {
      if (!raw || typeof raw !== 'object') {
        throw new Error('[paragraph-draft] response was not an object');
      }
      const obj = raw as Record<string, unknown>;
      if (!Array.isArray(obj.paragraphs) || obj.paragraphs.length === 0) {
        throw new Error('[paragraph-draft] response missing paragraphs array');
      }

      const paragraphs: DraftedParagraph[] = obj.paragraphs.map((p, idx) => {
        if (!p || typeof p !== 'object') {
          throw new Error(`[paragraph-draft] paragraph ${idx} is not an object`);
        }
        const para = p as Record<string, unknown>;

        if (typeof para.text !== 'string' || para.text.trim().length < 50) {
          throw new Error(`[paragraph-draft] paragraph ${idx} text missing or too short`);
        }
        if (typeof para.section_index !== 'number' || !Number.isInteger(para.section_index)) {
          throw new Error(`[paragraph-draft] paragraph ${idx} section_index invalid`);
        }
        const sectionIdx = para.section_index;
        if (sectionIdx < 0 || sectionIdx >= outline.sections.length) {
          throw new Error(
            `[paragraph-draft] paragraph ${idx} section_index ${sectionIdx} out of bounds (outline has ${outline.sections.length} sections)`,
          );
        }

        if (typeof para.anchor_quote_id !== 'string') {
          throw new Error(`[paragraph-draft] paragraph ${idx} missing anchor_quote_id`);
        }
        const anchorId = para.anchor_quote_id;
        const quoteInfo = quoteIndex.get(anchorId);
        if (!quoteInfo) {
          throw new Error(
            `[paragraph-draft] paragraph ${idx} references hallucinated quote_id "${anchorId}" — not in bundle`,
          );
        }

        // Rule 2: paragraph in section N must use a quote_id from that
        // section's anchor_quotes set.
        const allowed = sectionAnchors.get(sectionIdx);
        if (!allowed || !allowed.has(anchorId)) {
          throw new Error(
            `[paragraph-draft] paragraph ${idx} in section ${sectionIdx} uses quote_id "${anchorId}" which is not in that section's anchor_quotes`,
          );
        }

        if (typeof para.source_id !== 'string') {
          throw new Error(`[paragraph-draft] paragraph ${idx} missing source_id`);
        }
        if (para.source_id !== quoteInfo.source_id) {
          throw new Error(
            `[paragraph-draft] paragraph ${idx} source_id "${para.source_id}" does not match the anchor quote's source (${quoteInfo.source_id})`,
          );
        }

        return {
          text: para.text,
          section_index: sectionIdx,
          source_id: para.source_id,
          anchor_quote_id: anchorId,
        };
      });

      return { paragraphs };
  }

  let previousError: string | undefined;
  for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt += 1) {
    try {
      return await callLLMStructured<DraftedParagraphs>({
        system:
          attempt === 1
            ? system
            : `${system}\n\n## Repair mode\n\nYour previous output failed structural validation. Fix the exact issue described in the user message. Do not change the schema. Do not return partial output.`,
        user: buildUser(previousError),
        schema: PARAGRAPH_SCHEMA,
        model: MODELS.DRAFTER,
        maxTokens: 8192,
        parse: parseDraft,
      });
    } catch (err) {
      previousError = err instanceof Error ? err.message : String(err);
      if (attempt === MAX_DRAFT_ATTEMPTS) {
        throw err;
      }
      console.warn(`[paragraph-draft] attempt ${attempt} rejected: ${previousError}`);
    }
  }

  throw new Error('[paragraph-draft] exhausted draft attempts');
}
