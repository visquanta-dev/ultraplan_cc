import { callLLMStructured } from '../llm/openrouter';
import type { Bundle } from '../bundle/types';
import fs from 'node:fs';
import path from 'node:path';

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

interface EnrichResult {
  tldr: string;
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
  const promptTemplate = fs.readFileSync(ENRICH_PROMPT_PATH, 'utf-8');

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
        description: 'A 2-3 sentence TL;DR summary with the key stat and takeaway',
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
    },
    required: ['tldr', 'tables', 'faqs'],
  };

  const result = await callLLMStructured<EnrichResult>({
    system: promptTemplate,
    user: userPrompt,
    schema,
    parse: (raw) => {
      const obj = raw as Record<string, unknown>;
      return {
        tldr: String(obj.tldr ?? ''),
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
 * Render TL;DR box.
 */
export function renderTLDR(tldr: string): string {
  return [
    '',
    `**TL;DR:** ${tldr}`,
    '',
  ].join('\n');
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
