---
id: ST-60
title: Reconcile unfinished coordinator reviews safely after interruption
tier: next
kind: workflow
depends_on: [ST-52]
model: null
blocked: null
---

## Intent

As a developer, I want a restarted coordinator to reconcile its previous automatic review before scheduling another, so that a crashed owner does not silently duplicate a live reviewer or discard an uncertain outcome.

## Acceptance criteria

- [ ] **AC-1** — Before spawning an automatic review, persist its repository, PR, intended head SHA, execution ID, owner identity, start intent and recovery phase durably. Persist the supervised process identity when known, including enough identity to reject a reused PID. State transitions use crash-safe writes, and an interrupted write never becomes an implied clean completion.
- [ ] **AC-2** — On explicit coordinator start after an unclean exit, reconcile all nonterminal automatic work and ownership before accepting another automatic job. Inspect surviving process identity and the current PR/head/governing verdict. Neither process age nor the absence of a current-head verdict alone proves that a previous worker ended.
- [ ] **AC-3** — When termination of the prior operation and its potentially surviving descendants is positively established, release its obsolete reservation, record the recovery outcome, and let later scheduling reconsider the current GitHub head using existing review eligibility. A recorded verdict is not duplicated. Tests cover an exited worker with and without a posted verdict and a moved head.
- [ ] **AC-4** — When process identity, child startup, descendant liveness, or termination is uncertain, the coordinator reports `recovery-needed` with the implicated project/PR/head and actionable diagnostics, and dispatches no further automatic reviewer until reconciled. It does not kill unknown processes or take over using only an expired lock/PID. Tests cover PID reuse, missing child identity after spawn intent and a confirmed survivor.
- [ ] **AC-5** — Graceful-stop intent survives an interruption: recovery reports it rather than silently interpreting a stop request as permission for unattended scheduling. Status remains available, and independent manual commands are unaffected by the coordinator's recovery block.
- [ ] **AC-6** — Tests simulate process death between intent recording, child creation, child identity persistence, verdict posting and final state commit; no path treats unverified work as safe to duplicate. The implementing PR documents the recovery procedure and resolves its planned design marker.

## Out of scope

- Killing outstanding sessions on demand, a shared E-stop, or a process registry for independent manual commands.
- Automatically retrying a reviewer that still has a live or unverifiable child, or treating local state as a GitHub verdict.
- Cross-user or cross-machine claims and forced abandonment of an uncertain review without explicit operator reconciliation.
- Scheduling policy, interval controls and fairness (ST-61).

## Constraints

- Recovery must be conservative on supported operating systems. If it cannot verify the necessary process facts, do not claim safe automatic resumption.

## Context

- `scripts/dispatch/spawn.mjs` currently supervises child timeouts and stalls but does not supply durable child supervision across a crash of the launching process.
- `scripts/dispatch/review.mjs` checks PR head/verdict state around review posting; recovery must reuse those facts rather than invent a parallel result authority.
- ST-52 (revised in planning PR #93) supplies nonterminal automatic reservations; ST-58 (also in PR #93) supplies ownership/control and graceful-stop intent.
- Crew decision, 2026-10-27: E-stop is deferred until before 1.0, but safe restart remains essential to 0.1.
- Suggested size: medium/large; may require platform-specific process supervision tests.

## Open questions

- Which supported OS process identity and descendant-liveness mechanism gives sufficient positive evidence after a supervisor crash, particularly on Windows? Define observable success/refusal cases before dispatching this story.
- When previous work remains unverifiable, what explicit operator recovery action is allowed, and what proof is required to clear the block? Do not introduce an implicit unsafe `--force` takeover.