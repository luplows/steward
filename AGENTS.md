# steward

The rules every agent working in this repository follows, whatever tool or model runs it.
Instructions only. Rationale, mechanism and history live in the files listed under **Where things
are documented**.

This repository is steward, the harness, and also a project that uses steward: its own work is
written as stories under `stories/` and reviewed and landed through its own gate.

## Which instructions are yours

This file applies to every session. Each role has its own instructions as well:

| You are | Also read |
|---|---|
| The planning session, which plans steward with the crew and writes its stories | [`docs/planning-session.md`](docs/planning-session.md) |
| The controller, which a member of the crew has asked to run `scripts/dispatch/` by hand | [`docs/controller.md`](docs/controller.md) |
| A coder or reviewer session started by ATC | Your prompt, under `.claude/prompts/`. It says what else to read. |
| Any other session that changes this repository | **Opening a pull request**, below. |

## Every session

- Never commit or push to `main`. It is protected. Changes reach `main` only through a pull request
  that the sweep merges.
- Do not merge a pull request, your own or any other. The sweep is the only thing that merges.
- Do not delete a pull request's head branch. The sweep deletes it (see
  [`scripts/land/delete-merged-heads.mjs`](scripts/land/delete-merged-heads.mjs)); the repository's
  `delete_branch_on_merge` setting is not relied on.
- Do not trigger [`land-approved.yml`](.github/workflows/land-approved.yml). Only the crew, by hand,
  or the pilot, [`scripts/dispatch/land.mjs`](scripts/dispatch/land.mjs), run by ATC or by the
  controller, may.
- The sweep lands one eligible pull request per run, only when triggered, so a merge-ready pull
  request waits. A run given a pull request (`land.mjs` always gives one) considers only that one;
  a run given none lands the oldest. Its eligibility rules and the `review-blocked` circuit
  breaker are defined in `land-approved.yml`.

## Claims about this repository

Every assertion about how this repository works is produced by a command run while writing it, not
recalled — in story files, docs, commit messages, pull request bodies and review comments.

- Re-derive, don't recall: counts, thresholds, what a file says, which component does what, who may
  do what.
- Never quote filtered output as unfiltered.
- Before correcting a claim, grep for its other copies and correct all of them.
- Re-read a file end to end before committing an edit to it.
- Where a rule or number is enforced by code, point at the code rather than restating it. A
  restatement kept for readability says it is one and names what it must not drift from.

## Every pull request

These hold for every pull request's content, whoever writes it, the coder included.

- Fill all three sections of [`.github/pull_request_template.md`](.github/pull_request_template.md).
  An empty section is a missing one. **Verification** gives the commands run and their real results.
- Check whether `README.md` needs updating as a result of the change. Include any such update in
  the same pull request.
- [`REVIEW.md`](REVIEW.md) is the checklist a pull request is reviewed against. Read it before the
  pull request is opened.
- Write new text with the words in [`docs/glossary.md`](docs/glossary.md), with the meanings it
  gives them. Dated records keep the words they were written with.

## Stories

- [`stories/`](stories/README.md) is the dispatchable queue. Its README defines the schema, status
  derivation, ordering and readiness test.
- A pull request implementing a story ticks each acceptance criterion it delivered, in the story
  file. See `stories/README.md`, "Acceptance criteria and tests".
- A pull request implementing a story moves that story file to `stories/done/` in the same pull
  request, and is reviewed against the story.
- Record a design decision in `docs/agent-workflow-design.md` in the pull request that makes it,
  marked as not yet built. The story that builds it removes the mark. See that document's "Reading
  this document" note.
- An `OQ-<n>` is a tower-workshop-paths story. Look it up there by number, in its `stories/done/` or
  `Completed-Questions.md`, rather than reading either whole.

## Testing

- CI's `test` job runs oxlint (`npm run lint`), then Vitest (`npm test`), and on a pull request the
  story containment check (`.github/workflows/ci.yml`). `test` is a required check. Vitest includes
  the story lint over this repository's own stories (`scripts/lint-stories.test.mjs`).
- Add tests alongside new logic, in Vitest.
- Do not add coverage-percentage tooling such as `@vitest/coverage-v8`. Its absence is deliberate.
- Green CI is necessary and not sufficient.

## Opening a pull request

For a session that pushes and opens its own pull requests. The coder does not: the dispatcher
pushes its branch and opens its pull request, as its prompt says.

- Work in a git worktree of your own, never the repository's main checkout, so that sessions running
  at the same time cannot collide.
- For every change: feature branch, commit, push, open a pull request.
- Address anything arising from an open pull request with a new commit on its existing branch. New
  branch only for unrelated work.
- Open a pull request as a draft if it is not finished. Mark it ready when it is. The planning
  session is the exception: see [`docs/planning-session.md`](docs/planning-session.md).

## Where things are documented

| File | What it is |
|---|---|
| [`docs/agent-workflow-design.md`](docs/agent-workflow-design.md) | **The workflow's design of record** — roles, the gate, deliberate exclusions, platform facts. Read it before proposing a change to how work flows through this repository. |
| [`docs/harness-outline.md`](docs/harness-outline.md) | Steward's product outline: who it is for, why, what it must never do, and the owner's decisions defining it. |
| [`docs/glossary.md`](docs/glossary.md) | The words steward uses, and what each one means. |
| [`REVIEW.md`](REVIEW.md) | The enumerated checklist a pull request is reviewed against. |
| [`stories/README.md`](stories/README.md) | Story schema, status derivation, ordering, readiness test. |
| [`docs/planning-session.md`](docs/planning-session.md) | Instructions for the planning session, including how a story pull request is handed over. |
| [`docs/controller.md`](docs/controller.md) | Instructions for the controller: how it runs a rotation, reports, and lands. |
| [`docs/migration-plan.md`](docs/migration-plan.md) | The phased sequence for building the workflow, and its status. Not a design document. |
| [`docs/gap-analysis.md`](docs/gap-analysis.md) | A dated snapshot, kept for its reasoning. Not a design document, and not current. |
| [`docs/steward-bootstrap.md`](docs/steward-bootstrap.md) | The hand-run checklist that created `luplows/steward` from tower-workshop-paths. A procedure, not a design document. |
| [`CLAUDE.md`](CLAUDE.md) | Imports this file for Claude Code, which reads `CLAUDE.md` rather than `AGENTS.md`. |
