---
id: ST-57
title: Explicitly activate installed projects for local automatic review
tier: next
kind: product
depends_on: []
model: null
blocked: null
---

## Intent

As a developer, I want to explicitly register which installed projects Steward may review
unattended, so that installing the gate or discovering a checkout never authorizes local
execution. These are commands one person runs now and then: they cover the happy path, say
plainly what they did, and stop cleanly when something goes wrong, rather than defending against
every Git setup or a second command running at the same time.

## Acceptance criteria

- [ ] **AC-1** — **Activation checks `main`, not the caller's branch.**
      `steward project activate <checkout-path>` reads only the checkout's root and `origin`'s URL
      from the caller's checkout. `origin` must name one GitHub repository. The installation is
      checked in the coordinator-owned checkout (AC-2) at `origin`'s `main`: a readable, valid
      `steward.config.json` whose `repo` names that repository, the checklist it names, and
      `.github/workflows/review-gate.yml`. On success it prints the repository and the owned
      checkout's path. Otherwise it exits nonzero, says which of these failed, and records no
      activation; an owned checkout it already made is kept for the next attempt. Tests show a
      project whose installation is only on a feature branch of the caller's checkout refused, and
      one installed on `main` activated.
- [ ] **AC-2** — **A checkout of its own; the caller's is not touched.** The coordinator-owned
      checkout is a clone of `origin` at
      `~/.steward/checkouts/<owner>/<name>`, detached at `origin`'s `main`. Activation clones it
      when it is absent and fetches and checks out `origin`'s `main` there when it is present.
      Activation fetches nothing into the caller's checkout and writes nothing there. A test starts
      from a caller's checkout on a feature branch with staged, unstaged and untracked changes, and
      shows its files and `git status --porcelain=v1` output unchanged after activation.
- [ ] **AC-3** — **One record per repository.** Activations are kept in
      `~/.steward/projects.json`, separate from the user config (`~/.steward/config.json`) and
      from any project's `steward.config.json`. Each record holds the repository (`owner/name`),
      the checkout path the person gave, and the owned checkout's path, and no credentials.
      Activating a repository that is already activated, from any checkout of it, keeps one record
      for it and reuses its owned checkout. A test activates the same repository twice and shows
      one record.
- [ ] **AC-4** — `steward project list` reports all activated repositories, their source and owned
      checkout paths, and any invalid/missing checkout without starting a review. A malformed
      activation record fails visibly; it is never treated as permission to schedule unknown
      projects.
- [ ] **AC-5** — **Deactivation removes the record.** `steward project deactivate <owner/name>`
      removes that repository's record from `~/.steward/projects.json` and says so. It does not
      stop the coordinator, delete the owned checkout or change the caller's files. A repository
      with no record is reported as not activated, and the other records are left as they were.
      ST-52 and ST-61 read the records at each automatic admission, so a deactivated project is not
      admitted afterwards; an already admitted review may finish.
- [ ] **AC-6** — `steward init` never activates a project, starts the coordinator, or creates an
      activation record, including when it opens its installation pull request (ST-56). Tests
      distinguish an installed but inactive project from an activated one.
- [ ] **AC-7** — `steward project list` and the documented interface use
      `steward project activate <checkout-path>` and `steward project deactivate <owner/name>`.
      The documentation states where the records and owned checkouts are kept, that the
      installation must be on `origin`'s `main`, the activation boundary, and that a deactivated
      project's owned checkout is **retained for reuse** and never automatically cleaned up. The
      planned design-of-record marker for this story is resolved by its implementing PR.

## Out of scope

The threat model is one member of the crew running one `steward project` command at a time, from
an ordinary checkout of a GitHub repository (Constraints). Outside it, and not to be guarded
against, for 0.1:

- Two `steward project` commands, or a command and another process, changing the records or an
  owned checkout at the same time.
- Paths that reach one checkout through symlinks, aliases or different spellings; hand-edited or
  partly written records beyond reporting a malformed file (AC-4).
- Unusual or adversarial Git configuration; Git runs as the person's own configuration makes it
  run, and a Git command that fails is reported with Git's own message.
- Starting, stopping or scheduling the coordinator; those belong to ST-58 and ST-61.
- Migrating existing per-user/project configuration schemas or implicitly activating existing
  installations.
- Deleting unrecognized worktrees or owned checkouts, manipulating the caller's current branch,
  or opening installation PRs (ST-56).
- Cross-account project activation, shared credentials, and emergency stop.

## Constraints

- **Threat model:** one member of the crew, one command at a time, an ordinary checkout.
  Activation grants local permission; it need prove no more than that it checked `main`, wrote
  only its own record and owned checkout, and changed nothing in the caller's checkout.
- Scope and ownership are per OS user on one machine. No new runtime service or OS administrator
  privilege is required for activation.
- A repository's `steward.config.json` remains the authority for project review settings;
  activation grants local execution permission but does not alter GitHub authorization.
- Node 24, ESM, no new runtime dependencies or model calls. Git runs as argument arrays without a
  shell. Tests use temporary real Git repositories, a local bare repository standing in for
  `origin` and a temporary home directory; no test writes to GitHub.

## Context

- `scripts/dispatch/settings.mjs` validates project settings, and `scripts/dispatch/user-config.mjs`
  strictly validates current per-user model/usage configuration (ST-63).
- `scripts/dispatch/rotation.mjs` currently insists on a dedicated detached controller worktree;
  `scripts/dispatch/review.mjs` prepares a separate temporary reviewer checkout. The new owned
  checkout must not be the developer's working checkout.
- `scripts/dispatch/init.mjs` (ST-56, #102) reads only the caller's root and `origin`
  (`originRepo`, `repoFromRemoteUrl`) and works in a fresh clone: the shape AC-1 and AC-2 follow.
  ST-56 is done; it is not an implementation dependency of this story.
- Crew decision, 2026-10-27: coordinator scope is per OS user; manual commands are independent of
  automatic scheduling.
- Crew decision, 2026-10-31: rescope this story to the happy path under the threat model in
  Constraints, as ST-56 was in #101. The atomic writes, alias and symlink tests, refused ambiguous
  registration, and the test of deactivation concurrent with an admission are dropped; the owned
  checkout is a clone kept at `~/.steward/checkouts/<owner>/<name>` and the records at
  `~/.steward/projects.json`. `git log` of this file holds the earlier version.
- `docs/planning-session.md`, "Writing it": a safety criterion names a bounded threat model.
- Suggested size: medium; no scheduling or process owner implementation in this story.

## Open questions

*(none)*
