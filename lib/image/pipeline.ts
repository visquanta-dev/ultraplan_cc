import fs from 'node:fs';
import path from 'node:path';
import { loadImageStyle, buildImagePrompt, getImageCount, type ImageStyleConfig } from './style-loader';
import { generateImage, type GeneratedImage } from './generate';
import { runImageGates, type ImageGateResult } from './gates';

// ---------------------------------------------------------------------------
// Image generation pipeline — spec §7 (stage 6b)
// Orchestrates: style load → prompt build → generate → validate → retry.
// Outputs images to public/images/blog/<slug>/.
// ---------------------------------------------------------------------------

const MAX_IMAGE_RETRIES = 2;

export interface ImagePipelineResult {
  /** Paths relative to project root (e.g. public/images/blog/slug/hero.webp) */
  paths: string[];
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

/**
 * Build a subject description for image generation from the article headline
 * and section headings.
 */
function buildSubjectFromArticle(
  headline: string,
  sectionHeadings: string[],
  imageType: 'hero' | 'inline',
  inlineIndex?: number,
): string {
  if (imageType === 'hero') {
    return [
      `Article headline: "${headline}"`,
      `Key topics: ${sectionHeadings.join(', ')}`,
      '',
      'Create a hero image that captures the central thesis of this article.',
      'The image should be abstract and metaphorical — never literal.',
    ].join('\n');
  }

  const sectionContext = inlineIndex !== undefined && inlineIndex < sectionHeadings.length
    ? `This inline image accompanies the section: "${sectionHeadings[inlineIndex]}"`
    : `This is inline image ${(inlineIndex ?? 0) + 1} for the article.`;

  return [
    `Article headline: "${headline}"`,
    sectionContext,
    '',
    'Create an inline image that re-energizes the reader at this point in the article.',
  ].join('\n');
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
 * @param headline - Article headline (used to generate subject prompts)
 * @param sectionHeadings - Section headings from the outline
 */
export async function runImagePipeline(
  slug: string,
  lane: 'daily_seo' | 'weekly_authority' | 'monthly_anonymized_case',
  headline: string,
  sectionHeadings: string[],
  options: ImagePipelineOptions = {},
): Promise<ImagePipelineResult> {
  const style = loadImageStyle(lane);
  const counts = getImageCount(style);
  const outputDir = path.join(process.cwd(), 'public', 'images', 'blog', slug);

  const paths: string[] = [];
  const gateResults: ImagePipelineResult['gateResults'] = [];
  const blockedImages: string[] = [];

  // Generate hero image
  {
    const subject = buildSubjectFromArticle(headline, sectionHeadings, 'hero');
    const prompt = buildImagePrompt(style, subject, 'hero');
    const outputPath = path.join(outputDir, 'hero.webp');

    const result = await generateAndValidate(prompt, style, 'hero', outputPath, options, 0);
    gateResults.push({ type: 'hero', index: 0, result: result.gateResult, attempts: result.attempts });

    if (result.path) {
      paths.push(path.relative(process.cwd(), result.path));
    } else {
      blockedImages.push('hero.webp');
    }
  }

  // Generate inline images
  for (let i = 0; i < counts.inline; i++) {
    const subject = buildSubjectFromArticle(headline, sectionHeadings, 'inline', i);
    const prompt = buildImagePrompt(style, subject, 'inline', i);
    const outputPath = path.join(outputDir, `inline-${i + 1}.webp`);

    const result = await generateAndValidate(prompt, style, 'inline', outputPath, options, i);
    gateResults.push({ type: 'inline', index: i, result: result.gateResult, attempts: result.attempts });

    if (result.path) {
      paths.push(path.relative(process.cwd(), result.path));
    } else {
      blockedImages.push(`inline-${i + 1}.webp`);
    }
  }

  return {
    paths,
    gateResults,
    allPassed: blockedImages.length === 0,
    blockedImages,
  };
}
