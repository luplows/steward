---
id: OQ-69
title: Review an open pull request end to end without a human in the middle
tier: next
kind: workflow
depends_on: [OQ-65, OQ-68, OQ-77]
model: sonnet
blocked: null
---

## Intent

As the owner, I want to point the dispatcher at an open pull request and have it
reviewed and the verdict recorded without me assembling anything, so that the
half of the loop that catches problems works before the half that produces them
is automated.

## Acceptance criteria

- [x] **AC-1** — One entry point takes a pull request number and runs the whole
      reviewer half: resolve the PR's head SHA and branch, assemble the reviewer
      prompt, spawn the reviewer, parse its verdict, and record that verdict as a
      **marker comment**. It posts no commit status — `review-gate.yml` derives
      `review/agent` from the marker, per OQ-68's AC-3. It calls `spawn.mjs`
      (OQ-65, which builds the prompt through OQ-74's `invocation.mjs`) and
      `github.mjs`, and reimplements none of them.
- [x] **AC-2** — Every untrusted value is bounded before it reaches the prompt:
      `{{STORY}}` and `{{PR_BODY}}` go through `wrapInjectedBlock`. A test
      asserts the assembled prompt has exactly one begin and one end marker per
      block and no heading at or above the prompt's own top level. This overlaps
      OQ-74's AC-4 deliberately — that one covers the spawn contract, this one
      covers the reviewer path specifically, because the PR body is the least
      trusted input in the system and is only present here.
- [x] **AC-3** — The verdict is recorded against **the SHA the reviewer
      actually reviewed**, taken from the reviewer's own `head` field rather
      than from what the dispatcher believed the head to be. A verdict whose
      `head` does not match the current tip is **not** recorded: the PR moved
      under the review, and `reviewer.md` already instructs the reviewer to
      return `null` in that case. A test covers the race where the head moves
      between resolving it and posting.
- [x] **AC-4** — A `null` verdict records nothing — no comment, and therefore no
      status — and is not treated as a failure of the dispatch. `REVIEW.md` is
      explicit that the PR stays pending, because a visible stuck PR beats an
      invisible wrong pass.
- [x] **AC-5** — The reviewer runs against a checkout at the SHA under review
      that is **not** the coder's working tree, and a test asserts the path
      passed to the spawn is neither the repository root nor a tree with
      uncommitted changes. A reviewer reading a dirty tree reviews something
      that is not what the PR contains.
- [x] **AC-6** — The story a pull request implements is resolved from **the story
      file the diff moves into `stories/done/`**, with the `story/OQ-<n>-<slug>`
      branch name as a fallback when the diff contains no such move. That order
      matters: the move is what `REVIEW.md` item 19 actually requires, so it is
      the one signal guaranteed present on a conforming PR, and it works for a
      pull request this dispatcher did not open — which is the whole point of
      reviewer-only dispatch. A branch name is a convention nothing enforces, so
      it cannot be the primary source.
- [x] **AC-6b** — When neither signal resolves a story, that is reported, not
      guessed. A pull request implementing no story is a real case — a bootstrap
      or workflow-only change — and is handled as `reviewer.md`'s table
      specifies: `{{STORY}}` renders as `*(none — this PR implements no story;
      items 16–19 do not apply.)*` and the other story placeholders render `n/a`.
      A test covers a story PR, a workflow-only PR, and the case where the diff
      moves no story file but the branch name names one — which is a coder that
      forgot item 19, and must fail informatively rather than review against a
      story the diff never touched.
- [x] **AC-7** — The reviewer's model is never the coder's. `reviewer.md`
      requires a different model for context isolation and `stories/README.md`
      says the reviewer is never the story's `model`. A test asserts the
      constructed invocation's model differs from the story's declared one.
- [x] **AC-8** — Running this against a pull request that already carries a
      verdict at the current head does not post a second one. Re-review happens
      because a commit moved the head, not because the entry point was invoked
      twice.

## Out of scope

- **Spawning a coder, or fixing anything.** This story reviews what already
  exists. Coder dispatch is OQ-70.
- **Retrying, counting rounds, or the two-round bound.** OQ-48.
- **Triggering the landing sweep.** Never this module's, per OQ-68.
- **Judging the verdict.** The reviewer decides; this records.

## Constraints

- Node, ESM, no new runtime dependencies.
- The reviewer is handed no GitHub credential. `docs/agent-workflow-design.md`
  states this as the design and today it is prose only — there is no
  `reviewerEnv` counterpart to `coderEnv`. Whatever this story does, it must not
  pass the dispatcher's own credential into the reviewer's environment.

## Context

This is the migration plan's step 4, described there as "the highest-value half
and testable against real PRs immediately". It is ordered before coder dispatch
for that reason: a reviewer that runs on demand is useful even with every other
part of the loop still manual.

**OQ-51's hand-run did all of this four times**, and three details that looked
incidental turned out to be load-bearing:

1. **The reviewer's checkout matters.** It ran in a detached worktree at the head
   SHA, deliberately not the coder's tree — which by then held untracked scratch
   files. AC-5 exists because "review the diff" and "read the working tree" give
   different answers.
2. **The prompt must not be rendered with the code under review.** When the diff
   *is* `render.mjs`, using it to assemble the review prompt is circular, and in
   round 1 it would have produced the interleaved-marker output that was the
   defect. This module imports the merged `render.mjs` from the dispatcher's own
   checkout, never from the PR's branch. Worth an explicit test if it can be made
   one.
3. **Bounding the PR body is not optional.** Round 2's body documented the marker
   format literally, so a nonce-less wrap counted its prose as real markers.
   Content that discusses the mechanism forges the mechanism — see OQ-74's
   Context, point 3.

- `docs/migration-plan.md`, "Order within Phase 1" step 4 — this story's scope
- `.claude/prompts/reviewer.md` — the placeholder table AC-6 satisfies, the
  head-moved rule AC-3 implements, and the JSON contract `outcome.mjs`
  (OQ-75) returns
- `REVIEW.md`, "Recording a verdict", "The three verdicts", "When the reviewer
  returns no verdict" — AC-3, AC-4
- `scripts/dispatch/render.mjs` — `wrapInjectedBlock` and `render`
- OQ-74's AC-3 — the reviewer's `--allowedTools` list, read-only shell
  utilities included. This story passes it through and does not define its own.
  Both hand-run reviews of #122 and #123 had shell pipelines denied for want of
  it.
- [#117](https://github.com/luplows/tower-workshop-paths/pull/117) — four review
  rounds recorded as marker comments at known head SHAs; the fixtures for this
  story's tests are sitting in it

## Open questions

*(none)*

<!--
Resolved 2026-09-19 before dispatch, and recorded in AC-6 / AC-6b rather than
here: the story is resolved from the `stories/done/` move the diff makes, with
the branch name as a fallback. "The dispatcher remembers what it dispatched" was
rejected outright — it cannot review a pull request the dispatcher did not open,
which is this story's entire purpose.
-->

