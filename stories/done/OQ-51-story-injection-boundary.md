---
id: OQ-51
title: Mark where an injected block ends, so it cannot shadow the prompt
tier: next
kind: workflow
depends_on: []
model: sonnet
blocked: null
---

## Intent

As whoever assembles a spawn prompt, I need every injected block to be clearly
bounded within it, so that text I did not write cannot be read as an instruction
to the agent receiving it. There are two such blocks: the story, in both
prompts, and the PR description, in the reviewer's.

## Acceptance criteria

- [ ] **AC-1** — The assembled prompt marks unambiguously where each injected
      block begins and ends, and those markers are present regardless of what
      the block contains. There are two: `{{STORY}}` in both prompts, and
      `{{PR_BODY}}` in the reviewer's.
- [ ] **AC-2** — No heading in an injected block appears at the same structural
      level as the prompt's own top-level sections.
- [ ] **AC-3** — An injected block crafted to collide — one containing a heading
      matching a real section of the prompt, such as `## Your verdict` — does
      not shadow or displace the prompt's own section of that name. This holds
      for a hostile story and for a hostile PR description alike; the PR body is
      the less trusted of the two, since the story is authored by a planning
      session and the body by the agent under review.
- [ ] **AC-4** — A test exercises AC-1 to AC-3 against such deliberately
      hostile fixtures, not merely against well-behaved ones.
- [ ] **AC-5** — Assembling either prompt against a real story still leaves no
      unsubstituted `{{PLACEHOLDER}}`, which holds today and must keep holding.

## Out of scope

- Spawning anything, parsing a verdict, budgets or timeouts. Assembly of the
  prompt text only.
- Changing what either prompt says. This is about how the story is framed when
  inserted, not about the instructions around it.
- Validating the story's schema. That is a separate CI concern.

## Constraints

- Node, ESM, no new runtime dependencies, consistent with the rest of
  `scripts/`.

## Context

Found on 2026-09-18 while checking the Phase 0 exit criterion "both prompts
render against a story file". They do render — every placeholder used is
documented, every one documented is used, and assembling either against OQ-49
leaves nothing unsubstituted. The defect is in the *shape* of the result.

The assembled reviewer prompt's heading outline reads:

```
## The story this PR is meant to implement
## Intent                        <- story
## Acceptance criteria           <- story
## Out of scope                  <- story
## Constraints                   <- story
## Context                       <- story
## Open questions                <- story
## The pull request's own description
## What changed                  <- PR body
## Verification                  <- PR body
## Docs check                    <- PR body
## What review is                <- the prompt again, same level, no marker
```

Nothing separates either injected block from the instructions. Three
consequences, getting worse as they go:

1. `## Out of scope` and `## Constraints` belong to the story but read as
   constraints on the review.
2. The story's `## Context` names files as "the house style to match" —
   guidance meant for the *coder* — and in the reviewer's assembled prompt it
   sits as a top-level section indistinguishable from the reviewer's own.
3. Injected text is spliced into an instruction document at the same structural
   level as the instructions. A block containing `## Your verdict` would shadow
   the prompt's real section. That is a prompt-injection-shaped surface in a
   file whose own preamble exists because this project once shipped a prompt
   that a reviewer correctly refused as an injection attack.

Nothing assembles these automatically yet, so this is latent rather than live —
which is the cheapest moment to fix it.

- `.claude/prompts/reviewer.md`, `.claude/prompts/coder.md` — the `{{STORY}}`
  and `{{PR_BODY}}` placeholders and the sections around them
- `docs/agent-workflow-design.md`, "Credential minimalism" — the prior instance
  of a spawn prompt drifting into injection shape.

**Updated 2026-09-18**, after the first hand-run of the loop: the reviewer
prompt now also injects `{{PR_BODY}}`, so there are two blocks to bound rather
than one. The PR description is the more dangerous of the two — a story is
written by a planning session, whereas the body is written by the very agent
whose diff is under review, which makes "text the author controls" and "text
instructing the reviewer" the same bytes.

**Updated 2026-09-19. This story now owns `scripts/dispatch/render.mjs`**, and
its open question — *where does assembly live?* — is settled: a separate tested
module with pure functions behind a thin caller, matching `queue.mjs` and
`coder-env.mjs`, rather than folding assembly into `spawn.mjs`. OQ-65 declares
`depends_on: [OQ-51]` and calls it. Deciding it here rather than there is what
stops a coder inventing the module boundary as a side effect, which is what this
section warned about.

Two requirements on `render.mjs` came out of running the loop by hand, both
beyond bounding the blocks:

- **The leftover check must not be fooled by injected content.** Rendering the
  reviewer against OQ-63's PR produced a body that contained the coder's proposed
  diff *of `coder.md`*, which legitimately includes `{{BRANCH}}` and
  `{{STORY_PATH}}`. A renderer that scans its finished output for `{{...}}` reads
  those as unsubstituted placeholders and refuses to assemble a valid prompt. The
  check has to run against template text, before injection — masking each real
  placeholder and scanning in between works.
- **Both directions of the placeholder contract must be asserted.** Every
  placeholder used must be documented and every documented one used. That check
  is what found `{{STORY_PATH}}` documented-but-unused in `reviewer.md`, and a
  Phase 0 exit criterion claiming it had been verified when it had not.
  Documented-but-unused should warn rather than fail, so a defect in a prompt
  file cannot take a dispatch down with it.

A third injected block is coming: a retry carries review findings, and there is
no `{{FINDINGS}}` placeholder yet (OQ-65's **Context**). Whichever story adds it,
the bounding here must cover it rather than being written for exactly two.

## Open questions

*(none)*
