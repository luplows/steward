---
id: ST-89
title: Approve and retain durable coding handoffs
tier: normal
kind: product
depends_on: [ST-57, ST-66]
model: null
blocked: null
---

## Intent

As a crew member, I want to explicitly approve an existing file or GitHub Issue for coding and retain that exact approval across restarts, so that coding requires a deliberate handoff rather than automatic selection from a project's backlog.

## Acceptance criteria

- [ ] **AC-1** — `steward handoff add --repo <owner/name> --file <relative-path>` and `steward handoff add --repo <owner/name> --issue <number>` approve one unit from an activated GitHub project. A missing activation, unsupported `unitLinks` kind, unsafe path, unreadable file on `origin/main`, missing Issue, or pull request supplied as an Issue refuses without recording an approval. Files are not required to match a story schema.

- [ ] **AC-2** — Each approval stores a stable handoff ID, repository, source kind and identity, approval order, exact approved text and source provenance: the full `main` commit SHA for a file; Issue number, title, body and content fingerprint for an Issue. The file path is repository-relative and original, not a path inferred from a future PR. The approval sequence is durable and strictly ordered even for handoffs in different projects.

- [ ] **AC-3** — Store approvals and historical versions under `~/.steward/state/handoffs.json`, not in a project, `~/.steward/config.json`, or `projects.json`. `steward handoff list` and `steward handoff show <id>` read them after a fresh process starts; `show` includes the complete approved text, version and source identity. Neither command starts models or alters GitHub.

- [ ] **AC-4** — Repeating `add` for the same pending or held source at the same approved content reports the existing handoff rather than creating another. `steward handoff reapprove <id>` explicitly reads the source again, retains the same handoff ID and original approval-order position, appends the previous approved version to history, and returns a pending approval for the new text. Refuse reapproval of a handoff already admitted, completed or withdrawn; reapproval never changes content already handed to a running coder.

- [ ] **AC-5** — `steward handoff withdraw <id>` stops future selection of a pending or held approval and retains the history. It cannot cancel or withdraw an already admitted coder. An unknown ID fails with a useful explanation.

- [ ] **AC-6** — Use ST-66's `writeStateFile` temporary-write-and-rename pattern. A failed state write leaves the previous valid file unchanged; unreadable or malformed existing records refuse updates or selection instead of supplying default authorization. Validate record identity, ordering and approval versions on read.

- [ ] **AC-7** — Tests use temporary homes and local Git/GitHub stand-ins for file and Issue approvals, duplicate approval, changed-content reapproval preserving order and history, withdrawal, bad sources, restart persistence, and failed state writes. No model session or real GitHub mutation runs.

- [ ] **AC-8** — Document the command interface and local storage, and remove ST-89 from the design-of-record `**Planned (ST-89, ST-90, ST-91, ST-92, ST-93)**` marker when implemented.

## Out of scope

- Automatically picking units from a backlog or changing a client's definition of readiness.
- Scheduling, branch claiming, coder execution and PR publication (ST-90 through ST-93).
- Cross-machine synchronization, parallel handoff commands, distributed records and adversarial local writers.
- Reapproving an already executed unit or cancelling a running coder; a new request after execution requires explicit crew handling.

## Constraints

One OS user on one machine, with one crew-initiated handoff command at a time. The pinned text authorizes coding; independent review remains against the authoritative current unit.

## Context

- ST-57 activates repositories and supplies owned checkouts; ST-66 supplies `readStateFile` and `writeStateFile`.
- `scripts/dispatch/unit.mjs` already reads file and Issue units for reviews; handoffs use those source kinds, not Steward's story queue.
- Crew decision, 2026-11-08: reapproval retains a handoff's original FIFO position and historical snapshots.

## Open questions

*(none)*
