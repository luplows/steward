---
id: ST-51
title: Wait for short bounded events, leave fresh merges to the next inspection, print in order
tier: fix
kind: workflow
depends_on: []
model: null
blocked: null
---

## Intent

As a member of the crew, I want what a rotation reports to be true when it reports it: a pull
request that has just passed lands in the same rotation instead of being reported not landable
while the gate catches up, inspection raises no issue about a merge GitHub has not yet linked to
its pull request, and the rotation's lines appear in the order things happened, so that nothing a
rotation prints about the state of the repository is false.

## Acceptance criteria

- [ ] **AC-1** — **Inspection leaves fresh commits for the next run.** In `inspectMerges`
      (`scripts/dispatch/inspect.mjs`), a commit on `main` or a release branch whose committer
      date is less than 10 minutes before `now` is not judged: it is neither a finding nor
      checked for a passing verdict. The 10 minutes are a named constant in `inspect.mjs`, not a
      setting. A commit at or past it is judged as today. Tests, with `now` and GitHub injected: a
      commit 9 minutes old that GitHub associates with no pull request raises no finding and opens
      no issue; the same commit 11 minutes old raises the "without a pull request" finding; a
      commit 9 minutes old whose pull request merged without a passing verdict raises no finding;
      and the same holds on a release branch.
- [ ] **AC-2** — **Inspection names what it left.** For each commit AC-1 leaves, inspection prints
      one line naming its short SHA and branch and saying it was left for the next run, being
      committed less than 10 minutes ago. Such a commit changes neither the count of findings it
      prints nor its exit code. A test shows the line, and an exit code of 0 when the only commit
      in the window is one it left.
- [ ] **AC-3** — **The pilot waits through the gate's lag, even when it looks once.** In
      `landPullRequest` (`scripts/dispatch/land.mjs`) with `once: true`, when `passedAt` is the
      pull request's current head and `review/agent` on it is not `success` (pending, absent,
      `failure` or `error`), the pilot reads it again every `POLL_INTERVAL_MS` for up to
      `GATE_LAG_BOUND_MS`. Once it reads `success`, the look goes on as today (a conflict, the
      checks `landWhen` names, then the one trigger). If it has not read `success` by the bound,
      it returns `not-landable` with the reason `gate-lag`. Without `passedAt`, or with a
      `passedAt` that is not the current head, `once` returns `not-landable` with the reason
      `review-pending` at once, as today. Nothing else `once` returns waits: checks still running,
      a conflict, `github-blocked` and the other statuses are returned at once, as today. Without
      `once`, nothing changes. Tests, with `sleep`, `now` and GitHub injected: a status pending at
      the first read and `success` at the second lands, with one `sleep` of `POLL_INTERVAL_MS`
      between; a status that stays pending returns `not-landable` with `gate-lag` once
      `GATE_LAG_BOUND_MS` has passed, having triggered nothing; a pending status without
      `passedAt` returns `review-pending` with no `sleep`; and, with `success` read after the
      wait, checks still running return `not-landable` at once.
- [ ] **AC-4** — **The rule is written where the waits are.** `land.mjs`'s header says, in place
      of "look once instead of waiting": a rotation waits only for an event that finishes on its
      own within a known bound, the gate's status after a verdict (`GATE_LAG_BOUND_MS`) and the
      runway's merge after a trigger (`SWEEP_RUN_BOUND_MS`), and for nothing else, leaving
      anything of unknown length, such as checks still running, to a later rotation. Every
      comment and test title in `land.mjs`, `land.test.mjs`, `rotation.mjs` and
      `rotation.test.mjs` that says `once` never waits, or looks once without waiting, is
      corrected.
- [ ] **AC-5** — **The rotation prints in the order things happen.** `runRotation`
      (`scripts/dispatch/rotation.mjs`) prints each pull request's line for step 3 when its
      review, or its skip, is decided, and its line for step 4 when its landing, or the reason it
      is not landed, is decided, rather than all of them at the end: step 3's lines, oldest pull
      request first, then step 4's, then inspection's output and its exit code, then, if the
      rotation stopped, `rotation stopped` and the reason, last. Each line names its pull request
      and its step's outcome as today (`#81 reviewed: recorded (pass)`, `#81 landing: merged`, and
      so on). A stop prints the lines of the steps already finished, then the stop line, and no
      line for what was not done. Tests, with the review, land and inspection functions injected
      and each writing to the same record as `out`: the lines appear between the calls they
      report, in that order; and a stop in step 3 prints the finished lines, then the stop line.
