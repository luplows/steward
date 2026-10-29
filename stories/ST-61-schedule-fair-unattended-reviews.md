---
id: ST-61
title: Fairly schedule bounded automatic reviews for activated projects
tier: next
kind: product
depends_on: [ST-60, ST-63]
model: null
blocked: null
---

## Intent

As a developer with several activated projects, I want a single coordinator to discover and fairly review eligible pull-request heads unattended, while bounding model usage, so that review progresses without manual rotations or repeated costly failures.

## Acceptance criteria

- [ ] **AC-1** — Once ST-58 reports exclusive coordinator ownership and ST-60 allows scheduling after a clean restart or positively proven idle interruption, with exclusive ownership safely acquired, the coordinator scans only the activated projects established by ST-57. It does not scan an installed-but-inactive project. Corrupt or unreadable activation state prevents automatic admission and surfaces a reason; it cannot cause implicit activation. Candidate selection uses ST-59's current-head, trust, draft, block and existing-verdict checks, rather than a second independently drifting eligibility implementation. Tests cover an initial scan, an inactive project, unreadable activation state and recovery-not-cleared refusal.

- [ ] **AC-2** — A project turn admits at most one eligible PR/head through ST-52 and then yields to the next eligible activated project, in deterministic round-robin order by canonical repository identity. Candidate order within a project follows ST-59. With two projects continuously holding eligible heads, two successive admitted review turns cannot belong to the same project while the other remains eligible. Tests cover two projects with multiple candidates, one empty project, activation-list changes and continued alternation after restart.

- [ ] **AC-3** — Across all the invoking OS user's activated projects, only **one coordinator-managed reviewer operation** may be active at a time. The coordinator starts no second automatic review until the preceding operation is known to have ended; uncertain survival causes ST-60's `recovery-needed` refusal and prevents further automatic admission; exceptional reconciliation is future work in draft ST-64. Direct manual `review`, `--rereview`, `rotation` and `land` commands neither consume this automatic slot nor advance the scheduler cursor. Tests hold an automatic reviewer open, attempt a second automatic admission and separately exercise direct manual work.

- [ ] **AC-4** — The scan interval governs discovery of newly eligible work, **not the delay between review turns already discovered**. On safe startup, scan immediately. As capacity becomes available, dispatch known eligible candidates in fair turns, validating the intended head again through ST-59 before any model session. When no admissible candidates remain, do not start a model session or busy-loop; perform the next discovery scan after the configured interval. Tests using a controllable clock show consecutive known reviews without an extra interval, idle waiting and discovery on a later scan.

- [ ] **AC-5** — The per-user configuration supplies `coordinator.scanIntervalMinutes`, defaulting to **15** when that optional setting is absent. Accept any positive whole number of minutes that can be represented safely by the scheduler; impose **no arbitrary product maximum**. Reject zero, negative values, fractions, nonnumeric values and overflow rather than silently substituting a default. Configuration is persisted outside project `steward.config.json`, validated before scheduling, and reported as the effective interval by `coordinator status`. A change takes effect on the next coordinator start. Tests cover default, long intervals, invalid values, persistence and restart. **ST-63 already supplies `~/.steward/config.json`, the `STEWARD_CONFIG` override and validated interval; this story consumes that contract without replacing its reader. A configuration-editing command remains separate.**

- [ ] **AC-6** — Discovery and model-start refusals have distinct, observable outcomes. A project's GitHub discovery failure does not prevent other projects from progressing and is retried on that project's next normal scan; this story introduces **no exponential project-failure backoff**. When GitHub returns an actionable rate-limit reset/retry time, the coordinator does not retry before it. When the existing reviewer returns `over-usage`, no model session is started; the coordinator honors the returned reset time when valid and rechecks actual usage before starting again. With `usage-unknown`, no model session starts on that refusal and usage is rechecked on a later scan. Tests prove these refusals cannot cause an immediate retry loop or multiply model sessions.

- [ ] **AC-7** — Once an automatic review has **started a model session** and definitively ends without a usable recorded review result (such as `session-failed`, `malformed-verdict` or `cannot-review`), the coordinator durably marks that **repository/PR/head** as requiring operator attention and does **not automatically rerun that unchanged head** on later scans or after restart. A new PR head is independently eligible. A manual invocation remains available under its existing authorization and review rules, but does not silently clear automatic retry suppression; a governing recorded verdict makes the head no longer pending. ST-59's existing bounded malformed-output retry *within that original invocation* is preserved. Ambiguous termination or posting enters ST-60's `recovery-needed` refusal instead of being classified as safely finished; 0.1 does not automatically reconcile it. Tests cover repeated scans, restart, changed head, manual independence, and no extra model session.

