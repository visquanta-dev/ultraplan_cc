# UltraPlan: VisQuanta Blog Portal — Design Spec

**Date:** 2026-04-09
**Author:** brainstormed with Claude (Opus 4.6)
**Status:** Draft for review
**Repo:** `visquanta-dev/ultraplan_cc`
**Target site:** `visquanta-dev/site` → visquanta.com
**Owner:** VisQuanta

---

## 1. Purpose

Build an autonomous, high-quality blog generation engine for visquanta.com that produces 3 posts per week across three editorial lanes (SEO, authority, anonymized case study), with every post grounded in reputable sources, voice-transformed into VisQuanta's tone, gated by five hard quality checks, and reviewed by a human via GitHub PR before publishing.

**This is explicitly NOT a content farm.** It is a source-first synthesis pipeline that uses the best available models at every step, without cost trade-offs, to produce content that would not be embarrassing to publish on the visquanta.com brand.

---

## 2. Core Architectural Principles

These five principles override every implementation decision. Any conflict between a principle and a feature is resolved in favor of the principle.

1. **No source = no sentence.** The drafter cannot output a paragraph without an attached citation to a verbatim quote in a research bundle assembled before drafting starts. Enforced via structured output schema.
2. **Reputable allowlist only.** Sources are not "the open web". A `sources.yaml` file whitelists exact domains. Anything off-list is rejected at scrape time.
3. **Five hard gates, none optional.** Drafts that fail any gate either retry (max 3 attempts) or are blocked from the human review queue entirely. The human only sees drafts that already cleared every machine bar.
4. **Human reviews only what passed.** GitHub PR review is the only surface where the human encounters drafts. Merge = publish. Close + reason = learning log entry. No silent publishing.
5. **Best model at every step, no cost trade-offs.** Cost is logged for awareness but never used as a selection criterion. Quality is the only axis.

---

## 3. Architecture Overview

```
                            ┌──────────────────────────────┐
                            │   topics.yaml (git-versioned)│
                            │   editorial calendar         │
                            └──────────────┬───────────────┘
                                           │
                  ┌────────────────────────▼────────────────────────┐
                  │   Vercel Cron (Mon/Wed/Fri 06:00 CT)            │
                  │   triggers Vercel Workflow (WDK)                │
                  └────────────────────────┬────────────────────────┘
                                           │
   ┌───────────────┬──────────────────┬────┴─────────────┬─────────────────┐
   │ 1. SLOT       │ 2. SCRAPE        │ 3. CLUSTER       │ 4. RESEARCH     │
   │ resolver      │ Firecrawl + Apify│ embed + group    │ BUNDLE assembly │
   │ (which lane?) │ (allowlisted)    │ trending signals │ verbatim quotes │
   └───────────────┴──────────────────┴────┬─────────────┴─────────────────┘
                                           │
                  ┌────────────────────────▼────────────────────────┐
                  │ 5. SOURCE-FIRST DRAFT (4 sub-stages)            │
                  │   5a. outline (anchored to quote_ids)           │
                  │   5b. paragraph draft (each ¶ → source_id)      │
                  │   5c. rephrase distance check (0.40–0.85)       │
                  │   5d. voice transform (few-shot exemplars)      │
                  └────────────────────────┬────────────────────────┘
                                           │
   ┌───────────────────────────────────────▼─────────────────────────────┐
   │ 6. FIVE HARD GATES (any failure = retry, then block — never human) │
   │   a. Trace-back: every ¶ links to a bundle URL                     │
   │   b. Fact-recheck: re-fetch every cited URL, verify claims         │
   │   c. Slop lexicon: zero banned phrases                             │
   │   d. Originality: <20% n-gram overlap with any single source       │
   │   e. Anonymization: zero client names                              │
   │ 6b. IMAGE GENERATION (Nano Banana Pro)                             │
   │   hero + inline images, brand-fit vision check                     │
   └───────────────────────────────────────┬─────────────────────────────┘
                                           │
                  ┌────────────────────────▼────────────────────────┐
                  │ 7. PR INTO visquanta-dev/site                   │
                  │ branch: ultraplan/<date>-<slug>                 │
                  │ files: content/blog/<slug>.md +                 │
                  │        public/images/blog/<slug>/*.webp         │
                  │ PR description = research bundle + gate report  │
                  └────────────────────────┬────────────────────────┘
                                           │
                  ┌────────────────────────▼────────────────────────┐
                  │ 8. step.waitForEvent('pr.merged' | 'pr.closed') │
                  │ Workflow PAUSES (no compute cost while waiting) │
                  └────────────────────────┬────────────────────────┘
                                           │ webhook
                  ┌────────────────────────▼────────────────────────┐
                  │ 9. POST-PUBLISH (on merge)                      │
                  │ analytics ping, internal-link audit, log run    │
                  │ OR (on close) write to rejection_log.jsonl      │
                  └─────────────────────────────────────────────────┘
```

