# tower-workshop-paths

## Workflow

Never commit or push directly to `main`. `main` is protected (pull requests required, enforced even for admins) — for every change, create a feature branch, commit there, push it, and open a pull request. Note that agent containers have no `gh` CLI — open and inspect PRs through the GitHub MCP tools where the session has them, and plain `git` plus the REST API where it does not (a spawned session may get neither `gh` nor those tools).

While a PR is still open, address anything that comes up from reviewing that PR's own state (a spotted issue, a follow-up question, a requested tweak) with a new commit on its existing branch, not a new branch/PR. Only start a new branch for genuinely new, unrelated work.

For every change, before opening (or updating) its PR, check whether `README.md`, `Open-Questions.md`, and `Project-Outline.md` need updating as a result — e.g. a resolved open question, a newly-discovered one, a scope/design change, or a shift in what's built vs. not. Include any such doc updates in the same PR as the change that prompted them.

Every PR body uses [`.github/pull_request_template.md`](.github/pull_request_template.md) — **What changed**, **Verification** (the commands actually run and their real results, not a claim that they passed), **Docs check** (the outcome of the paragraph above). Fill all three; an empty section is treated as a missing one. [`REVIEW.md`](REVIEW.md) is the enumerated checklist a PR is reviewed against — read it before opening one.

Merging is part of the job, not a handoff. When a PR you wrote is ready, squash-merge it yourself — there is no human sign-off step to wait for. The branch is deleted automatically on merge; do not try to delete it yourself, as the git proxy refuses ref deletion outright (HTTP 403). "Ready" means all three of: CI green; the `review/agent` commit status reading `success` **on the PR's current head SHA**; and every review finding either fixed with a new commit or answered on the PR. Read that status yourself before merging rather than trusting the merge button — branch protection is a backstop for the rule, not the rule itself, so a `pending` or `failure` verdict is never mergeable no matter what GitHub lets you click. A verdict whose SHA is not the current head has been reset by a later commit and does not count.

Two things never merge. A reviewer session's entire output is its verdict comment — it does not merge, so that judging a PR and acting on that judgement stay separate hands. And nothing merges while the `review-blocked` circuit breaker is tripped (see `Open-Questions.md`, OQ-42), except the PR that clears the jam.

PRs land on `main` as a single squash commit, so commits within a PR exist only to make review easier, not to build history. One commit is right for most changes. The exception worth splitting: when a change both regenerates data files and alters logic, commit the regeneration separately from the logic so the reviewable part isn't buried in generated churn.

`Completed-Questions.md` is a large archive of resolved stories — bigger than the app's hand-written source. Look things up in it by OQ number (`grep -n 'OQ-37' Completed-Questions.md`) rather than reading it whole.

## Testing

Correctness of the buy-order tool is high priority. CI (`.github/workflows/ci.yml`) runs lint, unit/component tests (Vitest, `npm test`), the build, and functional/E2E tests (Playwright, `npm run test:e2e`, in `e2e/`) on every PR, and is a required status check — a PR cannot merge until it's green. Add tests alongside any new logic, especially the buy-order scoring algorithm (see `Project-Outline.md`) — Vitest for component/unit behavior, Playwright for real user flows through the running app.

Coverage-percentage tooling (e.g. `@vitest/coverage-v8`) is intentionally not set up — by design, not an oversight. Test quality is judged by reviewing what's covered, not a numeric threshold.

Green CI is necessary but no longer sufficient on its own — see the merge rule under **Workflow** for the full bar. The Playwright suite in `e2e/` is the guard for UI behavior, so a PR that changes how the tool behaves should extend it rather than lean on a manual spot-check. Appearance is guarded by the screenshot assertions in `e2e/appearance.spec.js` (OQ-40), whose baselines live in `e2e/__screenshots__/` and are generated on a CI runner by `.github/workflows/update-screenshots.yml` — never locally, so that one renderer owns them. That job mints baselines that don't exist yet; it never rewrites one, so an intentional appearance change means deleting the stale images in your PR (or dispatching that workflow with `mode=all`) and saying in the PR body what changed and why. Per [`REVIEW.md`](REVIEW.md) item 10, a regenerated baseline is never a silent side-effect of getting CI green.
