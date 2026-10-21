---
id: ST-46
title: Inspect release branches as main is inspected, for merges and for stalls
tier: normal
kind: workflow
depends_on: []
model: null
blocked: null
---

## Intent

As a member of the crew, I want inspection to look at release branches as it looks at `main`, so
that a commit that reached a release branch around the gate, or a pull request into one that the
review side has stopped moving on, is raised as an issue, as it would be on `main`. A release
branch changes only through pull requests reviewed and landed through the gate
(`docs/release-review.md`), so the same two checks apply to it.

## Acceptance criteria

- [ ] **AC-1** — **Which branches.** Inspection reads the repository's branches whose names
      `isReleaseBranch` (`scripts/land/release-branch.mjs`) accepts, and checks each of them as
      well as `main`. It holds no other definition of a release branch's name. A repository with
      no release branch is inspected exactly as before. Tests: no release branch; two release
      branches; a branch named `release/v1.2` or `release/next`, which is not inspected.
- [ ] **AC-2** — **Merges.** `inspectMerges` checks each commit on a release branch committed
      within the last `--since-days` days, as it checks those on `main`: a commit with which GitHub
      associates no merged pull request into `main` or into that release branch is a
      `no-pull-request` finding, and such a pull request whose head had no passing verdict at or
      before it merged is a `merged-without-verdict` finding. A passing verdict is what it is today
      (`latestReviewStatus`, `review/agent` `success` created by `github-actions[bot]`). A commit
      on both `main` and a release branch, such as the commit a release branch was cut at, gives
      at most one finding of each kind, and is not raised for being on the release branch when its
      pull request merged into `main`. Tests: a commit on a release branch whose pull request into
      it passed, raised nothing; one with no pull request; one whose pull request into it had no
      passing verdict; a commit of `main`'s within the window that is also on a release branch,
      raised once at most.
- [ ] **AC-3** — **Stalls.** `inspectStalls` checks every open pull request into `main` or a
      release branch (`isLandingBase`, `scripts/land/release-branch.mjs`), with today's rules: not
      a draft, an honoured author, `pending` or `holding` longer than `inspectAfterHours`. A pull
      request into any other branch is not checked. Tests: a pull request into a release branch
      left pending, raised; one holding, raised; one into `release/next`, not checked.
- [ ] **AC-4** — **Titles and bodies.** A finding on `main` keeps today's title, so that an issue
      already raised is not raised again. A `no-pull-request` finding on a release branch names
      the branch in its title, in place of `main`; every finding's body names the branch it is
      about. Tests show each title on a release branch, and today's titles unchanged.
- [ ] **AC-5** — **Requests.** Every request inspection sends is still built by a `build*`
      function and checked by `assertAllowedRequest` before it is sent. The allowlist admits the
      requests this story adds, for a release branch's name only, and still refuses anything else:
      tests show a listing of a branch that is not `main` or a release branch refused, and every
      request a run makes in AC-1's to AC-3's tests allowed. `inspection.yml`'s `permissions:`
      are unchanged, or a test or the pull request's body shows that the new requests need the
      added permission.
- [ ] **AC-6** — **Words.** `inspect.mjs`'s header, `inspection.yml`'s comment, the glossary's
      **inspection** entry, `docs/outline.md`'s description of inspection under "What installing
      steward sets up", and `README.md` wherever it describes what `inspect` raises, say that
      inspection checks release branches as it checks `main`.
- [ ] **AC-7** — Every **Planned** marker naming ST-46 in `docs/agent-workflow-design.md` is
      resolved, as its "Reading this document" note says.

## Out of scope

- Inspecting any other branch, or a branch a project names in its settings: `main` and release
  branches only, as the gate and the runway take them (`isLandingBase`).
- Tags: whether a tag was moved or deleted, which `docs/release-review.md` forbids.
- What a release branch is: `scripts/land/release-branch.mjs` stays its one definition.
- The thin inspection workflow `init` writes (ST-44): it runs the same command, so it needs no
  change of its own.
- Changing what counts as a passing verdict, a stall, or `inspectAfterHours`.

## Constraints

*(none)*

## Context

- **Decided on 2026-10-21 by the owner**, with the planning session: both of inspection's checks
  cover release branches (design doc, Part 3, "Decided so far", "Inspection checks release
  branches as it checks `main`"). Considered and not chosen: the stall check alone, leaving
  merges on a release branch to branch protection.
- `scripts/dispatch/inspect.mjs`: `const MAIN = 'main'` (line 41); `buildListMainCommits` (line
  65) lists `main`'s commits; `buildListOpenPullRequests` (line 83) lists open pull requests with
  `base=main`; `inspectMerges` keeps a merged pull request only when `pr.base?.ref === MAIN` (line
  254); the `no-pull-request` title is ``Inspection: ${shortSha(sha)} on main without a pull
  request`` (line 259); `ALLOWED` (line 111) is the allowlist.
- `scripts/land/release-branch.mjs`: `RELEASE_BRANCH_RE`, `isReleaseBranch` and `isLandingBase`,
  "the one definition of a release branch's name (ST-45)". `select-candidates.mjs` and
  `scripts/dispatch/invocation.mjs` import it.
- GitHub lists a repository's branches by prefix with `GET
  /repos/{owner}/{repo}/git/matching-refs/heads/release/v` (on this repository, 2026-10-21, it
  answered `[]`). `inspection.yml` grants `contents: read`, `pull-requests: read`,
  `statuses: read` and `issues: write`.
- `docs/release-review.md`, "The batch and its branch": a release branch is `release/vX.Y.Z`, kept
  for good, and changes only through pull requests into it.

## Open questions

*(none)*
