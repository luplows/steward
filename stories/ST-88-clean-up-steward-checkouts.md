---
id: ST-88
title: List and remove the checkouts steward keeps for projects
tier: later
kind: product
depends_on: [ST-86]
model: null
blocked: null
---

## Intent

As a member of the crew, I want to see the checkouts steward keeps under `~/.steward/state/`
and remove the ones I no longer need, so that clones of projects I have stopped working on do
not pile up.

**This is a draft.** Steward keeps one checkout per repository: the coordinator's, under
`~/.steward/state/checkouts/`, made by `steward project activate`, and, once ST-86 is built, one
for manual commands under `~/.steward/state/manual-checkouts/`. Both are reused rather than
made per run, so they grow only with the number of repositories. Nothing removes either today:
`project.mjs` keeps an owned checkout when a project is deactivated, for reuse.

## Acceptance criteria

- [ ] **AC-1** — Provisional: a `steward` command lists each kept checkout, its repository,
      which kind it is, its size, and whether the project is activated.
- [ ] **AC-2** — Provisional: the same command removes a named checkout, refusing a
      coordinator checkout of an activated project, and one with a review worktree in use.

## Out of scope

- Removing checkouts automatically.
- The project's own checkouts, outside `~/.steward/state/`.

## Constraints

*(none)*

## Context

- `scripts/dispatch/project.mjs`: owned checkouts at `~/.steward/state/checkouts/<owner>/<name>`;
  deactivation keeps them, and nothing here deletes one.
- ST-86: manual checkouts at `~/.steward/state/manual-checkouts/<owner>/<name>`.
- Crew discussion, 2026-11-07: keep ST-86's reused checkout, and leave clean-up to a later story
  rather than grow 0.2.

## Open questions

- Is it one command for both kinds, or part of `steward project`?
- Should removing a coordinator checkout also deactivate its project, or only refuse?
- When does the crew want it?
