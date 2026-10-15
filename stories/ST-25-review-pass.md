---
id: ST-25
title: A rotation of the review side, started as one command
tier: next
kind: workflow
depends_on: [ST-21, ST-22, ST-23, ST-24]
model: sonnet
blocked: null
---

## Intent

As a member of the crew, I want one command that runs a rotation of the review side: it decides
which open pull requests get a reviewer, starts them up to a cap, has the pilot request landing for
what has passed and is safe to merge, and exits, carrying nothing forward, so that the controller
(and later any other trigger) can start the review side with one command and each run uses steward
as it is on `main`.

## Acceptance criteria

- [ ] **AC-1** — `node scripts/dispatch/cli.mjs rotation [--max-reviews N] [--repo owner/name]`
      runs a new module, `scripts/dispatch/rotation.mjs`, and `cli.mjs`'s table of commands gains
      `rotation`.
      `--max-reviews` takes a positive integer and defaults to 5.
- [ ] **AC-2** — Step 1: the rotation refuses to run from a checkout with a branch checked out
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
      including one that passed in an earlier rotation. When `land` is false it lands nothing.
- [ ] **AC-5** — Step 5: it prints one line per pull request considered, with its number and
      outcome (skipped and why, reviewed with its result, landed or not and why), and exits 0. It
      exits non-zero only when the rotation itself could not run: a checkout with a branch, a dirty
      worktree, settings that do not read, or a listing that fails. It stores nothing.
- [ ] **AC-5a** — A script error stops the rotation (owner, 2026-10-14). When `reviewPullRequest`
      or `landPullRequest` throws, rather than returning a status, the rotation prints which pull
      request and step it was, reviews and lands nothing more, and exits non-zero. A status other
      than `recorded` or `merged` is that pull request's outcome, printed as AC-5 says, and the
      rotation goes on (`docs/controller.md`, "Reporting and stopping").
- [ ] **AC-6** — Tests in `rotation.test.mjs`, named `ST-25/AC-<n>`, with the GitHub, review and
      land functions injected: the order and the cap; each skip (draft, outsider, verdict already at
      the head); a pull request that passed in an earlier rotation and lands in this one;
      `land: false` landing nothing; a review that records no verdict leaving that pull request to
      the next rotation; a thrown error stopping the rotation (AC-5a); and the refusals in AC-2.
- [ ] **AC-7** — The `**Planned (ST-25)**` marker in `docs/agent-workflow-design.md` loses
      `ST-25`, and the passage is corrected wherever what was built differs.
- [ ] **AC-8** — `docs/controller.md` tells the controller to run a rotation with this command, in
      place of running its steps by hand, and drops each instruction the command now carries out
      itself; `docs/agent-workflow-design.md`, "The controller", is corrected to match.

## Out of scope

- What starts a rotation: the controller, for now (`docs/outline.md`, "The two sides").
  A scheduled task or another trigger is later.
- Raising problems a rotation meets as GitHub issues, and the stop measure shared with the coder.
- Remembering a pull request whose review keeps failing. A rotation stores nothing (AC-5), so the
  next one reviews it again and pays for that session again, every rotation, until it succeeds.
- Re-reviewing after a fix to the description alone. A `block` is an honoured verdict at the
  head, so a rotation skips that head (AC-3), and the re-review is asked for by hand
  (`docs/controller.md`, "Re-review").
- Running passes on more than one machine, and a review claim.
- Changing `loop.mjs` or `writer-prs.mjs`, which the frozen loop still uses.

## Constraints

- Node, ESM, no new runtime dependencies.
- The rotation never pushes, never starts a coder, and starts the runway only through the pilot,
  `landPullRequest`.

## Context

- `docs/outline.md`, "Defining steward", "The two sides": the review side as a
  review-and-land dispatcher, the five steps of a rotation, landing that never waits, the cap, and
  one machine for now.
- `scripts/dispatch/writer-prs.mjs`'s `reviewAndLandWriterPullRequests`: today's nearest thing,
  run only inside `loop.mjs`, landing straight after each review and never retrying a landing.
- `scripts/dispatch/loop.mjs`: `requireOwnWorktree`, `updateCheckout`, and how it reads the
  settings and creates its contexts.

## Open questions

*(none)*
