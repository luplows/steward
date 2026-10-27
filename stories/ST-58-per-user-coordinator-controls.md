---
id: ST-58
title: Start, inspect, and gracefully stop one coordinator per OS user
tier: next
kind: workflow
depends_on: [ST-57]
model: null
blocked: null
---

## Intent

As a developer, I want one local coordinator that I can start, inspect and gracefully stop, so that automatic review has a single per-user owner without restricting my independently invoked Steward commands.

## Acceptance criteria

- [ ] **AC-1** — `steward coordinator start` launches a detached long-running coordinator for the invoking OS user. It reports `started` only **after the background process acknowledges exclusive ownership**; failure to launch or acquire ownership does not report success. It distinguishes `started`, `already-running` and errors, does not require the launching terminal to remain attached, and may remain idle with no activated projects. This story itself introduces no scheduling or reviewer dispatch; when ST-61 later adds scheduling, startup may initiate an immediate scan.
- [ ] **AC-2** — Concurrent starts from independent processes of the same OS user yield exactly one authoritative coordinator owner. The losing attempt starts no scheduler or worker and reports the existing owner and start time with a nonzero already-running result. Ownership uses an exclusive OS-backed or atomic mechanism; reading a PID file alone is insufficient.
- [ ] **AC-3** — `steward coordinator status` works whether a coordinator is running or not, does not itself start one, and provides a machine-readable result distinguishing `stopped`, `running`, `stopping`, and `recovery-needed`, with owner process identity/start time when known. It does not leak credentials. Tests cover running, missing owner, and unverifiable/stale owner metadata.
- [ ] **AC-4** — `steward coordinator stop` durably requests a graceful drain and **returns promptly with `stopping`** when admitted work is still running, without waiting for a review to finish. Its acknowledgment forms the admission boundary: **no new automatic job may be admitted after stop is acknowledged**. Work admitted earlier may finish; the coordinator then releases ownership, and `status` reports `stopped`. Repeated stop requests are idempotent, including when already stopped. Tests hold a review open, acknowledge stop, attempt further admission, and verify the `stopping` → `stopped` transition.
- [ ] **AC-5** — Ordinary completion and thrown exceptions release clean ownership; a crashed or ambiguous owner cannot be silently replaced solely by age or a dead-looking PID. Until ST-60 recovery is available, the ambiguous state refuses a competing start and reports the recovery requirement.
- [ ] **AC-6** — Independent manual `review`, `rotation` and `land` commands continue to run without asking the coordinator for admission or consuming its reviewer slot, including when the coordinator is starting, running, stopping or stopped. No new lock is placed in those manual entry points.
- [ ] **AC-7** — Documentation names `steward coordinator start`, `status` and `stop`, describes detached startup and ownership acknowledgement, immediate-return draining semantics, and the difference between graceful coordinator stop and deferred shared E-stop. The implementing PR resolves this story's planned design-of-record marker.

## Out of scope

- Choosing PRs, automated scanning, interval timers and fair scheduling (ST-61).
- Durable per-review reservations (ST-52) and worker recovery after abnormal termination (ST-60).
- Forcibly terminating active manual or automatic process trees, or an E-stop latch (deferred pre-1.0 work).
- Cross-user supervision, auto-installing an OS service, or automatic startup on login/boot.

## Constraints

- One coordinator per OS user, across that user's terminal sessions and activated repositories. Other OS users are independent.
- No credential or filesystem isolation claim; existing machine settings remain authoritative for tool choices and usage limits.

## Context

- `scripts/dispatch/cli.mjs` currently launches individual modules in their own processes and supports direct module invocation; that behavior is preserved.
- ST-57 supplies the activated-project record. ST-60 supplies reconciliation for interrupted jobs and abandoned ownership.
- Crew decision, 2026-10-27: graceful stop remains in 0.1; E-stop is required before 1.0, not for 0.1.
- Suggested size: medium; ownership/control without a scheduler.

## Open questions

*(none)*
