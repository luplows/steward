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

As a crew member running a manual review rotation from an installed Steward package, I want
the command's prerequisite and skip messages to be actionable, so that I can use it without
access to Steward's source repository or misread a blocking review as a passing one.

## Acceptance criteria

Starter criteria for post-0.1 refinement; do not dispatch until Open questions are settled.

- [ ] **AC-1** — Placeholder: when manual rotation refuses a branch checkout, its error gives
      a supported way to prepare a checkout that can run the installed `steward rotation`
      command, without naming a script path available only in Steward's source repository.
- [ ] **AC-2** — Placeholder: document the supported package-based manual rotation and its
      checkout prerequisite in user-facing documentation.
- [ ] **AC-3** — Placeholder: when a rotation skips a PR with a governing verdict on its
      current head, its output identifies whether that verdict is `pass`,
      `pass-with-observations` or `block`.

## Out of scope

- Changing coordinator admission, automatic scheduling, review or landing rules.
- Automatically creating or deleting worktrees unless the crew chooses that separately.
- Relaxing the existing safeguard against rotation in a branch checkout.
- Changing the meaning of `review-blocked` or permitting extra review rounds.

## Constraints

*(none)*

## Context

- `scripts/dispatch/rotation.mjs` uses `requireOwnWorktree` from
  `scripts/dispatch/loop.mjs`, whose refusal names
  `node scripts/dispatch/loop.mjs --init [path]`: a source-repository path, not
  a command installed in another project.
- `scripts/dispatch/review-eligibility.mjs` returns the governing verdict in
  `existing` when a head has already been reviewed, while rotation currently prints only
  the generic skip reason.
- `README.md` documents `rotation` with a source-repository command and documents
  the installed `npx --package=...` command form elsewhere.

## Open questions

- Is a documented, manually prepared detached worktree sufficient, or should Steward expose
  a supported package command to create one?
- Does this remain one usability story, or should checkout guidance and verdict reporting
  be split into independently deliverable changes?
