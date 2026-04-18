// ---------------------------------------------------------------------------
// Chart renderer — spec §7b (stage 6c)
// Generates editorial stat-hero PNGs when the drafter emits a `chart:` block.
// Three chart types: bar (comparison), delta (single-stat callout), trendline
// (time series). Rendered as SVG then rasterized to PNG via sharp.
//
// Output dimensions (1200x630) match OG ratio — works as listing-card thumbnail
// and inline-body figure. All three types share the same canvas + brand palette
// so the blog hub has visual consistency across chart posts.
//
// Renders once per post at pipeline time, saved under
// public/images/blog/<slug>/chart-hero.png. Validation (validateChartSpec) is
// strict and throws on malformed data — per spec, a malformed `chart:` block
// hard-fails the PR rather than degrading to a metaphor image.
// ---------------------------------------------------------------------------

import sharp from 'sharp';

const WIDTH = 1200;
const HEIGHT = 630;

const PALETTE = {
  bg: '#08080A',
  fg: '#ffffff',
  muted: '#71717a',
  accent: '#F97316',
  gridline: '#27272a',
} as const;

// Single-word font names only — quoted multi-word names ("Segoe UI") would
// break the SVG attribute parser because the whole font-family attribute is
// already quote-delimited. Inter first, then generic fallbacks.
const FONT_STACK = 'Inter, Helvetica, Arial, sans-serif';

export type ChartType = 'bar' | 'delta' | 'trendline';

export interface ChartDataPoint {
  label: string;
  value: number;
  /** Optional display override — "48%" / "$1.5M" / "2x". Falls back to value.toString(). */
  valueLabel?: string;
}

export interface ChartSpec {
  type: ChartType;
  headline: string;
  data: ChartDataPoint[];
  source?: string;
}

export async function renderChart(spec: ChartSpec): Promise<Buffer> {
  const svg = buildSVG(spec);
  return await sharp(Buffer.from(svg)).png().toBuffer();
}

function buildSVG(spec: ChartSpec): string {
  let body = '';
  if (spec.type === 'bar') body = buildBar(spec);
  else if (spec.type === 'delta') body = buildDelta(spec);
  else if (spec.type === 'trendline') body = buildTrendline(spec);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${PALETTE.bg}"/>
  ${body}
</svg>`;
}

function buildBar(spec: ChartSpec): string {
  const { data, headline, source } = spec;
  const pad = { top: 140, right: 80, bottom: 150, left: 80 };
  const plotW = WIDTH - pad.left - pad.right;
  const plotH = HEIGHT - pad.top - pad.bottom;
  const maxVal = Math.max(...data.map((d) => d.value));
  const barGap = plotW * 0.06;
  const barW = (plotW - barGap * (data.length - 1)) / data.length;

  const bars = data
    .map((d, i) => {
      const x = pad.left + i * (barW + barGap);
      const h = (d.value / maxVal) * plotH;
      const y = pad.top + plotH - h;
      const isLast = i === data.length - 1;
      const fill = isLast ? PALETTE.accent : PALETTE.muted;
      const valueLabel = d.valueLabel ?? String(d.value);
      return `  <rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${fill}" rx="6"/>
  <text x="${x + barW / 2}" y="${y - 18}" font-family="${FONT_STACK}" font-size="48" font-weight="800" fill="${PALETTE.fg}" text-anchor="middle">${escapeText(valueLabel)}</text>
  <text x="${x + barW / 2}" y="${pad.top + plotH + 40}" font-family="${FONT_STACK}" font-size="22" font-weight="500" fill="${PALETTE.muted}" text-anchor="middle">${escapeText(d.label)}</text>`;
    })
    .join('\n');

  return `  <text x="${pad.left}" y="70" font-family="${FONT_STACK}" font-size="36" font-weight="700" fill="${PALETTE.fg}">${escapeText(headline)}</text>
${bars}
${renderSource(source, pad.left, HEIGHT - 40)}`;
}

function buildDelta(spec: ChartSpec): string {
  const { data, headline, source } = spec;
  const single = data[0];
  const valueLabel = single.valueLabel ?? String(single.value);
  const cx = WIDTH / 2;

  return `  <text x="${cx}" y="${HEIGHT / 2 - 20}" font-family="${FONT_STACK}" font-size="240" font-weight="900" fill="${PALETTE.accent}" text-anchor="middle" letter-spacing="-8">${escapeText(valueLabel)}</text>
  <text x="${cx}" y="${HEIGHT / 2 + 80}" font-family="${FONT_STACK}" font-size="34" font-weight="500" fill="${PALETTE.fg}" text-anchor="middle">${escapeText(headline)}</text>
  ${single.label ? `<text x="${cx}" y="${HEIGHT / 2 + 130}" font-family="${FONT_STACK}" font-size="20" font-weight="400" fill="${PALETTE.muted}" text-anchor="middle">${escapeText(single.label)}</text>` : ''}
${renderSource(source, undefined, HEIGHT - 40, cx)}`;
}

function buildTrendline(spec: ChartSpec): string {
  const { data, headline, source } = spec;
  const pad = { top: 140, right: 80, bottom: 130, left: 80 };
  const plotW = WIDTH - pad.left - pad.right;
  const plotH = HEIGHT - pad.top - pad.bottom;
  const values = data.map((d) => d.value);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const range = maxVal - minVal || 1;
  const stepX = plotW / (data.length - 1);

  const coords = data.map((d, i) => {
    const x = pad.left + i * stepX;
    const y = pad.top + plotH - ((d.value - minVal) / range) * plotH;
    return { x, y, point: d };
  });

  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x},${c.y}`).join(' ');
  const lastIdx = coords.length - 1;

  const points = coords
    .map((c, i) => {
      const isLast = i === lastIdx;
      const r = isLast ? 12 : 7;
      const fill = isLast ? PALETTE.accent : PALETTE.muted;
      const valueLabel = c.point.valueLabel ?? String(c.point.value);
      const labelY = isLast ? c.y - 28 : pad.top + plotH + 36;
      const labelText = isLast ? valueLabel : c.point.label;
      const labelSize = isLast ? 36 : 20;
      const labelWeight = isLast ? 800 : 500;
      const labelColor = isLast ? PALETTE.fg : PALETTE.muted;
      return `  <circle cx="${c.x}" cy="${c.y}" r="${r}" fill="${fill}"/>
  <text x="${c.x}" y="${labelY}" font-family="${FONT_STACK}" font-size="${labelSize}" font-weight="${labelWeight}" fill="${labelColor}" text-anchor="middle">${escapeText(labelText)}</text>`;
    })
    .join('\n');

  // x-axis labels (only for non-last points, last gets value label above)
  const axisLabels = coords
    .slice(0, lastIdx)
    .map((c) => `  <text x="${c.x}" y="${pad.top + plotH + 36}" font-family="${FONT_STACK}" font-size="20" font-weight="500" fill="${PALETTE.muted}" text-anchor="middle">${escapeText(c.point.label)}</text>`)
    .join('\n');

  return `  <text x="${pad.left}" y="70" font-family="${FONT_STACK}" font-size="36" font-weight="700" fill="${PALETTE.fg}">${escapeText(headline)}</text>
  <path d="${linePath}" fill="none" stroke="${PALETTE.accent}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
${points}
${axisLabels}
${renderSource(source, pad.left, HEIGHT - 40)}`;
}

