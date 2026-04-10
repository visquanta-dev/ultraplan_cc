import { MODELS } from '../llm/openrouter';

// ---------------------------------------------------------------------------
// Image generation via OpenRouter — spec §7
// Calls Gemini 2.5 Flash Image Preview Pro through OpenRouter's
// chat/completions endpoint. The model returns images as base64-encoded
// data in the response content blocks.
// ---------------------------------------------------------------------------

const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';

interface ImageContentBlock {
  type: 'image_url';
  image_url: { url: string }; // data:image/png;base64,...
}

interface TextContentBlock {
  type: 'text';
  text: string;
}

type ContentBlock = ImageContentBlock | TextContentBlock;

interface OpenRouterImageResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      role: string;
      content: string | ContentBlock[] | null;
      images?: ImageContentBlock[];
    };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
  error?: { message: string };
}

export interface GeneratedImage {
  /** Raw base64 image data (no data: prefix) */
  base64: string;
  /** MIME type (e.g. image/png) */
  mimeType: string;
  /** Model that generated the image */
  model: string;
}

function getApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error('[image-generate] OPENROUTER_API_KEY is not set.');
  }
  return key;
}

/**
 * Generate an image via OpenRouter using the Gemini image model.
 * Returns the base64-encoded image data.
 */
export async function generateImage(prompt: string): Promise<GeneratedImage> {
  const apiKey = getApiKey();
  const model = MODELS.IMAGE;

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
        {
          role: 'user',
          content: prompt,
        },
      ],
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`[image-generate] ${model} returned ${response.status}: ${text}`);
  }

  const body = (await response.json()) as OpenRouterImageResponse;
  if (body.error) {
    throw new Error(`[image-generate] ${model} error: ${body.error.message}`);
  }
  if (!body.choices?.length) {
    throw new Error(`[image-generate] ${model} returned no choices`);
  }

  const msg = body.choices[0].message;
  const content = msg.content;

  // Gemini models return images in a separate `images` array on the message
  if (msg.images?.length) {
    return parseDataUrl(msg.images[0].image_url.url, model);
  }

  // Content can be a string or an array of content blocks
  if (Array.isArray(content)) {
    const imageBlock = content.find(
      (block): block is ImageContentBlock => block.type === 'image_url',
    );
    if (imageBlock) {
      return parseDataUrl(imageBlock.image_url.url, model);
    }
    throw new Error('[image-generate] response had content blocks but no image_url block');
  }

  // Some models return base64 as plain text or in a data URL string
  if (typeof content === 'string') {
    if (content.startsWith('data:image/')) {
      return parseDataUrl(content, model);
    }
    // Try to extract from markdown image syntax ![](data:...)
    const match = content.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/);
    if (match) {
      return parseDataUrl(match[0], model);
    }
    throw new Error(
      `[image-generate] response was text but no image data found. First 200 chars: ${content.slice(0, 200)}`,
    );
  }

  throw new Error('[image-generate] unexpected response format');
}

function parseDataUrl(
  dataUrl: string,
  model: string,
): GeneratedImage {
  // data:image/png;base64,iVBOR...
  const match = dataUrl.match(/^data:(image\/[^;]+);base64,([\s\S]+)$/);
  if (!match) {
    throw new Error(`[image-generate] could not parse data URL: ${dataUrl.slice(0, 100)}`);
  }
  return {
    base64: match[2],
    mimeType: match[1],
    model,
  };
}