### How this integrates with visquanta.com (no changes needed to the main site)

The visquanta.com blog already has a hybrid publishing system:

- `src/lib/seobot.ts` reads markdown files from `content/blog/*.md` (gray-matter frontmatter, marked-rendered HTML).
- Local markdown overrides SEObot's hosted CDN on slug collision.
- `src/lib/blog.ts`'s `getPostFeaturedImage()` falls through to the `image:` field in frontmatter for unknown headlines.

UltraPlan therefore writes:
- A markdown file at `content/blog/<slug>.md` with frontmatter (`title`, `slug`, `metaDescription`, `image`, `category`, `tags`, `publishedAt`)
- Image files at `public/images/blog/<slug>/hero.webp` (+ inline images for long lanes)

Both arrive in a single PR. Merging the PR triggers a Vercel deploy of visquanta.com within ~90 seconds. **No code changes are required in `visquanta-dev/site` to support UltraPlan** — the publishing path is already wired.

---

## 4. The Three Editorial Lanes

Cadence: **3 posts/week** to start. Easily expanded later by editing `topics.yaml`.

| Property | **Daily SEO** | **Weekly Authority** | **Monthly Anonymized Case** |
|---|---|---|---|
| Cadence | Mon 06:00 + Fri 06:00 (CT) | Wed 06:00 (CT) | Replaces Fri slot on 1st Friday of each month |
| Funnel target | ToFu | MoFu | BoFu |
| Word count | 1,000–1,400 | 1,800–2,400 | 2,200–3,000 |
| Sources | trade press, regulatory, reddit | LinkedIn dealer principals, trade press, reddit | trade press, regulatory, pattern-extracted |
| Topic strategy | trend_hijack | opinion_on_signal | pattern_extraction |
| Hero images | 1 | 1 + 2 inline | 1 + 3 inline |
| Review | PR review | PR review | PR review + anonymization re-scrub |
| Hard constraint | none | none | **no client names, ever** |

Net output per month: **~12 posts** (8 daily SEO + 4 weekly authority − 1 daily SEO replaced by the monthly case study).

### Topic strategies defined

- **trend_hijack** — scrape today's source set, cluster by topic, pick the cluster with highest signal (most sources covering it within 48hr) **AND** that fills an unfilled gap from the audit inputs.
- **opinion_on_signal** — scrape + cluster, pick a cluster where dealer principals on LinkedIn are actively reacting (controversial = good for opinion), filtered by gap map.
- **pattern_extraction** — scrape last 30 days, find patterns repeated across multiple sources (e.g. "5 sources mentioned after-hours coverage problems"), construct an anonymized "a midwest Hyundai store..." narrative — never tied to a real dealer.

### Slot resolution = trend ∩ gap

Trending alone does not qualify a topic. It must also fill a gap from `BLOG_FUNNEL_AUDIT.md`, an Ahrefs keyword gap report, or a missing slug from `SITEMAP.md`. This is how strategy and opportunism coexist.

---

## 5. Source-First Drafting Pipeline (Stage 5)

This is the heart of the system. The drafter never writes from a prompt alone — it transforms a pre-assembled research bundle through four sub-stages.

### 5a. Research Bundle Assembly (no LLM)

Pure code. Inputs: slot resolution + cluster from step 3. Output: `bundle.json` saved to Vercel Blob.

Per source, the bundle assembler captures:
- Title, author, publish date, canonical URL
- 3–8 verbatim quote blocks tagged with stable `quote_id` (factual sentences only, not opinion fluff)
- 1–3 specific numbers/stats with sentence context

Example bundle entry:

