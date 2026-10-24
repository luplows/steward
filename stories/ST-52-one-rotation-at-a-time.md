---
id: ST-52
title: Run one rotation at a time on a machine, refusing a rotation while another is running
tier: normal
kind: workflow
depends_on: []
model: null
blocked: null
---

## Intent

As a member of the crew, I want a rotation that starts while another rotation of the same project
is still running on the same machine to refuse at once and say so, so that two rotations never
review the same head twice or request the same landing, once rotations are started by a schedule
as well as by hand.

## Acceptance criteria

Provisional, until the Open questions are settled.

- [ ] **AC-1** — Before step 1, `runRotation` (`scripts/dispatch/rotation.mjs`) takes a lock for
      its project on the machine. While the lock is held, a second rotation of the same project on
      that machine takes nothing, starts nothing, prints that a rotation is already running and
      since when, and exits with a status of its own. A test runs two rotations, the first held
      inside its review step, and shows the second refused before it lists anything.
- [ ] **AC-2** — The lock is released when the rotation ends, however it ends: finished, stopped,
      or thrown. A test shows a rotation that throws leaving no lock behind.
- [ ] **AC-3** — A lock left by a rotation that is no longer running does not stop the next
      rotation for good (how is an Open question). A test shows it.
- [ ] **AC-4** — `docs/controller.md` says what the refusal means and that the controller reports
      it and starts nothing more for that request, and the design document's **Planned (ST-52)**
      marker is resolved.

## Out of scope

- **Several machines, and several reviewers.** One rotation at a time on one machine is all this
  story gives. Rotations on more than one machine, or more than one reviewer at once, need a claim
  that every machine can see, such as one on GitHub, and are to be solved later (owner,
  2026-10-24).
- Starting rotations on a schedule.
- `review.mjs --rereview` run by hand, and `land.mjs` run by hand (unless the Open questions
  decide otherwise).

## Constraints

- Node, ESM, no new runtime dependencies.

## Context

- **Decided on 2026-10-24 by the owner**, with the planning session (design doc, Part 3, "Decided
  so far", the entry "A rotation waits only for short, bounded events, and one runs at a time on a
  machine"): while a rotation is running on a machine, any later rotation is locked out. The
  multi-machine and multi-reviewer cases are to be solved later.
- Today a rotation reviews one pull request at a time (`reviewPullRequest` returns only once the
  reviewer's session ends), so within one rotation reviews never overlap. Two rotations can
  overlap only when something starts a second while the first is running, which a schedule would.
- ST-25 (`stories/done/ST-25-review-pass.md`) left out "Running rotations on more than one
  machine, and a review claim". `stories/ST-11-*.md` (grounded) plans a lock for `loop.mjs`'s
  scheduled task, not for the rotation.
- ST-51 makes a rotation wait up to `GATE_LAG_BOUND_MS` for the gate and `SWEEP_RUN_BOUND_MS` for
  the runway, so a rotation lasts longer than its reviews alone.

## Open questions

- **Where the lock lives.** In the rotation's own worktree (under its git directory, so that
  `git status` never shows it), or machine-wide for the project, beside the machine's settings
  (`~/.steward/`, named for the repository), so that two worktrees of one project on one machine
  are covered too. The planning session suggests machine-wide, named for the repository.
- **A lock left behind.** A rotation that crashed, or a machine that restarted, leaves its lock.
  Options: the lock records the process id and its start, and a later rotation takes it over when
  that process is no longer running, saying so; or a lock older than a bound is taken over; or the
  crew removes it by hand, with the refusal saying how. The planning session suggests the process
  check, with the age as a fallback.
- **The refusal's status and exit code**: whether a refused rotation exits 0 (nothing went wrong;
  the running one will do the work) or non-zero, which a schedule would report as a failure.
- **What else respects the lock**: `review.mjs --rereview` and `land.mjs` run by hand while a
  rotation runs.
