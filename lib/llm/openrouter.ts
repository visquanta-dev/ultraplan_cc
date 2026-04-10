// ---------------------------------------------------------------------------
// OpenRouter LLM client — unified provider access per spec §2 principle 5
// "best model at every step, no cost trade-offs"
//
// OpenRouter exposes an OpenAI-compatible /chat/completions endpoint that
// fronts every major model (Claude, GPT, Gemini, DeepSeek, etc.) via a
// single API key. We use it as the default provider so different pipeline
// stages can call different models without juggling SDKs.
//
// Model IDs (spec §9):
//   drafter: anthropic/claude-opus-4-6        (outline, paragraph, voice)
//   judge:   openai/gpt-5                     (fact recheck, originality — Phase 2)
//   image:   google/gemini-2.5-flash-image
//
// Docs: https://openrouter.ai/docs/api-reference/chat-completion
// ---------------------------------------------------------------------------

const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_DRAFTER_MODEL = 'anthropic/claude-opus-4-6';
const DEFAULT_MAX_TOKENS = 8192;

interface OpenRouterChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenRouterChatChoice {
  message: { role: string; content: string };
  finish_reason: string;
  index: number;
}

interface OpenRouterChatResponse {
  id: string;
  model: string;
  choices: OpenRouterChatChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  error?: { message: string; code?: string };
}

export interface LLMStructuredOptions<T> {
  /**
   * System prompt. Appended with a JSON-schema reminder automatically.
   */
  system: string;

  /**
   * User message content (the actual data to transform).
   */
  user: string;

  /**
   * JSON schema as a plain object. Injected into the system prompt to
   * instruct the model on exact output shape.
   */
  schema: Record<string, unknown>;

  /**
   * Parser callback — validates the parsed JSON shape and returns typed
   * value. Throws on shape violation so the caller can retry or block.
   */
  parse: (raw: unknown) => T;

  /**
   * Model slug on OpenRouter. Defaults to anthropic/claude-opus-4-6.
   * See https://openrouter.ai/models for the full catalog.
   */
  model?: string;

  /**
   * Override max tokens. Default 8192.
   */
  maxTokens?: number;

  /**
   * Optional temperature. Default 0.7.
   */
  temperature?: number;
}

let apiKeyCache: string | null = null;

function getApiKey(): string {
  if (apiKeyCache) return apiKeyCache;
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error('[openrouter] OPENROUTER_API_KEY is not set. Add it to .env.local.');
  }
  apiKeyCache = key;
  return key;
}

/**
 * Call any model on OpenRouter with a structured-output contract. Retries
 * once on JSON parse failure with a stricter reminder.
 */
export async function callLLMStructured<T>(opts: LLMStructuredOptions<T>): Promise<T> {
  const apiKey = getApiKey();
  const model = opts.model ?? DEFAULT_DRAFTER_MODEL;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = opts.temperature ?? 0.7;

  const schemaHint = `\n\n## Output contract\n\nReturn JSON matching this schema exactly. Do not include any text outside the JSON object.\n\n${JSON.stringify(opts.schema, null, 2)}`;

  async function attempt(systemSuffix = ''): Promise<T> {
    const messages: OpenRouterChatMessage[] = [
      { role: 'system', content: opts.system + schemaHint + systemSuffix },
      { role: 'user', content: opts.user },
    ];

    const response = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Optional but recommended by OpenRouter docs so usage shows up in
        // the project dashboard and rate limits are per-app not per-key.
        'HTTP-Referer': 'https://ultraplan-cc.vercel.app',
        'X-Title': 'UltraPlan',
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `[openrouter] ${model} returned ${response.status} ${response.statusText}: ${text}`,
      );
    }

    const body = (await response.json()) as OpenRouterChatResponse;
    if (body.error) {
      throw new Error(`[openrouter] ${model} error: ${body.error.message}`);
    }
    if (!body.choices || body.choices.length === 0) {
      throw new Error(`[openrouter] ${model} returned no choices`);
    }

    const content = body.choices[0].message.content.trim();
    const unwrapped = content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(unwrapped);
    } catch (err) {
      throw new Error(
        `[openrouter] ${model} response was not valid JSON: ${err instanceof Error ? err.message : String(err)}\n\nRaw response:\n${content.slice(0, 500)}`,
      );
    }

    return opts.parse(parsed);
  }

  try {
    return await attempt();
  } catch (err) {
    if (err instanceof Error && err.message.includes('not valid JSON')) {
      return await attempt(
        '\n\nCRITICAL: Your last response was not valid JSON. Return ONLY the JSON object. No prose, no markdown, no code fences. Just the raw JSON.',
      );
    }
    throw err;
  }
}

/**
 * Non-structured text call. Phase 1 drafting always uses structured — this
 * is an escape hatch for future cases (debugging, one-off prompts).
 */
export async function callLLMText(
  system: string,
  user: string,
  options: { model?: string; maxTokens?: number; temperature?: number } = {},
): Promise<string> {
  const apiKey = getApiKey();
  const model = options.model ?? DEFAULT_DRAFTER_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  const response = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://ultraplan-cc.vercel.app',
      'X-Title': 'UltraPlan',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      temperature: options.temperature ?? 0.7,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`[openrouter] text call failed: ${response.status} ${text}`);
  }

  const body = (await response.json()) as OpenRouterChatResponse;
  if (body.error) {
    throw new Error(`[openrouter] error: ${body.error.message}`);
  }
  return body.choices[0].message.content;
}

/**
 * Model slugs pinned per pipeline stage from spec §9. Import from here to
 * avoid typos and to centralize model upgrades.
 */
export const MODELS = {
  DRAFTER: 'anthropic/claude-opus-4-6',
  JUDGE: 'anthropic/claude-sonnet-4-6',  // GPT-5 blocked by Azure content policy; Sonnet is cheaper + reliable
  IMAGE: 'google/gemini-2.5-flash-image',
} as const;
