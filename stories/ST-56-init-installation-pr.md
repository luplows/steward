---
id: ST-56
title: Open a reviewable installation pull request from init
tier: next
kind: product
depends_on: [ST-55]
model: null
blocked: null
---

## Intent

As a developer installing steward into an existing GitHub project, I want `steward init` to
commit its installation on a separate branch and open a reviewable pull request, so that the
crew can inspect and adopt it without manually assembling the commit and pull request. It is a
command one person runs once per project: it covers the happy path, says plainly what it did,
and stops cleanly when something goes wrong, rather than defending against every Git setup.

## Acceptance criteria

- [ ] **AC-1** — **Read only the checkout's root and `origin`.** `init` reads the caller's
      checkout root and `origin`'s URL, and nothing else about the checkout. `origin` must name
      one GitHub repository, and the GitHub credential must work; otherwise `init` exits 2,
      saying which, before any write. `init` fetches nothing into the caller's repository and
      writes nothing there: its branch, index, working files, ignored files, refs and
      configuration are the same afterwards. Tests start from a checkout on a feature branch with
      staged, unstaged and untracked changes, and show its files, `git status --porcelain=v1
      --ignored` and `git for-each-ref` output unchanged after a successful installation, a
      no-diff run and a failed push.
- [ ] **AC-1a** — **The caller's own work is not examined.** `init` neither looks at nor refuses
      because of the caller's uncommitted, unrelated or conflicting work, including local edits
      to files the installation adds; the installation comes from `origin`'s `main`. A test
      with local edits to an installation target in the caller's checkout shows the installation
      made from `origin`'s `main` and the caller's edits untouched.
- [ ] **AC-1b** — **Git runs as configured.** `init` refuses no Git configuration or environment
      (URL rewrites, hooks, signing, identity and the like) and changes none. It runs Git as the
      user's own configuration makes it run, and a Git command that fails is AC-7's failure,
      reported with Git's own message. A test whose commit hook rejects the commit shows AC-7's
      report.
