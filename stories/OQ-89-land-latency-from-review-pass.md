---
id: OQ-89
title: Measure landing latency from when the review gate passed, not from when land.mjs first looked
tier: normal
kind: workflow
depends_on: []
model: sonnet
blocked: "Held for the move to steward, decided 2026-10-08 by the owner (docs/agent-workflow-design.md, Portability, R4)"
---

## Intent

As the owner, I want the landing latency log to show how long a pull request
sat merge-ready before anything triggered the sweep, so that a late call to
`land.mjs` shows up as a long wait. Today the log's clock starts when
`land.mjs` itself first sees the pull request landable, so a call that comes
hours late records a wait of seconds.

## Acceptance criteria

- [ ] **AC-1** — Each line `land.mjs` appends to its latency log gains
      `reviewPassedAt`: the `created_at` of the `review/agent` status on the
      head, from the combined-status response `land.mjs` already reads, taken
      when that status's state is `success`. It is `null` when the run never
      saw that status succeed. No request is added, and `land.mjs`'s
      allowlist is unchanged.
- [ ] **AC-2** — `recentLandingLatencies`, and so `--latency`, gains
      `sinceReviewSeconds`: from `reviewPassedAt` to `triggeredAt`. The
      existing `waitSeconds` and `mergeSeconds` keep their meaning. A log line
      written before this change, which has no `reviewPassedAt`, reads
      `sinceReviewSeconds: null`, and does not throw.
- [ ] **AC-3** — Tests, with `now` and the responses injected:
      - a pull request whose `review/agent` success is dated an hour before
        `land.mjs` starts gives a `sinceReviewSeconds` of about 3600, while
        its `waitSeconds` stays within the poll interval;
      - a run that ends before the review succeeds records
        `reviewPassedAt: null`;
      - an old-format line reads as AC-2 says.
- [ ] **AC-4** — The module's header comment on latency (today "Latency is
      observable after the fact (AC-7)") says what each measure covers:
      `waitSeconds` is `land.mjs`'s own polling latency, bounded by OQ-50's
      AC-5, and `sinceReviewSeconds` is how long the pull request waited
      after the gate passed, including any delay in calling `land.mjs`.

## Out of scope

- **A call to `land.mjs` that never happens.** A log that `land.mjs` writes
  cannot record a run that did not start. Calling it for every story is
  OQ-48's; noticing a merge-ready pull request that nothing triggered belongs
  to the watchdog (`docs/agent-workflow-design.md`, "Watchdog").
- **CI finishing after the review.** `mergeable_state` stays `blocked` until
  required checks pass, so where CI finishes after the gate,
  `sinceReviewSeconds` includes that wait too. In OQ-48's order CI comes before
  review, so the gate is normally the last condition to pass.
- Changing when or how often the sweep is triggered.

## Constraints

*(none)*

## Context

- `scripts/dispatch/land.mjs`: `landPullRequest` sets `times.landableAt ??=
  now()` in the iteration that first sees the pull request landable, and
  `finish` appends the log line with `startedAt`, `landableAt`, `triggeredAt`
  and `mergedAt`. `reviewState` reads only the `review/agent` status's `state`
  from the response to `GET …/commits/<sha>/status`; the same entry carries
  `created_at`.
- OQ-50 (`stories/done/`), AC-7: "A cadence regression must be visible rather
  than silent, which is the failure this story exists because of." A late
  call is such a regression, and today it is silent.
- Raised by the reviewer session on 2026-09-27, in the notes from reviewing
  #151.

## Open questions

*(none)*
