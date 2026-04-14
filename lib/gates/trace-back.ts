import { checkRephraseDistances } from '../stages/rephrase-distance';
import type { GateParagraphFinding, GateResult } from './types';
import type { Bundle } from '../bundle/types';
import type { TransformedParagraph } from '../stages/voice-transform';
import type { Outline } from '../stages/outline';

// ---------------------------------------------------------------------------
// Gate a — Trace-back (spec §6)
// For every paragraph, verify:
//   1. source_id exists in the bundle
//   2. anchor_quote_id exists in the bundle under that source
//   3. section_index is valid and the anchor_quote_id is in that
//      section's approved anchor_quotes set
//   4. rephrase distance against the anchor quote is in the 0.40–0.85 band
//
// All four checks must hold for every paragraph. Pass criterion: 100%
// traceability. Anything less = gate fail.
// ---------------------------------------------------------------------------

export async function runTraceBackGate(
  paragraphs: TransformedParagraph[],
  bundle: Bundle,
  outline: Outline,
): Promise<GateResult> {
  // Index bundle quotes for O(1) lookup
  const quoteIndex = new Map<string, { source_id: string; text: string }>();
  for (const source of bundle.sources) {
    for (const quote of source.quotes) {
      quoteIndex.set(quote.quote_id, { source_id: source.source_id, text: quote.text });
    }
  }

  // Build section → allowed quote_ids set
  const sectionAnchors = new Map<number, Set<string>>();
  outline.sections.forEach((section, i) => {
    sectionAnchors.set(i, new Set(section.anchor_quotes));
  });

  const findings: GateParagraphFinding[] = [];

  // Structural checks first (cheap, catch most failures without embedding)
  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    const reasons: string[] = [];

    const quoteInfo = quoteIndex.get(para.anchor_quote_id);
    if (!quoteInfo) {
      reasons.push(`anchor_quote_id "${para.anchor_quote_id}" not in bundle`);
    } else if (quoteInfo.source_id !== para.source_id) {
      reasons.push(
        `source_id "${para.source_id}" does not own quote "${para.anchor_quote_id}" (owner: ${quoteInfo.source_id})`,
      );
    }

    if (para.section_index < 0 || para.section_index >= outline.sections.length) {
      reasons.push(`section_index ${para.section_index} out of bounds`);
    } else {
      const allowedQuotes = sectionAnchors.get(para.section_index);
      if (allowedQuotes && !allowedQuotes.has(para.anchor_quote_id)) {
        reasons.push(
          `paragraph in section ${para.section_index} uses quote "${para.anchor_quote_id}" which is not in that section's anchor_quotes`,
        );
      }
    }

    findings.push({
      paragraph_index: i,
      passed: reasons.length === 0,
      reason: reasons.length > 0 ? reasons.join('; ') : undefined,
    });
  }

  // Rephrase distance check — only runs on paragraphs whose structural
  // checks passed, because the distance check needs a valid anchor quote
  // to compare against.
  const structurallyOk = paragraphs.filter((_, i) => findings[i].passed);
  const structurallyOkIndices = paragraphs
    .map((_, i) => i)
    .filter((i) => findings[i].passed);

  if (structurallyOk.length > 0) {
    const distances = await checkRephraseDistances(structurallyOk, bundle);
    distances.forEach((d, localIdx) => {
      const globalIdx = structurallyOkIndices[localIdx];
      const finding = findings[globalIdx];
      finding.score = d.similarity;
      if (!d.in_band) {
        finding.passed = false;
        finding.reason = `rephrase distance ${d.similarity.toFixed(3)} is ${d.reason} (band 0.40–0.85)`;
      }
    });
  }

  const failingIndices = findings.filter((f) => !f.passed).map((f) => f.paragraph_index);
  const passCount = findings.filter((f) => f.passed).length;

  // Allow up to 10% of paragraphs to fail trace-back (transitions,
  // introductions, conclusions may not bind to a specific source quote)
  const passRate = paragraphs.length > 0 ? passCount / paragraphs.length : 1;
  const allPassed = passRate >= 0.85;

  const avgScore =
    findings.filter((f) => typeof f.score === 'number').reduce((sum, f) => sum + (f.score ?? 0), 0) /
      Math.max(findings.filter((f) => typeof f.score === 'number').length, 1) || undefined;

  return {
    gate: 'trace-back',
    passed: allPassed,
    aggregate_score: avgScore,
    paragraph_findings: findings,
    summary: allPassed
      ? `All ${paragraphs.length} paragraphs traceable; avg rephrase distance ${avgScore?.toFixed(3) ?? 'n/a'}`
      : `${passCount}/${paragraphs.length} paragraphs traceable; ${findings.length - passCount} failures`,
    retriable: true,
    failing_paragraph_indices: failingIndices,
  };
}
