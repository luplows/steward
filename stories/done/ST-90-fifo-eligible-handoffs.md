---
id: ST-90
title: Select eligible coding handoffs in approval order
tier: normal
kind: product
depends_on: [ST-89]
model: null
blocked: null
---

## Intent

As a crew member with approved units across activated projects, I want Steward to select the oldest eligible handoff while skipping unavailable work, so that coding follows approval order and does not stall behind a changed unit.

## Acceptance criteria

- [x] **AC-1** — A selection operation considers pending ST-89 handoffs across activated projects in original approval order (not by repository, story ID, Issue label or tier) and returns one eligible handoff and its approved version. Selection never admits execution, claims a branch or starts a model; it may persist a content-change hold under AC-3 using ST-66's state-file write pattern.

- [x] **AC-2** — Eligibility rechecks activation, source accessibility and exact approved content against the current `origin/main` file or current Issue title/body. A new unrelated commit on `main` that leaves the unit unchanged does not invalidate approval. A withdrawn, completed, held or admitted handoff is not eligible.

- [x] **AC-3** — If a unit's content differs from its approved snapshot at selection, record that handoff as held with a concrete reason and require ST-89's explicit reapproval. The hold survives a restart and is not removed merely because later source contents happen to match again. Reapproval preserves the original order.

- [x] **AC-4** — A deactivated project, transient GitHub read failure or inaccessible checkout/source is temporarily ineligible with a reported reason; it is reconsidered on a later selection without changing approval or requiring reapproval if source content is unchanged. Unreadable or malformed local authorization records fail closed and select nothing.

- [x] **AC-5** — Selection skips each ineligible handoff and considers later approvals in order. It returns a distinct no-eligible-handoffs result if none qualify, without busy-looping or creating another handoff.

- [x] **AC-6** — `steward handoff list` reports held and temporarily ineligible entries with repository, source, position and actionable reason. The operation records only durable holds where approved content changed; transient refusal is not silently converted into a permanent hold.

- [x] **AC-7** — Tests exercise FIFO across projects, unrelated main advancement, file and Issue content changes, original-position reapproval, withdrawn/active entries, deactivation/reactivation, transient failure, bad state and restart. Selection starts no model or remote claim.

- [x] **AC-8** — Document eligibility and remove ST-90 from the 0.3 coding design marker when implemented.

## Out of scope

- Using or changing the legacy `stories/` tier/id queue or ST-2's proposed starvation promotion.
- Model selection, branch claims, PR publication and coordinator admission (ST-91 through ST-93).
- Automatic reapproval, source-change monitoring during coding, and cross-machine arbitration.

## Constraints

One OS user and one machine; one selection at a time. The execution boundary in ST-91 must recheck an approval before its first side effect, because selection alone is not a reservation.

## Context

- ST-89 supplies snapshots, order and handoff lifecycle.
- ST-57 supplies explicit project activation; ST-61's review fairness policy is unchanged.
- Crew decision, 2026-11-08: FIFO among eligible approvals, skipped entries retained, and reapproval keeping their original positions.

## Open questions

*(none)*
