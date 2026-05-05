// ---------------------------------------------------------------------------
// Outbound link policy
//
// Competitor and adjacent vendor domains can be used as topic signals and
// research inputs, but published posts should not send referral traffic to
// them. Neutral trade press, analyst, regulatory, and data sources remain
// linkable so posts still carry credible external citations.
// ---------------------------------------------------------------------------

const COMPETITOR_OUTBOUND_DENYLIST = new Set([
  'podium.com',
  'fullpath.com',
  'impel.ai',
  'numa.com',
  'mia.inc',
  'matador.ai',
  'tecobi.com',
  'dealerai.com',
  'stellaautomotive.com',
  'gubagoo.com',
  'toma.com',
  'owini.ai',
  'bdc.ai',
  'useflai.com',
  'callrevu.com',
  'activengage.com',
  'drivecentric.com',
  'strolid.com',
  'useclearline.com',
  'dealershipaccelerator.io',
  'carnow.com',
  'autoalert.com',
]);

function normalizedHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function isCompetitorOutbound(url: string): boolean {
  const host = normalizedHost(url);
  return host ? COMPETITOR_OUTBOUND_DENYLIST.has(host) : false;
}
