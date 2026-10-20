---
id: ST-45
title: Review, check and land pull requests into a release branch as into main
tier: next
kind: workflow
depends_on: [ST-39]
model: null
blocked: "Built by hand: changes .claude/prompts/reviewer.md, which a spawned coder session cannot edit (docs/agent-workflow-design.md, A spawned session cannot edit .claude/prompts/)"
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
- [ ] **AC-5** — `reviewPullRequest` (`review.mjs`) reads the unit and the checklist from `main`
      whatever the pull request's base, since both are written on `main` (`readUnit` and
      `readRules`, each with `base: 'main'`), and still starts the reviewer in a checkout of the
      base's tip. A test shows a pull request into `release/v0.1.0` reviewed from a checkout of
      that branch's tip, with a unit file and a checklist that differ between `main` and the
      release branch read as they are on `main`; and a pull request into `main` reviewed as
      before.
- [ ] **AC-6** — `.claude/prompts/reviewer.md` names the pull request's base through a
      placeholder, `{{BASE_BRANCH}}`, wherever it now names `main` as the base of the diff or of
      the checkout (line numbers at `ed6b3eb`): `git diff origin/main...{{HEAD_SHA}}`, which
      becomes `git diff origin/{{BASE_BRANCH}}...{{HEAD_SHA}}` (lines 144, 179 and 215); "a
      checkout of the base branch, `main`" (line 169); and the instruction files that "are
      `main`'s" (line 183). The lines that say the unit and the checklist are read from `main`
      (20, 22, 32 to 33, 66, 70, 94 and 135) keep `main`. In the header, line 42 says the instructions,
      settings and hooks come from the base, and the placeholder table gains a `{{BASE_BRANCH}}`
      row saying what it is substituted with.
- [ ] **AC-7** — `buildInvocation` and `renderReviewerPrompt` (`scripts/dispatch/invocation.mjs`)
      substitute `{{BASE_BRANCH}}` with the pull request's base, `pr.baseRef`, which
      `reviewPullRequest` passes for a Claude and a Codex reviewer alike. `BASE_BRANCH` is a
      `TRUSTED_INLINE` placeholder whose pattern admits only `main` and a release branch's name
      (AC-1), and an invocation without a base, or with any other, is refused.
- [ ] **AC-8** — `invocation.test.mjs` renders the reviewer prompt with the base `release/v0.1.0`
      and shows `git diff origin/release/v0.1.0...` followed by the head's SHA, and no
      `origin/main` anywhere; renders it with `main` and shows `git diff origin/main...` as before;
      and shows a refusal for the bases `feature/x` and `main` followed by a newline.
- [ ] **AC-9** — `REVIEW.md` says, in "Every pull request", that a pull request into a release
      branch changes nothing under `stories/` (`docs/release-review.md`), and that the section's
      item 4 also accepts `Unit: none` for one into a release branch that reverts a deferred
      capability and names the pull requests it reverts; and, in "Conformance to the unit", that
      item 1's ticking and item 4 apply only to a pull request into `main`.
- [ ] **AC-10** — `docs/controller.md`'s rotation takes each open pull request against `main` or a
      release branch, and says so.
- [ ] **AC-11** — Every **Planned** marker naming ST-45 in `docs/agent-workflow-design.md` is
      resolved, as its "Reading this document" note says.

## Out of scope

- **Protecting a release branch**: the release review gives each one the same branch protection as
  `main`, on the crew's word, when it cuts it (`docs/release-review.md`).
- **Cutting a release branch, tagging it, and what goes into it**: the release review's.
- **A mechanical check that a pull request into a release branch changes nothing under
  `stories/`**: the reviewer checks it against `REVIEW.md` (AC-9).
- **Inspection** (ST-29) of release branches: it checks `main` only, for now.
- **`init`**: a project that uses steward has no release branches of its own; they are how
  steward releases itself.
- CI's after-sweep run (`workflow_run` on "Land approved PRs"), which checks `main` after a
  landing; a landing into a release branch does not move `main`, so it is skipped, as now.

## Constraints

- `{{BASE_BRANCH}}` is substituted inline, validated against its pattern, as `{{PR_NUMBER}}` is
  (`renderBounded`, `invocation.mjs`), and listed in the prompt's placeholder table, which
  `checkPlaceholderContract` (`render.mjs`) enforces.

## Context

- **Decided on 2026-10-19 by the owner**, with the planning session (design doc, Part 3, "Decided
  so far", "The release review cuts each release on a release branch, and a tag is never moved"):
  each release is cut on a branch of its own, which changes only through reviewed pull requests.
  **On 2026-10-20**, after #58's third review: the reviewer diffs against the pull request's base,
  the unit and the checklist are read from `main` whatever the base, no pull request into a
  release branch changes anything under `stories/`, and this story is built by hand.
- `scripts/land/select-candidates.mjs`, `selectCandidates`: `pull.base?.ref === 'main'`.
- `scripts/dispatch/land.mjs`, line 100: the dispatch's `ref: 'main'`, which is the ref the
  workflow runs from, not the pull request's base.
- `.github/workflows/ci.yml`: `pull_request: branches: [main]` and `push: branches: [main]`. Its
  story containment step passes `github.event.pull_request.base.sha`.
- `scripts/dispatch/review.mjs`: `reviewPullRequest` fetches `pr.baseRef`, checks it out, and reads
  the checklist and the unit from it (`readRules` and `readUnit`, each with `base: pr.baseRef`).
- ST-39 makes that fetch take every branch, pruned, so that `main` is fresh for a review into a
  release branch, and changes `reviewer.md` too. This story depends on it.
- ST-40 changes `reviewer.md` and `invocation.mjs` as well, and depends on this story.
- ST-25, AC-3: the rotation lists the open pull requests against `main` or a release branch.
- ST-42 moves `select-candidates.mjs`'s logic into a command, and depends on this story.

## Open questions

*(none)*
