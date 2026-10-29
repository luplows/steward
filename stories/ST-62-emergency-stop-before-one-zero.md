---
id: ST-62
title: Stop registered local Steward work with a per-user emergency-stop latch
tier: later
kind: workflow
depends_on: [ST-61]
model: null
blocked: null
---

## Intent

As a developer, I want one emergency stop for Steward work started under my OS account, whether automatic or manual, so that I can terminate registered local work and prevent new execution until I explicitly authorize a reset.

## Acceptance criteria

Provisional; this remains a draft for the before-1.0 milestone until its process-supervision design is decided.

- [ ] **AC-1** — E-stop engagement durably latches the invoking OS user's Steward execution state before requesting process termination. The state persists across coordinator restart, shell exit and machine reboot. Supported local commands that would start new executable work refuse while latched; read-only status and recovery remain available.
- [ ] **AC-2** — Coordinator-managed and independent manual executions register their owned work and supervised descendants through a common safety mechanism independent of scheduler admission. An E-stop attempts to terminate every registered local process tree, not just coordinator jobs, and does not require the coordinator to be running.
- [ ] **AC-3** — The command verifies termination or reports each process whose termination is uncertain. A signal sent or a killed parent does not by itself count as successful descendant termination. Uncertainty keeps the latch engaged.
- [ ] **AC-4** — Reset is explicit, auditable, restricted to the invoking user's Steward scope, and refuses while registered potentially active work remains unresolved. New work cannot race between a latch check and registration.
- [ ] **AC-5** — Tests exercise concurrently running manual and automatic commands, separate OS processes under one account, a descendant surviving a parent, an interrupted E-stop, restart with a latched stop, and an explicit safe reset. Cross-account and cross-machine processes are not included.
- [ ] **AC-6** — Documentation explains that local E-stop cannot recall a GitHub landing workflow or other remote side effect already dispatched, and makes no credential or filesystem isolation claim. The implementing PR resolves the planned design marker.

## Out of scope

- E-stop in 0.1, per-handoff cancellation UX, stopping arbitrary non-Steward processes, or cross-account OS administration.
- Revoking credentials, cancelling already-dispatched GitHub Actions, or bypassing the review gate.

## Constraints

- The crew's 2026-10-27 decision makes this a pre-1.0 release requirement, not a prerequisite for 0.1 review scheduling.

## Context

- `scripts/dispatch/cli.mjs` permits direct module invocation, and `scripts/dispatch/spawn.mjs` has session timeout/stall termination but not durable cross-command registration.
- ST-58 and ST-61 are the proposed automatic coordinator contracts; manual `review`, `rotation`, and `land` remain independent of its scheduling limits.
- Suggested size: large; split before implementation if process registration and stop/reset cannot be independently reviewed together.

## Open questions

- Which user-owned service, process supervisor, or OS primitives can verify descendant termination across supported platforms without requiring administrator privileges?
- Which existing executable entry points must register, including `coder`, `story`, `loop`, `review`, `rotation` and `land`, and what actions count as new execution while latched?
- Should registration and termination be separate implementation stories, and what explicit operator intervention handles irrecoverably uncertain processes?