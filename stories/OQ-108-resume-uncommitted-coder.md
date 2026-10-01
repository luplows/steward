---
id: OQ-108
title: Resume a coder session once when it ends with work left uncommitted, instead of discarding it
tier: normal
kind: workflow
depends_on: [OQ-107]
model: sonnet
blocked: null
---

## Intent

As the owner, I want a coder session that ends with uncommitted changes to be
given one more turn in the same session, told that its work is not committed,
so that a session ending early, for whatever reason, does not throw its work
away. Today `dispatchCoder` and `retryStory` return `nothing-committed` or
`uncommitted-changes`, and their clean-up removes the worktree. This is the
one backstop for every story, with no special case for any of them.

## Acceptance criteria

- [ ] **AC-1** — In `dispatchCoder` and in `retryStory`
      (`scripts/dispatch/coder.mjs`), when the session's outcome is
      `completed` and `pushBranch` reports uncommitted changes (`paths` not
      empty, with status `nothing-committed` or `uncommitted-changes`), the
      dispatcher resumes that session **once**, before any clean-up:
      - in the same worktree;
      - with the session's own `session_id` from its JSON output;
      - with the same arguments, allowlists and environment as the first
        spawn, plus the CLI's resume flag;
      - with the fixed resume message of AC-3 as the prompt.

      After a resume, everything the dispatcher reads from "the session"
      comes from the **resumed** session, not the first:
      - its outcome. One other than `completed` gives `session-failed`, as
        today;
      - its final report, which supplies the PR block (`prText`), `draft` and
        `findPromptChange`;
      - `pushBranch` run again.

      From there the dispatcher continues exactly as it does after a first
      session today. The first session's report is not used for any of these.
      A test covers a first session whose report has no PR block, resumed
      into one that commits and ends with a valid block: the result is
      `opened` (or `retried` for `retryStory`), with the resumed session's
      title and body.
- [ ] **AC-2** — No other case resumes:
      - an outcome other than `completed`;
      - `nothing-committed` with no `paths`;
      - `pushed`;
      - `push-failed`;
      - a second time.

      A resumed session that again leaves uncommitted changes ends with the
      status it reports today, and the clean-up runs as it does now. Tests
      cover each of these and AC-1's case, with the session stand-in.
- [ ] **AC-3** — The resume message is one exported constant in
      `scripts/dispatch/coder.mjs`, not a prompt file. It says that the
      session ended with its changes uncommitted, that any command it left
      running in the background has stopped, and that it should finish its
      task, commit, and end with its PR block, as its original instructions
      say. A test asserts the
      resumed invocation's prompt is that constant.
- [ ] **AC-4** — The result records the resume. `session` describes the first
      session as today. A `resumed` field, present only when a resume ran,
      describes the second session with the same fields (`sessionSummary`).
      `costUsd` stays the first session's. Callers that read
      `session.costUsd` are unchanged, and the resume's cost is in
      `resumed.costUsd`.
- [ ] **AC-5** — How the resume flag is passed is established by running the
      installed CLI, not from memory. The PR body states the command run and
      what showed that a `-p` session given the resume flag, with its prompt
      on stdin, continues the earlier session in the same working directory.
      `buildInvocation` (or `buildArgs`) gains whatever option this needs,
      with a test asserting the argument list.
- [ ] **AC-6** — Every `**Planned (…)**` marker in
      `docs/agent-workflow-design.md` that names OQ-108 is resolved as that
      document's "Reading this document" note says.

## Out of scope

- Resuming a session that did not complete (stalled, timed out, over budget,
  died). Those stay `session-failed`.
- Resuming a reviewer session.
- Keeping the worktree, or the uncommitted changes, after the resume has also
  failed.
- Changing how `story.mjs` or OQ-86's loop treat the resulting statuses.
- Counting a resume as a review or CI round. It is neither.

## Constraints

- Node, ESM, no new runtime dependencies.
- Unit tests do not invoke `claude`. AC-5's check is run by hand, once.

## Context

- `scripts/dispatch/coder.mjs`: `pushBranch`, `sessionSummary`, `cleanUp`, and
  the `finally` blocks of `dispatchCoder` and `retryStory` that remove the
  worktree.
- `scripts/dispatch/spawn.mjs`, `spawnSession`, and
  `scripts/dispatch/invocation.mjs`, `buildArgs` and `buildInvocation`.
- `claude --help` (2.1.281) lists `-r, --resume [value]`, "Resume a
  conversation by session ID". Whether it does this in print mode is AC-5's to
  establish.
- OQ-86's first dispatch (2026-10-01): a completed session left three
  uncommitted files and the run returned `nothing-committed`.
- `docs/agent-workflow-design.md`, "A long shell command in a headless
  session" (OQ-106): T1, T6 and T7 show sessions ending their turn to wait for
  a background command.
- OQ-107 tells sessions not to do that. This story is the backstop for when
  one does anyway.

## Open questions

*(none)*