- [ ] **AC-2** — **A fresh clone and a new branch.** `init` clones `origin`'s `main` into a new
      temporary directory it creates, and takes `main`'s commit there as the installation's
      base. Everything `init` reads about what the project already has (existing installation
      files, the existing `steward.config.json`'s `rulesFile`, pull request templates) is read
      from that clone, and every file it adds is written there, on a new branch from the base:
      `steward/install`, or `--branch <name>`. Before writing anything, `init` exits 2 if that
      branch already exists on `origin` or a pull request is open from it, naming which.
- [ ] **AC-3** — **Only the installation's files.** `init` stages exactly the files it wrote and
      makes one commit of them on the branch. Tests show the commit's only parent is the base and
      its changes are exactly those files.
- [ ] **AC-4** — **Additions only, and nothing when nothing is missing.** Each installation file
      is written only where the base lacks it, and a file the base has is left byte for byte.
      From an existing `steward.config.json`, `init` reads only `rulesFile`, to find the
      existing checklist, and never changes its `land` setting. When nothing is missing, `init`
      exits 0 saying the installation is already complete, and creates no branch, commit, push or
      pull request; labels and user config are still provisioned as `init` provisions them today.
- [ ] **AC-5** — **One push, one draft pull request.** `init` pushes the branch to `origin` and
      opens one **draft** pull request from it against `main` in the same repository, then
      prints the repository, branch, base commit, installation commit and the pull request's URL.
      It never marks the pull request ready, merges it, requests landing or changes protection.
- [ ] **AC-6** — **The pull request's body.** The pull request's title names steward and its
      version. Its body is a generated installation section followed by the project's pull
      request template unchanged, for the crew to fill. The generated section lists the files
      added and the files left as they were, steward's version or pin and the `land` setting, and
      says what to check before marking it ready: that the gate cannot review the pull request
      that installs it, and that `steward protect` comes after it merges. With one template that
      one is used; with several, `--pr-template <path>` chooses, and is required only when a pull
      request is to be opened (exit 2 before any write, naming the templates); with none,
      steward's own template is used. Nothing is inserted inside the template's text.
- [ ] **AC-7** — **A failure stops and says what is left.** When a step after the clone fails,
      `init` stops, exits 1, and says in plain words which step failed, Git's or GitHub's message,
      what now exists (the clone's path, whether the branch is on `origin`, the pull request's
      URL if one was opened) and what to do next, such as deleting the branch by hand before a
      rerun, or rerunning with another `--branch`. It retries nothing, deletes nothing on `origin`
      and rolls back no label or user config.
- [ ] **AC-7a** — **Output written for a person.** Everything `init` prints, its questions,
      refusals, failure report and closing message, is written for the member of the crew running
      it: what happened, what was and was not changed, and what to do next, in the glossary's
      words. Internal names (functions, the code's names for steps, Git plumbing) appear only
      where the person needs them to act, such as a path, a branch or a command to run. The clone
      is always kept, and the closing message gives its path and asks the person to remove it
      when done. Tests assert the closing message of a successful installation, a no-diff run and
      a failed push.
- [ ] **AC-8** — **Adoption and activation remain separate.** ST-55's review-only default and
      explicit `--land yes` opt-in are unchanged. Neither `init` nor merging its pull request
      activates a project, starts the coordinator or starts a review, rotation or landing
      (ST-57/AC-6).
- [ ] **AC-9** — **Tests and documentation.** Vitest cases named `ST-56/AC-N` use temporary real
      Git repositories and a local bare repository standing in for `origin`, reached through a
      URL mapping that only tests pass. GitHub is injected; no test writes to GitHub or starts a
      model. They cover a full installation, a partial one, a no-diff run, each refusal of AC-1,
      AC-2 and AC-6, a rejected commit, a failed push and a failed pull request request.
      `README.md`'s installation steps, `init`'s help, `docs/settings.md` and every other
      document describing how `init` delivers its files say what this story delivers, and every
      **Planned** marker naming ST-56 in `docs/` is resolved.

## Out of scope

The threat model is one member of the crew running one `init` from an ordinary checkout
(Constraints). Outside it, and not to be guarded against, for 0.1:

- Other processes or installers changing `origin`, the clone or the caller's checkout while `init`
  runs. A branch created on `origin` after AC-2's check is whatever `git push` reports.
- Unusual or adversarial Git configuration: URL rewrites, hooks, signing, filters, replacement
  refs, `init.templateDir` and the like (AC-1b).
- File names the platform cannot check out.
- Removing the clone after a success; a rerun that resumes its own branch; filling the
  template's sections; `--pr-title` and `--pr-body-file`. These are ST-65's candidates for 0.2.
- Implementing or revising ST-54's manual landing authorization, ST-55's defaults or ST-53's
  waiting policy; changing which files `init` installs (ST-44), its questions, its labels or the
  user config schema.
- Coordinator activation, discovery, scheduling, coding or fixing; merging the installation,
  granting a gate exception or setting protection.
- Arbitrary base branches, fork or upstream pull requests, non-GitHub installation, upgrades,
  repairing or migrating existing files, and repinning.

## Constraints

- **Threat model:** one member of the crew, one run, an ordinary checkout. The pull request is a
  draft that the crew and the project's own process review before anything lands; `init` need
  prove no more than that it only adds files there and changes nothing else.
- Start from `main`'s `init`, fresh. #92, the earlier implementation of this story, is closed and
  is not the starting point.
- Node 24, ESM, no new runtime dependencies or model calls. Git runs as argument arrays without a
  shell. The GitHub requests stay within the installation's repository and operations. No push
  to `main`, a release branch or a tag, and no force push.

## Context

- Crew request, 2026-10-26: init creates a reviewable installation PR; write its body as the
  project expects. Design doc, "Installation through a reviewable pull request"; roadmap 0.1.
- Crew decision, 2026-10-31: rescope this story to the happy path, "way too resilient and focused
  on the edge cases" as it was. The contract of 2026-10-27 (a restricted Git environment, hooks
  disabled, caller-work comparisons, invocation-owned temporary files) is replaced by this one.
  #92 implemented that contract, was blocked eleven times and is closed; `git log` of this file
  holds the earlier versions.
- Crew decisions, 2026-10-31: the installation is made in a fresh clone; Git runs as
  configured; URL rewrites are no longer refused; the clone is always kept, with a note to remove
  it; files `init` did not change are ignored; a rerun after a partial failure needs the branch
  removed by hand. Crew decision, 2026-10-30: `init`'s output is written for a person (AC-7a).
- `scripts/dispatch/init.mjs` on `main`: `run`, `originRepo`, `repoFromRemoteUrl`,
  `findPullRequestTemplates`, `writeNew`, `ensureLabels`, `createInitContext` and
  `landingNotes`. Today it writes into the caller's checkout, and the crew commits and opens the
  pull request by hand (`README.md`, installation steps).
- ST-55 precedes this story, and ST-54 precedes ST-55. Neither story's acceptance criteria or
  stable ids are changed here.
- `docs/planning-session.md`, "Writing it": a safety criterion names a bounded threat model.

## Open questions

- **Flags.** The planning session recommends keeping `--branch` and `--pr-template` and deferring
  `--pr-title` and `--pr-body-file` to 0.2 (ST-65), since the crew can edit the draft's title and
  body on GitHub. Does the crew agree?
