# tower-workshop-paths

## Workflow

Never commit or push directly to `main`. `main` is protected (pull requests required, enforced even for admins) — for every change, create a feature branch, commit there, push it, and open a pull request (`gh pr create`).

While a PR is still open, address anything that comes up from reviewing that PR's own state (a spotted issue, a follow-up question, a requested tweak) with a new commit on its existing branch, not a new branch/PR. Only start a new branch for genuinely new, unrelated work.

## Testing

Correctness of the buy-order tool is high priority. CI (`.github/workflows/ci.yml`) runs lint, unit/component tests (Vitest, `npm test`), the build, and functional/E2E tests (Playwright, `npm run test:e2e`, in `e2e/`) on every PR, and is a required status check — a PR cannot merge until it's green. Add tests alongside any new logic, especially the buy-order scoring algorithm (see `Project-Outline.md`) — Vitest for component/unit behavior, Playwright for real user flows through the running app.

**TEMPORARY, while the test suite and UI are still being built up:** before merging any PR that touches the running tool's behavior or appearance, the user must visually inspect it (`npm run dev`) — automated tests alone aren't yet sufficient to catch UI/UX issues. Don't merge such a PR until the user confirms they've done this. Docs-only PRs (no app code changes) are exempt — merge those without waiting for approval. Remove this rule entirely once the test suite and UI have matured.
