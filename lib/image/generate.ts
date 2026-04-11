// ---------------------------------------------------------------------------
// Image generation via OpenRouter — Nano Banana 2 (Gemini 3.1 Flash Image)
// Returns base64-encoded image data for the pipeline.
// ---------------------------------------------------------------------------

const MODEL = 'google/gemini-3.1-flash-image-preview';
const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';

export interface GeneratedImage {
  /** Raw base64 image data (no data: prefix) */
  base64: string;
  /** MIME type (e.g. image/png) */
  mimeType: string;
  /** Model that generated the image */
  model: string;
}

/**
 * Generate an image via OpenRouter using Nano Banana 2.
 * The prompt should describe a scene relevant to the blog post content.
 */
export async function generateImage(prompt: string): Promise<GeneratedImage> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('[image-generate] OPENROUTER_API_KEY is not set.');

  const response = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://ultraplan-cc.vercel.app',
      'X-Title': 'UltraPlan',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`[image-generate] ${MODEL} returned ${response.status}: ${text}`);
  }

  const body = await response.json() as {
    choices?: Array<{
      message: {
        content: string | null;
        images?: Array<{ type: 'image_url'; image_url: { url: string } }>;
      };
    }>;
    error?: { message: string };
  };

  if (body.error) throw new Error(`[image-generate] error: ${body.error.message}`);
  if (!body.choices?.length) throw new Error('[image-generate] no choices returned');

  const msg = body.choices[0].message;

  // Nano Banana returns images in message.images array
  if (msg.images?.length) {
    return parseDataUrl(msg.images[0].image_url.url);
  }

  // Fallback: check content for data URL
  const content = msg.content;
  if (typeof content === 'string' && content.includes('data:image/')) {
    const match = content.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/);
    if (match) return parseDataUrl(match[0]);
  }

  throw new Error('[image-generate] no image in response');
}

function parseDataUrl(dataUrl: string): GeneratedImage {
  const match = dataUrl.match(/^data:(image\/[^;]+);base64,([\s\S]+)$/);
  if (!match) throw new Error(`[image-generate] invalid data URL: ${dataUrl.slice(0, 80)}`);
  return { base64: match[2], mimeType: match[1], model: MODEL };
}
