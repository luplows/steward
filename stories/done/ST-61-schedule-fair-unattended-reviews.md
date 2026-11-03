---
id: ST-61
title: Fairly schedule bounded automatic reviews for activated projects
tier: next
kind: product
depends_on: [ST-60, ST-63, ST-66]
model: null
blocked: null
---

## Intent

As a developer with several activated projects, I want a single coordinator to discover and fairly
review eligible pull-request heads unattended, while bounding model usage, so that review
progresses without manual rotations or repeated costly failures.

## Acceptance criteria

- [x] **AC-1** — **Only activated projects.** Once `start` has reported `started`, the coordinator
      scans only the projects in ST-57's records, read with `readProjects` at each scan and again
      before each admission. Unreadable records prevent automatic admission and `status` gives the
      reason; they never cause implicit activation. Candidate selection uses ST-59's
      `listReviewCandidates`, not a second eligibility check. Each turn brings the project's owned
      checkout to `origin`'s `main`, as activation does, and passes it as `repoDir`. Tests cover an
      initial scan, an inactive project and unreadable records.
- [x] **AC-2** — **Fair turns.** A project's turn admits at most one eligible PR/head through
      ST-52, then yields to the next project with an eligible head, in round-robin order by
      `owner/name`. Candidate order within a project follows ST-59. With two projects holding
      eligible heads, two successive reviews do not belong to the same project. The position is
      kept in memory: a restart begins a new round. Tests cover two projects with several
      candidates, one empty project and a project activated or deactivated between turns.
- [x] **AC-3** — **One review at a time.** The coordinator awaits each review before starting the
      next, so at most one coordinator-managed review runs at a time across all of the OS user's
      activated projects. Direct manual `review`, `--rereview`, `rotation` and `land` commands
      neither count towards this nor change the scheduler's position. Tests hold a stand-in review
      open and show no second one started.
- [x] **AC-4** — **Scanning.** The scan interval governs discovery of new work, **not the delay
      between reviews already discovered**. On start, scan immediately. Run known eligible
      candidates in fair turns, with ST-59 checking the intended head again before any model
      session. When none remain, start no session and do not busy-loop; scan again after the
      configured interval. Tests using a controllable clock show consecutive known reviews with no
      added interval, idle waiting and discovery on a later scan.
- [x] **AC-5** — **The interval.** `start` reads `coordinator.scanIntervalMinutes` through
      `readUserConfig` (`scripts/dispatch/user-config.mjs`, ST-63) and refuses, starting nothing,
      when it throws. `coordinator status` reports the effective interval. A change takes effect
      at the next start. Tests cover the default, a configured interval and a refused
      configuration.
- [x] **AC-6** — **Failures and refusals do not loop.** A project's GitHub discovery failure, or a
      failure to bring its owned checkout to `origin`'s `main`, starts no review of that project,
      is reported in `status`, does not stop other projects, and is retried at that project's next
      normal scan.
      When a review returns `over-usage` or `usage-unknown`, no model session has started: the
      coordinator starts no more reviews until the next scan, where the reviewer's own usage check
      runs again. Other no-model refusals end that head's turn, and it may be considered again at a
      later scan. Tests show that none of these starts an immediate retry or an extra model
      session.
- [x] **AC-6a** — **A record that cannot be kept ends the coordinator.** When `admitReview` returns
      `record-failed`, or `reviewEnding` throws, the scheduler hands the reason to
      `runCoordinator`'s `fail` (ST-60/AC-2) and admits nothing more. The next `start` moves an
      entry still `running`, or refuses a malformed file, as ST-60/AC-4a says. An `already-admitted`
      outcome ends that head's turn and starts no session. Tests cover a stand-in `record-failed`
      and an unreadable `reviews.json`.
- [x] **AC-7** — **A failed head is not paid for twice.** A head that ST-60 counts as a
      model-consuming failure, `interrupted` included, is not reviewed again automatically, on
      later scans or after restart, and `status` lists it. A new head of that PR is eligible. A
      manual review remains available under its existing rules, and a verdict it records makes the
      head no longer pending. The reviewer's bounded retry within its own invocation is unchanged.
      Tests cover repeated scans, restart, a changed head and no extra model session.
