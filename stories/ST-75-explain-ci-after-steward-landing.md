---
id: ST-75
title: Explain post-landing CI for projects using Steward
tier: next
kind: product
depends_on: [ST-54]
model: null
blocked: null
---

## Intent

As a crew member installing Steward in a GitHub project, I want to know why a landing might
not run that project's push-triggered CI, and how to enable post-landing checks explicitly,
so that CI coverage is an informed project choice rather than an unnoticed gap.

## Acceptance criteria

- [ ] **AC-1** — `README.md` explains that Steward's landing workflow merges using
      GitHub Actions' `github.token`, whose merges do not cause new `push` workflow runs.
      It distinguishes checks completed before landing from checks a project wants after a
      landing, and states that a default-branch `workflow_run` trigger does not provide
      post-landing runs on release branches.
- [ ] **AC-2** — The generated installation PR body warns about the missing push-triggered
      run after any Steward runway landing, including an explicitly requested manual
      landing when `land: false`. Tests verify the warning in both landing configurations.
- [ ] **AC-3** — The README provides an optional, copyable `workflow_run` example for a
      project's CI, triggered by completion of `Land approved PRs` on the default
      branch. It explains how to avoid unnecessary work when the sweep landed nothing,
      and states the pattern's default-branch and release-branch limits.
- [ ] **AC-4** — The documented option makes no change to installed CI workflows,
      `templates/workflows/`, merge credentials, branch protection or landing behavior.
      The documentation does not claim that every project requires post-landing CI.
- [ ] **AC-5** — Remove the `**Planned (ST-75)**` marker from
      `docs/agent-workflow-design.md` once the documentation and installer warning land.

## Out of scope

- Granting a new token, using a personal access token or GitHub App credentials for landing.
- Dispatching arbitrary client workflows or installing a new post-landing CI workflow.
- Changing which pre-merge checks Steward's gate requires for landing.
- Providing an automatic post-landing CI mechanism for release branches.

## Constraints

- Keep the default installation reviewable and avoid new GitHub permissions or secrets.
- The optional example is guidance: a project chooses whether and how to adopt it.

## Context

- ST-48 client validation on 2026-11-04 exposed the absence of new push-triggered CI runs
  after a Steward landing. The crew selected documentation and an optional example first.
- `templates/workflows/land-approved.yml` supplies `GH_TOKEN` from `github.token`.
  `scripts/land/runway.mjs` merges with `gh pr merge --squash --match-head-commit`.
- Steward's own `.github/workflows/ci.yml` includes `workflow_run` for
  `Land approved PRs` with a no-landing guard; `init` leaves a client's CI alone.
- A future opt-in workflow dispatch or alternate token would require a separate crew
  decision and story.

## Open questions

*(none)*
