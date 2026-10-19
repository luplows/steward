---
id: ST-38
title: Start the reviewer in a checkout of the base, and read the head only through git
tier: fix
kind: workflow
depends_on: []
model: null
blocked: "Built by hand: changes .claude/prompts/reviewer.md, which a spawned coder session cannot edit (docs/agent-workflow-design.md, A spawned session cannot edit .claude/prompts/)"
---

## Intent

As a member of the crew, I want the reviewer to start in a checkout of the base branch, and read
the pull request's head only through git, so that the instructions, settings and hooks its tool
loads from its working directory come from `main`, which only reviewed changes reach, and never
from the pull request it is judging.

## Acceptance criteria

- [x] **AC-1** — Before anything else is changed, a trial, posting nothing, shows the design
      works. A head on a throwaway branch adds a `CLAUDE.md` and an `AGENTS.md`, each telling the
      reviewer to put a marker word in its summary, and a `.claude/settings.json` with a
      `SessionStart` hook that writes a marker file outside the checkout. A reviewer session, as
      `buildInvocation` and `codexReviewerArgs` render it, is run four times on that head: on
      Claude Code and on Codex, each once in a checkout of the head (today's design) and once in a
      checkout of the base (this story's). Each run's summary is searched for the marker word, and
      the marker file looked for. The results are recorded in `docs/agent-workflow-design.md`,
      "Trials and measurements", whatever they are. When a run in the base's checkout shows the
      marker word or the marker file, the story stops there: `blocked:` is set, saying what the
      trial found, and nothing below is built. The throwaway branch is deleted from `origin`
      afterwards, if it was pushed.
- [x] **AC-2** — `reviewPullRequest` makes the review's worktree, detached, at the base branch's
      tip as fetched (`origin/<baseRef>`), not at `pr.headSha`. The fetch of the head and the
      `head-moved` checks stay as they are, and `{{HEAD_SHA}}` in the prompt is still the head's.
      No working tree of the head is made. `assertReviewableCheckout` is given the base's SHA,
      before the session and before a re-run. Tests: the worktree is added at the base's tip; a
      checkout found at the head's SHA, or changed, before the session is refused.
- [x] **AC-3** — `reviewer.md` says that the working tree is the base branch, not the pull
      request: the Read, Grep and Glob tools and the shell utilities see the base's files, which
      are never evidence about the head. It says to read the head only through git, naming
      `git show {{HEAD_SHA}}:<path>`, `git grep <pattern> {{HEAD_SHA}}`, `git ls-tree
      {{HEAD_SHA}}` and `git diff origin/main...{{HEAD_SHA}}`. Its step 2 confirms the head with
      `git rev-parse origin/{{HEAD_BRANCH}}`, with no `git fetch`, since ATC has fetched it. Its
      "If you are running under the Codex CLI" section loses the two points that no longer
      differ (the head checked out, and the fetch failing). Its sentence against reviewing
      against "`REVIEW.md` in your checkout, which is the pull request's copy" is corrected,
      since the checkout's copy is now the base's.
- [x] **AC-4** — With AC-2 and AC-3 in place, two of ST-4's AC-5 heads are replayed, posting
      nothing, on the reviewer's default choice, through the composition ST-4's AC-5 describes:
      #37 at `c67ce61`, which returned `pass`, and #39 at `3a7dcea`, which returned
      `pass-with-observations`. Each verdict, its findings, and any finding that comes from
      reading the base's file for the head's, are recorded in "Trials and measurements". A
      finding that does is a failure of AC-3: the prompt is changed and both are run again.
- [x] **AC-5** — Every `**Planned (…)**` marker naming ST-38 in `docs/agent-workflow-design.md`
      loses `ST-38`, and each passage is corrected wherever what was built differs. Every other
      statement there, and in `review.mjs`'s comments, that the reviewer reads the diff in a
      checkout of the head is corrected, including "reads the diff in its own checkout of the
      head" in the passage on what the reviewer receives.

## Out of scope

- Instructions that reach the reviewer as content, such as text in the diff addressed to it. That
  is true of any design; this story stops only what the tool loads as configuration.
- ATC giving the reviewer the list of branches on `origin`, so that a reviewer without the
  network can check a story's number (#48's observation).
- The coder's checkout. A coder's retry runs in its own branch, which only coders wrote; that is
  ST-6's question.
- Containment of the reviewer's process, its network and git's credential: ST-6.

## Constraints

*(none)*

## Context

- **Decided on 2026-10-16 by the owner**, with the planning session (design doc, Part 3,
  "Decided so far", "The reviewer starts in a checkout of the base").
- `scripts/dispatch/review.mjs`: `reviewPullRequest` fetches `origin <headRef> <baseRef>`, adds
  the worktree at `pr.headSha`, and starts each session with `cwd: tree`;
  `assertReviewableCheckout` is called with `pr.headSha` before the first session and before a
  re-run. `scripts/dispatch/invocation.mjs`, `buildArgs`, passes no option that limits which
  project files Claude Code loads.
- The review's worktree is a worktree of `repoDir`, so it shares its refs: `origin/<headRef>` and
  the head's objects are there without a fetch from the session.
- ST-4 also changes `reviewer.md` and replays verdicts. Whichever lands second merges `main` and
  runs its replay on the prompt as the first left it.

## Open questions

*(none)*
