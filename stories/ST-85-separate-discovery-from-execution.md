---
id: ST-85
title: Separate coordinator discovery from execution and bound concurrent work
tier: later
kind: product
depends_on: [ST-84]
model: null
blocked: null
---

## Intent

As a crew member running multiple coding and review tasks, I want scheduled
discovery to continue while admitted work executes within explicit capacity,
so that long sessions do not delay finding other eligible work.

## Acceptance criteria

Provisional until the 0.3 coder and the Open questions establish the concurrency
contract. This 0.4 draft is not ready for dispatch.

- [ ] **AC-1** — Due review, landing, coding and fixing discovery can progress
      while a previously admitted session is deliberately held open.
- [ ] **AC-2** — Explicit per-kind capacity limits prevent over-admission and
      leave capacity-limited work eligible for later admission.
- [ ] **AC-3** — Repeated discovery does not duplicate active work; identities,
      recovery and retry contracts are specific to each work type.
- [ ] **AC-4** — Coordinator status distinguishes active, queued and
      capacity-limited work; graceful stop accounts for admitted sessions.
- [ ] **AC-5** — Tests hold execution open across multiple due scans and
      exercise capacity, duplicate prevention and restart behavior.
- [ ] **AC-6** — Resolve the `**Planned (ST-85)**` design marker when implemented.

## Out of scope

- Weakening 0.3's bounded coder, duplicate prevention or restart recovery.
- Distributed execution, shared E-stop and cancellation of remote GitHub work.
- Altering review or landing authorization.

## Constraints

The initial threat model is one coordinator on one machine, for one OS user.
Multi-machine operation and adversarial concurrent writers are excluded.

## Context

- `scripts/dispatch/coordinator-scheduler.mjs` currently combines discovery and
  execution; ST-83 and ST-84 preserve that model for 0.2.
- `docs/outline.md` places the first bounded coding slice in 0.3 and the general
  concurrency boundary in 0.4.
- Crew decision, 2026-11-07: do not build a general concurrency architecture
  merely to support inexpensive automatic landing.

## Open questions

- What per-kind capacity and fairness settings will the 0.3 coder need?
- What must be durable versus derived across coordinator or worker failures?
- Should capacity-limited work be reconsidered on another scan or on a
  bounded completion-driven wake-up?
- Should inexpensive landing remain separate from model-session capacity?
