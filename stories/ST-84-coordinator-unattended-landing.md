---
id: ST-84
title: Have the coordinator request bounded unattended landing and report outcomes
tier: next
kind: product
depends_on: [ST-83]
model: null
blocked: null
---

## Intent

As a crew member using unattended landing, I want the coordinator to invoke Steward's
existing pilot for eligible PRs and report what happened, so that reviewed work can
land without manual rotations or costly new recovery machinery.

## Acceptance criteria

- [ ] **AC-1** — The coordinator consumes due landing candidates from ST-83 through
      its existing work-admission lifecycle. Immediately before a request, it
      rechecks activation, `land: true` in current project `main` settings, and
      the PR/head identity; an invalid candidate dispatches nothing.
- [ ] **AC-2** — Each attempt invokes `landPullRequest` with `mode: unattended` and
      `once: true` via `createLandContext` using the project's `landWhen`.
      There is no direct merge or manual-mode dispatch. The pilot and runway
      make the final review, CI, authorization and protection decisions.
- [ ] **AC-3** — The pilot returns a distinguishable result when a candidate is
      not yet landable, and waits only for its bounded gate-lag and sweep-run
      windows after eligibility, not for open-ended checks or processes.
- [ ] **AC-4** — One running coordinator does not overlap local landing attempts
      for the same PR/head. A later scan may reconsider a PR whose previous
      attempt ended without a merge, after fresh authorization and eligibility
      checks. No durable exactly-once request ledger is introduced.
- [ ] **AC-5** — `steward coordinator status` and `status --json` distinguish active
      landing from review and report the last landing outcome, repository, PR
      number, head, time and any refusal or failure reason. A successful
      workflow dispatch is not falsely reported as a confirmed merge.
- [ ] **AC-6** — Graceful stop admits no more landing work and lets admitted
      bounded attempts finish. A restarted coordinator uses normal discovery
      and may reconsider a still-eligible PR; the runway is authoritative.
- [ ] **AC-7** — Tests cover the success path, denied or revoked permission,
      deactivation, changed head, duplicate scan, pending sweep, errors, status,
      graceful stop and preservation of the one-review-at-a-time limit.
- [ ] **AC-8** — Document this behavior and the limitation that due scans can
      be delayed by active execution until ST-85. Resolve the
      `**Planned (ST-84)**` design marker.

## Out of scope

- Independently ticking scans, parallel coders or general execution capacity (ST-85).
- Durable attempt recovery, exact-once dispatch, or cancelling a remote workflow.
- Manual landing changes, post-merge CI changes, linked-issue closure or
  retiring the pilot's older long-wait behavior (draft ST-53).

## Constraints

The threat model is one coordinator for one OS user. The runway already
serializes merge workflows and rechecks authorization and eligibility.
Repeated inexpensive requests after a completed local attempt are acceptable.
The 0.2 coordinator still executes admitted work sequentially.

## Context

- ST-83 supplies discovery, cadence and candidate identity.
- `scripts/dispatch/land.mjs` supports bounded `once: true` unattended requests.
- `templates/workflows/land-approved.yml` serializes runway runs.
- `scripts/dispatch/coordinator.mjs` owns admission, stop and status.
- Crew decision, 2026-11-07: avoid importing costly coder-session duplicate
  and interrupted-work recovery rules into inexpensive landing calls.

## Open questions

*(none)*
