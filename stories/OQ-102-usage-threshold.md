---
id: OQ-102
title: Stop starting coder sessions once a usage threshold is reached, and let reviews finish
tier: next
kind: workflow
depends_on: [OQ-83, OQ-86, OQ-101]
model: sonnet
blocked: null
---

## Intent

As the owner, I want the loop to stop starting coder sessions once my usage
passes a threshold I set, so that an unattended loop cannot run through my
allowance. Work already in flight should still end with a review posted,
nothing should be left half-done, and a story that had to wait should pick
up again once usage is back under the threshold.

## Acceptance criteria

- [ ] **AC-1** — **Past the threshold, no coder session starts.** Before
      starting any coder session, whether a story's first dispatch or a
      retry, the loop checks usage against the threshold. At or over it,
      the loop starts none:
      - a ready story that has not been dispatched is not dispatched;
      - a story in flight whose next step is a retry is **paused**. Its pull
        request stays open and ready, gets no `blocked:`, and is not turned
        into a draft. The run log (OQ-101) records it with status `paused`.

      A coder session that is already running is not stopped.
- [ ] **AC-2** — **Past the threshold, everything else carries on.** Waiting
      for CI, reviews and landing continue. So a run past the threshold still
      reviews every pull request that is waiting for one: an in-flight
      story's new head, and every ready pull request from a trusted author
      (OQ-83). A pull request whose review passes still lands. The run log
      records that the threshold was reached.
- [ ] **AC-3** — **A paused story resumes.** On a run under the threshold,
      before it dispatches a new story, the loop resumes each paused story
      through OQ-48's entry point (`story.mjs OQ-<n> --pr <number>`), which
      retries it from where it stopped. A paused story is derived, not
      stored: an open, non-draft pull request on a `story/OQ-<n>-*` branch,
      with no `blocked:` in its story file at the head, whose head either
      - has an honoured `block` verdict, with fewer blocking verdicts than
        the bound (`MAX_ROUNDS` in `scripts/dispatch/story.mjs`), or
      - has no verdict and a CI run that concluded `failure`, with fewer red
        rounds than the same bound (`countRedCiRounds`).

      Both are the points at which OQ-48 would have retried, and so the two
      ways AC-1 can pause a story.
- [ ] **AC-4** — **This extends OQ-86's loop in two places.** `paused` is
      an outcome after which the loop goes on, like a merge or a fully
      recorded stop (OQ-86's AC-3), rather than stopping the loop. And a
      paused story is the one kind of `in-progress` story the loop resumes;
      OQ-86's AC-4 otherwise never resumes one. Tests cover both: a pause
      does not stop the loop, and a paused story is resumed while another
      `in-progress` story, stopped with `blocked:`, is still skipped.
- [ ] **AC-5** — Tests cover:
      - over the threshold: no first dispatch and no retry, and a review and
        a landing still happen;
      - a story paused at a block, and one paused at red CI, each resumed on
        a later run under the threshold;
      - a running coder session left to finish.
- [ ] **AC-6** — `docs/agent-workflow-design.md`, "Running unattended": every
      `**Planned (…)**` marker that names OQ-102 is resolved as that
      document's "Reading this document" note says.

## Out of scope

- **GitHub's API rate limit.** Waiting for CI and for a landing polls every
  15 seconds (`CI_POLL_INTERVAL_MS` in `scripts/dispatch/ci.mjs`,
  `POLL_INTERVAL_MS` in `scripts/dispatch/land.mjs`), so a run that waits
  makes dozens to hundreds of calls. That is still far under 5,000 an hour.
- **Stopping a session that is running**, which would leave a branch, a
  worktree or a pull request with no verdict half-done.
- **Notifications.** The run log is the record (OQ-101).

## Constraints

- Node, ESM, no new runtime dependencies.

## Context

- Decided by the owner on 2026-09-28, in the dispatcher session: past the
  threshold, no new coder session starts, retries included, and reviews carry
  on, "I'd like the end state to be everything has a review posted".
- What the loop can measure today: every coder and reviewer session's JSON
  output carries `total_cost_usd`, which `scripts/dispatch/coder.mjs` already
  reads as `costUsd`. `claude --help` (Claude Code 2.1.281) has no command
  that reports a plan's usage, and a coder session's transcript holds only
  per-message token `usage`. Whether a plan's usage window can be read by a
  script is unknown.
- `story.mjs --pr` refuses a draft pull request, or one with `blocked:` at
  its head (`already-stopped`). That is why AC-1 pauses without either.
  Resumed on a pull request whose head has a block verdict, it retries
  (`decideVerdict`). With no verdict at the head, it waits for CI, and on a
  `failure` under the bound it retries (`decideCi`).

## Open questions

1. **What is measured?** Spend summed from each session's `costUsd`; a count
   of sessions; the plan's usage window, if a script can read it; or
   something else. The owner is researching this.
2. **Over what window, and where is the threshold set?** For example per day,
   or a rolling window matching the plan's, set in a config file or passed as
   a flag. Any running total is state the loop would keep, which the design
   otherwise avoids ("Status is derived, not stored"), so the answer should
   say where it lives.
3. **Should the loop also resume a story whose run was interrupted?** AC-3
   derives a paused story from GitHub alone. A story whose OQ-48 process was
   killed at the same two points looks the same, so the loop would resume it
   too. Today resuming an interrupted story is the owner's: OQ-86's AC-4,
   OQ-101's Out of scope, and the design doc's failure-table row "The
   dispatcher is interrupted mid-story". Either accept that the loop resumes
   both, and say so in those three places, or tell a pause apart, for
   example by the run log's `paused` entry (OQ-101), which would make the log
   state the loop reads. Raised by #174's third review.