- [ ] **AC-6** — **The docs say what was built.** The rotation's header (`rotation.mjs`, step 5)
      and `docs/controller.md`, "A rotation", describe the output as AC-5 does, in place of "one
      line per pull request". `docs/agent-workflow-design.md`: every **Planned** marker naming
      ST-51 is resolved, as its "Reading this document" note says: the id taken out of each
      marker, each passage made a plain statement and corrected wherever what was built differs.
      Four today: in "Merging", where the pilot "looks once"; in "The controller", where the
      rotation runs `land.mjs` with `once`; in "Watchdog", where a commit on `main` without a
      pull request is a finding; and in the entry added with this story.

## Out of scope

- **A lock, so that one rotation runs at a time on a machine**: ST-52.
- **Several machines, and several reviewers**: a review claim and whatever else they need, later
  (`docs/outline.md`, "One machine runs the review side, for now").
- Waiting for a `mergeable_state` of `unknown`, which GitHub recomputes after a merge: it has not
  been seen in a rotation. `once` returns it as today.
- Waiting for CI, or for any check `landWhen` names: of unknown length, so left to a later
  rotation.
- Renaming `once`.
- The stall check of inspection, and its `inspectAfterHours`.
- Changing what `inspect` prints or returns when run on its own, beyond AC-2's line.

## Constraints

- Node, ESM, no new runtime dependencies.
- No wait without a named bound: every wait this story adds polls every `POLL_INTERVAL_MS` and ends
  at `GATE_LAG_BOUND_MS`.

## Context

- **Decided on 2026-10-24 by the owner**, with the planning session (design doc, Part 3, "Decided
  so far", the entry added with this story). The owner: what a rotation reports must not be false
  about the state of things, and this blocks `v0.1.0`. A rotation that runs on a schedule should
  not wait, which does not mean moving past everything as fast as possible: a short step is given
  a reasonable time to act, such as two minutes for the gate's lag.
- **What happened, 2026-10-24.** #81, #82 and #83 each passed review in a rotation and were
  returned `not-landable` with the reason `review-pending`: `review/agent` read `success` about
  ten seconds after the verdict comment (#81: comment 07:24:16Z, status 07:24:25Z; #82: 07:45:53Z
  and 07:46:03Z; #83: 07:57:12Z and 07:57:22Z), so each needed a second rotation to land. In the
  rotation that landed #83, inspection opened issue #84, "23caaf0 on main without a pull
  request", 21 seconds after the merge (07:58:19Z merged, 07:58:40Z opened); GitHub's
  `commits/23caaf0/pulls` returned #83 when read afterwards. The rotation printed inspection's
  output before the pull request lines, though the landing came first.
- `scripts/dispatch/land.mjs`: `assess` (a `failure` at `passedAt` is waited through as
  `gate-lag` without `once`, OQ-104; anything not `success` is otherwise `review-pending`), the
  `once` branch of `landPullRequest`, `POLL_INTERVAL_MS` (15 seconds), `GATE_LAG_BOUND_MS`
  (2 minutes), `SWEEP_RUN_BOUND_MS` (3 minutes) and `REVIEW_PENDING_BOUND_MS` (30 minutes).
- `scripts/dispatch/rotation.mjs`: step 4 calls `landPullRequest` with `passedAt` set to the head
  and `once: true`; `printRecords` prints every pull request's line at the end.
- `scripts/dispatch/inspect.mjs`: `inspectMerges` reads each commit's pull requests
  (`buildListCommitPullRequests`) and raises a commit with none merged as "without a pull
  request".
- ST-23 (`stories/done/ST-23-land-once.md`) built `once`; ST-25
  (`stories/done/ST-25-review-pass.md`) built the rotation; ST-29
  (`stories/done/ST-29-inspection.md`) built inspection. Their stories are records and are
  not changed.
- The route to the release branch is the release review's: this fix lands on `main` first, then
  comes to `release/v0.1.0` as a cherry-pick pull request (`docs/release-review.md`, "The
  walkthrough").

## Open questions

*(none)*
