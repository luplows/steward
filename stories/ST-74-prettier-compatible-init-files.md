---
id: ST-74
title: Make init-generated files compatible with default Prettier
tier: normal
kind: product
depends_on: [ST-56]
model: null
blocked: null
---

## Intent

As a crew member installing Steward in a project that checks formatting, I want new
installation files to follow default Prettier formatting, so that adopting Steward does not
immediately fail an ordinary formatting check.

## Acceptance criteria

- [ ] **AC-1** — Every file that `steward init` adds to a fresh project's installation PR
      passes `prettier --check` with a pinned Prettier version and default options. This
      includes `steward.config.json`, all installed workflows (with and without optional
      inspection), the checklist and the PR template. Existing project files remain untouched.
- [ ] **AC-2** — Automated tests use actual files written by `init`, not just template
      source files. They check the added files using the pinned formatter, exercise
      installation with optional inspection enabled and disabled, and fail if formatting
      drifts. These tests do not require a live GitHub repository.
- [ ] **AC-3** — Formatting does not change the parsed settings, workflow triggers,
      permissions, actions, version pins or other functional behavior. Tests cover the
      resulting JSON values and the workflow behavior-sensitive contents.
- [ ] **AC-4** — `README.md` and the generated installation PR body each explain that a
      project may have different formatter settings. Both provide a one-line
      `npx prettier --write` example for files added by the installer, to run in a
      checkout of the installation PR's branch before merging, rather than formatting
      the whole project or the caller's original checkout.
- [ ] **AC-5** — Remove the `**Planned (ST-74)**` marker from
      `docs/agent-workflow-design.md` when the change is implemented.

## Out of scope

- Guaranteeing that default formatting satisfies every project's custom Prettier options.
- Automatically running or installing a formatter in the target project.
- Rewriting pre-existing or customized files; their upgrade path belongs to ST-69.
- Changing the installer's choice of which files to add or its approval workflow.

## Constraints

- The test's formatter version must be pinned and run with default options independently
  of any consuming project's settings.
- No formatter is required for using Steward at runtime.

## Context

- Reported during ST-48 client validation on 2026-11-04: a project's Prettier check rejected
  the generated JSON config and two YAML workflow files. The failing check was observed by
  the crew, not executed by this planning session.
- `scripts/dispatch/init.mjs` uses `JSON.stringify(value, null, 2)` for JSON and copies
  `templates/workflows/` with the release pin substituted.
- `scripts/dispatch/init.test.mjs` tests the generated files, but not formatter compliance.
- This focused first-install work is separate from ST-65's optional install polish and
  ST-69's upgrade of existing installations.

## Open questions

*(none)*
