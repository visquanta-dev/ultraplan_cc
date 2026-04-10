import fs from 'node:fs';
import path from 'node:path';
import { callLLMStructured, MODELS } from '../llm/openrouter';
import type { Bundle } from '../bundle/types';
import { buildRejectionFeedbackBlock } from './rejection-feedback';

// ---------------------------------------------------------------------------
// Outline stage — spec §5b
// LLM call #1 of the drafting pipeline. Produces a JSON outline where every
// section has a non-empty anchor_quotes array (enforced by schema + parse()).
// ---------------------------------------------------------------------------

export interface OutlineSection {
  /**
   * Section heading as it will appear in the finished post (# Markdown level
   * chosen later by the paragraph drafter).
   */
  heading: string;

  /**
   * Non-empty array of quote_ids from the bundle. Every section must anchor
   * to at least one quote. If this array is empty the parser throws.
   */
  anchor_quotes: string[];

  /**
   * Verb phrase describing what the section does — "establish problem with
   * stat", "refute common objection", "introduce formula", etc.
   */
  intent: string;
}

export interface Outline {
  /**
   * The post headline. Should be specific and promise a concrete insight,
   * not a generic "The Future of X" hook.
   */
  headline: string;

  /**
   * Same lane value as the input bundle.
   */
  lane: Bundle['lane'];

  /**
   * 4–8 sections depending on lane. Each section has required anchor_quotes.
   */
  sections: OutlineSection[];
}

const OUTLINE_SCHEMA = {
  type: 'object',
  required: ['headline', 'lane', 'sections'],
  properties: {
    headline: { type: 'string', description: 'Specific, insight-promising headline' },
    lane: { type: 'string', enum: ['daily_seo', 'weekly_authority', 'monthly_anonymized_case'] },
    sections: {
      type: 'array',
      minItems: 4,
      maxItems: 8,
      items: {
        type: 'object',
        required: ['heading', 'anchor_quotes', 'intent'],
        properties: {
          heading: { type: 'string' },
          anchor_quotes: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', pattern: '^src_\\d{3}_q\\d+$' },
          },
          intent: { type: 'string' },
        },
      },
    },
  },
};

function loadSystemPrompt(): string {
  const promptPath = path.join(
    process.cwd(),
    'workflows',
    'blog-pipeline',
    'prompts',
    'outline.md',
  );
  return fs.readFileSync(promptPath, 'utf-8');
}

function collectBundleQuoteIds(bundle: Bundle): Set<string> {
  const ids = new Set<string>();
  for (const source of bundle.sources) {
    for (const quote of source.quotes) {
      ids.add(quote.quote_id);
    }
  }
  return ids;
}

/**
 * Generate a structured outline from a research bundle. Every section will
 * have at least one anchor_quote. Every anchor_quote_id will exist in the
 * input bundle — hallucinated quote_ids cause the parser to throw.
 */
export async function generateOutline(
  bundle: Bundle,
  wordCount: { min: number; max: number },
): Promise<Outline> {
  const validQuoteIds = collectBundleQuoteIds(bundle);
  const baseSystem = loadSystemPrompt();
  const feedback = await buildRejectionFeedbackBlock();
  const system = feedback ? `${baseSystem}\n${feedback}` : baseSystem;
  const user = JSON.stringify(
    {
      bundle,
      lane: bundle.lane,
      word_count: wordCount,
    },
    null,
    2,
  );

  return await callLLMStructured<Outline>({
    system,
    user,
    schema: OUTLINE_SCHEMA,
    model: MODELS.DRAFTER,
    maxTokens: 4096,
    parse: (raw: unknown): Outline => {
      if (!raw || typeof raw !== 'object') {
        throw new Error('[outline] response was not an object');
      }
      const obj = raw as Record<string, unknown>;

      if (typeof obj.headline !== 'string' || !obj.headline.trim()) {
        throw new Error('[outline] missing or empty headline');
      }
      if (obj.lane !== bundle.lane) {
        throw new Error(`[outline] lane mismatch: expected ${bundle.lane}, got ${String(obj.lane)}`);
      }
      if (!Array.isArray(obj.sections) || obj.sections.length < 4 || obj.sections.length > 8) {
        throw new Error('[outline] sections must be an array of 4-8 items');
      }

      const sections: OutlineSection[] = obj.sections.map((s, idx) => {
        if (!s || typeof s !== 'object') {
          throw new Error(`[outline] section ${idx} is not an object`);
        }
        const sec = s as Record<string, unknown>;

        if (typeof sec.heading !== 'string' || !sec.heading.trim()) {
          throw new Error(`[outline] section ${idx} missing heading`);
        }
        if (typeof sec.intent !== 'string' || !sec.intent.trim()) {
          throw new Error(`[outline] section ${idx} missing intent`);
        }
        if (!Array.isArray(sec.anchor_quotes) || sec.anchor_quotes.length === 0) {
          throw new Error(
            `[outline] section ${idx} ("${sec.heading}") has empty anchor_quotes — every section MUST anchor to at least one quote`,
          );
        }

        const anchorIds: string[] = sec.anchor_quotes.map((q, qi) => {
          if (typeof q !== 'string') {
            throw new Error(`[outline] section ${idx} anchor_quote ${qi} is not a string`);
          }
          if (!validQuoteIds.has(q)) {
            throw new Error(
              `[outline] section ${idx} ("${sec.heading}") references hallucinated quote_id "${q}" — not found in bundle`,
            );
          }
          return q;
        });

        return {
          heading: sec.heading,
          anchor_quotes: anchorIds,
          intent: sec.intent,
        };
      });

      return {
        headline: obj.headline,
        lane: bundle.lane,
        sections,
      };
    },
  });
}
