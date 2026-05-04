import fs from 'node:fs';
import path from 'node:path';
import { callLLMStructured, MODELS } from '../llm/openrouter';
import type { Bundle } from '../bundle/types';
import { validateChartSpec, type ChartSpec } from '../image/chart-renderer';
import { buildRejectionFeedbackBlock } from './rejection-feedback';

// ---------------------------------------------------------------------------
// Outline stage — spec §5b
// LLM call #1 of the drafting pipeline. Produces a JSON outline where every
// section has a non-empty anchor_quotes array (enforced by schema + parse()).
// ---------------------------------------------------------------------------

export interface OutlineSection {
  heading: string;
  anchor_quotes: string[];
  intent: string;
  /** H3 subsection headings within this section (2-3 per section for SEO depth) */
  subsections?: string[];
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

  /**
   * Optional stat-hero chart spec. Emit only when the post has a single
   * central statistic that defines the angle (e.g. "48%" framing). The
   * pipeline renders this as a PNG hero (listing card + inline body) and
   * skips the metaphor image path. Malformed specs hard-fail the outline.
   */
  chart?: ChartSpec;
}

const OUTLINE_SCHEMA = {
  type: 'object',
  required: ['headline', 'lane', 'sections'],
  properties: {
    headline: { type: 'string', description: 'Specific, insight-promising headline' },
    lane: { type: 'string', enum: ['daily_seo', 'weekly_authority', 'monthly_anonymized_case', 'listicle'] },
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
          subsections: {
            type: 'array',
            items: { type: 'string' },
            description: 'H3 subsection headings for SEO depth (2-3 per section)',
          },
        },
      },
    },
    chart: {
      type: 'object',
      description: 'Optional stat-hero chart. Only include when a single central statistic defines the post angle.',
      required: ['type', 'headline', 'data'],
      properties: {
        type: { type: 'string', enum: ['bar', 'delta', 'trendline'] },
        headline: { type: 'string', description: 'Short label shown alongside the chart' },
        data: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['label', 'value'],
            properties: {
              label: { type: 'string' },
              value: { type: 'number' },
              valueLabel: { type: 'string', description: 'Optional display override like "48%" or "$1.5M"' },
            },
          },
        },
        source: { type: 'string', description: 'Primary source citation (e.g. "Cox Automotive")' },
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

        const subsections = Array.isArray(sec.subsections)
          ? sec.subsections
              .filter((h): h is string => typeof h === 'string' && h.trim().length > 0)
              .map((h) => h.trim())
              .slice(0, 3)
          : [];

        return {
          heading: sec.heading,
          anchor_quotes: anchorIds,
          intent: sec.intent,
          ...(subsections.length > 0 ? { subsections } : {}),
        };
      });

      // Optional stat-hero chart. Validation is strict — a malformed chart
      // spec hard-fails the outline stage rather than degrading to a metaphor
      // image. This is the chart-feature contract: if the drafter claims the
      // post has a central stat, it has to deliver well-formed data.
      let chart: ChartSpec | undefined;
      if (obj.chart !== undefined && obj.chart !== null) {
        try {
          chart = validateChartSpec(obj.chart);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`[outline] chart spec rejected: ${msg}`);
        }
      }

      return {
        headline: obj.headline,
        lane: bundle.lane,
        sections,
        ...(chart ? { chart } : {}),
      };
    },
  });
}
