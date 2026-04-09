# Voice Transform — Runtime Assembly Reference

The voice transform stage (`lib/stages/voice-transform.ts`) does not load
this file — it loads `config/voice/voice_prompt.md` and
`config/voice/exemplars.md` instead. Those files are the source of truth
for the system prompt.

This file exists as the pointer/index so that anyone exploring the
`workflows/blog-pipeline/prompts/` directory immediately understands that
the voice transform prompt lives in config/, not here.

## Why voice config lives in `config/voice/`

Voice is the thing that changes most often in response to human feedback.
Every rejected PR feeds the learning log (spec §8), which in turn tunes
the exemplars and the voice prompt over time. Putting those files under
`config/` instead of `workflows/blog-pipeline/prompts/` signals that they
are editorial configuration, not pipeline wiring.

## How the runtime assembles the prompt

`buildVoiceSystemPrompt()` in `lib/stages/voice-transform.ts` reads:

1. `config/voice/voice_prompt.md` — the non-negotiable rules and voice targets
2. `config/voice/exemplars.md` — 8+ voice exemplars from real visquanta.com posts

Then joins them with `\n\n---\n\n# Exemplars\n\n` and passes the whole
block as the system prompt to `callClaudeStructured()`.

## Editing the voice

1. Add or remove exemplars in `config/voice/exemplars.md` to shift voice.
2. Tighten or loosen rules in `config/voice/voice_prompt.md`.
3. Never edit the hardcoded rules in `lib/stages/voice-transform.ts`
   (paragraph-count-preservation, metadata integrity, JSON schema) — those
   are structural contracts, not stylistic choices.
