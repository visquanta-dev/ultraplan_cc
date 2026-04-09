# UltraPlan — VisQuanta Blog Portal

Autonomous, high-quality blog generation engine for [visquanta.com](https://visquanta.com). Produces 3 source-grounded posts per week across three editorial lanes (daily SEO, weekly authority, monthly anonymized case study), gated by five hard quality checks and reviewed by a human via GitHub PR before publishing.

## Status

**Phase 0 — Design complete.** The full 532-line design spec is at [`docs/superpowers/specs/2026-04-09-visquanta-blog-portal-design.md`](docs/superpowers/specs/2026-04-09-visquanta-blog-portal-design.md). Every architectural decision is finalized there.

**Phase 1 — Bootstrap Steps 1–5** is the current build target. See the implementation plan at `~/.claude/plans/async-riding-leaf.md`.

**Live preview:** [ultraplan-cc.vercel.app](https://ultraplan-cc.vercel.app) — auto-deploys from `main` via Vercel GitHub integration on the `vis-quanta` team.

## Core principles (from spec §2)

1. **No source = no sentence.** Every paragraph binds to a verbatim quote in a pre-assembled research bundle.
2. **Reputable allowlist only.** Sources are whitelisted in `config/sources.yaml` — no open-web scraping.
3. **Five hard gates, none optional.** Drafts that fail any gate retry (max 3) or are blocked from the human review queue.
4. **Human reviews only what passed.** GitHub PR review is the only publishing surface. Merge = publish.
5. **Best model at every step.** Quality is the only selection axis — cost is logged, never enforced.

## How it publishes

UltraPlan opens PRs into [`visquanta-dev/site`](https://github.com/visquanta-dev/site) with:
- `content/blog/<slug>.md` (frontmatter compatible with the existing `src/lib/seobot.ts` parser)
- `public/images/blog/<slug>/*.webp` (hero + inline images)

The main visquanta.com site already supports local markdown overrides via its hybrid SEObot + local-content loader. **No changes to the main site are required for UltraPlan to publish.**

## Repo layout (target — populated incrementally)

```
ultraplan_cc/
├── README.md                        ← this file
├── vercel.ts                        ← Vercel project config
├── package.json
├── config/
│   ├── topics.yaml                  ← editorial calendar
│   ├── sources.yaml                 ← allowlisted domains
│   ├── clients_blocklist.yaml       ← anonymization blocklist
│   ├── voice/{exemplars.md,banned.txt,voice_prompt.md}
│   └── image_styles/{daily_seo,weekly_authority,monthly_case_study}.yaml
├── workflows/blog-pipeline/         ← Vercel Workflow (WDK) definition
├── lib/
│   ├── sources/                     ← Firecrawl + Apify wrappers
│   ├── bundle/                      ← research bundle assembler (pure code)
│   ├── llm/                         ← Claude Opus, GPT-5, Nano Banana clients
│   └── stages/                      ← outline, paragraph-draft, rephrase, voice
├── app/                             ← Next.js App Router (admin + API routes)
├── data/rejection_log.jsonl         ← learning loop input
└── docs/superpowers/specs/          ← design spec lives here
```

## Links

- **Design spec:** [`docs/superpowers/specs/2026-04-09-visquanta-blog-portal-design.md`](docs/superpowers/specs/2026-04-09-visquanta-blog-portal-design.md)
- **Target site:** [`visquanta-dev/site`](https://github.com/visquanta-dev/site) → visquanta.com
- **Owner:** VisQuanta
