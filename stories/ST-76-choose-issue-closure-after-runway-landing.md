---
id: ST-76
title: Choose how Steward handles linked issues after runway landing
tier: normal
kind: product
depends_on: [ST-54]
model: null
blocked: null
---

## Intent

As a crew member using GitHub closing references, I want an explicit policy for issues linked to
a pull request landed by Steward, so that the crew knows whether those issues close and who is
responsible for closing them.

## Acceptance criteria

Provisional only. The controlled test settled the cause, but the crew has not yet chosen a
remedy. Refine these criteria after choosing an approach in Open questions.

- [ ] **AC-1** — Placeholder: define the observable issue-closing outcome for a runway
      landing with a valid closing reference, following the crew's selected remedy.
      Distinguish a successful landing from a refused or failed landing.
- [ ] **AC-2** — Placeholder: make the required crew actions, behavior and any permissions
      clear in project-facing guidance. If the choice is manual closure, consider extending
      ST-75 rather than implementing duplicate documentation.
- [ ] **AC-3** — Placeholder: verify the chosen remedy in an authorized public scratch
      repository and add tests appropriate to its scope. If the runway explicitly closes
      issues, demonstrate that it works and does not close issues outside the authorized
      merged PR's closing references.
- [ ] **AC-4** — Placeholder: record the chosen product decision in
      `docs/agent-workflow-design.md` under its planned/implemented decision convention.
      Do not claim that any untested remedy already works.

## Out of scope

- Reinvestigating whether a closing keyword, squash message or `issues: write` alone
  explains the observed failure: the controlled comparison has settled that question.
- Automatically closing any issue merely because its number appears in a `Unit:` line.
- Choosing new credentials, broader permissions or an issue-write implementation before
  the crew selects a remedy and its security boundary.
- Changing the in-progress v0.1.0 release or consulting private client evidence.

## Constraints

- The public `luplows/playground` experiment is the evidence for this draft; no private
  client details belong in the story or its implementation's public documentation.
- A future automated closure must be bound to a successfully landed PR and to its
  authorized closing references. Credential and API permissions require a separate
  explicit crew decision before implementation.

## Context

- Controlled public scratch comparison on 2026-11-04, using Steward `935fb5b`:
  - [playground PR #20](https://github.com/luplows/playground/pull/20) was merged
    through the runway with `github.token` and no `issues: write`; the linked
    [issue #3](https://github.com/luplows/playground/issues/3) remained open.
  - [playground PR #21](https://github.com/luplows/playground/pull/21) was merged
    through the runway with `issues: write` added; the linked
    [issue #5](https://github.com/luplows/playground/issues/5) remained open.
  - [playground PR #22](https://github.com/luplows/playground/pull/22) was
    merged manually by the crew; [issue #7](https://github.com/luplows/playground/issues/7)
    closed. Its merge had no closing keyword in the squash message either.
- All three PR bodies contain `Closes #n`. The crew confirmed GitHub listed the
  issues in `closingIssuesReferences`; the commits lack closing keywords.
  These controls identify the `github.token` merge identity as the relevant
  difference, not missing `issues: write` or the squash message.
- `templates/workflows/land-approved.yml` passes `github.token` as `GH_TOKEN`;
  `scripts/land/runway.mjs` uses `gh pr merge --squash --match-head-commit`.
  No explicit issue-closing call follows the merge.
- ST-75 covers documentation of the same token's limitation for post-landing CI.
  It could also carry manual issue-closing guidance if the crew chooses that option.
- Direct issue closure by the runway has not been tried. A different merge token would
  introduce a separate credential and authorization decision.

## Open questions

- Which remedy does the crew choose?
  - **Document and close by hand:** explain that runway landing leaves linked issues
    open and give the crew a manual procedure; consider incorporating it into ST-75.
  - **Runway closes linked issues itself:** after a successful merge, explicitly close
    the issues in the PR's closing references. This has not been tested and needs
    a bounded experiment, authorization policy and permission review.
  - **Use another merge token:** allow GitHub's ordinary automatic closure, but decide
    the credential source, storage, permissions, scope and rotation before coding.
- Once the remedy is chosen, should ST-76 implement it or be retired in favor of a
  focused story or a revised ST-75? Refine the ACs accordingly before dispatch.
