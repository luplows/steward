---
id: ST-70
title: Hide Windows console windows during automatic reviews
tier: fix
kind: product
depends_on: [ST-61]
model: null
blocked: null
---

## Intent

As a crew member running Steward's coordinator on Windows, I want automatic reviews to run
without flashing console windows on my desktop, so that unattended review is unobtrusive.

## Acceptance criteria

- [ ] **AC-1** — Each of these four direct subprocess calls used by coordinator-managed review
      supplies `windowsHide: true` in its Node child-process options: `gh auth token` in
      `scripts/dispatch/github.mjs`; the Git helper in `scripts/dispatch/review.mjs`; the
      `git show` call in `scripts/dispatch/rules.mjs`; and the Git helper that reads file
      units in `scripts/dispatch/unit.mjs`.
- [ ] **AC-2** — Regression tests exercise the options passed at all four sites, including a
      file-unit read and GitHub token retrieval, and fail if `windowsHide: true` is missing.
      These tests do not require a live GitHub repository or model session.
- [ ] **AC-3** — Each changed call still invokes the same command with the same arguments,
      working directory and output/error handling. The fix changes process-window visibility,
      not review eligibility, verdict content, tool choice, or credentials.

## Out of scope

- Making console windows created by the external reviewer or by its descendants invisible.
- Changing manual terminal commands' behavior or adding a global child-process wrapper.
- Changing `scripts/dispatch/init.mjs`'s synchronous Git helper: importing that module from
  `project.mjs` does not mean the coordinator calls this helper. The scheduler's owned-checkout
  update already uses `windowsHide: true`.
- Changing coordinator startup, process lifetime, recovery, or stop behavior.

## Constraints

- The supported case is one OS user running one detached coordinator on Windows, as in 0.1.
  The scope is direct child processes Steward starts during automatic review, not arbitrary
  external processes or competing coordinators.

## Context

- Reported during the 2026-11-04 `release/v0.1.0` scratch walkthrough on Windows:
  visible console windows flashed while the coordinator reviewed pull requests. The crew chose
  to repair that behavior for 0.1 before tagging. This report is an observation, not a test
  performed by this planning PR.
- `scripts/dispatch/coordinator.mjs` launches its detached Node process with
  `windowsHide: true`; `scripts/dispatch/coordinator-scheduler.mjs` invokes the review through
  `scripts/dispatch/review-work.mjs` and `scripts/dispatch/review.mjs`.
- `scripts/dispatch/github.mjs`, `review.mjs`, `rules.mjs` and `unit.mjs` have the
  child-process sites named in AC-1.
- `scripts/dispatch/spawn.mjs`, `codex.mjs`, `usage.mjs`, `review-tools.mjs` and
  `project.mjs` already use `windowsHide: true` in their relevant launch paths.
- After implementation reaches the release branch, the release review should observe a
  real Windows coordinator scan and review again; that is release acceptance evidence, not
  an assertion a code diff alone can prove.

## Open questions

*(none)*
