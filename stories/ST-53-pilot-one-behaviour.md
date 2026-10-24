---
id: ST-53
title: Give the pilot one behaviour, the bounded one, and retire its long-wait mode and once
tier: later
kind: workflow
depends_on: [ST-51]
model: null
blocked: null
---

## Intent

As a member of the crew, I want the pilot to behave one way wherever it is called, waiting only
for events that finish on their own within a known bound, so that `landPullRequest` has no `once`
option whose name no longer says what it does, and no second mode that waits up to half an hour.

## Acceptance criteria

Provisional, until the Open questions are settled.

- [ ] **AC-1** — `landPullRequest` (`scripts/dispatch/land.mjs`) has no `once` option. Every call
      behaves as a call with `once: true` does once ST-51 has landed: it waits only for the gate's
      lag, when it holds a pass at the current head (`GATE_LAG_BOUND_MS`), and for the runway's
      merge after its one trigger (`SWEEP_RUN_BOUND_MS`), and returns everything else at once.
- [ ] **AC-2** — The long-wait mode is gone: no wait bounded by `REVIEW_PENDING_BOUND_MS` or
      `MAX_TOTAL_WAIT_MS`, no re-trigger of the runway, and its constants and tests removed or
      rewritten, each named in the pull request's body.
- [ ] **AC-3** — `rotation.mjs` calls `landPullRequest` without `once`, and its header and
      `land.mjs`'s say so. `node scripts/dispatch/cli.mjs land <pr-number>`, run by hand, behaves
      as the rotation's pilot does, and `README.md`'s line for it says what it does.
- [ ] **AC-4** — Every **Planned (ST-53)** marker in `docs/agent-workflow-design.md` is resolved.

## Out of scope

- Changing what a rotation waits for: ST-51 decides that, and this story only makes it the
  pilot's only behaviour.
- Anything about the coder's stories beyond what the Open questions decide.

## Constraints

- Node, ESM, no new runtime dependencies.

## Context

- **Decided on 2026-10-24 by the owner**, with the planning session, while settling the first
  review of ST-51's pull request: `once` stays for the `v0.1.0` fix (ST-51), and a later story
  retires the long-wait mode, so that the pilot has one behaviour and the flag goes (design doc,
  Part 3, "Decided so far", "A rotation waits only for short, bounded events, and one runs at a
  time on a machine").
- After ST-51, only `rotation.mjs` passes `once: true`. The long-wait mode serves
  `node scripts/dispatch/cli.mjs land`, run by hand (`land.mjs`'s `main`), and
  tower-workshop-paths' frozen loop: `story.mjs` and `writer-prs.mjs` call `landPullRequest`
  without `once`. ST-25 kept `loop.mjs` and `writer-prs.mjs` unchanged on purpose.

## Open questions

- **The frozen loop's callers.** `story.mjs` and `writer-prs.mjs` rely on the long-wait mode. Does
  this story change them too, or wait for the coder's stories, which are to rework them, or wait
  for the loop to be retired?
- **Landing by hand.** Is a crew member running `land <pr-number>` at a terminal better served by
  the bounded behaviour, returning at once with the reason when a pull request is not landable, or
  does the hand-run command need a wait of its own?
- **When.** After `v0.1.0`, and before or with the coder's stories.
