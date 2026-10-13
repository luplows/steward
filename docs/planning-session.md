# The planning session

> **OQ numbers.** This document was written in tower-workshop-paths, and moved to steward with its
> history. An `OQ-<n>` in it means a tower-workshop-paths story, found in that repository's
> `stories/done/` or `Completed-Questions.md`. Steward's own stories are numbered `ST-<n>`.

Instructions for the session that plans steward with the owner and writes and refines its stories.
It was called Session A until 2026-10-12. The release review follows these instructions too when
it writes a story (`docs/agent-workflow-design.md`, "The release review is the planning session
wearing a different hat").

Instructions only. Where a rule is defined elsewhere, this file points there rather than restating
it. The role itself is described in [`docs/agent-workflow-design.md`](agent-workflow-design.md),
"The shape" and "The story artifact". [`AGENTS.md`](../AGENTS.md) applies as well, its "Opening a
pull request" section included, except where this file says otherwise.

## Before writing a story

- Read [`stories/README.md`](../stories/README.md) for the schema, the status derivation and the
  readiness test, and start from [`stories/_TEMPLATE.md`](../stories/_TEMPLATE.md).
- Read `REVIEW.md`, "PRs that add or change a story". That is what the story's pull request is
  reviewed against.
- Sizing is the planning session's judgement, and so is saying when a story is too big
  (`docs/agent-workflow-design.md`, "Sizing is a judgment, and it is the planning session's").

## Writing it

- Use the next unused `ST-<n>`, checked against `stories/` (`done/` and `retired/` included) and
  every branch on `origin` (`git ls-remote --heads origin`): a story still being written is on its
  branch and not yet on `main`.
- Work on a `write-story/<slug>` branch, never `story/…`, which is the name a coder's branch takes.
- Set `blocked:` only where something stops the story being built, with the reason. Until steward's
  coder works, a story is built by hand, and that alone is not a reason (owner, 2026-10-12;
  `docs/agent-workflow-design.md`, "Portability", "Decided so far").
- Record a design decision the story makes as `AGENTS.md`, "Stories", says: in the same pull
  request, marked as not yet built.
- Record each decision as the owner's statement, dated, with the options considered, and correct
  every other copy of a claim it revises.
- Before opening the pull request, run `node scripts/lint-stories.mjs` and
  `node scripts/dispatch/queue.mjs`. The story should lint with no blocking violation, and the
  queue should show the status you intend: `draft` while its Open questions section holds
  anything, otherwise `ready`, `waiting` on its `depends_on`, or `blocked` with the reason.

## Handing it over

Decided by the owner on 2026-09-28.

- **Open every pull request as a draft.**
- **Mark it ready only when the owner says so**, in the conversation with this session. Marking a
  pull request ready is the owner's go-ahead for it to be reviewed and landed. The landing sweep
  never lands a draft (`scripts/land/select-candidates.mjs`).
- The controller reviews and lands it once it is ready ([`docs/controller.md`](controller.md)).
  When the owner asks you to have a pull request reviewed, ask the controller for a rotation for
  it. It reports the result back to you.
- If its review blocks, fix the story on the same branch. Its new head is reviewed afresh. A block
  on the pull request's description alone is fixed by editing the description, then asking the
  controller for a `--rereview`, naming the finding (`docs/controller.md`, "Re-review").

## Stopped stories

- A story that comes back with `blocked:` set is the planning session's to resolve with the owner.
  Clearing `blocked:` is the planning session's (`stories/_TEMPLATE.md`).
- A story the owner decides not to build is retired to `stories/retired/`, as `stories/README.md`,
  "Lifecycle", describes.
