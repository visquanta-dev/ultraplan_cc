// Topical entity allow-list for the enrich stage.
// The LLM picks 2-3 entries from this list per post. Keeping a fixed allow-list
// prevents it from inventing Wikipedia URLs that 404 or sameAs-ing to
// entity pages that don't exist — both are EEAT-negative signals.
// When a new topic cluster emerges in the content plan, add the entry here
// and the enrich prompt picks it up automatically.

export interface TopicalEntity {
  name: string;
  sameAs: string;
}

export const ALLOWED_ENTITIES: TopicalEntity[] = [
  { name: 'Car dealership', sameAs: 'https://en.wikipedia.org/wiki/Car_dealership' },
  { name: 'Automotive industry', sameAs: 'https://en.wikipedia.org/wiki/Automotive_industry' },
  { name: 'Sales', sameAs: 'https://en.wikipedia.org/wiki/Sales' },
  { name: 'Lead generation', sameAs: 'https://en.wikipedia.org/wiki/Lead_generation' },
  { name: 'Customer relationship management', sameAs: 'https://en.wikipedia.org/wiki/Customer_relationship_management' },
  { name: 'Inventory management', sameAs: 'https://en.wikipedia.org/wiki/Inventory_management' },
  { name: 'Customer review', sameAs: 'https://en.wikipedia.org/wiki/Customer_review' },
  { name: 'Reputation management', sameAs: 'https://en.wikipedia.org/wiki/Reputation_management' },
  { name: 'Customer experience', sameAs: 'https://en.wikipedia.org/wiki/Customer_experience' },
  { name: 'Call centre', sameAs: 'https://en.wikipedia.org/wiki/Call_centre' },
  { name: 'Automobile repair shop', sameAs: 'https://en.wikipedia.org/wiki/Automobile_repair_shop' },
  { name: 'Marketing automation', sameAs: 'https://en.wikipedia.org/wiki/Marketing_automation' },
  { name: 'Conversion rate optimization', sameAs: 'https://en.wikipedia.org/wiki/Conversion_rate_optimization' },
  { name: 'Chatbot', sameAs: 'https://en.wikipedia.org/wiki/Chatbot' },
  { name: 'Voice user interface', sameAs: 'https://en.wikipedia.org/wiki/Voice_user_interface' },
  { name: 'Speech recognition', sameAs: 'https://en.wikipedia.org/wiki/Speech_recognition' },
  { name: 'Artificial intelligence', sameAs: 'https://en.wikipedia.org/wiki/Artificial_intelligence' },
  { name: 'Business process automation', sameAs: 'https://en.wikipedia.org/wiki/Business_process_automation' },
  { name: 'Return on investment', sameAs: 'https://en.wikipedia.org/wiki/Return_on_investment' },
  { name: 'Customer retention', sameAs: 'https://en.wikipedia.org/wiki/Customer_retention' },
];

export function renderAllowedEntitiesMarkdown(): string {
  return ALLOWED_ENTITIES.map((e) => `- ${e.name} — ${e.sameAs}`).join('\n');
}

/**
 * Filter an array of LLM-emitted entities against the allow-list. Drops any
 * entity whose sameAs URL does not exactly match a registered entry. The LLM
 * occasionally invents plausible-but-wrong Wikipedia URLs (e.g. `/wiki/Speed_to_lead`
 * which doesn't exist), so silent dropping is safer than shipping broken sameAs.
 */
export function filterToAllowed(
  emitted: Array<{ name?: unknown; sameAs?: unknown }>,
): TopicalEntity[] {
  const bySameAs = new Map(ALLOWED_ENTITIES.map((e) => [e.sameAs, e]));
  const out: TopicalEntity[] = [];
  const seen = new Set<string>();
  for (const raw of emitted) {
    const url = typeof raw?.sameAs === 'string' ? raw.sameAs.trim() : '';
    const canonical = bySameAs.get(url);
    if (canonical && !seen.has(canonical.sameAs)) {
      seen.add(canonical.sameAs);
      out.push(canonical);
    }
  }
  return out;
}
