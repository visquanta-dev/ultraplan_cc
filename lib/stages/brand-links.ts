// ---------------------------------------------------------------------------
// Brand-link enrichment — wraps first mention of known third-party brands in
// post body text with external links.
//
// Fills the gap between auto-linker's two existing passes:
//   - insertExternalLinks: appends (per Source) attribution to paragraphs
//     whose source_id matches a bundle source. Does not touch brand mentions
//     in body prose.
//   - insertInternalLinks: wraps keywords with links to /blog or /pages on
//     visquanta.com. Internal only.
//
// This stage handles the third case: a brand name like CarGurus, AutoTrader,
// or CARFAX appears in body text; the reader expects a link to the brand's
// homepage so they can verify or dig deeper. Without this, SEO/AEO gates ding
// the post for "0 external citations" even when it mentions industry-leading
// third-party sources by name.
//
// Behavior:
//   - First mention per brand per post only (subsequent mentions remain plain).
//   - Skips any mention already inside existing [text](url) markdown so we
//     never double-wrap, even if the drafter wrote its own link.
//   - Word-boundary matching so "CarGurus" doesn't match inside a longer token.
// ---------------------------------------------------------------------------

interface BrandEntry {
  pattern: RegExp;
  url: string;
}

// Registry — add brands here as they become relevant to dealer-audience posts.
// Each pattern uses \b anchors so prefix/suffix collisions are impossible.
// When a brand has multiple casings that appear in real copy (e.g. CARFAX vs
// Carfax), list the dominant casing first so it wins ordering.
const BRANDS: BrandEntry[] = [
  { pattern: /\bCarGurus\b/, url: 'https://www.cargurus.com/' },
  { pattern: /\bAutoTrader\.com\b/, url: 'https://www.autotrader.com/' },
  { pattern: /\bAutoTrader\b(?!\.)/, url: 'https://www.autotrader.com/' },
  { pattern: /\bCars\.com\b/, url: 'https://www.cars.com/' },
  { pattern: /\bCARFAX\b/, url: 'https://www.carfax.com/' },
  { pattern: /\bCarfax\b/, url: 'https://www.carfax.com/' },
  { pattern: /\bEdmunds\b/, url: 'https://www.edmunds.com/' },
  { pattern: /\bKelley Blue Book\b/, url: 'https://www.kbb.com/' },
  { pattern: /\bKBB\b/, url: 'https://www.kbb.com/' },
  { pattern: /\bDealerRater\b/, url: 'https://www.dealerrater.com/' },
  { pattern: /\bDealer\.com\b/, url: 'https://www.dealer.com/' },
  { pattern: /\bNADA\b/, url: 'https://www.nada.org/' },
  { pattern: /\bCox Automotive\b/, url: 'https://www.coxautoinc.com/' },
  { pattern: /\bJ\.D\. Power\b/, url: 'https://www.jdpower.com/' },
  { pattern: /\bGoogle Business Profile\b/, url: 'https://www.google.com/business/' },
];

/**
 * Wrap first mention of each known brand with an external link.
 * Returns new paragraph array; original strings unchanged.
 *
 * @param paragraphs  Post body paragraphs (already voice-transformed).
 * @returns           Same shape, with brand mentions linked on first occurrence.
 */
export function insertBrandLinks(paragraphs: string[]): string[] {
  const linkedUrls = new Set<string>();

  return paragraphs.map((para) => {
    // Split on existing markdown links so we never wrap inside one.
    // Even indices in `parts` are plain text; odd indices are existing
    // [text](url) spans that must pass through untouched.
    const parts = para.split(/(\[[^\]]*\]\([^)]*\))/);

    const rebuilt = parts.map((part, i) => {
      if (i % 2 === 1) return part;
      let text = part;
      for (const { pattern, url } of BRANDS) {
        if (linkedUrls.has(url)) continue;
        const m = text.match(pattern);
        if (m && m.index !== undefined) {
          text =
            text.slice(0, m.index) +
            `[${m[0]}](${url})` +
            text.slice(m.index + m[0].length);
          linkedUrls.add(url);
        }
      }
      return text;
    });

    return rebuilt.join('');
  });
}

// Exposed for tests + potential config-file migration later.
export const __BRANDS_FOR_TEST = BRANDS;
