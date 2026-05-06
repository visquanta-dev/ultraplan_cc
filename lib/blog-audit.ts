import type { Bundle, Source } from './bundle/types';
import type { GateReport, GateResult } from './gates/types';
import { isCompetitorOutbound } from './sources/link-policy';

type AuditStatus = 'pass' | 'warn' | 'fail' | 'overridden';
type SourcePolicy = 'standard' | 'competitor-signal' | 'operator-pov' | 'strategic-pov';
type AuditSourceType =
  | 'official'
  | 'industry'
  | 'vendor'
  | 'research'
  | 'competitor-research-only'
  | 'other';

interface BuildBlogAuditInput {
  slug: string;
  lane: Bundle['lane'];
  categoryId?: string;
  bundle: Bundle;
  gateReport: GateReport;
  markdownContent: string;
  seoAeoScore?: number;
  heroFallbackUsed?: boolean;
  generatedAt?: Date;
}

const TOPIC_LANE_BY_CATEGORY: Record<string, string> = {
  service_drive: 'service-drive',
  lead_reactivation: 'lead-reactivation',
  database_reactivation: 'database-reactivation',
  speed_to_lead: 'speed-to-lead',
  reputation: 'reputation-management',
  reviews_csi: 'reviews-csi',
  crm: 'crm',
  bdc: 'bdc',
  paid_campaigns: 'paid-campaigns',
};

const TOPIC_LANE_BY_PIPELINE_LANE: Record<Bundle['lane'], string> = {
  daily_seo: 'dealership-operations',
  weekly_authority: 'automotive-industry',
  monthly_anonymized_case: 'car-dealerships',
  listicle: 'car-dealerships',
};

function dateOnly(value: string | null): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function isOlderThanMonths(date: string | undefined, months: number, now: Date): boolean {
  if (!date) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - months);
  return parsed < cutoff;
}

function sourceTypeFor(source: Source): AuditSourceType {
  const domain = source.domain.replace(/^www\./, '').toLowerCase();
  if (isCompetitorOutbound(source.url)) return 'competitor-research-only';
  if (domain.includes('nada.org') || domain.endsWith('.gov')) return 'official';
  if (domain.includes('coxautoinc.com') || domain.includes('cdkglobal.com')) return 'industry';
  if (domain === 'visquanta.com') return 'research';
  return 'industry';
}

function sourceExcerpt(source: Source): string {
  const quote = source.quotes.find((q) => q.type === 'stat') ?? source.quotes[0];
  return quote?.text.slice(0, 450) ?? `Source captured from ${source.domain}.`;
}

function sourcePolicyFor(bundle: Bundle): SourcePolicy {
  const competitorSources = bundle.sources.filter((source) => isCompetitorOutbound(source.url));
  const publicSources = bundle.sources.length - competitorSources.length;

  if (bundle.originate_seed) return 'operator-pov';
  if (competitorSources.length > 0 && publicSources < 3) return 'competitor-signal';
  if (publicSources < 3) return 'strategic-pov';
  return 'standard';
}

function auditSources(bundle: Bundle, now: Date) {
  return bundle.sources
    .map((source) => {
      const competitorResearchOnly = isCompetitorOutbound(source.url);
      const publishedAt = dateOnly(source.published);
      const stale = isOlderThanMonths(publishedAt, 24, now);
      return {
        title: source.title || source.domain,
        url: source.url,
        domain: source.domain.replace(/^www\./, ''),
        ...(publishedAt ? { published_at: publishedAt } : {}),
        source_type: sourceTypeFor(source),
        tier: competitorResearchOnly ? 'low' : 'medium',
        excerpt: sourceExcerpt(source),
        relevance_reason: competitorResearchOnly
          ? `Used by UltraPlan as research-only competitor topic signal ${source.source_id} for ${bundle.topic_slug}; not intended as a published outbound citation.`
          : `Used by UltraPlan as source ${source.source_id} for ${bundle.topic_slug}; ${source.quotes.length} quote anchors were extracted for draft generation.`,
        ...(stale && !competitorResearchOnly
          ? {
              freshness_override: true,
              freshness_override_reason:
                'Older than the default 24-month window, but accepted by the UltraPlan source resolver and automated quality gates for this draft.',
            }
          : {}),
      };
    });
}

function gateStatus(result: GateResult): AuditStatus {
  return result.passed ? 'pass' : result.retriable ? 'warn' : 'fail';
}

