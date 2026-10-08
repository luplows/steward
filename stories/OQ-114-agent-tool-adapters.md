---
id: OQ-114
title: Run coder and reviewer sessions through an adapter per agent tool, so a role can use another company's model
tier: normal
kind: workflow
depends_on: [OQ-115]
model: sonnet
blocked: null
---

## Intent

As the owner, I want the coder and the reviewer to be able to run on models
from companies other than Anthropic, so that the work is not all done by
similar models, and so that the workflow does not depend on any one company
staying in business or affordable. Goals 2 and 3 in
`docs/agent-workflow-design.md`, "Portability".

**This is a placeholder for refinement, not a dispatchable story.** It will be
split before anything here is `ready`. The ACs below state the outcome only;
the real ones come from the answers to the open questions.

## Acceptance criteria

- [ ] **AC-1** — Provisional: a role (coder or reviewer) can be configured to
      run through a tool other than the Claude Code CLI, with no change to
      `story.mjs`, `loop.mjs` or `land.mjs`.
- [ ] **AC-2** — Provisional: before a tool runs a role, tests show that the
      role's guarantees hold for it (`docs/agent-workflow-design.md`,
      "Portability", M3).
- [ ] **AC-3** — Every `**Planned (…)**` marker in
      `docs/agent-workflow-design.md` that names OQ-114 is resolved as that
      document's "Reading this document" note says.

## Out of scope

- Moving the workflow to a repository of its own. That is OQ-115.
- Changing what the gate decides: verdicts, the round bound, landing.

## Constraints

*(none)*

## Context

- `docs/agent-workflow-design.md`, "Portability": the goals, what ties the
  workflow to the Claude Code CLI today, and the open questions.
- `scripts/dispatch/spawn.mjs`, `invocation.mjs`, `outcome.mjs`,
  `coder-env.mjs`: the CLI-specific parts.
- `scripts/dispatch/review.mjs`, `chooseReviewerModel`: how the reviewer's
  model is kept different from the coder's today.
- OQ-54: one declared default coder model. M4 may rework or absorb it.
- OQ-62, OQ-73: the reviewer's and coder's guarantees still being built for
  the Claude Code CLI.

## Open questions

M1 to M6, in
`docs/agent-workflow-design.md`, "Portability", "Open questions". Answers are
recorded there as they are made.
