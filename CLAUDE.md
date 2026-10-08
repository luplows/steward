# tower-workshop-paths

Instructions only. Rationale, mechanism and history live in the files listed under
**Where things are documented**.

## Branches and pull requests

- Never commit or push to `main`. It is protected.
- For every change: feature branch, commit, push, open a pull request.
- Work in a git worktree of your own, never the repository's main checkout, so that sessions running
  at the same time cannot collide. This applies to every session, the dispatcher session and
  Session A included. The dispatch scripts make the coder's and reviewer's worktrees themselves.
- Address anything arising from an open pull request with a new commit on its existing branch. New
  branch only for unrelated work.
- When a change both regenerates data files and alters logic, commit the regeneration separately.
- Read [`REVIEW.md`](REVIEW.md) before opening a pull request.
- Fill all three sections of [`.github/pull_request_template.md`](.github/pull_request_template.md).
  An empty section is a missing one. **Verification** gives the commands run and their real results.
- Check whether `README.md`, `Open-Questions.md` and `Project-Outline.md` need updating as a result
  of the change. Include any such updates in the same pull request.
- Open a pull request as a draft if it is not finished. Mark it ready when it is. Session A is the
  exception: it opens every pull request as a draft and marks it ready only when the owner says so
  (see [`docs/session-a.md`](docs/session-a.md)).
- Do not merge a pull request, your own or any other. The sweep is the only thing that merges.
- Do not delete the head branch. The sweep deletes it (see
  [`scripts/land/delete-merged-heads.mjs`](scripts/land/delete-merged-heads.mjs)); the repository's
  `delete_branch_on_merge` setting is not relied on.
- Do not trigger [`land-approved.yml`](.github/workflows/land-approved.yml). Only the owner, or
  [`scripts/dispatch/land.mjs`](scripts/dispatch/land.mjs) run by the dispatcher, may. The
  dispatcher is either a script or the **dispatcher session**: the one session the owner has asked
  to run `scripts/dispatch/` (see `docs/agent-workflow-design.md`, "The dispatcher session").
  - The dispatcher session lands only by running `land.mjs`, directly or through `story.mjs`. It
    never runs `gh workflow run`, and never merges through the API or any other way. No other
    agent session triggers the sweep at all.
  - It runs `land.mjs` only for a pull request whose head has an honoured `pass` or
    `pass-with-observations` verdict and green CI. `land.mjs` re-checks both through `review/agent`
    and `mergeable_state`; its header defines landable.
- The sweep lands one eligible pull request per run, only when triggered, so a merge-ready pull
  request waits. A run given a pull request (`land.mjs` always gives one) considers only that one;
  a run given none lands the oldest. Its eligibility rules and the `review-blocked` circuit breaker are defined in
  `land-approved.yml`.
- Agent containers have no `gh` CLI: use the GitHub MCP tools where the session has them, otherwise
  `git` plus the REST API. A spawned session may have neither.

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

## Stories

- [`stories/`](stories/README.md) is the dispatchable queue. Its README defines the schema, status
  derivation, ordering and readiness test.
- **Nothing dispatches from [`Open-Questions.md`](Open-Questions.md).** It is the idea backlog.
- A pull request implementing a story ticks each acceptance criterion it delivered, in the story
  file. See `stories/README.md`, "Acceptance criteria and tests".
- A pull request implementing a story moves that story file to `stories/done/` in the same pull
  request, and is reviewed against the story.
- Record a design decision in `docs/agent-workflow-design.md` in the pull request that makes it,
  marked as not yet built. The story that builds it removes the mark. See that document's "Reading
  this document" note.
- Look things up in `Completed-Questions.md` by OQ number rather than reading it whole.

## Testing

- CI runs lint, Vitest (`npm test`), the build, and Playwright (`npm run test:e2e`) on every pull
  request, and is a required check.
- Add tests alongside new logic: Vitest for unit and component behaviour, Playwright for user flows.
  The buy-order scoring algorithm is the highest priority.
- A pull request that changes how the tool behaves extends the Playwright suite rather than relying
  on a manual check.
- Do not add coverage-percentage tooling such as `@vitest/coverage-v8`. Its absence is deliberate.
- Green CI is necessary and not sufficient.
- Never generate screenshot baselines locally. `.github/workflows/update-screenshots.yml` creates
  missing ones on a CI runner and never rewrites an existing one. For an intentional appearance
  change, delete the stale images in your pull request and say in the body what changed and why.

## Where things are documented

| File | What it is |
|---|---|
| [`Project-Outline.md`](Project-Outline.md) | **The product's design of record** — goals, scope, definitions. |
| [`docs/agent-workflow-design.md`](docs/agent-workflow-design.md) | **The workflow's design of record** — roles, the gate, deliberate exclusions, platform facts. Read it before proposing a change to how work flows through this repository. |
| [`REVIEW.md`](REVIEW.md) | The enumerated checklist a pull request is reviewed against. |
| [`stories/README.md`](stories/README.md) | Story schema, status derivation, ordering, readiness test. |
| [`docs/session-a.md`](docs/session-a.md) | Instructions for the session that writes stories with the owner, including how a story pull request is handed over. |
| [`docs/migration-plan.md`](docs/migration-plan.md) | The phased sequence for building the workflow, and its status. Not a design document. |
| [`docs/gap-analysis.md`](docs/gap-analysis.md) | A dated snapshot, kept for its reasoning. Not a design document, and not current. |
| [`docs/harness-outline.md`](docs/harness-outline.md) | The workflow's product outline, as a product of its own (steward): who it is for, why, what it must never do. Moves with the workflow. |
| [`docs/steward-bootstrap.md`](docs/steward-bootstrap.md) | The hand-run checklist for creating `luplows/steward` from this repository. A procedure, not a design document. |
| `Completed-Questions.md` | Archive of resolved stories. |
