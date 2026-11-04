---
id: ST-76
title: Investigate issue closure after Steward landing
tier: normal
kind: spike
depends_on: [ST-54]
model: null
blocked: null
---

## Intent

As a crew member relying on GitHub issue links, I want to know why a linked issue remained
open after a Steward landing, so that we choose a fix only when the cause is understood.

## Acceptance criteria

This is an investigation, not a request to implement an issue-closing mechanism.

- [ ] **AC-1** — Produce `docs/research/steward-landing-issue-closure.md` that records
      the observed symptom, separates verified code behavior from reported GitHub behavior,
      and cites relevant GitHub documentation about issue-closing keywords, branch targets,
      repository settings and merge methods.
- [ ] **AC-2** — Compare at least one successful and one unsuccessful issue-closure case
      in a crew-authorized test repository, with the PR base, closing reference location,
      merge method, token or identity, and issue state before and after each recorded.
      Do not use a client's private repository as the test bed without separate approval.
- [ ] **AC-3** — The report evaluates whether the runway's `github.token`,
      `gh pr merge --squash` behavior, missing `issues: write` permission, default-branch
      constraints or PR/commit closing references explain the difference. It does not assume
      that any single factor is the cause without evidence.
- [ ] **AC-4** — Conclude with evidence for the cause or explicitly say what remains
      unproven, and recommend either no code change, a documentation change, or a
      separately scoped implementation story. No automatic issue-closing code is added.

## Out of scope

- Adding issue-write permissions or modifying merge behavior before the cause is known.
- Automatically closing an issue merely because its number appears in a PR.
- Inspecting or modifying a client's private repository without crew authorization.

## Constraints

- Use an explicitly authorized scratch repository; preserve issue and PR evidence needed
  to distinguish platform behavior from Steward behavior.

## Context

- During ST-48 client validation on 2026-11-04, one issue reportedly remained open after
  a Steward landing despite a closing link. The cause has not been established.
- `scripts/land/runway.mjs` performs a squash merge through `gh pr merge`.
  `templates/workflows/land-approved.yml` does not grant `issues: write`.
- Existing data has not established whether a PR body, commit text, target branch,
  token or GitHub configuration explains the observed outcome.

## Open questions

- Which crew-authorized scratch repository should be used for the controlled comparisons,
  and who will approve the GitHub writes required by AC-2?