- [x] **AC-8** — **Stop, deactivation and status.** After a stop's acknowledgement no new review is
      admitted, and the current one may finish (ST-58). A project deactivated during a review is
      not admitted afterwards, and the review under way may finish. `coordinator status` shows the
      active project, PR and full head, the effective interval, the next scan when known, the last
      outcome, and the usage or failure reasons above, without credentials. `status` is a separate
      process, so what makes this true is the coordinator writing these fields to its record,
      `coordinator.json`, through ST-66's module, as they change, and `status` reading them there;
      `readRecord` keeps them. `status` lists AC-7's failed heads from `reviews.json`, changing no
      entry (ST-60/AC-5). A failed write of these fields is not fatal: the coordinator carries on,
      and its next write replaces them. Tests cover a stop and a deactivation during a stand-in
      review, and `status`'s fields read from a separate process.
- [x] **AC-9** — Automatic scheduler work never calls `landPullRequest`, the runway,
      `runRotation`, inspection, the coder or the fixer, regardless of project `land` settings.
      Verdicts continue through the existing head-bound gate. Tests use two activated projects
      with differing issue and file unit-link conventions, and an inactive project. The
      implementing PR documents the fairness and scanning behaviour and resolves the ST-61
      planned design markers.

## Out of scope

The threat model is one member of the crew, one coordinator (ST-58), one automatic review at a
time, on one machine (Constraints). Outside it, and not to be guarded against, for 0.1:

- Fair order across a restart; a durable scheduler position; another process changing the records
  or state files during a scan.
- Waiting for a rate limit's or a usage window's reset time; the next scan's check is enough.
- Exponential backoff, scheduler-level retry of a model-consuming failure, same-head retry
  budgets, retry-reset commands or circuit breakers.
- Automatic landing, coding, fixing, inspection scheduling, or launching the legacy scheduled loop.
- More than one automatic reviewer slot; manual command concurrency; cross-user or cross-machine
  concurrency; universal E-stop or credential isolation.
- Changing ST-63's per-user configuration, or adding a configuration-editing command.

## Constraints

- **Threat model:** one member of the crew, one coordinator, one automatic review at a time. Bounds
  on usage come from this story's turns and from the reviewer's existing checks.
- Use ST-57's records, ST-58's owner and stop, ST-59's candidates and review, ST-52's record,
  ST-60's count and ST-66's module. Do not build a parallel reviewer, a GitHub verdict ledger or a
  whole-rotation scheduler.
- GitHub is authoritative for the PR's current head and governing verdict; discovered candidates
  are provisional and are rechecked at the review boundary.
- Preserve the reviewer's usage checks, tool selection, timeout and stall bounds and its
  single-invocation malformed-output retry.
- Node 24, ESM, no new runtime dependencies. Tests use a temporary home directory, stand-in reviews
  and an injected clock; no test writes to GitHub or starts a model.

## Context

- Crew decisions, 2026-10-27: one coordinator and one automatic reviewer per OS user; fair
  activated-project turns; no unattended landing in 0.1; manual calls bypass coordinator slots;
  shared E-stop is deferred until before 1.0. A 15-minute scan default, a configurable positive
  whole-minute interval with no product maximum, and a discovery interval that is not the
  inter-review delay. No exponential backoff, and no automatic retry of a failed model-consuming
  review on its unchanged head.
- Crew decision, 2026-11-02: rescope this story to the happy path under the threat model in
  Constraints, as ST-57 and ST-58 were in #103. The durable fair-order cursor, honouring GitHub's
  and the usage window's reset times, and the test of checkout aliases are dropped, and this story
  no longer refuses on `recovery-needed` (ST-60). Its two open questions asked to confirm ST-60's
  and ST-63's interfaces before dispatch: ST-60/AC-1 and AC-2, and ST-63's `readUserConfig`, now
  name them. `git log` of this file holds the earlier version.
- Crew decision, 2026-11-02: ST-66 comes before this story, which was checked against what ST-60
  and ST-52 built. AC-6's checkout failure, AC-6a and how `status` reads AC-8's fields were added
  then. The detached coordinator has no output, so `status` and the next `start` are where a person
  sees these.
- `scripts/dispatch/review.mjs` already reports named usage and session outcomes, and fetches into
  its `repoDir`. `scripts/dispatch/rotation.mjs` includes landing and inspection, so a whole
  rotation is not a review-only automatic turn.
- `docs/planning-session.md`, "Writing it": a safety criterion names a bounded threat model.
- Suggested size: medium.

## Open questions

*(none)*
