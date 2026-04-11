import fs from 'node:fs';
import path from 'node:path';
import { loadImageStyle, buildImagePrompt, getImageCount, type ImageStyleConfig } from './style-loader';
import { generateImage, type GeneratedImage } from './generate';
import { runImageGates, type ImageGateResult } from './gates';
import { callLLMStructured } from '../llm/openrouter';

// ---------------------------------------------------------------------------
// Image generation pipeline — spec §7 (stage 6b)
// Orchestrates: style load → prompt build → generate → validate → retry.
// Outputs images to public/images/blog/<slug>/.
// ---------------------------------------------------------------------------

const MAX_IMAGE_RETRIES = 2;

/**
 * Generate descriptive alt text for an image based on its context.
 * Used for accessibility and image search SEO.
 */
async function generateAltText(context: string, role: string): Promise<string> {
  try {
    const result = await callLLMStructured<{ alt: string }>({
      system: [
        'Generate alt text for a blog image about car dealership operations.',
        'Rules:',
        '- 10-25 words, one sentence',
        '- Describe what the image depicts in the context of the article',
        '- Be specific to the dealership industry',
        '- No "image of" or "photo of" prefix',
        '- No brand names',
      ].join('\n'),
      user: `Article context: ${context}\nImage role: ${role}`,
      schema: {
        type: 'object',
        properties: { alt: { type: 'string' } },
        required: ['alt'],
      },
      parse: (raw) => ({ alt: String((raw as Record<string, unknown>).alt ?? '').trim() }),
      maxTokens: 64,
      temperature: 0.5,
    });
    return result.alt;
  } catch {
    return `Dealership scene related to ${context.slice(0, 60)}`;
  }
}

export interface ImagePipelineResult {
  /** Paths relative to project root (e.g. public/images/blog/slug/hero.webp) */
  paths: string[];
  /** Alt text keyed by relative path */
  altTexts: Record<string, string>;
  /** Per-image gate results for diagnostics */
  gateResults: Array<{ type: 'hero' | 'inline'; index: number; result: ImageGateResult; attempts: number }>;
  /** Whether all images passed gates */
  allPassed: boolean;
  /** If any image was blocked after max retries */
  blockedImages: string[];
}

export interface ImagePipelineOptions {
  onImageStart?: (type: 'hero' | 'inline', index: number) => void;
  onImageResult?: (type: 'hero' | 'inline', index: number, passed: boolean, attempt: number) => void;
}

const IMAGE_AGENT_PROMPT_PATH = path.join(
  process.cwd(),
  'workflows',
  'blog-pipeline',
  'prompts',
  'image-agent.md',
);

let cachedImageAgentPrompt: string | null = null;

function loadImageAgentPrompt(): string {
  if (cachedImageAgentPrompt) return cachedImageAgentPrompt;
  cachedImageAgentPrompt = fs.readFileSync(IMAGE_AGENT_PROMPT_PATH, 'utf-8');
  return cachedImageAgentPrompt;
}

/**
 * Use the Image Agent prompt to generate a content-relevant image prompt.
 * The agent reads the blog content and outputs a production-ready prompt
 * following the VisQuanta brand guidelines.
 */
async function generateImagePrompt(
  headline: string,
  articleContent: string,
): Promise<string> {
  const agentSystem = loadImageAgentPrompt();

  // Truncate content to keep within token limits
  const truncatedContent = articleContent.slice(0, 4000);
  const userMessage = `Read the following blog post and generate one image prompt following the rules exactly.\n\n# ${headline}\n\n${truncatedContent}`;

  const result = await callLLMStructured<{ format: string; reason: string; prompt: string }>({
    system: agentSystem,
    user: userMessage,
    schema: {
      type: 'object',
      properties: {
        format: { type: 'string', description: 'Editorial Photo, Text Overlay on Photo, Text on Solid Background, or Close-Up Detail' },
        reason: { type: 'string', description: 'One sentence explaining why this format fits' },
        prompt: { type: 'string', description: 'The image generation prompt, 40-80 words' },
      },
      required: ['format', 'reason', 'prompt'],
    },
    parse: (raw) => {
      const obj = raw as Record<string, unknown>;
      return {
        format: String(obj.format ?? 'Editorial Photo'),
        reason: String(obj.reason ?? ''),
        prompt: String(obj.prompt ?? ''),
      };
    },
  });

  console.log(`[image-agent] Format: ${result.format}`);
  console.log(`[image-agent] Reason: ${result.reason}`);
  return result.prompt;
}