- [ ] **AC-8** — The scheduler durably records its next-project cursor at the automatic admission boundary and restores a deterministic fair order after clean restart. A changed activation set is reconciled without treating checkout aliases as extra projects. An acknowledged graceful stop admits no new automatic work and allows the current admitted review to finish; deactivation similarly forbids later admission for that project. Read-only `coordinator status` surfaces active project/PR/full head, effective scan interval, next scan when known, last outcome, and usage/retry-suppressed reasons without leaking credentials. Tests inject interrupted turns, deactivation during review, graceful stop and restarted coordination.

- [ ] **AC-9** — Automatic scheduler work never calls `landPullRequest`, the runway, `runRotation`, inspection, the coder or the fixer, regardless of project `land` settings. Review verdicts continue through the existing head-bound gate. Integration tests use two activated projects with differing issue/file unit-link conventions and an inactive project. The implementing PR documents the fairness and scanning behavior and resolves the ST-61 planned design marker.

## Out of scope

- Exponential backoff, bounded scheduler-level automatic retry of a model-consuming failure, programmable same-head retry budgets, operator retry-reset commands or circuit breakers. These may be planned separately if operational evidence supports them.
- Automatic landing, coding, fixing, inspection scheduling, or launching the legacy scheduled loop.
- Cross-user or cross-machine concurrency; more than one automatic reviewer slot; manual command concurrency management; universal E-stop or credential isolation.
- Process-liveness reconciliation and ambiguous posted-verdict recovery (draft ST-64); 0.1 retains ST-60's protective refusal.
- Changing ST-63's per-user `config.json` file name, `STEWARD_CONFIG` override or validation contract, or adding a configuration-editing command.

## Constraints

- Use ST-57 activation, ST-58 owner/stop behavior, ST-59 bounded candidate/reviewer operation, ST-52 automatic admission and ST-60 routine completion/clean-start validation. Do not build a parallel reviewer, GitHub verdict ledger or whole-rotation scheduler.
- GitHub is authoritative for the PR's current head and governing verdict; discovered candidates are provisional and are rechecked at the review boundary.
- Preserve the existing reviewer usage checks, tool selection, timeout/stall bounds and single-invocation malformed-output retry. Direct manual commands remain independent even when automatic retry of a head is suppressed.

## Context

- Crew decision, 2026-10-27: one coordinator and one automatic reviewer per OS user; fair activated-project turns; no unattended landing in 0.1; manual calls bypass coordinator slots; shared E-stop is deferred until before 1.0.
- Crew decision, 2026-10-27: 15-minute scan default, configurable positive whole-minute interval without a product maximum; discovery interval is not the inter-review delay.
- Crew decision, 2026-10-27: no exponential project-failure backoff in this scheduling story; a failed model-consuming review is not automatically retried on its unchanged head in 0.1. Reviewer's own bounded retry remains.
- `scripts/dispatch/review.mjs` already reports named usage and session outcomes; `scripts/dispatch/usage.mjs` provides usage reset timestamps where available. `scripts/dispatch/rotation.mjs` includes landing and inspection, so a whole rotation is not a review-only automatic turn.
- Crew decision, 2026-10-27: ST-60 supplies routine outcomes, clean/provably idle restart and refusal on uncertain execution; exceptional recovery is deferred to draft ST-64 and does not block this story. ST-63 is implemented on `main`: `scripts/dispatch/user-config.mjs` provides `readUserConfig` and the validated 15-minute default. ST-61 consumes these interfaces rather than reimplementing configuration parsing.
- Suggested size: medium/large integration story; automatic retry/backoff is intentionally excluded.

## Open questions

- Confirm the implemented ST-60 completion/startup interface before dispatch: recorded verdict, no-model refusal, definitive model-consuming failure and `recovery-needed` must reach the scheduler without losing retry suppression. Exceptional automatic reconciliation is not required.
- Confirm the coordinator startup integration consumes ST-63's implemented `readUserConfig` contract and effective scan interval, including refusal on invalid configuration, before clearing this question.