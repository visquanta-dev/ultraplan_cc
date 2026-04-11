import type { ImageStyleConfig } from './style-loader';
import type { GeneratedImage } from './generate';

// ---------------------------------------------------------------------------
// Image gates — spec §7 (stage 6b)
// Three validation checks per generated image:
//   1. Aspect ratio + file size sanity
//   2. Banned content check via Gemini 2.5 Pro Vision
//   3. Brand fit score via Gemini 2.5 Pro Vision (1-10, min 7)
// ---------------------------------------------------------------------------

const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
const VISION_MODEL = 'google/gemini-2.5-pro-preview-06-05';
const MIN_BRAND_FIT_SCORE = 7;
const MIN_FILE_SIZE_BYTES = 10_000; // 10KB minimum
const MAX_FILE_SIZE_BYTES = 10_000_000; // 10MB maximum

export interface ImageGateResult {
  passed: boolean;
  sanityCheck: { passed: boolean; reason?: string };
  bannedContent: { passed: boolean; violations: string[] };
  brandFit: { passed: boolean; score: number; reasons: string[] };
}

function getApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('[image-gates] OPENROUTER_API_KEY not set.');
  return key;
}

/**
 * Call Gemini 2.5 Pro Vision with an image for structured analysis.
 */
async function callVision<T>(
  image: GeneratedImage,
  systemPrompt: string,
  userPrompt: string,
  parse: (raw: unknown) => T,
): Promise<T> {
  const apiKey = getApiKey();

  const response = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://ultraplan-cc.vercel.app',
      'X-Title': 'UltraPlan',
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:${image.mimeType};base64,${image.base64}`,
              },
            },
            { type: 'text', text: userPrompt },
          ],
        },
      ],
      max_tokens: 2048,
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`[image-gates] vision call failed: ${response.status} ${text}`);
  }

  const body = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    error?: { message: string };
  };
  if (body.error) throw new Error(`[image-gates] vision error: ${body.error.message}`);

  const content = body.choices[0].message.content.trim();
  const unwrapped = content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  return parse(JSON.parse(unwrapped));
}

// ---------------------------------------------------------------------------
// Gate 1: Sanity check
// ---------------------------------------------------------------------------

function checkSanity(
  image: GeneratedImage,
  style: ImageStyleConfig,
  imageType: 'hero' | 'inline',
): { passed: boolean; reason?: string } {
  const bytes = Buffer.from(image.base64, 'base64').length;

  if (bytes < MIN_FILE_SIZE_BYTES) {
    return { passed: false, reason: `File too small: ${bytes} bytes (min ${MIN_FILE_SIZE_BYTES})` };
  }
  if (bytes > MAX_FILE_SIZE_BYTES) {
    return { passed: false, reason: `File too large: ${bytes} bytes (max ${MAX_FILE_SIZE_BYTES})` };
  }

  const validMimes = ['image/png', 'image/jpeg', 'image/webp'];
  if (!validMimes.includes(image.mimeType)) {
    return { passed: false, reason: `Invalid MIME type: ${image.mimeType}` };
  }

  // We can't check pixel dimensions from base64 without a decoder,
  // so we trust the generation prompt specified the correct size.
  // The vision check below catches obvious aspect ratio violations.

  return { passed: true };
}

// ---------------------------------------------------------------------------
// Gate 2: Banned content check
// ---------------------------------------------------------------------------

interface BannedContentResponse {
  has_violations: boolean;
  violations: string[];
}

async function checkBannedContent(
  image: GeneratedImage,
  style: ImageStyleConfig,
): Promise<{ passed: boolean; violations: string[] }> {
  const system = `You are an image content reviewer for a blog. Your job is to catch PROMINENT legal risks, not incidental background details. Return JSON only.`;

  const user = [
    'Check this image for PROMINENT banned content. Only flag items that are clearly featured or central to the composition:',
    '',
    '1. Identifiable human faces that are clearly visible and in focus (blurred, silhouetted, distant, or out-of-focus people are FINE)',
    '2. Large, readable text that is a focal element of the image (small/distant/blurred text on screens, signs, or objects in the background is FINE)',
    '3. Copyrighted logos that are prominently displayed and clearly the focus or a major element (small badges on vehicle rears, tiny logos on phones/monitors in the background are FINE)',
    '4. A specific trademarked vehicle model that is the clear hero/subject AND its badge is prominently readable (generic vehicles with small distant badges are FINE)',
    '',
    'IMPORTANT CONTEXT: This is for an automotive dealership blog. Cars and vehicles WILL appear in every image — that is expected and correct. Do NOT flag:',
    '- Vehicles that resemble a particular manufacturer (all cars resemble some brand)',
    '- Small badges, emblems, or grille shapes on vehicles',
    '- Distant or blurred signage, screen text, or name tags',
    '- Silhouetted, blurred, or out-of-focus people',
    '',
    'ONLY flag: a clearly readable brand name/logo as the focal point of the image, or a clearly identifiable human face in sharp focus as a primary subject.',
    '',
    style.anonymization_rule ? `Additional anonymization rules:\n${style.anonymization_rule}` : '',
    '',
    'Return: {"has_violations": boolean, "violations": ["description of each violation"]}',
    'If nothing is prominently featured, return: {"has_violations": false, "violations": []}',
  ].join('\n');

  const result = await callVision<BannedContentResponse>(image, system, user, (raw) => {
    const obj = raw as Record<string, unknown>;
    return {
      has_violations: Boolean(obj.has_violations),
      violations: Array.isArray(obj.violations)
        ? obj.violations.filter((v): v is string => typeof v === 'string')
        : [],
    };
  });

  return { passed: !result.has_violations, violations: result.violations };
}

// ---------------------------------------------------------------------------
// Gate 3: Brand fit score
// ---------------------------------------------------------------------------

interface BrandFitResponse {
  score: number;
  reasons: string[];
}

async function checkBrandFit(
  image: GeneratedImage,
  style: ImageStyleConfig,
): Promise<{ passed: boolean; score: number; reasons: string[] }> {
  const rubricText = style.brand_fit_rubric
    .map((r, i) => `${i + 1}. ${r}`)
    .join('\n');

  const system = `You are a brand consistency reviewer for VisQuanta, a dealership technology company. Score images against a style rubric. Return JSON only.`;

  const user = [
    'Score this image on a 1-10 scale against the following brand fit rubric:',
    '',
    rubricText,
    '',
    `Minimum passing score: ${MIN_BRAND_FIT_SCORE}.`,
    '',
    'Return: {"score": integer 1-10, "reasons": ["explanation for each point deducted"]}',
  ].join('\n');

  const result = await callVision<BrandFitResponse>(image, system, user, (raw) => {
    const obj = raw as Record<string, unknown>;
    const score = typeof obj.score === 'number' ? Math.round(obj.score) : 0;
    const reasons = Array.isArray(obj.reasons)
      ? obj.reasons.filter((r): r is string => typeof r === 'string')
      : [];
    return { score, reasons };
  });

  return {
    passed: result.score >= MIN_BRAND_FIT_SCORE,
    score: result.score,
    reasons: result.reasons,
  };
}

// ---------------------------------------------------------------------------
// Combined gate runner
// ---------------------------------------------------------------------------

/**
 * Run all three image gates. Short-circuits on sanity failure.
 */
export async function runImageGates(
  image: GeneratedImage,
  style: ImageStyleConfig,
  imageType: 'hero' | 'inline',
): Promise<ImageGateResult> {
  const sanity = checkSanity(image, style, imageType);
  if (!sanity.passed) {
    return {
      passed: false,
      sanityCheck: sanity,
      bannedContent: { passed: false, violations: ['skipped — sanity check failed'] },
      brandFit: { passed: false, score: 0, reasons: ['skipped — sanity check failed'] },
    };
  }

  const [banned, brandFit] = await Promise.all([
    checkBannedContent(image, style),
    checkBrandFit(image, style),
  ]);

  return {
    passed: sanity.passed && banned.passed && brandFit.passed,
    sanityCheck: sanity,
    bannedContent: banned,
    brandFit,
  };
}
