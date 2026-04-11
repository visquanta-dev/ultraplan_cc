// ---------------------------------------------------------------------------
// Contextual tool/calculator embed system
// Scans article content for keyword matches and inserts embed markers
// that the main site renders as interactive components.
// ---------------------------------------------------------------------------

interface ToolEmbed {
  /** Marker inserted into markdown, e.g. {{calculator:service-roi}} */
  marker: string;
  /** Keywords that trigger this embed */
  keywords: string[];
  /** Where to insert: 'after-first-match' places it after the first paragraph containing a keyword */
  placement: 'after-first-match';
  /** Max one embed of this type per post */
  maxPerPost: 1;
  /** Human-readable label for logging */
  label: string;
}

const TOOL_EMBEDS: ToolEmbed[] = [
  {
    marker: '{{calculator:lead-reactivation}}',
    keywords: ['lead reactivation', 'reactivate leads', 'dormant leads', 'dead leads', 'old leads', 'lead recovery'],
    placement: 'after-first-match',
    maxPerPost: 1,
    label: 'Lead Reactivation Calculator',
  },
  {
    marker: '{{calculator:speed-to-lead}}',
    keywords: ['speed to lead', 'response time', 'lead response', 'first contact', 'follow-up speed', '5-minute'],
    placement: 'after-first-match',
    maxPerPost: 1,
    label: 'Speed-to-Lead Calculator',
  },
  {
    marker: '{{calculator:service-roi}}',
    keywords: ['missed calls', 'service drive', 'service department', 'fixed ops', 'service retention', 'repair order'],
    placement: 'after-first-match',
    maxPerPost: 1,
    label: 'Service ROI Calculator',
  },
  {
    marker: '{{calculator:roi}}',
    keywords: ['return on investment', 'ROI', 'cost savings', 'payback period', 'revenue impact'],
    placement: 'after-first-match',
    maxPerPost: 1,
    label: 'ROI Calculator',
  },
  {
    marker: '{{cta:case-studies}}',
    keywords: ['case study', 'real results', 'dealer results', 'implementation results', 'success story'],
    placement: 'after-first-match',
    maxPerPost: 1,
    label: 'Case Study Callout',
  },
];

// Max total embeds per post to avoid clutter
const MAX_EMBEDS_PER_POST = 2;

/**
 * Scan article body parts and insert contextual tool/calculator embeds
 * based on keyword matching. Returns modified body parts array.
 */
export function insertToolEmbeds(bodyParts: string[]): { parts: string[]; inserted: string[] } {
  const result = [...bodyParts];
  const inserted: string[] = [];
  const usedMarkers = new Set<string>();

  for (const embed of TOOL_EMBEDS) {
    if (inserted.length >= MAX_EMBEDS_PER_POST) break;
    if (usedMarkers.has(embed.marker)) continue;

    // Find the first paragraph containing any of the embed's keywords
    for (let i = 0; i < result.length; i++) {
      const part = result[i].toLowerCase();

      // Skip headings and non-paragraph content
      if (result[i].startsWith('##') || result[i].startsWith('|') || result[i].trim() === '') continue;

      const matched = embed.keywords.some((kw) => part.includes(kw.toLowerCase()));
      if (matched) {
        // Insert the marker after this paragraph
        result.splice(i + 1, 0, `\n${embed.marker}\n`);
        usedMarkers.add(embed.marker);
        inserted.push(embed.label);
        break;
      }
    }
  }

  return { parts: result, inserted };
}
