---
id: ST-45
title: Review, check and land pull requests into a release branch as into main
tier: next
kind: workflow
depends_on: []
model: null
blocked: null
---

## Intent

As a member of the crew, I want a pull request into a release branch, `release/vX.Y.Z`, to be
checked by CI, reviewed and landed by steward exactly as one into `main` is, so that a release is
reviewed on its own branch while work on `main` goes on, and nothing reaches a release except
through the gate.

## Acceptance criteria

- [ ] **AC-1** — One definition of a release branch's name, `release/v<major>.<minor>.<patch>`
      with each part a non-negative integer, is exported from one module under `scripts/`, with
      a function saying whether a branch name is one. Tests: `release/v0.1.0` and
      `release/v12.0.3` are; `release/0.1.0`, `release/v0.1`, `release/v0.1.0-rc`,
      `release/v0.1.0/x` and `main` are not.
- [ ] **AC-2** — `selectCandidates` (`scripts/land/select-candidates.mjs`) takes a pull request
      whose base is `main` or a release branch (AC-1), and still none whose base is anything else.
      Tests: a ready pull request into `release/v0.1.0` is a candidate; one into
      `release/next` or `feature/x` is not; and the existing cases are unchanged.
- [ ] **AC-3** — `land.mjs` requests landing for a landable pull request into a release branch as
      for one into `main`, dispatching `land-approved.yml` on `main` with the pull request's number
      (the workflow runs from `main`, whatever the pull request's base). A test shows the dispatch
      for a pull request whose base is `release/v0.1.0`.
- [ ] **AC-4** — `.github/workflows/ci.yml` runs its `test` job on a pull request into a release
      branch and on a push to one, as it does for `main`, with its story containment step
      unchanged (it compares against the pull request's own base). A test reads `ci.yml` and shows
      both triggers name `main` and the release branches.
- [ ] **AC-5** — A test shows that `reviewPullRequest` reviews a pull request into
      `release/v0.1.0` from a checkout of that branch's tip, with the checklist and the unit read
      from that branch, as its code does for any base today (`pr.baseRef`, `review.mjs`).
- [ ] **AC-6** — `docs/controller.md`'s rotation takes each open pull request against `main` or a
      release branch, and says so.
- [ ] **AC-7** — Every **Planned** marker naming ST-45 in `docs/agent-workflow-design.md` is
      resolved, as its "Reading this document" note says.

## Out of scope

- **Protecting a release branch**: the release review gives each one the same branch protection as
  `main`, on the crew's word, when it cuts it (`docs/release-review.md`).
- **Cutting a release branch, tagging it, and what goes into it**: the release review's.
- **Inspection** (ST-29) of release branches: it checks `main` only, for now.
- **`init`**: a project that uses steward has no release branches of its own; they are how
  steward releases itself.
- CI's after-sweep run (`workflow_run` on "Land approved PRs"), which checks `main` after a
  landing; a landing into a release branch does not move `main`, so it is skipped, as now.

## Constraints

*(none)*

## Context

- **Decided on 2026-10-19 by the owner**, with the planning session (design doc, Part 3, "Decided
  so far", "The release review cuts each release on a release branch, and a tag is never moved"):
  each release is cut on a branch of its own, which changes only through reviewed pull requests.
- `scripts/land/select-candidates.mjs`, `selectCandidates`: `pull.base?.ref === 'main'`.
- `scripts/dispatch/land.mjs`, line 100: the dispatch's `ref: 'main'`, which is the ref the
  workflow runs from, not the pull request's base.
- `.github/workflows/ci.yml`: `pull_request: branches: [main]` and `push: branches: [main]`. Its
  story containment step passes `github.event.pull_request.base.sha`.
- `scripts/dispatch/review.mjs`: `reviewPullRequest` fetches `pr.baseRef`, checks it out, and reads
  the checklist and the unit from it.
- ST-25, AC-3: the rotation lists the open pull requests against `main` or a release branch.
- ST-42 moves `select-candidates.mjs`'s logic into a command, and depends on this story.

## Open questions

*(none)*
