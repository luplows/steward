# tower-workshop-paths

## Workflow

Never commit or push directly to `main`. `main` is protected (pull requests required, enforced even for admins) — for every change, create a feature branch, commit there, push it, and open a pull request (`gh pr create`).

## Testing

Correctness of the buy-order tool is high priority. CI (`.github/workflows/ci.yml`) runs lint, tests (Vitest), and the build on every PR, and is a required status check — a PR cannot merge until it's green. Add tests alongside any new logic, especially the buy-order scoring algorithm (see `Project-Outline.md`).
