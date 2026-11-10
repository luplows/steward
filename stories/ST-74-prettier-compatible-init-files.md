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
installation files to follow default Prettier formatting, so that adoption does not fail
ordinary formatting checks or force needless corrections to managed files.

## Acceptance criteria

- [ ] **AC-1** — Every file that `steward init` adds in a fresh project passes
      `prettier --check` with one exact pinned Prettier version and default options,
      independently of any consuming project's formatting configuration. This includes
      `steward.config.json`, each installed workflow (with optional inspection enabled
      and disabled), the installed checklist and the PR template. Files already owned by
      the project are not reformatted.
- [ ] **AC-2** — Automated tests apply the pinned formatter to the actual files
      produced by `init` (after pin substitution), not just the raw templates.
      They cover the optional workflow, both installation paths, and regression when a
      generated artifact drifts from the formatter. The check runs offline and does not
      require Prettier or a configuration file in the client's repository.
- [ ] **AC-3** — Compare the generated artifacts' parsed JSON, workflow triggers,
      permissions, command values and pin references before and after template formatting
      to establish that formatting changes no behavior. The installed artifacts retain
      their expected content and have no unrelated additions.
- [ ] **AC-4** — `README.md` and the generated installation PR explain that a project
      with custom formatting settings may format *only newly installed files* on its
      installation branch before merging, with an example scoped command. Do not claim
      this is required for all projects. Explain that verified formatting-only workflow
      differences are accepted on a future upgrade by ST-96; substantive modifications
      remain subject to refusal.
- [ ] **AC-5** — Keep the pinned formatter version explicit and reproducible in
      Steward's package/lockfile and tests. Do not add a formatter invocation to
      `steward init` or require a client to install one. Do not introduce a
      repository-wide source-formatting requirement as part of this story.
- [ ] **AC-6** — Resolve `**Planned (ST-74)**` in
      `docs/agent-workflow-design.md` when implemented.

## Out of scope

- Matching every consuming project's custom Prettier options.
- Automatically running a formatter inside the project or modifying existing files.
- Relaxing the workflow-upgrade comparison, which is ST-96.
- Formatting all Steward JavaScript, documentation and historical artifacts, or
  turning a repository-wide format check on.

## Constraints

The formatting check uses an exact pinned Prettier version with default options,
regardless of a project's configuration. Client projects do not acquire a
formatter dependency merely by installing Steward.

## Context

- ST-48 client validation, 2026-11-04: generated JSON and YAML did not satisfy a
  project's default formatting check.
- The v0.2.0 upgrade walkthrough found that formatting the installed workflows,
  as earlier documentation advised, then made `upgrade` refuse those files as modified.
  ST-96 owns the necessary backward-compatible upgrade comparison.
- `scripts/dispatch/init.mjs` writes JSON and copies templates with the pin
  filled; `templates/workflows/` and `scripts/dispatch/init.test.mjs` are relevant.
- ST-65 retains optional installation-PR template improvements; ST-97 addresses
  *upgrade* PR template population instead.
- Crew decision, 2026-11-09: adopt pinned default Prettier for generated Steward
  artifacts incrementally. Consider repository-wide formatting later, separately.

## Open questions

*(none)*
