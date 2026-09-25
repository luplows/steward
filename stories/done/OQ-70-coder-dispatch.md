---
id: OQ-70
title: Take a ready story from the queue to an open pull request
tier: next
kind: workflow
depends_on: [OQ-65, OQ-68, OQ-77]
model: sonnet
blocked: null
---

## Intent

As the owner, I want the dispatcher to pick the next ready story and turn it
into an open pull request without me preparing anything, so that starting work
costs a command rather than a sequence of steps I have to get right each time.

## Acceptance criteria

- [x] **AC-1** — One entry point takes the next dispatchable story from
      `queue.mjs`, creates its branch and a dedicated worktree, spawns the
      coder, and opens a pull request from the `## PR title` / `## PR body` /
      `draft`-or-`ready` block the coder emits. It calls `queue.mjs`,
      `spawn.mjs` (OQ-65, which builds the prompt through OQ-74's
      `invocation.mjs`) and `github.mjs`, and reimplements none of them.
- [x] **AC-2** — The branch is `story/OQ-<n>-<slug>` derived from the story
      filename, is created from the current `origin/main`, and **carries no
      upstream tracking `main`**. A branch created with `git branch <name>
      origin/main` tracks `origin/main`, which makes a bare `git push` on it aim
      at `main`. A test asserts no upstream is configured.
- [x] **AC-3** — The coder's environment and allowlist come from
      `coderEnv` and `coderAllowedTools(branch)`, never restated here, and a
      test asserts no credential variable survives into the spawned
      environment.
- [x] **AC-4** — A coder that pushed nothing does not get a pull request opened
      for it. The branch's existence on the remote is checked rather than
      assumed from a `completed` classification, because OQ-75's AC-2 makes
      those separate questions: a session can report failure having succeeded,
      and can report success having pushed nothing.
- [x] **AC-5** — A missing or malformed `## PR title` / `## PR body` block is a
      classified failure, and **no pull request is opened with an invented
      description**. `coder.md` requires that block as the last thing in the
      report; if it is absent the run is reported as such, leaving a pushed
      branch and no PR, which is a visible state someone can resolve.
- [x] **AC-6** — The `draft` or `ready` flag the coder emits is honoured
      exactly. `CLAUDE.md` is explicit that a non-draft PR which goes green will
      be landed whether or not another commit was intended, so defaulting this
      either way is unsafe. Absent, it is AC-5's malformed case.
- [x] **AC-7** — This module posts no commit status, and a test asserts it.
      `coder.md` promises the coder that its PR "gets a `review/agent` commit
      status, set pending the moment it opens", and that promise is already kept
      by `review-gate.yml`, which sets `pending` on the `pull_request` opened
      event. Opening the PR is therefore sufficient; posting `pending` from here
      as well would duplicate the workflow and race it, which is what OQ-51's
      hand-run did four times without noticing.
- [x] **AC-7b** — A coder that emits a diff for `.claude/prompts/` has that
      **reported, not applied**. The run finishes, the pull request opens, and the
      report says a prompt change is pending manual application, naming the
      emitted diff. A test asserts no code path in this module writes to
      `.claude/` or invokes `git apply`. See **Open questions**'s resolution in
      **Context** for why automating it was rejected.
- [x] **AC-8** — A `blocked:` frontmatter value written by the coder is
      detected, and the pull request is opened as a draft regardless of what the
      coder said. That is the escape route `coder.md` documents for a story it
      cannot settle, and draft is what keeps the sweep off it.
- [x] **AC-9** — The worktree is removed when the run finishes, and a test
      asserts it is removed on the failure paths too. A leaked worktree blocks
      the next run on the same story and is the kind of state that accumulates
      silently.

## Out of scope

- **Reviewing the pull request.** OQ-69.
- **Retrying a blocked round, or the two-round bound.** OQ-48. This story runs a
  coder once.
- **Triggering the landing sweep.** Never this module's, per OQ-68.
- **Choosing which story to run.** `queue.mjs` decides; this consumes the
  decision. Overriding it with an explicit story id is a convenience, not a
  requirement, and must not become a second ordering.

## Constraints

- Node, ESM, no new runtime dependencies.
- Push must stay scoped to the story's own branch. `coderAllowedTools` is what
  enforces that and this story must not widen it.

## Context

The migration plan's step 5. It comes after reviewer dispatch deliberately: a
coder that opens PRs nobody reviews automatically is the half that produces work
without the half that checks it.

**Everything in the acceptance criteria above was done by hand for OQ-51**, and
the ones that look fussy are the ones that went wrong:

- **AC-2** — the branch was created with `git branch … origin/main` and silently
  tracked `origin/main`. The coder's allowlist would have refused a bare `git
  push`, so it was harmless that time, but a branch pointed at `main` is not
  something to leave armed.
- **AC-4 and AC-5** — rounds 2 and 3 both finished their work and were refused
  `git push` (see OQ-67), so the branch tip and the coder's report disagreed. A
  dispatcher that trusts either one alone gets it wrong: one reported success
  having pushed nothing, and the report still contained a complete, correct PR
  body.
- **AC-9** — the two worktrees from that run outlived it and were cleaned up by
  hand afterwards.

**The prompt-diff question is settled: this module does not apply them.** A coder
cannot edit `.claude/prompts/`, so a story touching the prompts emits its intended
change as a diff in the PR body — `docs/agent-workflow-design.md` calls this "the
coder emits, the dispatcher writes", and #112 applied one by hand.

Automating that application was considered and **rejected** on 2026-09-19. It
would mean this module taking patch text out of a pull request body written by the
agent under review and applying it to the one directory that agent is deliberately
forbidden to touch. The narrower version — apply only when the patch is confined
to `.claude/prompts/` — is weaker than it sounds, because the paths being checked
come from the patch, which is the untrusted input. Refusing outright is the only
option where the dispatcher cannot be talked into writing somewhere by a PR body,
and the cost is stated rather than hidden: **a story that changes a prompt stays
partly manual, permanently.** That is AC-7b, and the reasoning is the same one
`.claude/prompts/` being a sensitive path rests on — if the platform judges a
spawned session should not write there, a script spawned from the same loop
applying its diff for it is a workaround, not a solution. OQ-67's AC-6 is the
first story that will feel this.

- `docs/migration-plan.md`, "Order within Phase 1" step 5 — this story's scope
- `.claude/prompts/coder.md` — the `## PR title` / `## PR body` contract AC-5
  and AC-6 read, the `blocked:` escape route AC-8 detects, and the pending-status
  promise AC-7 keeps
- `scripts/dispatch/coder-env.mjs` — `coderEnv` and `coderAllowedTools`; note
  OQ-67 fixes two gaps in the latter and should land first
- `CLAUDE.md`, "Open a PR as a draft if it is not finished" — why AC-6 refuses to
  default
- `docs/agent-workflow-design.md`, "A spawned session cannot edit
  `.claude/prompts/`" — the constraint behind the open question below

## Open questions

*(none)*

<!--
Resolved 2026-09-19 before dispatch: this module does not apply a coder's emitted
`.claude/prompts/` diff. It reports one as pending manual application (AC-7b), and
the reasoning is in Context. A second question answered itself while writing the
ACs: `review/agent` pending is already posted by review-gate.yml, so AC-7 became a
prohibition rather than a requirement.
-->

