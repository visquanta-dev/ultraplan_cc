// ---------------------------------------------------------------------------
// Text overlay compositor — composites a styled headline bar onto hero images.
// Uses Sharp to resize + composite an SVG overlay as JPEG output.
// ---------------------------------------------------------------------------

import sharp from 'sharp';

export interface TextOverlayOptions {
  /** Main text to overlay (e.g. "Prices Up $1,500 in One Month") */
  text: string;
  /** Optional subtitle/source line */
  subtitle?: string;
  /** Position: 'bottom' (default) or 'top' */
  position?: 'bottom' | 'top';
  /** Target output width (default 1600) */
  width?: number;
  /** Target output height (default 900) */
  height?: number;
}

// ---------------------------------------------------------------------------
// Word-wrap helper — splits text into lines of at most maxChars characters
// ---------------------------------------------------------------------------
function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      // If a single word exceeds maxChars, put it on its own line
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ---------------------------------------------------------------------------
// SVG overlay generator
// ---------------------------------------------------------------------------
function buildSvg(
  width: number,
  height: number,
  text: string,
  subtitle: string | undefined,
  position: 'bottom' | 'top',
): string {
  const barHeight = Math.round(height * 0.32);
  const padX = 40;
  const padY = 36;
  const mainFontSize = 38;
  const subFontSize = 20;
  const lineHeight = mainFontSize * 1.3;
  const maxCharsPerLine = Math.floor((width - padX * 2) / (mainFontSize * 0.55));

  const lines = wrapText(text, maxCharsPerLine);

  // Gradient direction: dark side toward image edge, transparent toward center
  const gradId = 'overlay-grad';
  let gradY1: string, gradY2: string, rectY: string;
  if (position === 'top') {
    gradY1 = '0%';
    gradY2 = '100%';
    rectY = '0';
  } else {
    gradY1 = '100%';
    gradY2 = '0%';
    rectY = String(height - barHeight);
  }

  // Build main text tspans
  const textBlockStartY =
    position === 'top'
      ? padY + mainFontSize
      : height - barHeight + padY + mainFontSize;

  const mainTspans = lines
    .map(
      (line, i) =>
        `<tspan x="${padX}" dy="${i === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join('');

  const subtitleY =
    textBlockStartY + lines.length * lineHeight + 10;

  const subtitleEl = subtitle
    ? `<text
        x="${padX}"
        y="${subtitleY}"
        font-family="Arial, Helvetica, sans-serif"
        font-size="${subFontSize}"
        font-weight="normal"
        fill="rgba(255,255,255,0.80)"
        filter="url(#shadow)"
      >${escapeXml(subtitle)}</text>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="${gradId}" x1="0" y1="${gradY1}" x2="0" y2="${gradY2}">
      <stop offset="0%"   stop-color="rgba(0,0,0,0.72)" />
      <stop offset="100%" stop-color="rgba(0,0,0,0.00)" />
    </linearGradient>
    <filter id="shadow" x="-5%" y="-5%" width="110%" height="140%">
      <feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="rgba(0,0,0,0.70)" />
    </filter>
  </defs>

  <!-- Semi-transparent gradient bar -->
  <rect x="0" y="${rectY}" width="${width}" height="${barHeight}" fill="url(#${gradId})" />

  <!-- Main headline -->
  <text
    x="${padX}"
    y="${textBlockStartY}"
    font-family="Arial, Helvetica, sans-serif"
    font-size="${mainFontSize}"
    font-weight="bold"
    fill="white"
    filter="url(#shadow)"
  >${mainTspans}</text>

  ${subtitleEl}
</svg>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Composite a styled text overlay onto a hero image.
 *
 * @param imageBuffer  Raw image data (any format Sharp can decode)
 * @param options      Text content and layout options
 * @returns            JPEG buffer of the composited image
 */
export async function applyTextOverlay(
  imageBuffer: Buffer,
  options: TextOverlayOptions,
): Promise<Buffer> {
  const {
    text,
    subtitle,
    position = 'bottom',
    width = 1600,
    height = 900,
  } = options;

  // 1. Resize source image to target dimensions (cover / crop-to-fill)
  const resized = sharp(imageBuffer).resize(width, height, {
    fit: 'cover',
    position: 'centre',
  });

  // 2. Build SVG overlay
  const svgString = buildSvg(width, height, text, subtitle, position);
  const svgBuffer = Buffer.from(svgString, 'utf8');

  // 3. Composite SVG onto resized image and encode as JPEG
  const result = await resized
    .composite([
      {
        input: svgBuffer,
        top: 0,
        left: 0,
      },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();

  return result;
}