function renderSource(source: string | undefined, x: number | undefined, y: number, cx?: number): string {
  if (!source) return '';
  const anchor = cx !== undefined ? `text-anchor="middle"` : '';
  const xAttr = cx !== undefined ? `x="${cx}"` : `x="${x}"`;
  return `  <text ${xAttr} y="${y}" font-family="${FONT_STACK}" font-size="14" font-weight="500" fill="${PALETTE.muted}" letter-spacing="2" ${anchor}>SOURCE: ${escapeText(source.toUpperCase())}</text>`;
}

function escapeText(s: string): string {
  return s.replace(/[<>&"']/g, (c) => {
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '&') return '&amp;';
    if (c === '"') return '&quot;';
    if (c === "'") return '&#39;';
    return c;
  });
}

// ---------------------------------------------------------------------------
// Validation — hard-fail on malformed data per spec §10
// ---------------------------------------------------------------------------

export class ChartSpecError extends Error {
  constructor(msg: string) {
    super(`[chart-spec] ${msg}`);
    this.name = 'ChartSpecError';
  }
}

export function validateChartSpec(raw: unknown): ChartSpec {
  if (!raw || typeof raw !== 'object') {
    throw new ChartSpecError('chart spec must be an object');
  }
  const obj = raw as Record<string, unknown>;

  if (obj.type !== 'bar' && obj.type !== 'delta' && obj.type !== 'trendline') {
    throw new ChartSpecError(`type must be 'bar' | 'delta' | 'trendline' (got: ${JSON.stringify(obj.type)})`);
  }
  const type = obj.type;

  if (typeof obj.headline !== 'string' || obj.headline.trim().length === 0) {
    throw new ChartSpecError('headline must be a non-empty string');
  }

  if (!Array.isArray(obj.data) || obj.data.length === 0) {
    throw new ChartSpecError('data must be a non-empty array');
  }

  const data: ChartDataPoint[] = obj.data.map((d, i) => {
    if (!d || typeof d !== 'object') {
      throw new ChartSpecError(`data[${i}] must be an object`);
    }
    const pt = d as Record<string, unknown>;
    if (typeof pt.label !== 'string' || pt.label.trim().length === 0) {
      throw new ChartSpecError(`data[${i}].label must be a non-empty string`);
    }
    if (typeof pt.value !== 'number' || !Number.isFinite(pt.value)) {
      throw new ChartSpecError(`data[${i}].value must be a finite number (got: ${JSON.stringify(pt.value)})`);
    }
    const valueLabel = typeof pt.valueLabel === 'string' ? pt.valueLabel : undefined;
    return { label: pt.label, value: pt.value, ...(valueLabel ? { valueLabel } : {}) };
  });

  if (type === 'delta' && data.length !== 1) {
    throw new ChartSpecError(`type 'delta' requires exactly 1 data point, got ${data.length}`);
  }
  if (type === 'bar' && data.length < 2) {
    throw new ChartSpecError(`type 'bar' requires at least 2 data points, got ${data.length}`);
  }
  if (type === 'bar' && data.length > 5) {
    throw new ChartSpecError(`type 'bar' supports at most 5 data points (readability), got ${data.length}`);
  }
  if (type === 'trendline' && data.length < 3) {
    throw new ChartSpecError(`type 'trendline' requires at least 3 data points, got ${data.length}`);
  }
  if (type === 'trendline' && data.length > 12) {
    throw new ChartSpecError(`type 'trendline' supports at most 12 data points (readability), got ${data.length}`);
  }

  const source = typeof obj.source === 'string' && obj.source.trim().length > 0 ? obj.source : undefined;

  return { type, headline: obj.headline, data, ...(source ? { source } : {}) };
}
