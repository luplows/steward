---
id: ST-39
title: Fetch every branch, pruned, before a review, so the reviewer can check origin's branches
tier: normal
kind: workflow
depends_on: []
model: null
blocked: "Built by hand: changes .claude/prompts/reviewer.md, which a spawned coder session cannot edit (docs/agent-workflow-design.md, A spawned session cannot edit .claude/prompts/)"
---

## Intent

As a member of the crew, I want a reviewer with no network to be able to tell which branches exist
on `origin`, so that `REVIEW.md`'s checks against them, a new story's number and a story already in
flight, are made on every review rather than reported as not checked.

## Acceptance criteria

- [ ] **AC-1** — `reviewPullRequest` (`scripts/dispatch/review.mjs`) makes its fetch before a
      review as `git fetch --prune origin +refs/heads/*:refs/remotes/origin/*` (with `REMOTE` for
      `origin`), in place of fetching the head and base branches alone. A test with a local
      `origin` shows that, once the review's session is started, a branch created on `origin`
      since an earlier fetch has its ref under `refs/remotes/origin/`, and a branch deleted on
      `origin` since then has none.
- [ ] **AC-2** — `.claude/prompts/reviewer.md` tells every reviewer, whatever its tool, that the
      branches on `origin` are the remote-tracking refs ATC fetched, pruned, just before the
      review, which `git branch -r` lists, and to check a branch on `origin` there, not with
      `git ls-remote` or `git fetch`. A test in `invocation.test.mjs` pins the new wording.
- [ ] **AC-3** — `REVIEW.md`, "Changes to stories", item 5 no longer names `git ls-remote` as the
      way to check that a story's branch exists on `origin`.
- [ ] **AC-4** — Every **Planned** marker naming ST-39 in `docs/agent-workflow-design.md` is
      resolved, as its "Reading this document" note says.

## Out of scope

- Giving the reviewer anything from GitHub: `gh`, a token, or pull requests and comments fetched
  by ATC. The crew decided on 2026-10-19 to leave the reviewer with the local repository alone,
  to be revisited if needed (`docs/agent-workflow-design.md`, Part 3, "Decided so far").
- ATC passing the list of branches, or anything else new, in the reviewer's prompt.
- The reviewer's allowlist (`reviewerAllowedTools()`, `scripts/dispatch/invocation.mjs`): its
  `git fetch` and `git ls-remote` stay.
- The fetches `coder.mjs`, `story.mjs` and `loop.mjs` make, and the controller's own fetch before a
  rotation (`docs/controller.md`).
- `stories/README.md`, "Numbering", which tells a story's author to use `git ls-remote`.

## Constraints

- The refspec is given in the command, not taken from the repository's configured
  `remote.origin.fetch`, so that a project whose clone fetches fewer branches still fetches the
  pull request's head.
- The check that the head did not move (`head-moved`), and the base's tip as the review's
  checkout (ST-38/AC-2), read the refs this fetch updates, as they do today.

## Context

- `scripts/dispatch/review.mjs`, line 434: `git(repoDir, ['fetch', REMOTE, pr.headRef,
  pr.baseRef])`, then the `head-moved` check and `baseSha`.
- `.claude/prompts/reviewer.md`, "If you are running under the Codex CLI", line 191: "There is no
  network, so `git fetch` and `git ls-remote` fail." `invocation.test.mjs`, line 246, pins that
  sentence (ST-32/AC-4, ST-38/AC-3).
- `REVIEW.md`, "Changes to stories": item 1 (a new story's number, checked against every branch on
  `origin`) and item 5 (line 108, "check with `git ls-remote`").
- `docs/agent-workflow-design.md`, "Trials and measurements", "The reviewer's checkout: head or
  base": both replayed Codex verdicts said the remote branches could not be checked, with no
  network.
- The review's checkout is a worktree of the repository ATC runs in, so its remote-tracking refs
  are shared with every other worktree of that repository. Pruning removes, for all of them, only
  the refs of branches already deleted on `origin`.
- This repository's `remote.origin.fetch` is `+refs/heads/*:refs/remotes/origin/*`
  (`git config --get-all remote.origin.fetch`, 2026-10-19).

## Open questions

*(none)*
