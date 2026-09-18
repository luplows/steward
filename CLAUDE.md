# tower-workshop-paths

## Workflow

Never commit or push directly to `main`. `main` is protected (pull requests required, enforced even for admins) — for every change, create a feature branch, commit there, push it, and open a pull request. Note that agent containers have no `gh` CLI — open and inspect PRs through the GitHub MCP tools where the session has them, and plain `git` plus the REST API where it does not (a spawned session may get neither `gh` nor those tools).

While a PR is still open, address anything that comes up from reviewing that PR's own state (a spotted issue, a follow-up question, a requested tweak) with a new commit on its existing branch, not a new branch/PR. Only start a new branch for genuinely new, unrelated work.

For every change, before opening (or updating) its PR, check whether `README.md`, `Open-Questions.md`, and `Project-Outline.md` need updating as a result — e.g. a resolved open question, a newly-discovered one, a scope/design change, or a shift in what's built vs. not. Include any such doc updates in the same PR as the change that prompted them.

Every PR body uses [`.github/pull_request_template.md`](.github/pull_request_template.md) — **What changed**, **Verification** (the commands actually run and their real results, not a claim that they passed), **Docs check** (the outcome of the paragraph above). Fill all three; an empty section is treated as a missing one. [`REVIEW.md`](REVIEW.md) is the enumerated checklist a PR is reviewed against — read it before opening one.

You do not merge your own PR, and neither does the reviewer. [`.github/workflows/land-approved.yml`](.github/workflows/land-approved.yml) runs on a schedule and lands the oldest open PR that is not a draft, carries no `review-blocked` label, reads `clean` (no conflict, every required check green), and has the `review/agent` commit status reading `success` on its current head SHA. One PR per run, then it stops — GitHub recomputes mergeability asynchronously, so a second merge in the same run would be decided on state read before the first one landed. The branch is deleted automatically; you could not delete it anyway, as the git proxy refuses ref deletion outright (HTTP 403).

This is deliberate, not a convenience. Landing used to be the author's job, but a worker session finishes long before its verdict arrives, so the rule assigned the work to something that no longer existed — #92 sat merge-ready with nobody responsible for noticing.

**Open a PR as a draft if it is not finished, and mark it ready when it is.** The sweep skips drafts, and nothing else distinguishes "passed review" from "done": a non-draft PR that goes green will be landed whether or not you meant to add another commit.

While the `review-blocked` circuit breaker is tripped (see `Open-Questions.md`, OQ-42), the sweep lands only the PR that clears the jam — one carrying a `breaker-override` label, or one whose diff is confined to `.github/workflows/`. Neither exemption skips review: an exempt PR still needs `review/agent` success and green CI. Without them a tripped breaker would be a trap escapable only by admin merge, since nothing else merges PRs.

PRs land on `main` as a single squash commit, so commits within a PR exist only to make review easier, not to build history. One commit is right for most changes. The exception worth splitting: when a change both regenerates data files and alters logic, commit the regeneration separately from the logic so the reviewable part isn't buried in generated churn.

`Completed-Questions.md` is a large archive of resolved stories — bigger than the app's hand-written source. Look things up in it by OQ number (`grep -n 'OQ-37' Completed-Questions.md`) rather than reading it whole.

## Testing

Correctness of the buy-order tool is high priority. CI (`.github/workflows/ci.yml`) runs lint, unit/component tests (Vitest, `npm test`), the build, and functional/E2E tests (Playwright, `npm run test:e2e`, in `e2e/`) on every PR, and is a required status check — a PR cannot merge until it's green. Add tests alongside any new logic, especially the buy-order scoring algorithm (see `Project-Outline.md`) — Vitest for component/unit behavior, Playwright for real user flows through the running app.

Coverage-percentage tooling (e.g. `@vitest/coverage-v8`) is intentionally not set up — by design, not an oversight. Test quality is judged by reviewing what's covered, not a numeric threshold.

Green CI is necessary but no longer sufficient on its own — see the merge rule under **Workflow** for the full bar. The Playwright suite in `e2e/` is the guard for UI behavior, so a PR that changes how the tool behaves should extend it rather than lean on a manual spot-check. Appearance is guarded by the screenshot assertions in `e2e/appearance.spec.js` (OQ-40), whose baselines live in `e2e/__screenshots__/` and are generated on a CI runner by `.github/workflows/update-screenshots.yml` — never locally, so that one renderer owns them. That job mints baselines that don't exist yet; it never rewrites one, so an intentional appearance change means deleting the stale images in your PR (or dispatching that workflow with `mode=all`) and saying in the PR body what changed and why. Per [`REVIEW.md`](REVIEW.md) item 10, a regenerated baseline is never a silent side-effect of getting CI green.