/**
 * Generate a single image with gate validation and retry.
 */
async function generateAndValidate(
  prompt: string,
  style: ImageStyleConfig,
  imageType: 'hero' | 'inline',
  outputPath: string,
  options: ImagePipelineOptions,
  imageIndex: number,
): Promise<{
  path: string | null;
  gateResult: ImageGateResult;
  attempts: number;
}> {
  let lastGateResult: ImageGateResult | null = null;

  for (let attempt = 1; attempt <= MAX_IMAGE_RETRIES + 1; attempt++) {
    options.onImageStart?.(imageType, imageIndex);

    const image = await generateImage(prompt);
    const gateResult = await runImageGates(image, style, imageType);
    lastGateResult = gateResult;

    if (gateResult.passed) {
      // Convert to WebP by saving as-is (the model outputs PNG/WebP)
      // In production we'd use sharp for conversion; for now save raw
      const outputDir = path.dirname(outputPath);
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(outputPath, Buffer.from(image.base64, 'base64'));

      options.onImageResult?.(imageType, imageIndex, true, attempt);
      return { path: outputPath, gateResult, attempts: attempt };
    }

    options.onImageResult?.(imageType, imageIndex, false, attempt);
  }

  return { path: null, gateResult: lastGateResult!, attempts: MAX_IMAGE_RETRIES + 1 };
}

/**
 * Run the full image generation pipeline for a blog post.
 *
 * @param slug - Article slug (used for output directory)
 * @param lane - Editorial lane (determines style config)
 * @param headline - Article headline
 * @param sectionHeadings - Section headings from the outline
 * @param articleContent - Full article markdown (passed to image agent)
 */
export async function runImagePipeline(
  slug: string,
  lane: 'daily_seo' | 'weekly_authority' | 'monthly_anonymized_case',
  headline: string,
  sectionHeadings: string[],
  options: ImagePipelineOptions = {},
  articleContent?: string,
): Promise<ImagePipelineResult> {
  const style = loadImageStyle(lane);
  const counts = getImageCount(style);
  const outputDir = path.join(process.cwd(), 'public', 'images', 'blog', slug);

  const paths: string[] = [];
  const altTexts: Record<string, string> = {};
  const gateResults: ImagePipelineResult['gateResults'] = [];
  const blockedImages: string[] = [];

  // Generate hero image using the Image Agent prompt
  {
    let prompt: string;
    if (articleContent) {
      // Use the Image Agent to generate a content-relevant prompt
      prompt = await generateImagePrompt(headline, articleContent);
    } else {
      // Fallback: basic prompt from headline
      prompt = `Ultra-realistic photograph, modern car dealership environment related to: "${headline}". Professional editorial quality, warm lighting, automotive setting. No identifiable faces (show people from behind or silhouetted only). No readable text or signage. No brand logos or car manufacturer badges. No watermarks.`;
    }
    const outputPath = path.join(outputDir, 'hero.webp');

    const result = await generateAndValidate(prompt, style, 'hero', outputPath, options, 0);
    gateResults.push({ type: 'hero', index: 0, result: result.gateResult, attempts: result.attempts });

    if (result.path) {
      const relPath = path.relative(process.cwd(), result.path);
      paths.push(relPath);
      altTexts[relPath] = await generateAltText(headline, 'hero image');
    } else {
      blockedImages.push('hero.webp');
    }
  }

  // Generate inline images
  for (let i = 0; i < counts.inline; i++) {
    const sectionContext = i < sectionHeadings.length ? sectionHeadings[i] : headline;
    const prompt = `Ultra-realistic photograph, modern car dealership scene related to: "${sectionContext}". Professional editorial quality, warm showroom lighting. No identifiable faces (show people from behind or silhouetted only). No readable text or signage. No brand logos or car manufacturer badges. No watermarks.`;
    const outputPath = path.join(outputDir, `inline-${i + 1}.webp`);

    const result = await generateAndValidate(prompt, style, 'inline', outputPath, options, i);
    gateResults.push({ type: 'inline', index: i, result: result.gateResult, attempts: result.attempts });

    if (result.path) {
      const relPath = path.relative(process.cwd(), result.path);
      paths.push(relPath);
      altTexts[relPath] = await generateAltText(sectionContext, `section image for ${sectionContext}`);
    } else {
      blockedImages.push(`inline-${i + 1}.webp`);
    }
  }

  return {
    paths,
    altTexts,
    gateResults,
    allPassed: blockedImages.length === 0,
    blockedImages,
  };
}
