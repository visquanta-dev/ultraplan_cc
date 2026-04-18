import { callLLMStructured } from '../llm/openrouter';
import type { Bundle } from '../bundle/types';
import fs from 'node:fs';
import path from 'node:path';
import {
  renderAllowedEntitiesMarkdown,
  filterToAllowed,
  type TopicalEntity,
} from '../entities';

// ---------------------------------------------------------------------------
// Content enrichment — adds tables, TL;DR, and FAQ to drafted posts
// Runs AFTER auto-linking, BEFORE final markdown render.
// ---------------------------------------------------------------------------

const ENRICH_PROMPT_PATH = path.join(
  process.cwd(),
  'workflows',
  'blog-pipeline',
  'prompts',
  'enrich-content.md',
);

export interface EnrichBottomLine {
  synthesis: string;
  what_this_means: string[];
  closer: string;
}

export interface EnrichResult {
  tldr: string;
  key_takeaways: string[];
  bottom_line: EnrichBottomLine;
  entities: TopicalEntity[];
  tables: Array<{
    title: string;
    insert_after_heading: string;
    headers: string[];
    rows: string[][];
  }>;
  faqs: Array<{
    question: string;
    answer: string;
  }>;
}

/**
 * Generate TL;DR, data tables, and FAQ from the article content + sources.
 */
export async function enrichContent(
  articleMarkdown: string,
  bundle: Bundle,
  headline: string,
): Promise<EnrichResult> {
  const promptTemplate = fs
    .readFileSync(ENRICH_PROMPT_PATH, 'utf-8')
    .replace('{{ALLOWED_ENTITIES}}', renderAllowedEntitiesMarkdown());

  const sourceList = bundle.sources
    .map((s) => `- ${s.domain}: "${s.title ?? s.url}" (${s.quotes.length} quotes)`)
    .join('\n');

  const userPrompt = [
    `## Article Headline`,
    headline,
    '',
    `## Article Content`,
    articleMarkdown.slice(0, 6000),
    '',
    `## Source Summary`,
    sourceList,
  ].join('\n');

  const schema = {
    type: 'object',
    properties: {
      tldr: {
        type: 'string',
        description: 'A 2-3 sentence Key Takeaway highlight paragraph (rendered as a blockquote at the top of the post)',
      },
      key_takeaways: {
        type: 'array',
        items: { type: 'string' },
        minItems: 4,
        maxItems: 6,
        description: 'Above-the-fold bullet list — 4-6 self-contained, specific, outcome-framed takeaways for LLM extraction',
      },
      bottom_line: {
        type: 'object',
        description: 'Closing synthesis section inserted between the last body section and the FAQ',
        properties: {
          synthesis: {
            type: 'string',
            description: '1-2 sentence synthesis of the core argument',
          },
          what_this_means: {
            type: 'array',
            items: { type: 'string' },
            minItems: 3,
            maxItems: 5,
            description: '3-5 short bullet takeaways under "What this means for dealerships in 2026:"',
          },
          closer: {
            type: 'string',
            description: 'One directional closing sentence (not a sales pitch)',
          },
        },
        required: ['synthesis', 'what_this_means', 'closer'],
      },
      tables: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            insert_after_heading: {
              type: 'string',
              description: 'The H2 heading this table should appear after',
            },
            headers: { type: 'array', items: { type: 'string' } },
            rows: {
              type: 'array',
              items: { type: 'array', items: { type: 'string' } },
            },
          },
          required: ['title', 'insert_after_heading', 'headers', 'rows'],
        },
        minItems: 2,
        maxItems: 4,
      },
      faqs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            answer: { type: 'string' },
          },
          required: ['question', 'answer'],
        },
        minItems: 4,
        maxItems: 6,
      },
      entities: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            sameAs: { type: 'string' },
          },
          required: ['name', 'sameAs'],
        },
        minItems: 2,
        maxItems: 3,
        description: '2-3 topical entities picked from the allow-list in the system prompt',
      },
    },
    required: ['tldr', 'key_takeaways', 'bottom_line', 'tables', 'faqs', 'entities'],
  };

  const result = await callLLMStructured<EnrichResult>({
    system: promptTemplate,
    user: userPrompt,
    schema,
    parse: (raw) => {
      const obj = raw as Record<string, unknown>;
      const bl = (obj.bottom_line ?? {}) as Record<string, unknown>;
      const emittedEntities = Array.isArray(obj.entities)
        ? (obj.entities as Array<{ name?: unknown; sameAs?: unknown }>)
        : [];
      return {
        tldr: String(obj.tldr ?? ''),
        key_takeaways: Array.isArray(obj.key_takeaways)
          ? obj.key_takeaways.map((x) => String(x))
          : [],
        bottom_line: {
          synthesis: String(bl.synthesis ?? ''),
          what_this_means: Array.isArray(bl.what_this_means)
            ? bl.what_this_means.map((x) => String(x))
            : [],
          closer: String(bl.closer ?? ''),
        },
        // Silently drop any entity whose sameAs URL isn't in the allow-list;
        // the LLM occasionally emits plausible-but-nonexistent Wikipedia URLs.
        entities: filterToAllowed(emittedEntities),
        tables: Array.isArray(obj.tables) ? obj.tables : [],
        faqs: Array.isArray(obj.faqs) ? obj.faqs : [],
      };
    },
  });

  return result;
}

