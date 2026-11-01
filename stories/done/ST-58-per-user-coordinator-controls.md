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

As a developer, I want one local coordinator that I can start, inspect and gracefully stop, so
that automatic review has a single per-user owner without restricting my independently invoked
Steward commands. These are commands one person runs from a terminal: they cover the happy path,
say plainly what they did, and stop cleanly when something goes wrong, rather than defending
against two of them racing or every way a process can die.

## Acceptance criteria

- [x] **AC-1** — `steward coordinator start` launches a detached long-running coordinator for the
      invoking OS user. It reports `started` only **after the background process has written its
      record (AC-2) and acknowledged that it is running**; failure to launch does not report
      success. It distinguishes `started`, `already-running` and errors, does not require the
      launching terminal to remain attached, and may remain idle with no activated projects. This
      story itself introduces no scheduling or reviewer dispatch; when ST-61 later adds scheduling,
      startup may initiate an immediate scan.
- [x] **AC-2** — **One coordinator, by its record.** The running coordinator keeps a record at
      `~/.steward/state/coordinator.json` with its process id and start time, and no credentials. A
      `start` while the recorded process is running starts nothing and reports `already-running`
      with that process id and start time, exiting nonzero. Tests start one coordinator, then a
      second `start`, and show one process and the `already-running` report.
- [x] **AC-3** — `steward coordinator status` works whether a coordinator is running or not, does
      not itself start one, and provides a machine-readable result distinguishing `stopped`,
      `running` and `stopping`, with the process id and start time when there is a record. A
      record whose process is no longer running is reported as `stopped`, saying that the
      previous coordinator ended without removing its record. It does not leak credentials. Tests
      cover running, no record, and a record whose process is gone.
- [x] **AC-4** — `steward coordinator stop` requests a graceful drain and **returns promptly with
      `stopping`** when admitted work is still running, without waiting for a review to finish.
      Its acknowledgment forms the admission boundary: **no new automatic job may be admitted
      after stop is acknowledged**. Work admitted earlier may finish; the coordinator then removes
      its record and exits, and `status` reports `stopped`. Repeated stop requests are idempotent,
      including when already stopped. Tests may use an injected, simulated admitted job held open
      (without scheduling or dispatching a real review): acknowledge stop, attempt admission of
      another simulated job, and verify refusal of new admission and the `stopping` → `stopped`
      transition when the held job completes.
- [x] **AC-5** — **Exiting and starting again.** On an ordinary exit, or a handled error, with no
      admitted work running, the coordinator removes its record. A `start` that finds a record
      whose process is no longer running replaces it, says that it did, and starts as AC-1 says.
      Whether such a coordinator may then schedule is ST-60's decision (its idle proof and
      `recovery-needed` refusal), not this story's. A test shows a `start` after a coordinator
      killed while idle.
- [x] **AC-6** — Independent manual `review`, `rotation` and `land` commands continue to run
      without asking the coordinator for admission or consuming its reviewer slot, including when
      the coordinator is starting, running, stopping or stopped. No new lock is placed in those
      manual entry points.
- [x] **AC-7** — Documentation names `steward coordinator start`, `status` and `stop`, describes
      detached startup and its acknowledgement, the coordinator's record, immediate-return draining
      semantics, and the difference between graceful coordinator stop and deferred shared E-stop.
      The implementing PR resolves this story's planned design-of-record marker.

## Out of scope

The threat model is one member of the crew running one `steward coordinator` command at a time
from a terminal, as the invoking OS user (Constraints). Outside it, and not to be guarded against,
for 0.1:

- Two `start` commands racing, or another process writing the coordinator's record; an exclusive
  OS-level lock.
- A recorded process id reused by an unrelated process; hand-edited or partly written records.
- Deciding whether work was in flight when a coordinator died, and `recovery-needed`: ST-60.
- Choosing PRs, automated scanning, interval timers and fair scheduling (ST-61).
- Durable per-review reservations (ST-52), per-review result handoff and clean-state validation
  (ST-60), and exceptional worker recovery after abnormal termination (draft ST-64).
- Forcibly terminating active manual or automatic process trees, or an E-stop latch (deferred
  pre-1.0 work).
- Cross-user supervision, auto-installing an OS service, or automatic startup on login/boot.

## Constraints

- **Threat model:** one member of the crew, one command at a time, from a terminal. The
  coordinator's record says which process owns it; this story need prove no more than that a
  second `start` finds a running one and that `stop` closes admission.
- One coordinator per OS user, across that user's terminal sessions and activated repositories.
  Other OS users are independent.
- No credential or filesystem isolation claim; the implemented per-user `~/.steward/config.json`
  (ST-63) remains authoritative for tool choices and usage limits.
- Node 24, ESM, no new runtime dependencies or model calls. Tests use a temporary home directory.

## Context

- `scripts/dispatch/cli.mjs` currently launches individual modules in their own processes and
  supports direct module invocation; that behavior is preserved.
- ST-57 supplies the activated-project record, at `~/.steward/state/projects.json`. ST-60 supplies
  routine completion, clean/provably idle restart and a protective refusal for uncertain execution
  or ownership; draft ST-64 holds future exceptional reconciliation.
- Crew decision, 2026-10-27: graceful stop remains in 0.1; E-stop is required before 1.0, not for
  0.1.
- Crew decision, 2026-10-31: rescope this story to the happy path under the threat model in
  Constraints, as ST-56 was in #101. Exactly one owner under concurrent starts, an OS-backed
  exclusive mechanism, the `recovery-needed` status and the provably idle takeover are dropped
  from it; `recovery-needed` and the idle proof stay with ST-60, which comes after this story.
  `git log` of this file holds the earlier version.
- `docs/planning-session.md`, "Writing it": a safety criterion names a bounded threat model.
- Suggested size: medium; ownership/control without a scheduler.

## Open questions

*(none)*
