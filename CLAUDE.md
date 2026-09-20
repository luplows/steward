# tower-workshop-paths

Instructions only. Rationale, mechanism and history live in the files listed under
**Where things are documented**.

## Branches and pull requests

- Never commit or push to `main`. It is protected.
- For every change: feature branch, commit, push, open a pull request.
- Address anything arising from an open pull request with a new commit on its existing branch. New
  branch only for unrelated work.
- When a change both regenerates data files and alters logic, commit the regeneration separately.
- Read [`REVIEW.md`](REVIEW.md) before opening a pull request.
- Fill all three sections of [`.github/pull_request_template.md`](.github/pull_request_template.md).
  An empty section is a missing one. **Verification** gives the commands run and their real results.
- Check whether `README.md`, `Open-Questions.md` and `Project-Outline.md` need updating as a result
  of the change. Include any such updates in the same pull request.
- Open a pull request as a draft if it is not finished. Mark it ready when it is.
- Do not merge your own pull request.
- Do not delete the head branch.
- Do not trigger [`land-approved.yml`](.github/workflows/land-approved.yml). That is the owner's. It
  lands one eligible pull request per run, only when triggered, so a merge-ready pull request waits.
  Its eligibility rules and the `review-blocked` circuit breaker are defined in that file.
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
- A pull request implementing a story moves that story file to `stories/done/` in the same pull
  request, and is reviewed against the story.
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
| [`docs/migration-plan.md`](docs/migration-plan.md) | The phased sequence for building the workflow, and its status. Not a design document. |
| [`docs/gap-analysis.md`](docs/gap-analysis.md) | A dated snapshot, kept for its reasoning. Not a design document, and not current. |
| `Completed-Questions.md` | Archive of resolved stories. |
