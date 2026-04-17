import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

// ---------------------------------------------------------------------------
// Image style loader — spec §7
// Reads per-lane image style YAML from config/image_styles/<lane>.yaml.
// Each lane has its own style prompt, negative prompt, dimensions, and
// brand-fit rubric.
// ---------------------------------------------------------------------------

export interface ImageDimensions {
  width: number;
  height: number;
  aspect_ratio: string;
}

export interface ImageStyleConfig {
  lane: string;
  model: string;
  dimensions: {
    hero: ImageDimensions;
    inline?: ImageDimensions;
    count?: { hero: number; inline: number };
  };
  style_prompt: string;
  negative_prompt: string;
  brand_fit_rubric: string[];
  inline_guidance?: string;
  anonymization_rule?: string;
}

type LaneName = 'daily_seo' | 'weekly_authority' | 'monthly_anonymized_case' | 'listicle';

const cache = new Map<string, ImageStyleConfig>();

/**
 * Load image style config for a lane. Cached after first load.
 */
export function loadImageStyle(lane: LaneName): ImageStyleConfig {
  if (cache.has(lane)) return cache.get(lane)!;

  const filePath = path.join(process.cwd(), 'config', 'image_styles', `${lane}.yaml`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`[image-style] No style config found for lane "${lane}" at ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = YAML.parse(raw) as ImageStyleConfig;
  cache.set(lane, parsed);
  return parsed;
}

/**
 * Build a complete image generation prompt by combining the lane style
 * with an article-specific subject description.
 */
export function buildImagePrompt(
  style: ImageStyleConfig,
  articleSubject: string,
  imageType: 'hero' | 'inline',
  inlineIndex?: number,
): string {
  const dims = imageType === 'hero' ? style.dimensions.hero : (style.dimensions.inline ?? style.dimensions.hero);

  const parts = [
    `Generate an image at ${dims.width}x${dims.height} (${dims.aspect_ratio}).`,
    '',
    '## Style',
    style.style_prompt.trim(),
    '',
    '## Subject',
    articleSubject,
  ];

  if (imageType === 'inline' && style.inline_guidance) {
    parts.push('', '## Inline image guidance', style.inline_guidance.trim());
    if (inlineIndex !== undefined) {
      parts.push(`This is inline image ${inlineIndex + 1}.`);
    }
  }

  parts.push('', '## Do NOT include', style.negative_prompt.trim());

  if (style.anonymization_rule) {
    parts.push('', '## Anonymization (mandatory)', style.anonymization_rule.trim());
  }

  return parts.join('\n');
}

/**
 * Determine how many images a lane needs.
 */
export function getImageCount(style: ImageStyleConfig): { hero: number; inline: number } {
  return {
    hero: 1,
    inline: style.dimensions.count?.inline ?? 0,
  };
}