/**
 * Render a markdown table from headers and rows.
 */
export function renderTable(
  title: string,
  headers: string[],
  rows: string[][],
): string {
  const headerRow = '| ' + headers.join(' | ') + ' |';
  const separator = '| ' + headers.map(() => '---').join(' | ') + ' |';
  const bodyRows = rows.map((r) => '| ' + r.join(' | ') + ' |').join('\n');

  return [
    '',
    `### ${title}`,
    '',
    headerRow,
    separator,
    bodyRows,
    '',
  ].join('\n');
}

/**
 * Render FAQ section in markdown.
 */
export function renderFAQ(
  faqs: Array<{ question: string; answer: string }>,
): string {
  const items = faqs
    .map((faq) => [
      `### ${faq.question}`,
      '',
      faq.answer,
      '',
    ].join('\n'))
    .join('\n');

  return [
    '',
    '## Frequently Asked Questions',
    '',
    items,
  ].join('\n');
}

/**
 * Render the top-of-post blockquote. Renamed from "The Bottom Line" to
 * "Key Takeaway" so it doesn't collide with the closing bottom-line synthesis
 * section — two things named "Bottom Line" on one page confuses both humans
 * and crawlers. The site renders this via a selector that catches both labels
 * for SpeakableSpecification.
 */
export function renderTLDR(tldr: string): string {
  return [
    '',
    `> **Key Takeaway:** ${tldr}`,
    '',
  ].join('\n');
}

/**
 * Render the "Key Takeaways" bullet block that sits near the top of the post,
 * under the direct-answer paragraph and above the Key Takeaway blockquote.
 * This is the single highest-value element for LLM answer-surface citation.
 */
export function renderKeyTakeaways(bullets: string[]): string {
  if (!bullets.length) return '';
  return [
    '',
    '### Key Takeaways',
    '',
    ...bullets.map((b) => `- ${b}`),
    '',
  ].join('\n');
}

/**
 * Render a punchier closing for the listicle lane — one concrete action step,
 * not a three-paragraph synthesis. Replaces the Bottom Line section for
 * numbered/roundup posts where a reader needs "what do I do Monday morning"
 * rather than "here's what we just covered." Uses the drafter's `closer`
 * field only; synthesis + what_this_means bullets are dropped for this lane.
 */
export function renderMondayDirective(closer: string): string {
  if (!closer.trim()) return '';
  return [
    '',
    '## Monday Morning Directive',
    '',
    closer,
    '',
  ].join('\n');
}

/**
 * Render the closing Bottom Line synthesis section inserted between the last
 * body section and the FAQ. LLMs extract the final section of a post
 * aggressively (second only to the opener) — this is the citation slot on the
 * closing side of the article.
 */
export function renderBottomLine(bl: EnrichBottomLine): string {
  const hasContent = bl.synthesis || bl.what_this_means.length || bl.closer;
  if (!hasContent) return '';
  const bullets = bl.what_this_means.map((b) => `- ${b}`).join('\n');
  return [
    '',
    '## The Bottom Line',
    '',
    bl.synthesis,
    '',
    '**What this means for dealerships in 2026:**',
    '',
    bullets,
    '',
    bl.closer,
    '',
  ].join('\n');
}

/**
 * Render FAQPage JSON-LD schema from FAQ items.
 * Embedded as a <script> tag in the markdown so the main site renders it.
 */
export function renderFAQSchema(
  faqs: Array<{ question: string; answer: string }>,
): string {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: faq.answer,
      },
    })),
  };

  return `\n<script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n</script>\n`;
}

/**
 * Insert tables into article markdown at the correct positions.
 */
export function insertTables(
  bodyParts: string[],
  tables: EnrichResult['tables'],
  sectionHeadings: string[],
): string[] {
  const result = [...bodyParts];

  // For each table, find the section it belongs after and insert
  for (const table of tables) {
    const heading = table.insert_after_heading.toLowerCase();
    let insertIdx = -1;

    for (let i = 0; i < result.length; i++) {
      if (result[i].startsWith('## ') && result[i].toLowerCase().includes(heading.slice(0, 20))) {
        // Insert after the next paragraph block (i+1 is the content)
        insertIdx = i + 2;
        break;
      }
    }

    if (insertIdx === -1) {
      // Fallback: insert after the second section
      insertIdx = Math.min(4, result.length);
    }

    const tableMarkdown = renderTable(table.title, table.headers, table.rows);
    result.splice(insertIdx, 0, tableMarkdown);
  }

  return result;
}
