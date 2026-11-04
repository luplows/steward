---
id: ST-72
title: Make manual rotation guidance usable in installed projects
tier: later
kind: product
depends_on: [ST-25]
model: null
blocked: null
---

## Intent

As a crew member running a manual rotation from an installed Steward package, I want its
checkout prerequisite and skip messages to be actionable, so that I can run it without
Steward's source repository and distinguish a blocked PR from a passing one.

## Acceptance criteria

- [ ] **AC-1** — A rotation from a checkout with a branch checked out still refuses before
      dispatch. Its message names the need for a detached worktree and directs the user to
      prepare one with Git and run `steward rotation` from it, rather than referring to
      `node scripts/dispatch/loop.mjs --init [path]` or another source-only path.
- [ ] **AC-2** — `README.md` gives a complete manual rotation procedure for an installed
      project, using `git fetch origin main`, `git worktree add --detach <path> origin/main`,
      entering the resulting worktree and invoking the installed package's
      `steward rotation`. It says what checkout state the command requires.
- [ ] **AC-3** — When rotation skips a PR because it already has an honoured governing
      verdict on the current head, the printed skip line names `pass`,
      `pass-with-observations` or `block`, as applicable. It still skips without starting
      another review; other refusal messages retain their meaning.
- [ ] **AC-4** — Tests exercise the branch-checkout refusal and all three governing-verdict
      skip outputs, including the unchanged refusal/skip behavior.
- [ ] **AC-5** — Remove the `**Planned (ST-72)**` marker from the corresponding decision in
      `docs/agent-workflow-design.md` when these usability changes are implemented.

## Out of scope

- Adding a command that automatically creates, deletes or repairs a rotation worktree.
- Changing the detached-checkout requirement, automatic review scheduling or landing rules.
- Reworking the separate coder loop; its shared refusal may become clearer, but its workflow
  is otherwise unchanged.
- Changing the meaning of `review-blocked` or allowing extra review rounds.

## Constraints

- Manual rotation retains the existing refusal to run from a branch checkout; this is a
  guidance and reporting change, not new worktree lifecycle automation.

## Context

- `scripts/dispatch/rotation.mjs` calls `requireOwnWorktree` in
  `scripts/dispatch/loop.mjs`, whose refusal names a source-only script path.
- `scripts/dispatch/review-eligibility.mjs` returns the governing verdict in `existing`;
  rotation currently prints only the generic skip reason.
- `README.md` separately documents source-tree commands and installed-package commands.
- Crew decision, 2026-11-04: document manual Git worktree preparation and keep these related
  usability changes in one story, without adding automatic setup.

## Open questions

*(none)*
