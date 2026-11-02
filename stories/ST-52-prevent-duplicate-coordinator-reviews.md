---
id: ST-52
title: Prevent duplicate coordinator-dispatched reviews without locking manual commands
tier: next
kind: workflow
depends_on: [ST-58, ST-59]
model: null
blocked: null
---

## Intent

As a developer using unattended review, I want the per-user coordinator to note each PR/head
review before starting it, so that repeated scans cannot pay for the same automatic review twice,
without limiting independently invoked manual Steward commands. There is one coordinator, doing
one review at a time, so this is a small record it keeps for itself, not a lock.

## Acceptance criteria

- [ ] **AC-1** — **A note before the review starts.** Before starting an automatic reviewer, the
      coordinator writes an entry to `~/.steward/state/reviews.json` for `(owner/name, PR number,
      full head SHA)`, in state `running`. The review runs as admitted work through ST-58's `admit`.
      If the entry cannot be written, no reviewer starts, and the coordinator reports the failure
      with the file's path. A malformed file is treated the same way: it is reported, and it never
      reads as an empty one. Tests show the entry written before the review starts, and no review
      started when the write fails or the file is malformed.
- [ ] **AC-2** — **The same review is not started twice.** A `running` entry for the same identity
      makes a later attempt return a distinct, nonfatal `already-admitted` outcome, naming the
      entry rather than reporting a review success. It starts no model session and leaves the entry
      as it was. A different head is a different identity, and ST-59's expected-head check still
      refuses a review if GitHub no longer reports that head. Tests exercise both cases.
- [ ] **AC-3** — **The entry records how it ended.** When the review returns, or throws, its entry
      moves to state `ended` with the result: the reviewer's `status` and `sessions` as returned,
      or `threw` and the error's message. `reviewPullRequest` awaits each session, and `runSession`
      resolves only after the session's process has ended, so under a living coordinator a review
      that returned or threw has ended. An `ended` entry does not itself block a later admission;
      whether to review that head again is ST-61's decision. Tests cover a recorded review, a
      returned failure, a throw, and admission after an `ended` entry.
- [ ] **AC-4** — **A coordinator that dies leaves its entry `running`.** Only the coordinator that
      wrote an entry moves it to `ended`; no timeout or process check does. What the next `start`
      does with such an entry is ST-60/AC-4a's. A test ends a stand-in coordinator during a review
      and shows the entry still `running`.
- [ ] **AC-5** — Direct manual `review`, `review --rereview`, `rotation` and `land` operations
      neither read nor write `reviews.json`. A test holds a `running` entry and shows an
      independently invoked manual review reaching its normal review logic. Existing review
      integrity checks, manual landing authorization and GitHub gate constraints remain unchanged.
- [ ] **AC-6** — Automatic admission uses this record and ST-58's `admit`, with no lock around
      `runRotation`. Documentation explains that this prevents duplicate *coordinator-dispatched*
      work only; manual concurrency and possible duplicate costs or verdict races are the crew's to
      manage. The implementing PR resolves the design of record's **Planned (ST-52)** marker and
      corrects the superseded rotation-lock description where applicable.

## Out of scope

The threat model is one member of the crew, one coordinator (ST-58), one automatic review at a
time, on one machine (Constraints). Outside it, and not to be guarded against, for 0.1:

- Another process writing `reviews.json`, two coordinators, or atomic writes and locking to survive
  either; hand-edited files beyond reporting a malformed one (AC-1).
- Checkout aliases: activation keeps one record per repository (ST-57), so the identity is the
  repository, never a path.
- Locking, serializing or warning on manual reviews, re-reviews, rotations, landings or externally
  orchestrated Steward commands.
- Scheduling choices, project fairness, scan cadence and whether to review a head again (ST-61).
- Handling a `running` entry found at start, and how each result counts for scheduling (ST-60).
- Pruning old entries from `reviews.json`.
- Process-tree monitoring, automatic landing, universal emergency stop, cross-user or cross-machine
  reservations, GitHub-distributed claims or exactly-once remote side effects.

## Constraints

- **Threat model:** one member of the crew, one coordinator, one automatic review at a time. The
  record's job is that a later scan does not start a review already started; it need prove no more
  than that.
- The record belongs to the coordinator for one OS user on one machine. GitHub remains
  authoritative for PR heads and governing verdicts; the record is not a verdict or a GitHub lock.
- Node 24, ESM, no new runtime dependencies. Tests use a temporary home directory and stand-in
  reviews; no test writes to GitHub or starts a model.

## Context

- Crew decision, 2026-10-27: manual Steward commands and external harnesses may parallelize
  independently of the coordinator's admission and concurrency rules. The earlier 2026-10-24
  proposal to lock out every concurrent same-project rotation is superseded.
- Crew decision, 2026-11-02: rescope this story to the happy path under the threat model in
  Constraints, as ST-57 and ST-58 were in #103. Concurrent admission, checkout aliases and the
  refusal on an uncertain reservation are dropped, and a coordinator that dies mid-review no longer
  blocks automatic review (ST-60). `git log` of this file holds the earlier version.
- ST-58 supplies the coordinator and `admit` (`runCoordinator`, `scripts/dispatch/coordinator.mjs`);
  ST-59 supplies `reviewCandidate` and expected-head checking (`scripts/dispatch/review-work.mjs`).
- `scripts/dispatch/review.mjs`'s `reviewPullRequest` returns each named `status`, with `sessions`
  on every result returned after a session started. `scripts/dispatch/rotation.mjs` may request
  landing, so the coordinator must not use a whole rotation for automatic review.
- `docs/planning-session.md`, "Writing it": a safety criterion names a bounded threat model.
- Suggested size: small.

## Open questions

*(none)*
