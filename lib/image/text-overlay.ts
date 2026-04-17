// ---------------------------------------------------------------------------
// Text overlay compositor — composites a styled headline bar onto hero images.
// Uses Sharp to resize + composite an SVG overlay as JPEG output.
// ---------------------------------------------------------------------------

import sharp from 'sharp';

export interface TextOverlayOptions {
  /** Main text to overlay (e.g. "Prices Up $1,500 in One Month") */
  text: string;
  /** Optional subtitle/source line (ignored for 'center' position) */
  subtitle?: string;
  /**
   * Position of the text:
   *   'bottom' — legacy: gradient bar at bottom, left-aligned headline
   *   'top'    — legacy: gradient bar at top, left-aligned headline
   *   'center' — editorial treatment: centered both axes, larger bold
   *              headline, radial vignette, double drop shadow. This is
   *              the default going forward.
   */
  position?: 'bottom' | 'top' | 'center';
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
// SVG overlay — centered editorial treatment (v2)
//
// This is the default VisQuanta hero overlay going forward: large centered
// headline, 32% base tint + radial vignette for contrast, double drop shadow
// so the white text reads cleanly even on busy backgrounds. Font size scales
// with image width so the same treatment works at 1600 or 1920 output.
// ---------------------------------------------------------------------------
function buildCenteredSvg(
  width: number,
  height: number,
  text: string,
): string {
  const mainFontSize = Math.round(width * 0.058); // 112pt at 1920w
  const lineHeight = mainFontSize * 1.08;
  const padX = Math.round(width * 0.10);
  const maxCharsPerLine = Math.floor((width - padX * 2) / (mainFontSize * 0.50));
  const lines = wrapText(text, maxCharsPerLine);
  const blockHeight = lines.length * lineHeight;
  const blockTop = Math.round(height / 2 - blockHeight / 2 + mainFontSize * 0.75);
  const cx = Math.round(width / 2);

  const tspans = lines
    .map(
      (l, i) =>
        `<tspan x="${cx}" dy="${i === 0 ? 0 : lineHeight}" text-anchor="middle">${escapeXml(l)}</tspan>`,
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <radialGradient id="vignette" cx="50%" cy="50%" r="70%">
      <stop offset="0%"   stop-color="rgba(0,0,0,0.15)" />
      <stop offset="60%"  stop-color="rgba(0,0,0,0.45)" />
      <stop offset="100%" stop-color="rgba(0,0,0,0.75)" />
    </radialGradient>
    <filter id="textShadow" x="-10%" y="-10%" width="120%" height="140%">
      <feDropShadow dx="0" dy="3" stdDeviation="6" flood-color="rgba(0,0,0,0.90)" />
      <feDropShadow dx="0" dy="0" stdDeviation="2" flood-color="rgba(0,0,0,0.60)" />
    </filter>
  </defs>

  <!-- Base dark tint + radial vignette for editorial framing -->
  <rect x="0" y="0" width="${width}" height="${height}" fill="rgba(0,0,0,0.32)" />
  <rect x="0" y="0" width="${width}" height="${height}" fill="url(#vignette)" />

  <!-- Centered bold headline with double drop shadow -->
  <text
    x="${cx}"
    y="${blockTop}"
    font-family="'Helvetica Neue', Helvetica, Arial, sans-serif"
    font-size="${mainFontSize}"
    font-weight="900"
    fill="white"
    letter-spacing="-2"
    filter="url(#textShadow)"
  >${tspans}</text>
</svg>`;
}

// ---------------------------------------------------------------------------
// Legacy SVG overlay — gradient bar at top/bottom with left-aligned headline.
// Kept available via position:'top' and position:'bottom' for backward compat.
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
    position = 'center', // Editorial centered treatment is the new default
    width = 1600,
    height = 900,
  } = options;

  // 1. Resize source image to target dimensions (cover / crop-to-fill)
  const resized = sharp(imageBuffer).resize(width, height, {
    fit: 'cover',
    position: 'centre',
  });

  // 2. Build SVG overlay — centered editorial style by default,
  //    legacy top/bottom gradient bar on request.
  const svgString =
    position === 'center'
      ? buildCenteredSvg(width, height, text)
      : buildSvg(width, height, text, subtitle, position);
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
