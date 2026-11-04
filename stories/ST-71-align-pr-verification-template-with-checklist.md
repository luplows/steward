---
id: ST-71
title: Align pull request Verification guidance with the checklist
tier: later
kind: product
depends_on: [ST-68]
model: null
blocked: null
---

## Intent

As a project using Steward's example pull request template, I want its Verification guidance
to reflect the review checklist, so that a well-documented change is not surprised by a
requirement the template never mentioned.

## Acceptance criteria

Starter criteria for post-0.1 refinement; do not dispatch until Open questions are settled.

- [ ] **AC-1** — Placeholder: update the Verification guidance in the example pull request
      template to ask for commands and actual results, numbers only for measured results,
      an explanation when no project check applies, and evidence of what changed.
- [ ] **AC-2** — Placeholder: reconcile the corresponding Verification guidance in Steward's
      own pull request template without replacing either project's other template instructions.
- [ ] **AC-3** — Placeholder: verify that the template guidance matches the applicable
      Integrity checklist items, without claiming that following a template guarantees a pass.

## Out of scope

- Rewriting the reviewer prompt or changing verdict rules.
- Requiring numerical measurements for changes that have nothing to measure.
- Guaranteeing that every change using the template passes review.
- Changing projects' already installed, customized templates automatically. Upgrades are ST-69.

## Constraints

*(none)*

## Context

- In the 2026-11-04 release-branch walkthrough, the crew reported that a PR could follow
  `templates/pull_request_template.md` yet be blocked for omitting an explanation that no
  project check applied.
- ST-68 changed Integrity item 1 in `templates/review-checklist.md` and `REVIEW.md`.
  The story deliberately left `templates/pull_request_template.md` and
  `.github/pull_request_template.md` unchanged.
- Both template files currently use the comment "Numbers, not claims", while the checklists
  now require actual results and numbers only for measurements.

## Open questions

- Should the two templates receive the same Verification wording, or should Steward's own
  template retain additional repository-specific instructions?
- Should a small example of a documentation-only change accompany the measurement example,
  or is guidance without examples clearer?
