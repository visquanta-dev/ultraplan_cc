// ---------------------------------------------------------------------------
// Bundle types — spec §5a "Research Bundle Assembly"
// The bundle is the ONLY thing the drafter is allowed to look at. Every
// paragraph in a draft must bind to a quote_id that exists in the bundle.
// These types define that contract.
// ---------------------------------------------------------------------------

/**
 * A single factual quote pulled verbatim from a source. Quotes are the atoms
 * of the bundle — every drafted paragraph anchors to one.
 */
export interface Quote {
  /**
   * Stable identifier of the form `<source_id>_q<n>`. Once assigned, a
   * quote_id must never change for the lifetime of the draft run.
   */
  quote_id: string;

  /**
   * The verbatim text. Must be copy-pasted from the source article, not
   * paraphrased. Gate b (fact recheck) re-fetches the source URL and
   * verifies this text still appears.
   */
  text: string;

  /**
   * Classification of the quote. `stat` is preferred because statistics
   * carry the most weight in dealer-audience writing.
   */
  type: 'stat' | 'claim' | 'opinion' | 'context';
}

/**
 * A source is one article/post that the bundle assembler found, scraped,
 * and extracted quotes from.
 */
export interface Source {
  /**
   * Stable identifier of the form `src_NNN` (3-digit zero-padded).
   */
  source_id: string;

  /**
   * Hostname without protocol or path. Used by the originality gate to
   * attribute n-gram overlap to a specific domain.
   */
  domain: string;

  /**
   * Canonical URL. Gate b re-fetches this URL during fact recheck.
   */
  url: string;

  /**
   * Article title as captured at scrape time.
   */
  title: string;

  /**
   * ISO 8601 publish date if available, otherwise null.
   */
  published: string | null;

  /**
   * 3–8 verbatim factual quotes extracted from this source. Spec §5a
   * specifies "factual sentences only, not opinion fluff" and "prefer
   * ones containing numbers/stats."
   */
  quotes: Quote[];
}

/**
 * A research bundle is the complete universe of evidence for one draft run.
 * Everything the drafter sees must come from here.
 */
export interface Bundle {
  /**
   * Identifier of the bundle, used as a filename: `bundle_<bundle_id>.json`.
   */
  bundle_id: string;

  /**
   * Editorial lane this bundle is assembled for. Determines word count
   * range, topic strategy, and which sources are allowed.
   */
  lane: 'daily_seo' | 'weekly_authority' | 'monthly_anonymized_case' | 'listicle';

  /**
   * Topic slug resolved from the cluster step (slot resolver — Phase 3).
   * In Phase 1, this is set manually when running smoke-bundle.ts.
   */
  topic_slug: string;

  /**
   * Product-aligned category id (from config/categories.yaml). Set by the
   * signal-driven resolver from the winning cluster's suggested_category.
   * Drives per-category CTA routing and cooldown accounting.
   * Optional because legacy callers (curated path) don't always set it.
   */
  category_id?: string;

  /**
   * Originate seed (operator-voice observation) — set when this bundle
   * was assembled via the originate path (step 6). The drafter uses this
   * as the primary cold-open hook, with competitor research as supporting
   * evidence. Undefined for the normal signal-driven / curated paths.
   */
  originate_seed?: string;

  /**
   * ISO 8601 timestamp when assembly completed.
   */
  assembled_at: string;

  /**
   * Array of sources contributing to this bundle. Must contain at least
   * one source — a bundle with zero sources is an error and drafting
   * cannot proceed.
   */
  sources: Source[];
}

/**
 * Input shape the assembler accepts for a single article. This is what
 * the source layer (firecrawl, apify) produces, normalized to one shape
 * regardless of provider.
 */
export interface ScrapedInput {
  url: string;
  title: string;
  publishedAt: string | null;
  rawText: string;
}
