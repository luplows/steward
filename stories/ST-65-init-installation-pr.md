---
id: ST-65
title: Open a draft installation pull request from init, made in a fresh clone
tier: normal
kind: product
depends_on: []
model: null
blocked: null
---

## Intent

As a member of the crew installing steward in a project, I want `steward init` to put the files it
adds on a branch of their own and open a draft pull request for them, so that I adopt the
installation through the project's own review instead of committing it by hand. It is a command
run once per project by one person: it should be small, say plainly what it did, and stop
cleanly when something goes wrong, rather than defend against every Git setup.

## Acceptance criteria

- [ ] **AC-1** — **The caller's checkout is only read for its root and `origin`.** `init` reads
      the checkout's root and `origin`'s URL, and nothing else about it. `origin` must name one
      GitHub repository; otherwise `init` exits 2, saying so, before any write. `init` fetches
      nothing into the caller's repository and writes nothing there: its branch, index, working
      files, ignored files, refs and configuration are the same afterwards. Tests start from a
      checkout on a feature branch with staged, unstaged and untracked changes, and show its files,
      `git status --porcelain=v1 --ignored` and `git for-each-ref` output unchanged after a
      successful installation, a no-diff run and a failed push.
- [ ] **AC-2** — **A fresh clone of `origin`'s `main`.** `init` clones `origin`'s `main` into a
      new temporary directory it creates, and takes `main`'s commit there as the installation's
      base.
      Everything `init` reads about what the project already has (existing installation files,
      the existing `steward.config.json`'s `rulesFile`, pull request templates) is read from that
      clone, and every file it adds is written there. Before writing anything, `init` exits 2 if
      the installation branch (default `steward/install`, or `--branch <name>`) already exists on
      `origin`, or a pull request is open from it, naming which.
- [ ] **AC-3** — **Additions only.** Each installation file is written only where the base lacks
      it, and a file the base has is left byte for byte. From an existing `steward.config.json`
      `init` reads only `rulesFile`, to find the existing checklist, and never changes its `land`
      setting. When nothing is missing, `init` exits 0 saying the installation is already
      complete, and creates no branch, commit, push or pull request; labels and user config are
      still provisioned as `init` provisions them today.
- [ ] **AC-4** — **One commit, one push, one draft pull request.** On the new branch from the
      base, `init` stages exactly the files it wrote, makes one commit and pushes that branch to
      `origin`. Git runs as the user's own configuration makes it run (identity, hooks, signing);
      a Git command that fails is AC-6's failure, reported with Git's own message. `init` then
      opens one **draft** pull request from the branch against `main` in the same repository, and
      prints the repository, branch, base commit, installation commit and the pull request's URL.
      It never marks the pull request ready, merges it, requests landing or changes protection.
- [ ] **AC-5** — **The body.** The title is `--pr-title <text>`, or a default naming steward and
      its version. With `--pr-body-file <path>` that file is the body, verbatim. Otherwise the
      body is a generated installation section followed by the project's pull request template
      unchanged, for the crew to fill. The generated section lists the files added and the files
      left as they were, steward's version or pin, and the `land` setting, and tells the crew
      what to check before marking it ready: that the gate cannot review the pull request that
      installs it, and that `steward protect` comes after it merges. With one template, that one
      is used; with several, `--pr-template <path>` chooses, and is required only when a pull
      request is to be opened (exit 2 before any write, naming the templates); with none,
      steward's own template is used. Nothing is inserted inside the template's text.
- [ ] **AC-6** — **A failure stops and says what is left.** When a step after the clone fails,
      `init` stops, exits 1, and says in plain words which step failed, Git's or GitHub's message,
      what now exists (the clone's path, whether the branch is on `origin`, the pull request's URL
      if one was opened) and what to do next. It keeps the clone, retries nothing, deletes nothing
      on `origin` and rolls back no label or user config. After a success the clone is removed.
- [ ] **AC-7** — **Output written for a person.** Everything `init` prints, its questions,
      refusals, failure report and closing message, is written for the member of the crew running
      it: what happened, what was and was not changed, and what to do next, in the glossary's
      words. Internal names (functions, the code's names for steps, Git plumbing) appear only
      where the person needs them to act, such as a path, a branch or a command to run. Tests
      assert the closing message of a successful installation, a no-diff run and a failed push.
- [ ] **AC-8** — **Adoption stays separate from activation.** ST-55's review-only default and
      explicit `--land yes` opt-in are unchanged. Neither `init` nor merging its pull request
      activates a project, starts the coordinator or starts a review, rotation or landing
      (ST-57/AC-6).
- [ ] **AC-9** — **Tests.** Vitest cases named `ST-65/AC-N` use temporary real Git repositories
      and a local bare repository standing in for `origin`, reached through a URL mapping that only
      tests pass. GitHub is injected; no test writes to GitHub or starts a model. They cover a
      full installation, a partial one, a no-diff run, each refusal of AC-1, AC-2 and AC-5, a
      failed commit (a hook that rejects it), a failed push and a failed pull request request.
- [ ] **AC-10** — **Documentation.** `README.md`'s installation steps, `init`'s help,
      `docs/settings.md` and every other document describing how `init` delivers its files say
      what this story delivers, and every **Planned (ST-65)** marker in `docs/` is resolved.

## Out of scope

The threat model is one member of the crew running one `init` from an ordinary checkout
(Constraints). Outside it, and not to be guarded against:

- Other processes or installers changing `origin`, the clone or the caller's checkout while `init`
  runs. A branch created on `origin` after AC-2's check is whatever `git push` reports.
- Unusual or adversarial Git configuration: URL rewrites, hooks, signing, filters, replacement
  refs, `init.templateDir` and the like. `init` runs Git as configured and reports what fails.
- File names the platform cannot check out.
- Looking at, or refusing because of, the caller's uncommitted or unrelated work.
- Changing which files `init` installs (ST-44), its questions, its labels or the user config
  schema; merging, protection, activation and the coordinator.

## Constraints

- **Threat model:** one member of the crew, one run, an ordinary checkout. The pull request is a
  draft that the crew and the project's own process review before anything lands; `init` need
  prove no more than that it only adds files there and changes nothing else.
- Start from `main`'s `init`, not from #92's branch. A piece of #92 may be reused only where it
  does what this story asks; nothing outside these criteria comes with it.

## Context

- `scripts/dispatch/init.mjs` on `main`: `run`, `originRepo`, `repoFromRemoteUrl`,
  `findPullRequestTemplates`, `writeNew`, `ensureLabels`, `createInitContext` and
  `landingNotes`. Today it writes into the caller's checkout and the crew commits and opens the
  pull request by hand (`README.md`, installation steps).
- `stories/retired/ST-56-init-installation-pr.md`: the story this replaces, retired 2026-10-31,
  and #92, its implementation, not landed. Its reviews show the cases this story leaves out.
- Crew decision, 2026-10-30: "init sets up a clean worktree and goes from there", a clean checkout
  of its own being acceptable too; the clone is that checkout. Crew decision, 2026-10-30: the
  audience of `init`'s output is a person (AC-7). Crew decision, 2026-10-31: rewrite ST-56 as
  this story, "way too resilient and focused on the edge cases" as it was.
- `docs/planning-session.md`, "Writing it": a safety criterion names a bounded threat model.
- ST-57/AC-6: `init` never activates a project.

## Open questions

- **When.** The crew is inclined to 0.2 (2026-10-30). Is this story in 0.1 or 0.2?
