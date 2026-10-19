---
id: ST-37
title: Tell a reviewer that could not review from a head that moved, and stop the rotation on it
tier: fix
kind: workflow
depends_on: []
model: null
blocked: null
---

## Intent

As a member of the crew, I want a review whose reviewer returned no verdict on a head that has not
moved to fail, and to stop the rotation, so that a reviewer that cannot work on this machine, such
as one whose tool will not start, is seen and fixed rather than passed over as an ordinary review
that reached no verdict.

## Acceptance criteria

- [x] **AC-1** — When a reviewer session returns a `null` verdict, `reviewPullRequest` reads the
      pull request's state again (`getPullRequestState`). When its head differs from the head the
      reviewer was handed (`pr.headSha`), the result is `no-verdict`, with `headSha` and the
      reviewer's `summary`, as today. When the head is unchanged, the result is
      `{ status: 'cannot-review', headSha, summary, sessions }`, `summary` being the reviewer's.
      Nothing is posted in either case. Tests: a `null` verdict with the head moved gives
      `no-verdict`; a `null` verdict with the head unchanged gives `cannot-review`, with the
      reviewer's summary, and posts no comment.
- [x] **AC-2** — `cannot-review` is a failure for `review.mjs`'s command line: it is not in
      `NON_FAILURES`, so the command exits 1 for it. `no-verdict` stays a non-failure.
      `review.mjs` exports `NON_FAILURES`, and a test asserts that it holds `no-verdict` and not
      `cannot-review`.
- [x] **AC-3** — `review.mjs`'s header, and `reviewPullRequest`'s doc comment, say what
      `cannot-review` means, and that `no-verdict` is now only a `null` verdict on a head that
      moved.
- [x] **AC-4** — `docs/controller.md`, "Reporting and stopping", says that `cannot-review` from
      `review.mjs` stops the whole rotation, as a script error does: the controller reports it,
      with the reviewer's summary, and starts nothing more until the crew says how to go on. It
      does not run the review again on another choice.
- [x] **AC-5** — Every `**Planned (…)**` marker naming ST-37 in `docs/agent-workflow-design.md`
      loses `ST-37`, and each passage is corrected wherever what was built differs.

## Out of scope

- The rotation's own command stopping on `cannot-review`: ST-25, AC-5c.
- Moving a review to another choice when one cannot review. ST-35 moves only when a tool's usage
  is over the limit or cannot be read.
- `.claude/prompts/reviewer.md`: when a reviewer returns `null` is unchanged. This story changes
  only how ATC reads a `null`.
- A retry of the session on `cannot-review`.

## Constraints

*(none)*

## Context

- **Raised on 2026-10-16** by the first rotation on the Codex reviewer, #48 at `d2ecf4f`: Codex's
  command tool would not start, because `codex-code-mode-host.exe` was missing beside
  `codex.exe`, so the reviewer could run no `git` command and returned a `null` verdict. ATC-Haiku
  got `no-verdict` and exit 0, the same as for a head that moved. It stopped only because the
  planning session had asked it to stop on a Codex failure. With the helper installed, the next
  run recorded `pass-with-observations`.
- `reviewer.md` returns `null` when the head moved, when the diff will not resolve, when a
  credential seems needed, and when a refused command was load-bearing. Only the first is ordinary:
  each of the others is something about the machine or the prompt that someone has to fix.
- `scripts/dispatch/review.mjs`: `reviewPullRequest` returns `no-verdict` for a `null` verdict
  before its two `head-moved` checks, which apply only to a verdict; `NON_FAILURES` lists
  `no-verdict`.
- Design doc, Part 3, "Decided so far", "A reviewer that returns no verdict on an unchanged head
  could not review" (**Planned (ST-37)**).

## Open questions

*(none)*
