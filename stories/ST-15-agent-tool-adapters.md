---
id: ST-15
title: Run coder sessions through an adapter per agent tool, so the coder can use another company's model
tier: normal
kind: workflow
depends_on: []
model: sonnet
blocked: "Held until steward's coder works (decided 2026-10-10 by the owner; docs/agent-workflow-design.md, Portability, Decided so far)"
---

## Intent

As the owner, I want the coder to be able to run on models from companies
other than Anthropic, so that the work is not all done by similar models, and
so that the workflow does not depend on any one company staying in business or
affordable. Goals 2 and 3 in `docs/agent-workflow-design.md`, "Purpose",
"Goals". The reviewer's half is ST-32.

**This is a placeholder for refinement, not a dispatchable story.** It will be
split before anything here is `ready`. The ACs below state the outcome only;
the real ones come from the answers to the open questions.

## Acceptance criteria

- [ ] **AC-1** — Provisional: the coder can be configured to run through a
      tool other than the Claude Code CLI, with no change to `story.mjs`,
      `loop.mjs` or `land.mjs`.
- [ ] **AC-2** — Provisional: before a tool runs the coder, tests show that the
      coder's guarantees hold for it (`docs/agent-workflow-design.md`,
      "Open questions", "Other companies' models (OQ-114)", M3).
- [ ] **AC-3** — Every `**Planned (…)**` marker in
      `docs/agent-workflow-design.md` that names OQ-114 is resolved as that
      document's "Reading this document" note says.

## Out of scope

- Moving the workflow to a repository of its own. That is OQ-115.
- Changing what the gate decides: verdicts, the round bound, landing.

## Constraints

*(none)*

## Context

Formerly tower-workshop-paths OQ-114. Its `depends_on` also named OQ-115, which
is tower-workshop-paths' own, so it was dropped at the move (design doc, R4: it
only meant "after the move").

- `docs/agent-workflow-design.md`: "Goals" and "Other companies' models
  (OQ-114)", in Part 1; "What ties the workflow to one company today", in
  Part 3, "Portability".
- `scripts/dispatch/spawn.mjs`, `invocation.mjs`, `outcome.mjs`,
  `coder-env.mjs`: the CLI-specific parts.
- `scripts/dispatch/review.mjs`, `chooseReviewerModel`: how the reviewer's
  model is kept different from the coder's today.
- OQ-54: one declared default coder model. M4 may rework or absorb it.
- OQ-62, OQ-73: the reviewer's and coder's guarantees still being built for
  the Claude Code CLI.
- **The reviewer's half is ST-32** (2026-10-15): running the reviewer through
  the Codex CLI, chosen in the settings, written from the first trial of Codex
  here (design doc, "Trials and measurements", "Codex as reviewer"). This
  story keeps the coder's half, which waits until steward's coder stories are
  built (owner, 2026-10-15; design doc, Part 3, "Decided so far").

## Open questions

M1 to M6, in `docs/agent-workflow-design.md`, "Open questions", "Other
companies' models (OQ-114)". Answers are recorded there as they are made.
