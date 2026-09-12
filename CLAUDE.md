# tower-workshop-paths

## Workflow

Never commit or push directly to `main`. `main` is protected (pull requests required, enforced even for admins) — for every change, create a feature branch, commit there, push it, and open a pull request (`gh pr create`).

## Testing

Correctness of the buy-order tool is high priority. CI (`.github/workflows/ci.yml`) runs lint, tests (Vitest), and the build on every PR, and is a required status check — a PR cannot merge until it's green. Add tests alongside any new logic, especially the buy-order scoring algorithm (see `Project-Outline.md`).

**TEMPORARY, while the test suite and UI are still being built up:** before merging any PR, the user must visually inspect the running tool (`npm run dev`) — automated tests alone aren't yet sufficient to catch UI/UX issues. Don't merge a PR until the user confirms they've done this. Remove this rule once the test suite and UI have matured.
