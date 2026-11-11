---
id: ST-93
title: Schedule approved coding and report interrupted handoffs
tier: normal
kind: product
depends_on: [ST-84, ST-90, ST-91, ST-92]
model: null
blocked: null
---

## Intent

As a crew member, I want the coordinator to execute explicitly approved coding work sequentially and retain actionable stopped-work records, so that an interrupted session does not silently run again or lose its evidence.

## Acceptance criteria

- [x] **AC-1** — The existing per-user coordinator first services currently due review and unattended landing work under their existing rules, then admits the oldest eligible coding handoff from ST-90. It waits for one bounded ST-91 execution and ST-92 publication before reconsidering available work. At most one coordinator-managed coder runs at a time; coding may delay subsequent scans. No independent discovery/execution architecture is added.

- [x] **AC-2** — Before starting a branch claim, setup or model, durably record a unique active admission ID, handoff ID, approved revision, repository, intended branch and admission time using ST-66's state-file write pattern. Pass that matching admission identity to ST-91. A failed admission write starts no model or remote claim, and further coding admission stops with an actionable error rather than using uncertain authorization state.

- [x] **AC-3** — On a successful pushed branch, call ST-92 once, and on successful publication record the PR/head and mark the handoff completed so scans and restarts do not recode it. On a model-consuming failure, missing PR or incomplete publication, retain the known branch, PR and local recoverable-work location and mark the handoff stopped pending crew action.

- [x] **AC-4** — At coordinator startup, a coding admission left running by the previous coordinator becomes interrupted and ineligible for automatic redispatch; it does not automatically resume or re-run a model, delete a surviving worker, re-claim the branch or clean an orphan worktree. Record what is known and what the crew should inspect.

- [x] **AC-5** — A refusal confirmed to occur before both remote claim and model start is resolved only after the active admission is durably cleared. A retryable refusal (`over-usage`, `usage-unknown`, or one of ST-90 AC-4's temporary conditions: a deactivated project, a failed GitHub read, a source or checkout that cannot be reached) restores the handoff to pending; it may be reconsidered at a later normal scheduling pass, never in an immediate busy-loop. ST-91's changed-content refusal instead records ST-90 AC-3's hold, with its reason, so the handoff needs ST-89's explicit reapproval and is not released by the source later matching the approved snapshot again. If clearing the admission fails, stop further coding admission and report the unresolved record rather than dispatching again. Any claimed or uncertain side effect is stopped for crew attention, not treated as a safe automatic retry.

- [x] **AC-6** — `steward coordinator status` and `status --json`, and `steward handoff list`, show queued, running, completed and stopped coding work as appropriate, with repository, handoff ID, unit, reason, known branch/PR/worktree and next crew action. Stopped history remains inspectable when no coordinator process is running. These command outputs are 0.3's crew notification; no alert service is required.

- [x] **AC-7** — Once `coordinator stop` acknowledges closure, no new coding work is admitted. An already admitted bounded coding-and-publication operation finishes under the existing graceful drain rules, and pending handoffs remain for the next start. Existing manual commands, automatic reviews and runway safety remain independent.

- [x] **AC-8** — Tests with injected stand-in sessions and temporary home state exercise FIFO across repositories, due review/landing precedence, matching vs mismatched active admission, one active coder, changed approval before admission, completed PR, publication failure, no-model refusal with durable admission clearing, a changed-content refusal at execution recorded as a hold that a later revert of the source does not release, failed clearing write, interrupted restart without second execution, failed admission-state writes and graceful stop. No live model or forced OS crash test is required.

- [x] **AC-9** — Document sequential coding and recovery, including that long sessions delay due scans, and remove ST-93 from the 0.3 design marker when implemented.

## Out of scope

- General concurrent workers or independent due-scan execution (ST-85 in 0.4).
- Automatic fixing, coder retries, resumptions and remote orphan cleanup.
- Force-killing surviving workers, multi-machine exactly-once guarantees or a shared emergency stop.
- GitHub Issues, push notifications or dedicated alerts for stopped work.

## Constraints

One OS user, one coordinator, one machine; no competing coordinator processes or adversarial state writers. The durable admission barrier guards against unintended repeat sessions after ordinary restart; it does not claim full crash/process isolation.

## Context

- ST-58/ST-60: coordinator lifecycle and interrupted review precedents.
- ST-61 and ST-84: existing sequential review and landing scheduler.
- ST-90, ST-91 and ST-92: eligible work, bounded coding and PR publication.
- Crew decisions, 2026-11-08: review/landing at a scheduling boundary before coding; no general concurrency; stopped status is sufficient notification.

## Open questions

*(none)*
