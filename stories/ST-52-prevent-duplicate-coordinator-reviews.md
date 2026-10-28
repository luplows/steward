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

As a developer using unattended review, I want the per-user coordinator to reserve each PR/head review before starting it, so that repeated scans cannot duplicate coordinator-managed work without limiting independently invoked manual Steward commands.

## Acceptance criteria

- [ ] **AC-1** — Before starting an automatic reviewer, the coordinator atomically records a durable, nonterminal reservation for the canonical `(repository owner/name, PR number, full head SHA)` identity in its per-user work state. Two simultaneous admission attempts for the same identity, including attempts from different registered checkout paths, admit at most one operation; the rejected attempt starts no reviewer. If the reservation cannot be durably recorded, admission fails closed and starts no reviewer. Tests exercise concurrent admission, checkout aliases, and persistence failure.
- [ ] **AC-2** — A pending or running reservation for the same identity makes a later automatic attempt return a distinct, nonfatal `already-admitted` outcome, identifying the reserved work rather than reporting a review success. It neither starts a model session nor changes the existing reservation. A different head is a different identity, but ST-59's expected-head check still refuses review if GitHub no longer reports that head; no automatically selected stale head starts a session. Tests exercise both cases.
- [ ] **AC-3** — When an automatic operation completes and the coordinator can establish that its reviewer work has ended, its reservation transitions to a durable terminal outcome with the actual operation result, including a returned refusal or failure. A completed successful review is not falsely treated as an in-progress reservation. A terminal failed or refused attempt no longer blocks admission solely because of that previous reservation; the future scheduler (ST-61) decides if and when a retry is eligible from current GitHub state and backoff. Tests cover recorded review, known failure and re-admission after a terminal outcome without needing a scheduler.
- [ ] **AC-4** — If an operation is interrupted or throws before reviewer termination can be established, its reservation remains nonterminal and prevents automatic re-admission for that identity. It is surfaced as requiring ST-60 reconciliation, rather than deleted because a timeout elapsed, a PID appears absent, or an exception occurred. Tests inject an interruption before a terminal record and show that subsequent admission refuses while the result is uncertain. ST-52 does not implement the reconciliation or operator override.
- [ ] **AC-5** — Direct manual `review`, `review --rereview`, `rotation` and `land` operations neither acquire nor wait for the coordinator's automatic reservation, and do not modify its automatic admission state. Tests hold an automatic reservation and show that an independently invoked manual review reaches its normal review logic without reservation admission. Existing review integrity checks, manual landing authorization and GitHub gate constraints remain unchanged; overlap does not confer coordinator ownership of manual work.
- [ ] **AC-6** — Automatic admission uses the coordinator's existing per-user state and ownership boundary, not a second lock around `runRotation`. Documentation explains that this prevents duplicate *coordinator-dispatched* work only; manual concurrency and possible duplicate costs/verdict races are operator-managed. The implementing PR resolves the design of record's **Planned (ST-52)** marker and corrects the superseded rotation-lock description where applicable.

## Out of scope

- Locking, serializing or warning on manual reviews, re-reviews, rotations, landings or externally orchestrated Steward commands; a separate manual advisory warning can be considered later.
- Scheduling choices, project fairness, scan cadence, global automatic reviewer concurrency and retry backoff policy (ST-61).
- Process-tree monitoring, reclaiming uncertain reservations, crash recovery or targeted operator reconciliation (ST-60).
- Automatic landing, universal emergency stop, cross-user or cross-machine reservations, GitHub-distributed claims or guaranteed exactly-once remote side effects.

## Constraints

- The automatic reservation belongs to the coordinator for one OS user on one machine. GitHub remains authoritative for PR heads and governing verdicts; the local reservation exists for automatic admission and recovery, not as a replacement review verdict or GitHub lock.

## Context

- Crew decision, 2026-10-27: manual Steward commands and external harnesses may parallelize independently of the coordinator's admission and concurrency rules. The earlier 2026-10-24 proposal to lock out every concurrent same-project rotation is superseded.
- ST-58 supplies one coordinator owner and per-user local state; ST-59 supplies the bounded review-only operation and expected-head checking. Both are introduced alongside this ST-52 revision in planning PR #93.
- `scripts/dispatch/rotation.mjs` invokes `reviewPullRequest` and may request landing; the coordinator must not use a whole rotation for automatic 0.1 review admission.
- `scripts/dispatch/review.mjs` checks current heads and governing verdicts but does not provide admission across independent manual invocations.
- ST-60 owns uncertain process survival and recovery. ST-61 owns fair scheduling, the global automatic reviewer limit and automatic retry-eligibility policy.

## Open questions

*(none)*