```json
{
  "source_id": "src_001",
  "domain": "automotivenews.com",
  "url": "https://www.automotivenews.com/dealers/...",
  "title": "Dealers Embrace AI Voice Agents to Cover After-Hours Calls",
  "published": "2026-03-28",
  "quotes": [
    {
      "quote_id": "src_001_q1",
      "text": "Group 1 Automotive reported that 38% of inbound service calls between 6 p.m. and 8 a.m. now route to an AI agent across its 12 pilot stores.",
      "type": "stat"
    }
  ]
}
```

The bundle is **the only thing the drafter is allowed to look at.** No web search at draft time. No general knowledge. The bundle is the universe.

### 5b. Outline Generation (Claude Opus 4.6, structured output)

LLM call #1. Produces a JSON outline where every section is pre-bound to source quotes. Schema **rejects** any section without `anchor_quotes`. Structurally impossible to draft a section that isn't grounded in evidence.

```json
{
  "headline": "Why After-Hours AI Coverage Is Becoming Table Stakes for Service",
  "lane": "weekly_authority",
  "sections": [
    {
      "heading": "The 6pm–8am gap nobody talks about",
      "anchor_quotes": ["src_001_q1", "src_003_q2"],
      "intent": "establish problem with stat"
    }
  ]
}
```

### 5c. Paragraph-Level Drafting (Claude Opus 4.6, structured output)

LLM call #2. Each paragraph is a JSON object with a **required** `source_id` and a `rephrase_distance` cosine-similarity score against the verbatim quote. Allowed range: **0.40 ≤ d ≤ 0.85**.

- Below 0.40 = LLM drifted from source → auto-regenerate
- Above 0.85 = too close to plagiarism → auto-regenerate

### 5d. Voice Transform (Claude Opus 4.6, few-shot)

LLM call #3. Final pass takes the drafted paragraphs and rewrites them through a few-shot prompt seeded with **8+ verbatim paragraphs from existing visquanta.com posts** loaded from `voice/exemplars.md`.

Prompt instruction: "Rewrite these factual paragraphs in the voice of these examples. Do not change facts. Do not add facts. Do not remove citations."

This is where the post starts to *sound* like VisQuanta instead of like ChatGPT. **The voice transform is the highest-risk piece of v1** because no automated gate can score voice fidelity objectively — only human taste, fed back through the rejection log, can tune it.

---

## 6. The Five Hard Gates (Stage 6)

