import Replicate from 'replicate';

// ---------------------------------------------------------------------------
// Image generation via Replicate — spec §7
// Uses Flux 2 Pro for high-fidelity blog hero images.
// Returns base64-encoded image data for the pipeline.
// ---------------------------------------------------------------------------

const MODEL = 'black-forest-labs/flux-1.1-pro' as const;

export interface GeneratedImage {
  /** Raw base64 image data (no data: prefix) */
  base64: string;
  /** MIME type (e.g. image/webp) */
  mimeType: string;
  /** Model that generated the image */
  model: string;
}

function getClient(): Replicate {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    throw new Error('[image-generate] REPLICATE_API_TOKEN is not set.');
  }
  return new Replicate({ auth: token });
}

/**
 * Generate an image via Replicate using Flux 2 Pro.
 * Returns the base64-encoded image data.
 */
export async function generateImage(prompt: string): Promise<GeneratedImage> {
  const replicate = getClient();

  // Append safety suffix to avoid branded content in hero images
  const safePrompt = `${prompt}. No brand logos, no trademarked names, no text overlays.`;

  const output = await replicate.run(MODEL, {
    input: {
      prompt: safePrompt,
      aspect_ratio: '16:9',
      output_format: 'webp',
      output_quality: 90,
    },
  });

  // Replicate SDK returns a FileOutput object whose toString() gives the URL
  const url = String(output);

  if (!url.startsWith('http')) {
    throw new Error(`[image-generate] unexpected output — not a URL: ${url.slice(0, 200)}`);
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`[image-generate] failed to fetch image: ${res.status}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());

  return {
    base64: buffer.toString('base64'),
    mimeType: 'image/webp',
    model: MODEL,
  };
}
