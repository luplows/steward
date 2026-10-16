---
id: ST-33
title: Review without running tests, with no install before the review and no npm or npx for the reviewer
tier: next
kind: workflow
depends_on: []
model: sonnet
blocked: "Built by hand: changes .claude/prompts/reviewer.md, which a spawned coder session cannot edit (docs/agent-workflow-design.md, A spawned session cannot edit .claude/prompts/)"
---

## Intent

As a member of the crew, I want the reviewer to settle claims by reading, searching and diffing,
and never by running the project's tests, lint or other checks, so that a Claude reviewer and a
Codex reviewer, whose read-only sandbox cannot start a test run, work to the same rules. CI runs
the checks on every pull request as a peer check, so a test that fails still stops the pull
request. Nothing is installed in the review's checkout, and the reviewer is granted no `npm` or
`npx`.

## Acceptance criteria

- [x] **AC-1** — `.claude/prompts/reviewer.md` tells the reviewer not to run the project's tests,
      lint or any other check, a single test file included, and to settle a claim by reading the
      code, searching it (`Grep`, `git grep`) or diffing it. A claim that only a run would settle,
      such as a test passing or a count of tests, is CI's, and the reviewer says in `summary`
      that it left the claim to CI. No instruction or example in the prompt runs a test, a lint or
      `npm`, `npx` or `vitest`; its examples of an allowed pipeline use `git` or the read-only
      shell utilities instead.
- [x] **AC-2** — `reviewPullRequest` (`scripts/dispatch/review.mjs`) installs nothing in the
      review's checkout. Its `install` option, the call to `installDependencies` and its
      `install-failed` result go from `review.mjs`. `coder.mjs` keeps its install.
- [x] **AC-3** — `reviewerAllowedTools()` (`scripts/dispatch/invocation.mjs`) no longer grants
      `Bash(npm:*)` or `Bash(npx:*)`, and still grants `Bash(node:*)`. The comments that give
      running the suite as the reason for `npm`, `npx` and `node` are corrected.
      `scripts/dispatch/review-tools.mjs`, which admits only the reviewer's own command prefixes,
      then admits no `npm` or `npx` command, and its handling of how Windows starts `npm` and
      `npx` goes with them.
- [x] **AC-4** — Tests, named `ST-33/AC-<n>`:
      - `reviewPullRequest` reviews and records a verdict in a checkout that has no
        `package.json`, with no install option given and none run;
      - `reviewerAllowedTools()` contains no `npm` or `npx` entry, and contains `Bash(node:*)`;
      - `review-tools.mjs` refuses `npm test` and `npx vitest run`, starting nothing;
      - the prompt below its `---` contains none of `npm`, `npx` or `vitest`, and says that a
        claim only a run would settle is CI's.
- [x] **AC-5** — `docs/agent-workflow-design.md`: every `**Planned (ST-33)**` marker loses
      `ST-33`, and each passage is corrected wherever what was built differs. That includes
      "Invocation shape", which says the reviewer is granted `npm`, `npx` and `node` "because
      verifying the author's claims means running the suite", and "Credential minimalism", which
      says its allowlist includes `npm` and `node` "so that it can verify the author's claims".

## Out of scope

- Removing `node` from the reviewer's allowlist. The owner kept it on 2026-10-15, for
  `review-tools.mjs` and `node -e`.
- The coder's install, and the project's `setup` command: ST-7, which now prepares the coder's
  checkout only.
- ST-13, which would have let `review-tools.mjs` run a repository script such as
  `node scripts/lint-stories.mjs` to capture its exit code. It was retired on 2026-10-16, since
  its reason, confirming that a check passed, goes with this story.
- A periodic check that the tests test something useful: ST-36.

## Constraints

- Node, ESM, no new runtime dependencies.

## Context

- **Decided on 2026-10-15 by the owner** (design doc, Part 3, "Decided so far", "The reviewer runs
  no checks"): the reviewer runs no tests, so that the two tools work alike; `npm` and `npx` go
  from its allowlist, and `node` stays.
- ST-22 had already narrowed the reviewer to "one test file rather than the whole suite"
  (`reviewer.md`, "Verify rather than accept"), and left the whole run to CI.
- A Codex reviewer runs under `codex exec -s read-only`. Probed on 2026-10-15 (design doc,
  "Trials and measurements", "Codex as reviewer"): Vitest could not start there, since it writes
  `node_modules\.vite-temp`; under `workspace-write` it could, and could also write to `%TEMP%`.
- `review.mjs` runs `install` (default `installDependencies`, `scripts/dispatch/install.mjs`)
  before the first session, and returns `install-failed` when it rejects. Its comment says "A
  reviewer that cannot run a test silently reviews by reading".
- `review-tools.mjs` builds the prefixes it admits from `reviewerAllowedTools()`, leaving out
  `node`, and starts Windows `npm` and `npx` as `execPath` running npm's own CLI.
- The rotation that reviews this story's own pull request runs `main`'s `reviewer.md`, which still
  allows one test file.

## Open questions

*(none)*
