import Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// Claude Opus 4.6 client — spec §2 principle 5 "best model at every step"
// Thin wrapper around the Anthropic SDK with a structured-output helper that
// (a) injects the JSON schema into the system prompt,
// (b) parses the response as JSON,
// (c) retries once on parse failure with a stricter reminder.
//
// All three drafting sub-stages (outline, paragraph draft, voice transform)
// use this module. One import, one client, one cost-tracking hook.
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = 'claude-opus-4-6';
const DEFAULT_MAX_TOKENS = 8192;

let cachedClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('[claude] ANTHROPIC_API_KEY is not set. Add it to .env.local.');
  }
  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

export interface ClaudeStructuredOptions<T> {
  /**
   * System prompt. Appended with a JSON-schema reminder automatically.
   */
  system: string;

  /**
   * User message. Usually the actual content (bundle, paragraphs to
   * transform, etc.) serialized as JSON or text.
   */
  user: string;

  /**
   * JSON schema as a plain object. Used to instruct Claude on the exact
   * output shape. Not runtime-validated — the parse() callback is
   * responsible for validation if strict shape matters.
   */
  schema: Record<string, unknown>;

  /**
   * Parser callback — receives the parsed JSON and must return the
   * typed value or throw if the shape is wrong.
   */
  parse: (raw: unknown) => T;

  /**
   * Override the default Claude model. Almost never needed — spec §9
   * pins claude-opus-4-6 for drafting.
   */
  model?: string;

  /**
   * Override max tokens. Default 8192 is enough for most outline/paragraph
   * responses.
   */
  maxTokens?: number;
}

/**
 * Call Claude with a structured-output contract. Returns the parsed,
 * typed result.
 *
 * Retries once on JSON parse failure with a stricter reminder appended
 * to the system prompt. Never retries more than once — persistent
 * failures should surface so the caller (or the gate system) can
 * decide whether to regenerate or block.
 */
export async function callClaudeStructured<T>(
  opts: ClaudeStructuredOptions<T>,
): Promise<T> {
  const client = getClient();
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  const schemaHint = `\n\n## Output contract\n\nReturn JSON matching this schema exactly. Do not include any text outside the JSON object.\n\n${JSON.stringify(opts.schema, null, 2)}`;

  async function attempt(systemSuffix = ''): Promise<T> {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: opts.system + schemaHint + systemSuffix,
      messages: [{ role: 'user', content: opts.user }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('[claude] no text block in response');
    }

    const text = textBlock.text.trim();

    // Strip markdown code fences if Claude wrapped the JSON in them.
    const unwrapped = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(unwrapped);
    } catch (err) {
      throw new Error(
        `[claude] response was not valid JSON: ${err instanceof Error ? err.message : String(err)}\n\nRaw response:\n${text.slice(0, 500)}`,
      );
    }

    return opts.parse(parsed);
  }

  try {
    return await attempt();
  } catch (err) {
    if (err instanceof Error && err.message.includes('not valid JSON')) {
      // Retry once with a stricter reminder
      return await attempt(
        '\n\nCRITICAL: Your last response was not valid JSON. Return ONLY the JSON object. No prose, no markdown, no code fences. Just the raw JSON.',
      );
    }
    throw err;
  }
}

/**
 * Simple non-structured call for cases where we just want prose back.
 * Kept for future flexibility — Phase 1 drafting always uses structured.
 */
export async function callClaudeText(system: string, user: string): Promise<string> {
  const client = getClient();
  const response = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: DEFAULT_MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('[claude] no text block in response');
  }
  return textBlock.text;
}
