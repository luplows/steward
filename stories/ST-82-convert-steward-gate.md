---
id: ST-82
title: Convert steward's own gate to the thin workflows
tier: later
kind: workflow
depends_on: [ST-79]
model: null
blocked: "Only the crew can merge the installation pull request, by hand, since steward's gate cannot review the pull request that installs it"
---

## Intent

As the owner, I want steward to run its gate from the same thin workflows a
project installs, so that steward uses what it ships. The crew moved this to
0.2 on 2026-11-04 (`docs/outline.md`, "Release preparation"), and on 2026-11-05
decided to time it when 0.2 is cut, since nothing else in the 0.2 slice depends
on it.

**This is a draft.** Its criteria are provisional until the Open questions are
answered.

## Acceptance criteria

- [ ] **AC-1** — Provisional: steward's `review-gate.yml`, `land-approved.yml`
      and `inspection.yml` are replaced by `init`'s, pinned to a steward release,
      through `init`'s installation pull request, which the crew merges by hand.
- [ ] **AC-2** — Provisional: after the merge, a pull request is reviewed and
      landed in steward through the thin workflows, and the record says which.
- [ ] **AC-3** — Provisional: steward's documents that describe its own gate
      running from `scripts/` say what it runs instead.

## Out of scope

- `ci.yml`, which is steward's own check.
- Changing what the gate decides.

## Constraints

*(none)*

## Context

- Steward's workflows run its gate from its own checkout, such as
  `node scripts/dispatch/cli.mjs mark-pending` in `.github/workflows/review-gate.yml`.
- ST-48's record, `docs/validation/ST-48-review-installation.md`: in
  tower-workshop-paths, 56 files of the old engine were removed (#280) before
  `init` could install; "Steward itself" records
  `init`'s run here at `935fb5b`.
- ST-79: `init` names workflows that are not its own, which is steward's case.

## Open questions

- With the gate pinned to a release, a change to the gate's code reaches
  steward's own gate only after a release, or a repin. Is that what the crew
  wants, or should steward pin a commit on `main`?
- Is steward's gate repinned by ST-69's upgrade, or by hand?
- When in 0.2 does this run?
