---
id: ST-77
title: Include unit and reviewer provenance in verdict comments
tier: normal
kind: product
depends_on: [ST-22, ST-34]
model: null
blocked: null
---

## Intent

As a crew member reading an automated review, I want the verdict comment to identify the
unit actually considered and the reviewer tool and model actually used, so that a later
reader can understand what the review was based on.

## Acceptance criteria

- [ ] **AC-1** — Each successfully recorded verdict comment identifies the unit using
      the existing `describeUnit` note from that review. The comment distinguishes
      a readable issue or file unit from `Unit: none`, a missing line, an unreadable
      unit and multiple links, using the note the reviewer actually received.
- [ ] **AC-2** — A recorded verdict also names the selected reviewer's tool and model
      from the choice actually run, including a manual `--choice` or usage fallback.
      It does not infer the tool/model from the configured default and reveals no
      credential, local configuration path or environment secret.
- [ ] **AC-3** — The machine-readable verdict marker remains exactly compatible with
      `composeMarkerComment` and the existing gate. Tests parse recorded comments with
      unit/reviewer provenance and show that the governing head SHA, verdict, and
      `review/agent` status semantics do not change.
- [ ] **AC-4** — Tests cover readable and unavailable unit cases and at least two
      reviewer-choice paths. Provenance supplied by PR or issue text is displayed
      as data; it cannot introduce another machine-readable review marker.
- [ ] **AC-5** — Remove the `**Planned (ST-77)**` marker from
      `docs/agent-workflow-design.md` when the comment change is implemented.

## Out of scope

- Changing unit discovery, which unit text the reviewer sees, or reviewer selection rules.
- Posting separate comments for provenance or editing past review comments.
- Reporting an attempted review that produced no recorded verdict as if it were a verdict.
- Publishing full reviewer prompts, usage statistics or local tool configuration.

## Constraints

- The existing marker's parsing and trust boundary remains authoritative; displayed
  provenance is informational and does not decide the gate.

## Context

- During ST-48 client validation on 2026-11-04, the crew found verdict comments did
  not state which unit was read. The crew also chose to show the actual tool and model.
- `scripts/dispatch/review.mjs` passes `describeUnit`'s note to the reviewer and
  returns the selected tool and model in `choice`, but `formatFindings` currently
  formats only verdict, summary, findings and section application.
- The recorded comment goes through `composeMarkerComment`; the gate reads the
  head-specific marker, not the human-readable narrative.

## Open questions

*(none)*