| # | Gate | Mechanism | Pass criteria |
|---|---|---|---|
| **a** | **Trace-back** | For every paragraph, verify `source_id` exists in `bundle.json` and rephrase_distance is in band | 100% of paragraphs traceable |
| **b** | **Fact recheck** | Re-fetch every cited URL via Firecrawl. GPT-5 judge: "Does this sentence support this claim?" | ≥95% claim support |
| **c** | **Slop lexicon** | Regex scan for ~80 banned phrases in `voice/banned.txt` (`game-changer`, `revolutionize`, `unlock the power of`, `in today's fast-paced`, etc.) + Claude Opus 4.6 second-pass for "slop in spirit" | Zero hits on regex; LLM second-pass score ≥8/10 |
| **d** | **Originality** | Hash-based n-gram overlap check against bundle quotes + GPT-5 second-pass | <20% overlap with any single source |
| **e** | **Anonymization** | Regex against `clients_blocklist.yaml` (full dealer list from VisQuanta's client roster) + Claude Opus 4.6 pass | Zero hits, no exceptions |

**Failure handling:**
- Gate failure → loop back to drafting (max 3 retries)
- Still failing after 3 retries → log to admin dashboard "Blocked drafts" view, never reach human PR queue
- The system is biased toward "publish nothing" over "publish slop"

---

## 7. Image Generation Sub-Pipeline (Stage 6b)

**Provider:** OpenRouter
**Model:** Nano Banana Pro (`google/gemini-2.5-flash-image-preview-pro`) on every lane, every image. Best, not cheapest.
**Vision check model:** Gemini 2.5 Pro Vision (judge for brand-fit scoring).

### Per-lane style lock

Each lane has a `image_style_prompt` block in `config/image_styles/<lane>.yaml`. Prepended to every generation in that lane. Result: all daily SEO posts share one look, all weekly authority pieces share another, all monthly case studies share a third. Together they read as one publication.

### Image gates (within stage 6b)

1. **Aspect ratio + file size sanity check** (auto-fail malformed outputs)
2. **Banned-content check** via Gemini 2.5 Pro Vision: no human faces, no AI text artifacts, no copyrighted logos (NHTSA marks, OEM branding), no recognizable real cars
3. **Brand fit score** via Gemini 2.5 Pro Vision: 1–10 rubric, must score ≥7

Failed images regenerate (max 2 retries) before escalating to blocked drafts.

### Output

- Hero: `public/images/blog/<slug>/hero.webp` (1600×900)
- Inline (long lanes): `public/images/blog/<slug>/inline-1.webp`, `inline-2.webp`, `inline-3.webp`
- Frontmatter `image:` field updated to point to `/images/blog/<slug>/hero.webp`

---

## 8. The Review Flow

### The PR experience

Branch: `ultraplan/<yyyy-mm-dd>-<slug>`. PR contains:
1. `content/blog/<slug>.md`
2. `public/images/blog/<slug>/*.webp`
3. *(optional)* `content/blog/_metadata/<slug>.json` — slot resolution + gate report

Auto-applied labels: `lane:*`, `funnel:*`, `ultraplan-draft`, `ready-for-review`.

PR description = the gate report (sources, gate pass/fail, link to research bundle in Vercel Blob, link to original cluster signal).

### Three actions on a PR

1. **Merge** → Vercel auto-deploys visquanta.com (~90s). Webhook → workflow resumes from `step.waitForEvent` → step 9 (post-publish: analytics ping, internal-link audit, log as `published`).
2. **Request changes** with comment + push `regenerate` label → workflow resumes at step 5, feeding the comment back as a constraint. New draft = fresh PR.
3. **Close without merging** + add `rejection_reason:` label → workflow resumes, marks `rejected`, writes structured entry to `data/rejection_log.jsonl`.

### The learning log

```jsonl
{"date":"2026-04-12","slug":"after-hours-ai-coverage","lane":"weekly_authority","reason":"opening was too generic","feedback":"start with a specific scenario, not 'AI is changing X'"}
```

The **last 30 days of rejection feedback** is loaded into the drafter's system prompt as a "lessons learned" block on every subsequent run. Over 6 months, the rejection rate should drop measurably.

### The admin dashboard

Lightweight Next.js admin route at `/admin` (basic auth, single user). Five views:

| View | Purpose |
|---|---|
| **Pipeline status** | Currently-running runs, paused-for-review runs, completed today |
| **Blocked drafts** | Failed-gate drafts with failure reason + manual override button (rare escape hatch) |
| **PR queue** | Mirror of GitHub PRs with `ultraplan-draft` label |
| **Run history** | Last 90 days with status, gate scores, time, costs (logged, not enforced) |
| **Rejection log viewer** | Searchable log + auto-generated "lessons learned" preview |

### Failure modes and responses

1. **Scrape fails** → exponential backoff retry (3 attempts) → log to admin "Scrape failures" → skip source for this run
2. **Gate failure exhausts retries** → "Blocked drafts" view → human discards or manually overrides → slot logged as `failed_silent`
3. **PR creation fails** → retry 3 times → escalate via Slack webhook → draft preserved in Vercel Blob

**Critical:** no failure mode silently produces a bad post.

---

## 9. `topics.yaml` — The Steering Wheel

```yaml
version: 2026-Q2
timezone: America/Chicago

global_constraints:
  - never_mention_specific_clients
  - reputable_sources_only
  - source_first_drafting

lanes:
  daily_seo:
    cadence: "MON,FRI 06:00"
    funnel_target: ToFu
    word_count: { min: 1000, max: 1400 }
    sources: [trade_press, regulatory, reddit]
    topic_strategy: trend_hijack
    image: { count: 1, style: daily_seo }
    review: pr_only
    models:
      drafter: claude-opus-4-6
      judge: gpt-5
      image: google/gemini-2.5-flash-image-preview-pro

  weekly_authority:
    cadence: "WED 06:00"
    funnel_target: MoFu
    word_count: { min: 1800, max: 2400 }
    sources: [linkedin_dealer_principals, trade_press, reddit]
    topic_strategy: opinion_on_signal
    image: { count: 3, style: weekly_authority }
    review: pr_only
    models: { drafter: claude-opus-4-6, judge: gpt-5, image: google/gemini-2.5-flash-image-preview-pro }

  monthly_anonymized_case:
    cadence: "1ST FRI 06:00"   # replaces daily_seo Friday slot
    funnel_target: BoFu
    word_count: { min: 2200, max: 3000 }
    sources: [trade_press, regulatory]
    topic_strategy: pattern_extraction
    image: { count: 4, style: monthly_case_study }
    review: pr_plus_anonymization_rescrub
    hard_constraint: no_client_names
    models: { drafter: claude-opus-4-6, judge: gpt-5, image: google/gemini-2.5-flash-image-preview-pro }

audit_inputs:
  - sync: visquanta-dev/site/BLOG_FUNNEL_AUDIT.md
    purpose: gap_targeting
  - sync: visquanta-dev/site/ahref_reports/
    purpose: keyword_gaps
  - sync: visquanta-dev/site/SITEMAP.md
    purpose: avoid_duplicates
```

The whole editorial direction lives in **one git-versioned YAML file**.

---

## 10. Repo Structure

```
ultraplan_cc/
├── README.md
├── package.json
├── tsconfig.json
├── vercel.ts                      # cron schedule + project config
├── next.config.ts
├── .env.example
│
├── config/
│   ├── topics.yaml
│   ├── sources.yaml
│   ├── clients_blocklist.yaml
│   ├── image_styles/{daily_seo,weekly_authority,monthly_case_study}.yaml
│   └── voice/{exemplars.md,banned.txt,voice_prompt.md}
│
├── workflows/blog-pipeline/
│   ├── index.ts                   # WDK workflow definition
│   ├── steps/                     # 01-resolve-slot ... 09-post-publish
│   └── prompts/                   # outline, paragraph-draft, voice-transform, judges
│
├── lib/
│   ├── sources/{firecrawl,apify-linkedin,apify-reddit,trade-press,nhtsa}.ts
│   ├── llm/{openrouter,claude-opus,gpt5,nano-banana}.ts
│   ├── github.ts
│   ├── blob-store.ts
│   └── supabase.ts
│
├── app/                           # Next.js App Router
│   ├── api/cron/trigger/route.ts
│   ├── api/webhooks/{github-pr,workflow-resume}/route.ts
│   ├── api/admin/{runs,blocked,reject}/route.ts
│   └── admin/{page,blocked,runs,rejections}/page.tsx
│
├── data/
│   ├── rejection_log.jsonl
│   └── slot_resolutions/
│
├── inputs/                        # synced from visquanta-dev/site at runtime
│
└── docs/superpowers/specs/2026-04-09-visquanta-blog-portal-design.md
```

### Required environment variables

```
# LLM providers
OPENROUTER_API_KEY=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=

# Scraping
FIRECRAWL_API_KEY=
APIFY_API_TOKEN=

# Storage
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
BLOB_READ_WRITE_TOKEN=

# GitHub PR creation + merge webhook
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_INSTALLATION_ID=
GITHUB_WEBHOOK_SECRET=

# Admin auth
ADMIN_BASIC_AUTH_USER=
ADMIN_BASIC_AUTH_PASS=

# Notifications
SLACK_WEBHOOK_URL=
```

---

## 11. Bootstrap Sequence (Build Order)

| # | Phase | Demonstrable result |
|---|---|---|
| 1 | Repo + scaffolding (Next.js 16 + TS, link to Vercel) | `ultraplan_cc` deploys to a Vercel preview URL |
| 2 | Config files (no code) — `topics.yaml`, `sources.yaml`, `clients_blocklist.yaml`, `voice/exemplars.md`, `voice/banned.txt` | Config exists, human-reviewed before any code reads it |
| 3 | Source layer — Firecrawl + Apify wrappers, one-shot scrape | Real article quotes pulled from real sources |
| 4 | Bundle assembler (5a) | Real `bundle.json` for a real topic |
| 5 | First end-to-end draft (5a→5d), local file output, no PR | **First real draft for human review (the "see content" milestone)** |
| 6 | Five gates (6a→6e) added one at a time | First draft makes it through all gates |
| 7 | Image generation (6f) — Nano Banana Pro + vision check | Draft now has a real generated image |
| 8 | GitHub PR creation (7) — GitHub App, manual trigger | **First real PR in `visquanta-dev/site`** |
| 9 | Webhook + workflow resume (8 + 9) — merge webhook, post-publish | Full happy path end-to-end |
| 10 | Wrap in Vercel Workflow + Cron | Cron fires, real PR opens automatically |
| 11 | Admin dashboard | Five admin views live |
| 12 | Rejection learning loop | System learns from human taste |
| 13 | Hardening + observability — error handling, retries, Slack notifications | Robust enough for unattended operation |

**Steps 1–9 are intentionally a manual happy path.** No automation gets built on top of mediocre output. Steps 5–7 are where voice tuning happens before the cron is enabled.

### GitHub-side authorizations needed

Both require explicit human approval at step 8:

1. **Create a GitHub App** in `visquanta-dev` org with `contents: write` and `pull_requests: write` scopes, install on `visquanta-dev/site` only.
2. **Add a webhook** on `visquanta-dev/site` for `pull_request.closed` events pointing to `https://ultraplan-cc.vercel.app/api/webhooks/github-pr`.

Neither touches visquanta.com production directly — they only let one repo open PRs into another.

---

## 12. Definition of Done (v1)

v1 is complete when **all** of the following are true:

1. `topics.yaml` cron fires automatically on Mon/Wed/Fri at 06:00 CT.
2. Each fire produces a research bundle, draft, image, gates, and either opens a PR or logs a blocked draft — without manual intervention.
3. PRs land in `visquanta-dev/site` with gate report, sources, and image attached.
4. Merging the PR resumes the workflow and runs post-publish steps.
5. Closing a PR with a `rejection_reason:` label writes to the learning log.
6. Admin dashboard shows pipeline status, blocked drafts, run history, rejection log.
7. **Human has personally approved at least 5 generated posts as "I'd be proud to publish this"** before cron flips from manual to automatic.

The cron stays off until 5 consecutive drafts pass the human taste bar. No exceptions.

---

## 13. Success Metrics (30 / 60 / 90 days post-launch)

| Metric | 30d | 60d | 90d |
|---|---|---|---|
| Posts published | 12 | 24 | 36 |
| Gate pass rate (drafts → PR) | ≥60% | ≥75% | ≥85% |
| PR merge rate (human approval) | ≥40% | ≥60% | ≥75% |
| Avg human time per post | ≤10 min | ≤7 min | ≤5 min |
| Rejection → prompt improvement cycles | 1 | 2 | 3 |

PR merge rate climbing 40% → 75% over 90 days proves the learning loop is working.

---

## 14. Out of Scope for v1 (Deferred)

| Feature | Why deferred |
|---|---|
| Real anonymized client outcome data feeding case study lane | Requires sanitized data source; revisit later |
| Multilingual posts (`/ca/blog`) | Ship English first |
| LinkedIn auto-cross-posting | Easy add later |
| Newsletter auto-send | Same |
| Custom voice fine-tuned model from rejection log | Need ~6 months of data first |
| Multi-author voice variation | Single voice in v1 |
| Video script lane | Add by editing `topics.yaml` once core stable |
| Automatic internal-link auto-edits | Step 9 audits but doesn't auto-edit; v2 adds suggestions to PR |
| Comments / discussion | Out of scope |

---

## 15. Highest-Risk Piece of v1

**The voice transform step (5d).** Everything else is mechanical engineering. The voice transform is the only step that's *aesthetic* and the only step that determines whether output sounds like VisQuanta or like a content farm.

No automated gate can score "voice fidelity" objectively. The five gates catch slop, plagiarism, hallucination, and naming violations — they cannot catch "this is technically correct and reads like a robot."

Only human taste, fed back through the rejection log, can fix that. This is why bootstrap steps 5–7 (manual draft review before automation) matter so much: that's the window where voice gets tuned to the human's bar before the cron starts producing 12 posts/month at it.

---

## 16. Open Questions (To Resolve Before Plan Stage)

None. All design decisions made and approved in brainstorming. The next stage is the implementation plan, produced by the writing-plans skill.

---

## 17. Approvals Log

- 2026-04-09 — Sections 1–6 each approved iteratively during brainstorm
- 2026-04-09 — Spec doc written (this file)
- _Pending_ — Human review of this spec
- _Pending_ — Implementation plan generated
