# tower-workshop-paths

## Workflow

Never commit or push directly to `main`. `main` is protected (pull requests required, enforced even for admins) — for every change, create a feature branch, commit there, push it, and open a pull request (`gh pr create`).

While a PR is still open, address anything that comes up from reviewing that PR's own state (a spotted issue, a follow-up question, a requested tweak) with a new commit on its existing branch, not a new branch/PR. Only start a new branch for genuinely new, unrelated work.

For every change, before opening (or updating) its PR, check whether `README.md`, `Open-Questions.md`, and `Project-Outline.md` need updating as a result — e.g. a resolved open question, a newly-discovered one, a scope/design change, or a shift in what's built vs. not. Include any such doc updates in the same PR as the change that prompted them.

## Testing

Correctness of the buy-order tool is high priority. CI (`.github/workflows/ci.yml`) runs lint, unit/component tests (Vitest, `npm test`), the build, and functional/E2E tests (Playwright, `npm run test:e2e`, in `e2e/`) on every PR, and is a required status check — a PR cannot merge until it's green. Add tests alongside any new logic, especially the buy-order scoring algorithm (see `Project-Outline.md`) — Vitest for component/unit behavior, Playwright for real user flows through the running app.

Coverage-percentage tooling (e.g. `@vitest/coverage-v8`) is intentionally not set up — by design, not an oversight. Test quality is judged by reviewing what's covered, not a numeric threshold.

**TEMPORARY, while the test suite and UI are still being built up:** before merging any PR that touches the running tool's behavior or appearance, the user must visually inspect it (`npm run dev`) — automated tests alone aren't yet sufficient to catch UI/UX issues. Don't merge such a PR until the user confirms they've done this. Docs-only PRs (no app code changes) are exempt from this visual-inspection wait: once CI is green, merge them yourself right away — don't hold them open for a separate merge confirmation. Remove this rule entirely once the test suite and UI have matured.
