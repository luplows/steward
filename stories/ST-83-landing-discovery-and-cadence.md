---
id: ST-83
title: Discover unattended landing candidates on a configurable coordinator cadence
tier: next
kind: product
depends_on: [ST-54, ST-61]
model: null
blocked: null
---

## Intent

As a crew member who has authorized unattended landing, I want the coordinator to discover
candidate PRs on a shared or separately configured scan cadence, so that landing can follow
review without a hand-run rotation or a second standing authorization.

## Acceptance criteria

- [ ] **AC-1** — The optional per-OS-user `coordinator.landingScanIntervalMinutes` setting is
      accepted alongside `coordinator.scanIntervalMinutes`. When absent, landing shares the
      review scan cadence. When present, it is a positive safe integer of minutes, validated
      to the same bounds as the review setting; invalid values are refused with their key.
      No new project-owned setting is introduced.
- [ ] **AC-2** — The coordinator discovers landing candidates on the review scan when the
      optional setting is absent, or at separate due times when present. When idle, its
      wake-up uses the earlier next due scan. The intervals make scans eligible, but do
      not guarantee they run while admitted work is active; no concurrent execution or
      additional review admission is introduced.
- [ ] **AC-3** — Discovery considers open non-draft PRs on supported landing bases in
      explicitly activated projects, including current heads already reviewed and
      therefore absent from the automatic-review queue. Discovery is independent of
      whether this coordinator dispatched the reviewer.
- [ ] **AC-4** — Discovery reads each project's current `main` settings. Only `land`
      exactly `true` admits candidates for unattended landing consideration; false,
      malformed or unreadable settings never authorize it. A per-user cadence setting
      is not standing permission to land.
- [ ] **AC-5** — Deduplicate within a scan by repository, PR number and head SHA,
      and pass that identity to ST-84. Preliminary review or check filtering may
      avoid wasted calls, but the existing pilot and runway retain final authority.
- [ ] **AC-6** — Tests cover default and separate intervals, malformed settings,
      `land: false`, already-reviewed heads, drafts, duplicate discoveries and
      a held-open review delaying the next due scan rather than starting parallel work.
      This story alone dispatches no landing workflows.
- [ ] **AC-7** — Update `docs/user-config.md` and coordinator documentation. Remove
      ST-83 from the `**Planned (ST-83, ST-84)**` marker in
      `docs/agent-workflow-design.md`, leaving ST-84 until implemented.

## Out of scope

- Dispatch and landing-result reporting, owned by ST-84.
- Independent timers, parallel execution pools, or scans guaranteed during a
  running reviewer, coder or landing operation; deferred to ST-85 for 0.4.
- Altering manual landing, the runway gate, client `land` permission or the coder queue.

## Constraints

The threat model is one coordinator per OS user with explicitly activated projects
and honest settings. Manual commands remain independent of the coordinator;
the existing one-review-at-a-time bound stays intact.

## Context

- `scripts/dispatch/coordinator-scheduler.mjs` currently executes reviews sequentially.
- `scripts/dispatch/user-config.mjs` validates the per-user scan interval.
- `scripts/dispatch/land.mjs` and `scripts/land/runway.mjs` remain the landing gate.
- Crew decision, 2026-11-07: shared scans by default, optional separate landing
  interval, and general concurrency deferred until 0.4.

## Open questions

*(none)*
