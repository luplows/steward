# tower-workshop-paths

## Workflow

Never commit or push directly to `main`. `main` is protected (pull requests required, enforced even for admins) — for every change, create a feature branch, commit there, push it, and open a pull request (`gh pr create`).

While a PR is still open, address anything that comes up from reviewing that PR's own state (a spotted issue, a follow-up question, a requested tweak) with a new commit on its existing branch, not a new branch/PR. Only start a new branch for genuinely new, unrelated work.

For every change, before opening (or updating) its PR, check whether `README.md`, `Open-Questions.md`, and `Project-Outline.md` need updating as a result — e.g. a resolved open question, a newly-discovered one, a scope/design change, or a shift in what's built vs. not. Include any such doc updates in the same PR as the change that prompted them.

PRs land on `main` as a single squash commit, so commits within a PR exist only to make review easier, not to build history. One commit is right for most changes. The exception worth splitting: when a change both regenerates data files and alters logic, commit the regeneration separately from the logic so the reviewable part isn't buried in generated churn.

`Completed-Questions.md` is a large archive of resolved stories — bigger than the app's hand-written source. Look things up in it by OQ number (`grep -n 'OQ-37' Completed-Questions.md`) rather than reading it whole.

## Testing

Correctness of the buy-order tool is high priority. CI (`.github/workflows/ci.yml`) runs lint, unit/component tests (Vitest, `npm test`), the build, and functional/E2E tests (Playwright, `npm run test:e2e`, in `e2e/`) on every PR, and is a required status check — a PR cannot merge until it's green. Add tests alongside any new logic, especially the buy-order scoring algorithm (see `Project-Outline.md`) — Vitest for component/unit behavior, Playwright for real user flows through the running app.

Coverage-percentage tooling (e.g. `@vitest/coverage-v8`) is intentionally not set up — by design, not an oversight. Test quality is judged by reviewing what's covered, not a numeric threshold.

A PR is ready to merge as soon as CI is green — there is no separate human sign-off step. The Playwright suite in `e2e/` is the guard for UI behavior, so a PR that changes how the tool behaves should extend it rather than lean on a manual spot-check. Nothing currently guards *appearance* — there are no visual-regression snapshots — so review layout and styling changes with that in mind.
