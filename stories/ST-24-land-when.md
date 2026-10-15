---
id: ST-24
title: Land when the checks the settings name are green, in both the pilot and the runway
tier: next
kind: workflow
depends_on: [ST-18, ST-23]
model: sonnet
blocked: null
---

## Intent

As a member of the crew, I want the pilot and the runway to merge only once the checks the project's
`landWhen` setting names are green on the head, as well as `review/agent`, so that a project's
own rule for when a pull request may merge is what steward follows, including on a repository
with no branch protection, where GitHub's `mergeable_state` says nothing about required checks.

## Acceptance criteria

- [ ] **AC-1** — A new module, `scripts/land/checks-green.mjs`, exports a pure function that
      takes the head's check runs, its commit statuses and the `landWhen` setting, and returns
      `{ green: true }` or `{ green: false, waiting, failing }`, naming each check that is not
      yet finished and each that failed. It reads:
      - the latest check run of each name, and the latest status of each context;
      - a check run as green when its conclusion is `success`, `neutral` or `skipped`, and a
        status when its state is `success`; anything unfinished is waiting, anything else failing;
      - `review/agent` never, in either direction: the pilot and the runway check it themselves.
      With `"all-checks"`, every other check on the head must be green; with a list, each named
      check must be present and green, and one absent is waiting.
- [ ] **AC-2** — `land.mjs` decides landability with AC-1's function, for the settings'
      `landWhen`, in place of requiring `mergeable_state` to be `clean`. It still requires
      `review/agent` to be `success`, no `review-blocked` label, and not a draft. A
      `mergeable_state` of `dirty` is a conflict, as today. A `mergeable_state` of `blocked` with
      the named checks green means GitHub requires something `landWhen` does not name, and GitHub
      would refuse the merge: the runway is not started, and the result is a distinct
      `github-blocked`, which a later call may try again. With ST-23's `once: true`, that case
      returns `github-blocked` rather than `not-landable`. Its request allowlist gains one read,
      the head's check runs (`GET /repos/<repo>/commits/<sha>/check-runs`), and nothing else.
- [ ] **AC-3** — `land-approved.yml` decides the same way: it reads the head's check runs and
      statuses with `gh api`, and `landWhen` from `steward.config.json` in its checkout of `main`,
      and runs AC-1's function through a script under `scripts/land/` instead of its
      `mergeable_state != clean` test. Its "Belt and braces" check of `review/agent`, and every
      other check it makes, are unchanged.
- [ ] **AC-4** — Tests, named `ST-24/AC-<n>`: AC-1's function for each case (all green; one
      waiting; one failing; a rerun whose latest run is green after a failed one; a named check
      absent; `review/agent` failing while everything else is green, which is green here); and
      `land.mjs`'s landability for each `mergeable_state` with the checks green.
- [ ] **AC-5** — The `**Planned (ST-24)**` marker in `docs/agent-workflow-design.md` loses
      `ST-24`, and "Merging" and "GitHub mechanics" are corrected wherever what was built
      differs.

## Out of scope

- Landing once without waiting, and `land: false`: ST-23.
- Waiting for checks before a review: reviews do not wait (`docs/outline.md`, "Land").
- Branch protection itself, or `init` offering it.

## Constraints

- Node, ESM, no new runtime dependencies.
- The runway still takes no new permission, token or secret.

## Context

- `docs/outline.md`, "Defining steward", "Land" (a project says which checks must pass;
  the default is every check on the head green) and "Settings" (`landWhen`).
- `scripts/dispatch/land.mjs`'s `assess`: `clean` lands, `blocked` and `unknown` wait, `dirty` is
  a conflict.
- `.github/workflows/land-approved.yml`: `if [ "${mergeable_state}" != "clean" ]`, then its
  "Belt and braces" `review/agent` check, then `gh pr merge --match-head-commit`.
- `docs/agent-workflow-design.md`, "GitHub mechanics": `clean` means every required check green;
  `unstable` means only non-required checks failing or pending.
- Each GitHub Actions job is a check run, so `review-gate.yml`'s own jobs are among a head's
  checks: steward PR 1's head had `test` (success), `pending` (success) and `verdict` (skipped)
  besides the `review/agent` status (`gh pr view 1 --json statusCheckRollup`, 2026-10-11).

## Open questions

*(none)*
