# Session A

Instructions for the session that writes and refines stories with the owner.
Session B, the release review, follows them too when it writes a story
(`docs/agent-workflow-design.md`, "Session B is Session A wearing a different
hat").

Instructions only. Where a rule is defined elsewhere, this file points there
rather than restating it. The role itself is described in
[`docs/agent-workflow-design.md`](agent-workflow-design.md), "The shape" and
"The story artifact".

## Before writing a story

- Read [`CLAUDE.md`](../CLAUDE.md). Its "Branches and pull requests" and
  "Claims about this repository" sections apply to every story pull request.
- Read [`stories/README.md`](../stories/README.md) for the schema, the status
  derivation and the readiness test, and start from
  [`stories/_TEMPLATE.md`](../stories/_TEMPLATE.md).
- Read `REVIEW.md`, "PRs that add or change a story" (items 20–25). That is
  what the story's pull request is reviewed against.
- Sizing is Session A's judgement, and so is saying when a story is too big
  (`docs/agent-workflow-design.md`, "Sizing is a judgment, and it is
  Session A's").

## Writing it

- Use the next unused OQ number, checked against `stories/`,
  `Open-Questions.md` and `Completed-Questions.md` (`REVIEW.md` item 5). Also
  check every branch on `origin` (`git ls-remote --heads origin`): a story
  still being written is on its branch and not yet on `main`.
- Work on a `write-story/OQ-<n>-<slug>` branch, never `story/…`, which is the
  name a coder's branch takes.
- Work in a separate git worktree, not the repository's main checkout. The
  dispatcher runs from the main checkout.
- Record a design decision the story makes in
  `docs/agent-workflow-design.md`, in the same pull request, marked as that
  document's "Reading this document" note says (`CLAUDE.md`, "Stories").
- Before opening the pull request, run `node scripts/lint-stories.mjs` and
  `node scripts/dispatch/queue.mjs`. The story should lint with no blocking
  violation, and the queue should show the status you intend: `ready` when
  its Open questions section is empty, `draft` otherwise.

## Handing it over

Decided by the owner on 2026-09-28.

- **Open every pull request as a draft.**
- **Mark it ready only when the owner says so**, in the conversation with
  this session. Marking a pull request ready is the owner's go-ahead for it
  to be reviewed and landed. The landing sweep never lands a draft
  (`land-approved.yml`).
- Until the loop picks these pull requests up itself (**Planned (OQ-83)** in
  `docs/agent-workflow-design.md`: it reviews and lands a ready pull request
  from a trusted author, and skips drafts), the owner or the dispatcher
  session reviews and lands a ready one.
- If its review blocks, fix the story on the same branch, and it is reviewed
  again once its head has moved. Under OQ-83 the loop re-reviews it and never
  spawns a coder for a pull request it did not open.

## Stopped stories

- A story that comes back with `blocked:` set, from a coder or from the loop,
  is Session A's to resolve with the owner. Clearing `blocked:` is Session
  A's (`stories/_TEMPLATE.md`).
