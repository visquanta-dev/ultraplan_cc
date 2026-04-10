import { readJsonl } from '../storage/blob';

// ---------------------------------------------------------------------------
// Rejection learning loop — spec §8-9, Phase 12 → Phase 14 (Vercel Blob)
// Loads the last 30 days of rejection feedback from Vercel Blob and formats
// it as a "lessons learned" block to inject into the drafter's system prompt.
// ---------------------------------------------------------------------------

const FEEDBACK_WINDOW_DAYS = 30;

interface RejectionEntry {
  date: string;
  slug: string;
  lane: string | null;
  reason: string;
  feedback: string;
  reviewer: string;
  pr_url: string;
}

/**
 * Load rejection entries from the last N days.
 */
async function loadRecentRejections(days: number = FEEDBACK_WINDOW_DAYS): Promise<RejectionEntry[]> {
  const all = await readJsonl<RejectionEntry>('rejection_log.jsonl');
  if (all.length === 0) return [];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  return all.filter((entry) => entry.date >= cutoffStr);
}

/**
 * Group rejections by common themes to avoid repetitive lessons.
 */
function groupByTheme(entries: RejectionEntry[]): Map<string, RejectionEntry[]> {
  const groups = new Map<string, RejectionEntry[]>();

  for (const entry of entries) {
    const reason = entry.reason.toLowerCase();
    let theme = 'general';

    if (reason.includes('voice') || reason.includes('tone') || reason.includes('style')) {
      theme = 'voice-and-tone';
    } else if (reason.includes('generic') || reason.includes('vague') || reason.includes('filler')) {
      theme = 'specificity';
    } else if (reason.includes('fact') || reason.includes('stat') || reason.includes('data')) {
      theme = 'factual-accuracy';
    } else if (reason.includes('opening') || reason.includes('intro') || reason.includes('headline')) {
      theme = 'openings';
    } else if (reason.includes('structure') || reason.includes('flow') || reason.includes('transition')) {
      theme = 'structure';
    }

    const existing = groups.get(theme) ?? [];
    existing.push(entry);
    groups.set(theme, existing);
  }

  return groups;
}

/**
 * Build a "lessons learned" block to inject into the drafter's system
 * prompt. Returns an empty string if no recent rejections exist.
 */
export async function buildRejectionFeedbackBlock(): Promise<string> {
  const entries = await loadRecentRejections();
  if (entries.length === 0) return '';

  const grouped = groupByTheme(entries);

  const lessons: string[] = [
    '',
    '## Lessons from recent rejections (last 30 days)',
    '',
    `The following ${entries.length} drafts were rejected by human reviewers recently. Learn from these patterns and avoid repeating them:`,
    '',
  ];

  for (const [theme, themeEntries] of grouped) {
    lessons.push(`### ${theme} (${themeEntries.length} rejections)`);
    for (const entry of themeEntries.slice(0, 5)) {
      lessons.push(`- **${entry.slug}** (${entry.date}): ${entry.feedback}`);
    }
    lessons.push('');
  }

  lessons.push(
    '**Key takeaway:** Address these patterns proactively. Do not wait for the gates to catch them — write the first draft clean.',
  );

  return lessons.join('\n');
}

/**
 * Convenience: check if there's any feedback to inject.
 */
export async function hasRejectionFeedback(): Promise<boolean> {
  const entries = await loadRecentRejections();
  return entries.length > 0;
}
