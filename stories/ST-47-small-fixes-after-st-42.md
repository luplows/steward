---
id: ST-47
title: Keep main and release branches as merged heads, page review/agent's re-check, and fix three tests
tier: normal
kind: workflow
depends_on: [ST-42]
model: null
blocked: null
---

## Intent

As a member of the crew, I want four small defects the planning session noted while landing
earlier stories fixed together: one that could delete a project's `main`, one that could skip a
landing for want of reading a second page, and three tests whose names claim more than they check.
Each is small; together they are one pull request. It waits for ST-42, which moves two of them
into steward commands, so that they are fixed where the code then lives.

## Acceptance criteria

- [ ] **AC-1** — **Merged heads.** Deleting merged heads (today
      `scripts/land/delete-merged-heads.mjs`; after ST-42, wherever ST-42 puts it) never deletes
      `main` or a branch `isLandingBase` (`scripts/land/release-branch.mjs`) accepts, whatever the
      merged pull request's base, and reports each it kept as kept, naming the reason. Tests: a
      merged pull request from `main` into `release/v0.1.0`, and one from `release/v0.1.0` into
      `main`, each with the branch still at the merged head, delete nothing and report the branch
      kept; a merged `story/` head is still deleted as before.
- [ ] **AC-2** — **The runway's re-check of `review/agent`.** The runway's direct re-check of
      `review/agent` on the head before it merges (today `land-approved.yml`, the lines under the
      comment "Belt and braces"; after ST-42, the command that runs it) reads every page of the
      head's statuses, so that a `review/agent` status on a later page is found. A test gives it a
      first page full of other contexts and `review/agent` `success` on the second, and shows it
      found; with no `review/agent` on any page, it still skips the pull request.
- [ ] **AC-3** — **Codex's process is stopped.** In `scripts/dispatch/codex.test.mjs`, the two
      ST-32/AC-3 tests named for stopping the process ("…, and stops the process" and "no answer
      within the time limit is unreadable, and the process is stopped") each assert that the
      process the fake app server runs in exits after the result is returned, waiting for its exit
      for at most 5 seconds; the stand-in never exits by itself. The pull request's body shows each
      failing with the call that stops the process removed from `rateLimitsRpc`
      (`scripts/dispatch/codex.mjs`).
- [ ] **AC-4** — **A test named for what it checks.** The test in
      `scripts/land/apply-review-blocked.test.mjs` titled "applyReviewBlocked makes no labels
      request at all when the label is already there" is retitled to say what it checks: that no
      request changes a label when the label is already there. Its expectations are unchanged.

## Out of scope

- Anything else about which branches are deleted: same-repository heads, a branch that has moved
  since the merge, and not failing the run stay as they are.
- The runway's other reads of statuses and check runs, which already read every page.
- What counts as landable, or as a passing verdict.
- Codex's usage reading itself (`rateLimitsRpc`, `readCodexUsage`): only its tests change.

## Constraints

*(none)*

## Context

- Each was noted by the planning session as a small fix for the next pull request touching its
  file, and on 2026-10-21 the owner had them written as one story, waiting for ST-42, since ST-42
  moves the logic of `land-approved.yml` and `delete-merged-heads.mjs` into steward commands.
- `scripts/land/delete-merged-heads.mjs` skips a head only when `ref === pr.base.ref`, the pull
  request's own base, so a merged pull request whose head was `main` and whose base was a release
  branch would have `main` deleted while `main` still pointed at that head. On this repository
  branch protection forbids deleting `main`; on a private repository on GitHub Free nothing does
  (design doc, Part 3, R6). Its test "OQ-52/AC-4" covers a head named as its own base, `main` into
  `main`.
- `.github/workflows/land-approved.yml`, under the comment "Belt and braces": `gh api
  "repos/${REPO}/commits/${sha}/status" --jq '.statuses[] | select(.context == "review/agent")
  | .state'`, with no `--paginate`, where the lines before it read
  `commits/${sha}/status?per_page=100` with `--paginate`. It fails safe: a `review/agent` it does
  not read skips the pull request.
- `scripts/dispatch/codex.test.mjs`: `fakeAppServer` spawns node running a stand-in for `codex
  app-server`, which keeps running on a `setInterval` until it is stopped. `rateLimitsRpc` resolves
  once `killTree` (`scripts/dispatch/spawn.mjs`) resolves (`codex.mjs`, `finish`). On Windows
  `killTree` waits for `taskkill` to exit, kills the child directly, then resolves; elsewhere it
  sends `SIGKILL` and resolves at once, without waiting for the child to exit. So the process may
  still be running when the result is returned, and the tests wait for its exit rather than
  expect it already gone (owner, 2026-10-22, after #69's first review). The two tests assert the
  answer, and the second the time taken, but neither that the process ended.
- `scripts/land/apply-review-blocked.test.mjs`: the test asserts that no call starts with `-X`; the
  function still reads the labels endpoint.

## Open questions

*(none)*
