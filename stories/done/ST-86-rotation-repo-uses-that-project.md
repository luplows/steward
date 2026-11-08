---
id: ST-86
title: Run a rotation for another repository against that repository's own checkout
tier: fix
kind: product
depends_on: []
model: null
blocked: null
---

## Intent

As a member of the crew, I want `steward rotation --repo owner/name` to review, land and
inspect that repository correctly when I run it from another project's checkout, so that one
controller can run rotations for every project. Today only the GitHub calls follow `--repo`.
The checkout check, its update, the settings, the review's Git operations and the inspection all
use the checkout the command runs from. Run from steward's controller worktree for
`luplows/playground`, the review of playground #24 threw on
`git rev-parse origin/setup/react-app`, and the rotation stopped with `script-error` (2026-11-07).

The threat model is one member of the crew running manual commands on their own machine, one
rotation per project at a time.

## Acceptance criteria

- [x] **AC-1** — When `--repo` names the repository of the invoking checkout's `origin`, or is
      not given, `rotation`, `review` and `inspect` behave exactly as today, and every existing
      test of them passes unchanged.
- [x] **AC-2** — When `--repo owner/name` names another repository, `rotation` works against a
      checkout of that repository kept for manual commands at
      `~/.steward/state/manual-checkouts/<owner>/<name>`:
      - cloned with `gh repo clone owner/name` when absent, so that `gh`'s sign-in and protocol
        apply;
      - brought to `origin`'s `main`, detached, before anything else.

      It is never the coordinator's owned checkout under `~/.steward/state/checkouts/`, and the
      command neither reads nor changes that checkout. An existing manual checkout whose
      `origin` is not that repository, or that cannot be brought to `main`, is refused, naming
      the path and the reason, before any review.
- [x] **AC-3** — In that case, every project-side step of the rotation uses that checkout and
      nothing of the invoking one:
      - the checks that the checkout has no branch checked out and nothing uncommitted are made
        on it, and the invoking checkout, which may have a branch checked out, is not checked;
      - the settings, including `land`, `landWhen`, `unitLinks` and `rulesFile`, are read from
        it;
      - the review's fetch, its `rev-parse` of the head and base, its unit and rules reading and
        its review worktree are made in it;
      - the check after each review that the files have not changed is made on it;
      - the pilot's context is built from its settings;
      - the inspection runs with it as its working directory.
- [x] **AC-4** — `steward review <n> --repo owner/name` and `steward inspect --repo owner/name`
      follow the same rule as `rotation`: the invoking checkout when it is that repository's,
      else the manual checkout of AC-2.
- [x] **AC-5** — Tests, with injected Git and GitHub, show for another repository:
      - the manual checkout is cloned when absent and reused when present;
      - its settings, not the invoking checkout's, decide landing;
      - the review's Git calls run in it;
      - inspection gets it as its working directory;
      - a foreign `origin` in the manual checkout is refused;
      - the coordinator's owned checkout path is never touched.

      A test also repeats #24's case: a head branch that exists only in the requested
      repository is reviewed.
- [x] **AC-6** — `docs/controller.md`, where it describes `--repo`, says which checkout it
      uses. The `**Planned (ST-86)**` marker in `docs/agent-workflow-design.md` loses `ST-86`.

## Out of scope

- Two manual commands for the same repository at the same time.
- The coordinator, its owned checkouts, and anything it schedules.
- Removing or cleaning up manual checkouts.
- A manual rotation's usability messages and its documentation for an installed project
  (ST-72).
- Repositories outside GitHub, or a `--repo` value that is not `owner/name`.

## Constraints

*(none)*

## Context

- `scripts/dispatch/rotation.mjs`, `runRotation`: `repo` sets only `slug`, used for `ctx`,
  `landCtx` and `inspectCtx`. `requireOwnWorktree`, `updateCheckout`, `readSettings`,
  `reviewPullRequest({ repoDir })`, the post-review `git` calls and the inspection's `cwd` all
  take `repoDir`, the invoking checkout.
- `scripts/dispatch/review.mjs`, `reviewPullRequest`: reads settings from `repoDir`, fetches
  and runs `rev-parse origin/<headRef>` and `origin/<baseRef>` there, reads the unit and rules
  from it and adds the review worktree from it.
- `scripts/dispatch/inspect.mjs`: reads the settings from its `cwd`.
- `scripts/dispatch/project.mjs`: the coordinator's owned checkout,
  `~/.steward/state/checkouts/<owner>/<name>`, and `updateOwnedCheckout`, the pattern AC-2's
  checkout follows. `activate` clones from the caller's own `origin` URL, which a manual checkout
  of another repository does not have.
- `README.md` mentions `--repo` only for `steward protect`, which reads `main` on GitHub rather
  than a checkout.
- Crew decision, 2026-11-07: the fix makes `--repo` work, not merely refuse, keeps
  coordinator-owned checkouts untouched, and keeps ST-72 separate.

## Open questions

*(none)*
