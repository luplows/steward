---
id: ST-25
title: A rotation of the review side, started as one command
tier: next
kind: workflow
depends_on: [ST-21, ST-22, ST-23, ST-24, ST-29, ST-37, ST-45]
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

- [x] **AC-1** — `node scripts/dispatch/cli.mjs rotation [--max-reviews N] [--repo owner/name]`
      runs a new module, `scripts/dispatch/rotation.mjs`, and `cli.mjs`'s table of commands gains
      `rotation`.
      `--max-reviews` takes a positive integer and defaults to 5.
- [x] **AC-2** — Step 1: the rotation refuses to run from a checkout with a branch checked out
      (`loop.mjs`'s `requireOwnWorktree`), then brings its worktree to `origin/main`, detached,
      and stops with status `dirty`, doing nothing more, if the worktree has anything uncommitted
      (`loop.mjs`'s `updateCheckout`). It reads the settings after the update.
- [x] **AC-3** — Step 2: it lists the open pull requests against `main` or a release branch (ST-45,
      AC-1) once. Step 3: oldest first (lowest number), it reviews each that is not a draft, whose
      author the gate honours (`HONOURED_ASSOCIATIONS`), that is not labelled `review-blocked`, and
      that has no honoured verdict at its current head, with `reviewPullRequest`, stopping once it
      has reviewed `--max-reviews` of them. Every pull request is a candidate whoever opened it.
      One labelled `review-blocked` is skipped until the crew removes the label (owner,
      2026-10-21), and step 4 still passes it to the pilot when it has a passing verdict at its
      head, which returns `review-blocked` (AC-5e).
- [x] **AC-4** — Step 4: when the settings' `land` is true, it then reads each pull request from
      the list again and, one at a time, calls `landPullRequest` with `once: true` (ST-23) for
      each whose current head has an honoured `pass` or `pass-with-observations` verdict,
      including one that passed in an earlier rotation. When `land` is false it lands nothing.
- [x] **AC-4a** — Step 4a: after step 4, it runs inspection (ST-29) once, as
      `node scripts/dispatch/cli.mjs inspect` does, and prints what inspection prints. Inspection's
      exit code, and an error inside it, are printed and change neither what the rotation has done
      nor its own exit code. A test shows inspection runs after the landings, and that a failing
      inspection leaves the rotation's exit code as it was.
- [x] **AC-5** — Step 5: it prints one line per pull request considered, with its number and
      outcome (skipped and why, reviewed with its result, landed or not and why), and exits 0. It
      exits non-zero only when the rotation itself could not run or go on: a checkout with a
      branch, a dirty worktree, settings that do not read, a listing that fails, a script error
      (AC-5a), a worktree a review changed (AC-5b), or a reviewer that could not review (AC-5c). It
      stores nothing.
- [x] **AC-5a** — A script error stops the rotation (owner, 2026-10-14). When `reviewPullRequest`
      or `landPullRequest` throws, rather than returning a status, the rotation prints which pull
      request and step it was, reviews and lands nothing more, and exits non-zero. A status other
      than `recorded` or `merged`, and other than `cannot-review` (AC-5c) and AC-5d's refusals, is
      that pull request's outcome, printed as AC-5 says, and the rotation goes on
      (`docs/controller.md`, "Reporting and stopping").
- [x] **AC-5b** — A worktree changed by a review stops the rotation (owner, 2026-10-15). After
      each review in step 3, before the next review or step 4, the rotation checks its worktree
      again: `HEAD` is still the commit step 1 checked out, and `git status --porcelain` prints
      nothing. Otherwise it prints which pull request's review preceded the change, reviews and
      lands nothing more, and exits non-zero. A test, with git injected, shows a change found after
      the first review stopping the rotation before any landing.
- [x] **AC-5c** — A reviewer that could not review stops the rotation (owner, 2026-10-16). When
      `reviewPullRequest` returns `cannot-review` (ST-37), the rotation prints which pull request
      it was and the reviewer's `summary`, reviews and lands nothing more, and exits non-zero. A
      test, with the review function injected, shows `cannot-review` on the first of two pull
      requests stopping the rotation before the second is reviewed and before any landing.
- [x] **AC-5d** — A refusal that holds for every pull request ends the reviewing, not the rotation
      (owner, 2026-10-21 and 2026-10-22). When `reviewPullRequest` returns `rules-unreadable` (the
      checklist is read from `main`) or `choice-unavailable` (the choice the crew named is not
      one), each of which refuses before a session starts, the rotation prints which pull request
      it was, the status and what the result carries to say why, reviews no other pull request, and
      goes on to step 4 and step 4a as usual. It exits 0 unless something else in AC-5 stops it.
      `over-usage`, `usage-unknown` and `reviewer-unavailable` are not among them: which choices
      may review depends on the pull request (`coderModelsRan` and `reviewerCandidates`,
      `scripts/dispatch/review.mjs`), so each is that pull request's outcome, as AC-5a says, and
      the next is reviewed. Tests, with the review function injected: each of the two on the first
      of two pull requests, where the second is not reviewed and a third, which passed in an
      earlier rotation, is still landed; and each of the other three on the first, where the
      second is still reviewed.
- [x] **AC-5e** — Every result of the pilot is printed, and landing goes on (owner, 2026-10-21).
      Each status `landPullRequest` returns with `once: true` (`merged`, `sweep-pending`,
      `closed`, `head-moved`, `landing-off`, `draft`, `review-blocked`, `review-failed`,
      `conflict`, `checks-failed`, `github-blocked` and `not-landable`) is printed on that pull
      request's line with what the result carries (`reason` and `waiting` on `not-landable`,
      `failing` on `checks-failed`, `newHeadSha` on `head-moved`), and the rotation goes on to the
      next pull request in step 4. A `sweep-pending` pull request is left to a later rotation. A
      test, with the land function injected, returns each status for a first pull request, with its
      fields, and shows the line printed and a second pull request still landed.
- [x] **AC-6** — Tests in `rotation.test.mjs`, named `ST-25/AC-<n>`, with the GitHub, review and
      land functions injected: the order and the cap; each skip (draft, outsider, `review-blocked`,
      verdict already at the head); a pull request that passed in an earlier rotation and lands in
      this one; `land: false` landing nothing; a review that records no verdict leaving that pull
      request to the next rotation; a thrown error stopping the rotation (AC-5a); and the refusals in AC-2.
- [x] **AC-7** — Each `**Planned (ST-25)**` marker in `docs/agent-workflow-design.md` loses
      `ST-25`, and each passage is corrected wherever what was built differs.
- [x] **AC-8** — `docs/controller.md` tells the controller to run a rotation with this command, in
      place of running its steps by hand, and drops each instruction the command now carries out
      itself; `docs/agent-workflow-design.md`, "The controller", is corrected to match.

## Out of scope

- What starts a rotation: the controller, for now (`docs/outline.md`, "The two sides").
  A scheduled task or another trigger is later.
- Raising problems a rotation meets as GitHub issues, and the stop measure shared with the coder.
  Inspection (ST-29) raises its own findings as issues, as that story defines.
- Remembering a pull request whose review keeps failing. A rotation stores nothing (AC-5), so the
  next one reviews it again and pays for that session again, every rotation, until it succeeds.
- Re-reviewing after a fix to the description alone. A `block` is an honoured verdict at the
  head, so a rotation skips that head (AC-3), and the re-review is asked for by hand
  (`docs/controller.md`, "Re-review").
- Running rotations on more than one machine, and a review claim.
- Changing `loop.mjs` or `writer-prs.mjs`, which the frozen loop still uses.
- Stopping a review from writing outside the rotation's worktree, or to files git ignores there.
  AC-5b only notices a change `git status` shows. Containment is ST-6's, a spike.
- Reviewing a pull request from outside the crew that a member of the crew has scheduled: ST-27,
  which depends on this story and narrows AC-3's `outsider` skip to one that is not scheduled.

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
