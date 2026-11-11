---
id: ST-95
title: Wait for the review gate after a fresh coordinator pass
tier: normal
kind: product
depends_on: [ST-84]
model: null
blocked: null
---

## Intent

As a crew member using unattended landing, I want a pull request that just passed the
coordinator's independent review to land without waiting for another scan merely because
GitHub has not yet recorded the gate's `review/agent` status.

## Acceptance criteria

- [x] **AC-1** — When a coordinator review in the current scheduling cycle returns
      `recorded` with a `pass` or `pass-with-observations` verdict for a PR and full head SHA,
      a subsequent unattended landing attempt in that cycle for the same repository, PR number
      and head calls `landPullRequest` with `passedAt` set to that SHA, alongside its existing
      `mode: unattended` and `once: true`. No different PR or head inherits that proof of a
      fresh pass.
- [x] **AC-2** — A `block`, non-verdict result, failed or interrupted review, or an
      `already-reviewed` candidate with no pass newly recorded by this coordinator does not
      set `passedAt`. A landing candidate discovered independently, without a matching fresh
      pass in its scheduling cycle, retains the existing one-look behavior. No historical
      review result is promoted into a fresh pass after restart.
- [x] **AC-3** — The pilot uses its existing `POLL_INTERVAL_MS` and `GATE_LAG_BOUND_MS`
      behavior for that matching head: a pending, absent, failing or error `review/agent`
      status that becomes `success` within the bound can proceed to normal checks and request
      the runway in that cycle. If the bound expires, it returns `not-landable` with
      `gate-lag` and triggers nothing. Other pending checks do not gain a new wait.
- [x] **AC-4** — Existing activation, project `land: true`, PR/head rechecks, draft and
      `review-blocked` refusals, check requirements and runway authority remain intact.
      The coordinator does not send a head authorization in the unattended workflow dispatch:
      `passedAt` is evidence used for a bounded pilot wait, not a manual-mode head pin.
      A changed PR head cannot use another head's freshly recorded pass.
- [x] **AC-5** — Deterministic tests using injected coordinator reviews, landing attempts and
      GitHub statuses demonstrate fresh `pass` and `pass-with-observations`, status success
      after a short gate lag, timeout with no dispatch, blocked/failed/already-reviewed results,
      a mismatched or moved head, and independently discovered landing candidates. No
      real model, wait interval or GitHub mutation is required.
- [x] **AC-6** — Update coordinator-facing documentation for the newly supported short gate
      wait, and remove the `**Planned (ST-95)**` marker from
      `docs/agent-workflow-design.md` when implemented.

## Out of scope

- Changing manual landing or the runway's unattended standing-authorization model.
- Adding independent scan timers, parallel execution or general capacity management (ST-85).
- Waiting for arbitrary CI, mergeability or a GitHub Actions run with no known bound.
- Polling indefinitely, re-reviewing, rescheduling or retrying the same head after gate-lag
  timeout; a later ordinary scan can consider it.
- Durable passing-verdict caches, cross-process coordination and post-restart reconstruction.

## Constraints

One coordinator on one machine executes reviews and landing attempts sequentially. Reuse the
existing pilot's bounded gate wait from ST-51; do not add another polling mechanism or GitHub
permission. The runway still performs all final checks before merging.

## Context

- ST-84 already sends `mode: unattended` and `once: true` to `landPullRequest` from
  `scripts/dispatch/coordinator-scheduler.mjs`, but does not supply `passedAt`.
- ST-51 built the existing bounded gate-lag wait in `scripts/dispatch/land.mjs`; a manual
  rotation supplies `passedAt` when it has a pass on the reviewed head.
- Reported 2026-11-09 from a client upgrade: twice, the coordinator reached landing a few
  seconds after a verdict, before `review/agent` became `success`, requiring another
  15-minute scan. This story addresses the scheduling gap without inspecting private
  client implementation.
- An unattended runway log with `authorized head=""` is expected: only manual landing
  authorizes a named head. The runway still checks the actual head and uses
  `--match-head-commit` for its merge.
- Crew decision, 2026-11-09: target v0.3.0 with this narrow coordinator follow-up,
  independently of the ST-89–ST-93 working coder slice.

## Open questions

*(none)*
