---
id: ST-25
title: A review-and-land pass, started as one command
tier: next
kind: workflow
depends_on: [ST-21, ST-22, ST-23, ST-24]
model: sonnet
blocked: null
---

## Intent

As a member of the crew, I want one command that runs a review-and-land pass: it decides which open
pull requests get a reviewer, spawns them up to a cap, lands what has passed and is safe to merge,
and exits, carrying nothing forward, so that the controller (and later any other trigger) can start
the review side with one command and each run uses steward as it is on `main`.

## Acceptance criteria

- [ ] **AC-1** — `node scripts/dispatch/cli.mjs pass [--max-reviews N] [--repo owner/name]` runs a
      new module, `scripts/dispatch/pass.mjs`, and `cli.mjs`'s table of commands gains `pass`.
      `--max-reviews` takes a positive integer and defaults to 5.
- [ ] **AC-2** — Step 1: the pass refuses to run from a checkout with a branch checked out
      (`loop.mjs`'s `requireOwnWorktree`), then brings its worktree to `origin/main`, detached,
      and stops with status `dirty`, doing nothing more, if the worktree has anything uncommitted
      (`loop.mjs`'s `updateCheckout`). It reads the settings after the update.
- [ ] **AC-3** — Step 2: it lists the open pull requests against `main` once. Step 3: oldest first
      (lowest number), it reviews each that is not a draft, whose author the gate honours
      (`HONOURED_ASSOCIATIONS`), and that has no honoured verdict at its current head, with
      `reviewPullRequest`, stopping once it has reviewed `--max-reviews` of them. Every pull
      request is a candidate whoever opened it.
- [ ] **AC-4** — Step 4: when the settings' `land` is true, it then reads each pull request from
      the list again and, one at a time, calls `landPullRequest` with `once: true` (ST-23) for
      each whose current head has an honoured `pass` or `pass-with-observations` verdict,
      including one passed in an earlier pass. When `land` is false it lands nothing.
- [ ] **AC-5** — Step 5: it prints one line per pull request considered, with its number and
      outcome (skipped and why, reviewed with its result, landed or not and why), and exits 0. It
      exits non-zero only when the pass itself could not run: a checkout with a branch, a dirty
      worktree, settings that do not read, or a listing that fails. It stores nothing.
- [ ] **AC-6** — Tests in `pass.test.mjs`, named `ST-25/AC-<n>`, with the GitHub, review and land
      functions injected: the order and the cap; each skip (draft, outsider, verdict already at the
      head); a pull request passed in an earlier pass and landed in this one; `land: false`
      landing nothing; a review that records no verdict leaving that pull request to the next pass;
      and the refusals in AC-2.
- [ ] **AC-7** — The `**Planned (ST-25)**` marker in `docs/agent-workflow-design.md` loses
      `ST-25`, and the passage is corrected wherever what was built differs.
- [ ] **AC-8** — `docs/controller.md` tells the controller to run a rotation with this command, in
      place of running its steps by hand, and drops each instruction the command now carries out
      itself; `docs/agent-workflow-design.md`, "The controller", is corrected to match.

## Out of scope

- What starts a pass: the controller, for now (`docs/harness-outline.md`, "The two sides").
  A scheduled task or another trigger is later.
- Raising problems a pass meets as GitHub issues, and the stop measure shared with the coder.
- Running passes on more than one machine, and a review claim.
- Changing `loop.mjs` or `writer-prs.mjs`, which the frozen loop still uses.

## Constraints

- Node, ESM, no new runtime dependencies.
- The pass never pushes, never starts a coder, and triggers the sweep only through
  `landPullRequest`.

## Context

- `docs/harness-outline.md`, "Defining steward", "The two sides": the review side as a
  review-and-land dispatcher, the five steps of a pass, landing that never waits, the cap, and one
  machine for now.
- `scripts/dispatch/writer-prs.mjs`'s `reviewAndLandWriterPullRequests`: today's nearest thing,
  run only inside `loop.mjs`, landing straight after each review and never retrying a landing.
- `scripts/dispatch/loop.mjs`: `requireOwnWorktree`, `updateCheckout`, and how it reads the
  settings and creates its contexts.

## Open questions

*(none)*
