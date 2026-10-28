---
id: ST-60
title: Handle routine review failures and clean coordinator restart
tier: next
kind: workflow
depends_on: [ST-52]
model: null
blocked: null
---

## Intent

As a developer, I want routine reviewer failures and graceful coordinator restarts to leave automatic work in a clear state, so that ordinary operation can continue without repeating a failed review or silently abandoning uncertain work.

## Acceptance criteria

- [ ] **AC-1** — While the coordinator remains alive, an automatic operation that returns after its supervised reviewer work has ended records its actual terminal result through ST-52, including whether a model session started. Successful review, a refusal before model start, and a definitive model-consuming failure remain distinct. A thrown error is not alone evidence that reviewer work ended; an uncertain operation retains its nonterminal reservation.
- [ ] **AC-2** — The completion handoff to ST-61 distinguishes a recorded verdict, a no-model refusal, and a definitive model-consuming failure. ST-61 applies its existing retry rules: a failure after model start does not automatically retry the unchanged repository/PR/head on later scans or after restart; no-model refusals may be reconsidered under its usage/discovery rules. Preserve the reviewer's existing bounded malformed-output retry within the original invocation. Persist the outcome needed for this handoff before admitting another automatic operation; persistence failure enters AC-4 rather than silently losing retry suppression.
- [ ] **AC-3** — A graceful stop follows ST-58: close admission at stop acknowledgement, let the admitted operation finish, durably record its outcome, then release clean ownership. An explicit start after that clean stop may schedule after ownership acknowledgement and validation of local state, rechecking current GitHub eligibility through ST-59. Recorded verdicts and unchanged-head failure suppression survive this clean restart. No machine reboot is required.
- [ ] **AC-4** — On start with abandoned or unverifiable ownership, a nonterminal review reservation, or unreadable/inconsistent completion state, report `recovery-needed` and start no automatic reviewer. Status identifies the known repository/PR/head and last phase when available, explains the uncertainty, and says automatic reconciliation is outside 0.1. Do not delete a reservation, kill an unknown process or take over based only on elapsed time or PID absence. A posted verdict or moved head alone does not clear unfinished execution. Independent manual commands remain available.
- [ ] **AC-5** — A durable graceful-stop request is not treated as clean completion. If interruption prevents the drain and completion record from finishing, a later explicit start reports AC-4's refusal. Repeated status/stop calls do not clear the uncertainty or admit work.
- [ ] **AC-6** — Stand-in tests cover a returned no-model refusal, a definitive reviewer failure, a recorded review, an acknowledged stop with work held open, successful drain and clean restart, failed outcome persistence, and a startup fixture containing unfinished work or interrupted-stop state. Assert the handoff classifications and zero automatic admissions in uncertain cases; no exhaustive OS crash-window or descendant-liveness experiment is required. The implementing PR documents these boundaries and resolves this story's planned design marker.

## Out of scope

- Automatic recovery after coordinator/supervisor death, reconstructing orphaned process trees, PID-reuse reconciliation, uncertain GitHub POST recovery or a targeted operator recovery command (draft ST-64, future release).
- Proving termination of every arbitrary descendant, OS-specific containment, or verifying a full machine reboot (ST-64 questions, not 0.1 prerequisites).
- Killing sessions on demand, shared E-stop or registration of independent manual commands (ST-62).
- Adding scheduler retry budgets, backoff or retry-reset commands; ST-61 keeps its existing policy.

## Constraints

- Reuse ST-52 reservations, ST-58 ownership/drain behavior, ST-59 review execution and ST-61 retry policy. Local execution records are not GitHub verdicts.
- This story handles routine outcomes under a living supervisor and clean stop/start. Unexpected interruptions receive a protective refusal, not a claim of automatic recovery.

## Context

- Crew decision, 2026-10-27: narrow 0.1 to expected reviewer failures and ordinary graceful restart; defer comprehensive exceptional recovery to a separate draft.
- `scripts/dispatch/review.mjs` reports named outcomes and rechecks heads/verdicts; `spawn.mjs` supplies timeout/stall supervision while its caller lives. Neither supplies durable supervision across caller death.
- ST-64 holds the exceptional-recovery questions. It is not a dependency of 0.1 scheduling.

## Open questions

*(none)*