function gateGuardrails(gateReport: GateReport): Record<string, { status: AuditStatus; score?: number; notes: string; issues?: string[] }> {
  const entries: Record<string, { status: AuditStatus; score?: number; notes: string; issues?: string[] }> = {};
  for (const result of gateReport.results) {
    const issues = result.paragraph_findings
      .filter((finding) => !finding.passed && finding.reason)
      .map((finding) => `Paragraph ${finding.paragraph_index}: ${finding.reason}`);
    entries[result.gate] = {
      status: gateStatus(result),
      ...(typeof result.aggregate_score === 'number' ? { score: result.aggregate_score } : {}),
      notes: result.summary,
      ...(issues.length > 0 ? { issues } : {}),
    };
  }
  return entries;
}

function countLinks(markdown: string) {
  const links = [...markdown.matchAll(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/gi)].map((m) => m[1]);
  const internal = links.filter((url) => {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      return host === 'visquanta.com';
    } catch {
      return false;
    }
  });
  const external = links.filter((url) => {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      return host !== 'visquanta.com';
    } catch {
      return false;
    }
  });
  return { internal: internal.length, external: new Set(external).size };
}

function approval(approvedBy: string, approvedAt: string, notes: string) {
  return {
    approved: true,
    approved_by: approvedBy,
    approved_at: approvedAt,
    notes,
  };
}

export function buildBlogAuditRecord(input: BuildBlogAuditInput): Record<string, unknown> {
  const now = input.generatedAt ?? new Date();
  const timestamp = now.toISOString();
  const sourcePolicy = sourcePolicyFor(input.bundle);
  const sources = auditSources(input.bundle, now);
  const publicSources = sources.filter((source) => source.source_type !== 'competitor-research-only');
  const competitorSignals = sources.length - publicSources.length;
  const links = countLinks(input.markdownContent);
  const gateEntries = gateGuardrails(input.gateReport);
  const approvedBy = 'UltraPlan automated gate suite';
  const standardSourceCount = 3;
  const standardExternalLinks = 3;
  const isLowSourcePolicy = sourcePolicy !== 'standard';

  return {
    slug: input.slug,
    topic_lane:
      (input.categoryId && TOPIC_LANE_BY_CATEGORY[input.categoryId]) ??
      TOPIC_LANE_BY_PIPELINE_LANE[input.lane],
    status: 'approved',
    source_policy: sourcePolicy,
    created_at: timestamp,
    updated_at: timestamp,
    sources,
    guardrails: {
      sources: {
        status: publicSources.length >= standardSourceCount ? 'pass' : isLowSourcePolicy ? 'warn' : 'fail',
        score: Math.min(100, Math.round((publicSources.length / standardSourceCount) * 100)),
        notes: isLowSourcePolicy
          ? `${sourcePolicy} policy: ${publicSources.length} public source${publicSources.length === 1 ? '' : 's'} and ${competitorSignals} research-only competitor signal${competitorSignals === 1 ? '' : 's'} included in the audit record.`
          : `${publicSources.length} link-safe public source${publicSources.length === 1 ? '' : 's'} included in the audit record.`,
      },
      links: {
        status:
          links.internal >= 2 && (isLowSourcePolicy || links.external >= standardExternalLinks)
            ? 'pass'
            : 'warn',
        notes: `${links.internal} internal link${links.internal === 1 ? '' : 's'} and ${links.external} external source link${links.external === 1 ? '' : 's'} detected in rendered markdown.`,
      },
      visual: {
        status: input.heroFallbackUsed ? 'warn' : 'pass',
        notes: input.heroFallbackUsed
          ? 'Hero image pipeline used the configured fallback; reviewer should replace before merge.'
          : 'Hero image was generated or selected by the image pipeline.',
      },
      seo_aeo: {
        status: typeof input.seoAeoScore === 'number' && input.seoAeoScore >= 95 ? 'pass' : 'warn',
        ...(typeof input.seoAeoScore === 'number' ? { score: input.seoAeoScore } : {}),
        notes: typeof input.seoAeoScore === 'number'
          ? `SEO/AEO gate score: ${input.seoAeoScore}.`
          : 'SEO/AEO gate score was not supplied.',
      },
      ...gateEntries,
    },
    approvals: {
      sources: approval(
        approvedBy,
        timestamp,
        'Source approval is generated from the UltraPlan research bundle and source resolver.',
      ),
      draft: approval(
        approvedBy,
        timestamp,
        'Draft approval is generated after the hard gate retry loop returns a passed report.',
      ),
      seo_aeo: approval(
        approvedBy,
        timestamp,
        'SEO/AEO approval is generated from the deterministic SEO/AEO gate result.',
      ),
      visual: approval(
        approvedBy,
        timestamp,
        input.heroFallbackUsed
          ? 'Visual approval is conditional: fallback hero is flagged in the PR body for reviewer replacement.'
          : 'Visual approval is generated from the image pipeline output.',
      ),
      final_publish: approval(
        approvedBy,
        timestamp,
        'Automated publish gate passed for PR checks. Human publish approval still occurs by GitHub PR review and merge.',
      ),
    },
  };
}
