---
id: ST-8
title: Measure landing latency from when the review gate passed, not from when land.mjs first looked
tier: normal
kind: workflow
depends_on: [ST-23]
model: sonnet
blocked: null
---

## Intent

As a member of the crew, I want the landing latency log to show how long a
pull request sat merge-ready before the pilot requested landing, so that a
late call to `land.mjs`, such as a rotation that comes hours after the review
passed, shows up as a long wait. Today the log's clock starts when `land.mjs`
itself first sees the pull request landable, so a call that comes hours late
records a wait of seconds.

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
- [ ] **AC-3a** — A test of a `once` call (ST-23) on a landable pull request
      whose `review/agent` success is dated an hour before the call: its log
      line carries that `reviewPassedAt`, and `sinceReviewSeconds` is about
      3600.
- [ ] **AC-4** — The module's header comment on latency (today "Latency is
      observable after the fact (AC-7)") says what each measure covers:
      `waitSeconds` is `land.mjs`'s own polling latency, bounded by OQ-50's
      AC-5, and `sinceReviewSeconds` is how long the pull request waited
      after the gate passed, including any delay in calling `land.mjs`.

## Out of scope

- **A call to `land.mjs` that never happens.** A log that `land.mjs` writes
  cannot record a run that did not start. Having the pilot request landing
  for each cleared pull request is a rotation's (ST-25); noticing a
  merge-ready pull request that nothing landed belongs to inspection
  (`docs/agent-workflow-design.md`, "Watchdog").
- **CI finishing after the review.** `mergeable_state` stays `blocked` until
  required checks pass, so where CI finishes after the gate,
  `sinceReviewSeconds` includes that wait too. A rotation reviews a pull
  request without waiting for its CI (`docs/controller.md`, "A rotation"), so
  this can happen.
- Changing when or how often the runway is started.

## Constraints

*(none)*

## Context

Formerly tower-workshop-paths OQ-89.

- `scripts/dispatch/land.mjs`: `landPullRequest` sets `times.landableAt ??=
  now()` in the iteration that first sees the pull request landable, and
  `finish` appends the log line with `startedAt`, `landableAt`, `triggeredAt`
  and `mergedAt`. `reviewState` reads only the `review/agent` status's `state`
  from the response to `GET …/commits/<sha>/status`; the same entry carries
  `created_at`.
- ST-23 adds `once` to `landPullRequest`, the mode a rotation calls the pilot
  in, and each `once` call appends its line to the latency log (its AC-4).
  This story adds a field to that line, so it depends on ST-23.
- OQ-50 (tower-workshop-paths' `stories/done/`), AC-7: "A cadence regression
  must be visible rather than silent, which is the failure this story exists
  because of." A late call is such a regression, and today it is silent.
- Raised by tower-workshop-paths' reviewer session on 2026-09-27, in the
  notes from reviewing its #151.

## Open questions

*(none)*
