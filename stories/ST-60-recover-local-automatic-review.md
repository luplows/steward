---
id: ST-60
title: Count how each automatic review ended, and carry on after a restart
tier: next
kind: workflow
depends_on: [ST-52]
model: null
blocked: null
---

## Intent

As a developer, I want each automatic review's ending to be counted plainly, and automatic review
to carry on after a graceful stop or an interruption, so that ordinary operation continues without
paying again for a failed review and without my having to reset anything.

## Acceptance criteria

- [ ] **AC-1** — **Three ways a review counts.** From ST-52's `ended` entry, a review counts as
      exactly one of: a **verdict** (`recorded` or `already-reviewed`); a **no-model refusal** (a
      result with no `sessions`, other than those); or a **model-consuming failure** (every other
      result with `sessions`, `threw`, and AC-4a's `interrupted`). `threw` counts as a failure
      because the record does not say whether a model started, and counting it as one cannot cause
      a second paid review. Tests classify each `status` `reviewPullRequest` names.
- [ ] **AC-2** — **ST-61 reads the count.** A function gives ST-61 that classification for an
      identity, or nothing when it has no `ended` entry, read from `reviews.json`. The outcome is
      written before another review is admitted. If it cannot be written, the coordinator admits
      nothing more and ends as ST-58/AC-5's handled error, leaving the entry `running` for AC-4a.
      The reviewer's bounded malformed-output retry inside its original invocation is unchanged.
      Tests cover the function's three classes, no entry, and a failed write.
- [ ] **AC-3** — **A graceful stop and start.** A stop follows ST-58: admission closes at the
      acknowledgement, the admitted review finishes and its outcome is written, and the coordinator
      exits. A later `start` schedules again, rechecking current GitHub eligibility through ST-59.
      Recorded outcomes survive the restart. A test holds a stand-in review through a stop, then
      restarts and reads its outcome.
- [ ] **AC-4** — **Interrupted while idle.** A `start` that finds a record whose process has gone
      (ST-58/AC-5) and no `running` entry starts as after a clean stop. No reset, reboot or other
      proof is needed. A test kills a stand-in coordinator while idle and restarts it.
- [ ] **AC-4a** — **Interrupted during a review.** Before launching the coordinator, `start` moves
      each `running` entry to `ended` with `interrupted`, says which repository, PR and head were
      interrupted and that the head will not be reviewed again automatically, and starts as usual.
      A manual review of that head, or a new head, is how it gets a verdict. `start` does not look
      for a surviving reviewer, kill any process or check the verdict. A `start` that finds a
      running coordinator changes no entry and reports `already-running` (ST-58). Tests start from
      a `running` entry and show the `interrupted` entry and the message.
- [ ] **AC-5** — **Only `start` changes this.** `status` and `stop` read `reviews.json` at most,
      and change no entry and admit no work. A test runs both with a `running` entry present.
- [ ] **AC-6** — Tests use stand-in reviews, as each AC names, and no test starts a model or an OS
      crash experiment. The implementing PR documents what an interruption does, including the
      accepted risk under Out of scope, and resolves this story's planned design marker.

## Out of scope

The threat model is one member of the crew, one coordinator (ST-58), one automatic review at a
time, on one machine (Constraints). Outside it, and not to be guarded against, for 0.1:

- A reviewer process that outlives its coordinator. **Accepted risk (crew, 2026-11-02):** it may
  still post a verdict, which the gate binds to the head reviewed. Steward does not look for it.
- Proving whether any process has ended, reused process ids, descendants and OS containment.
- A verdict accepted by GitHub but not recorded locally: such a review counts as `interrupted` or
  `threw`, and GitHub's verdict still governs the head (ST-59).
- A second interruption during `start`'s own write, and hand-edited state.
- A `recovery-needed` refusal, an idle proof, an operator recovery command and a machine reboot as
  evidence (draft ST-64 keeps the questions).
- Killing sessions on demand, shared E-stop or registration of independent manual commands (ST-62).
- Scheduler retry budgets, backoff or retry-reset commands; ST-61 keeps its existing policy.

## Constraints

- **Threat model:** one member of the crew, one coordinator, one automatic review at a time. The
  story need prove no more than that an interrupted review is not paid for again automatically,
  and that automatic review carries on.
- Reuse ST-52's record, ST-58's ownership and stop, and ST-59's review execution. Local records are
  not GitHub verdicts.
- Node 24, ESM, no new runtime dependencies. Tests use a temporary home directory; no test writes
  to GitHub.

## Context

- Crew decision, 2026-11-02: an interrupted review is counted as a failed one and automatic review
  carries on, reversing the decisions of 2026-10-27 and 2026-10-28 (`recovery-needed` and a durable
  idle proof). Those left no way to clear the refusal before draft ST-64, so one crash mid-review
  turned automatic review off for good. Considered and not chosen: keeping the refusal, cleared by
  a new `steward coordinator clear` command, or by removing the entry by hand. `git log` of this
  file holds the earlier version.
- `scripts/dispatch/spawn.mjs`'s `runSession` resolves after its process has ended, and
  `scripts/dispatch/review.mjs` awaits it, so under a living coordinator a finished review has
  ended. `reviewPullRequest` documents that every result returned after a session started has
  `sessions`.
- ST-64 holds the exceptional-recovery questions. It is not a dependency of 0.1 scheduling.
- `docs/planning-session.md`, "Writing it": a safety criterion names a bounded threat model.
- Suggested size: small.

## Open questions

*(none)*
