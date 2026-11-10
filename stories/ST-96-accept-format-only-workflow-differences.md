---
id: ST-96
title: Accept formatting-only changes to managed workflows during upgrade
tier: normal
kind: product
depends_on: [ST-69]
model: null
blocked: null
---

## Intent

As a crew member upgrading Steward in a project that formatted its installed
workflows, I want `upgrade` to accept differences that can be proved formatting-only,
while still refusing modifications that Steward would otherwise overwrite.

## Acceptance criteria

- [ ] **AC-1** — When comparing an installed managed YAML workflow with the
      template at its installed pin, `upgrade` accepts the workflow if both files,
      after the existing pin normalization, produce identical output from the same
      exact pinned version of Prettier's YAML formatter with explicit default options.
      Both files must parse successfully; use no configuration from the client.
      Existing exact-text and line-ending-only matches remain accepted.
- [ ] **AC-2** — If either input cannot be formatted, or the normalized results
      differ, `upgrade` continues refusing to replace the installed workflow
      before cloning, pushing or opening a PR, identifying the affected file.
      Modified triggers, permissions, commands, expressions, nonformatting comments,
      added or removed entries, and alternative repositories in pin references
      do not become acceptable merely because YAML parses.
- [ ] **AC-3** — The shared workflow identity check used by `init` also recognizes
      proven formatting-only differences without losing its existing distinction
      between managed and project-modified workflows. Neither command rewrites
      existing client workflows as a side effect of comparing them. An accepted
      upgrade still proposes the *target-pin* Steward template, not a merge of
      the project's formatting into the target template.
- [ ] **AC-4** — Offline tests using the actual Steward workflow fixtures exercise
      Prettier-induced quote, indentation and line-break changes, including
      previously installed workflows, and refusals for representative functional,
      comment and repository-reference differences and malformed YAML. The tests
      exercise `upgrade` as well as the shared comparator and `init`'s detection;
      they verify that a refused upgrade creates no branch, push or PR.
- [ ] **AC-5** — The exact pinned formatter version is installed as a Steward
      runtime dependency when needed by `upgrade`, and is available under the
      supported `npx --package=github:luplows/steward#...` invocation. Document
      the version-independent comparison rule and continued refusal of unproven
      differences. No formatter installation or configuration is required in
      a consuming project.
- [ ] **AC-6** — Resolve `**Planned (ST-96)**` in
      `docs/agent-workflow-design.md` when implemented.

## Out of scope

- Accepting arbitrary YAML semantic equivalence or parsing away comments,
  key order or shell-script differences.
- Automatically repairing customized workflows, applying project-specific
  formatting rules, or installing a formatter into a client repository.
- Changing the managed workflow set, version-pin validation, downgrade refusal
  or upgrade's crew-approval boundary.
- Formatting `init` output (ST-74), generated PR evidence (ST-97) or richer
  refusal messages (ST-98).

## Constraints

The threat model is the ordinary project's own formatter changing YAML presentation
without changing the commands or settings in a managed workflow. Unknown or
unparseable differences fail closed. One exact formatter version and fixed options
must be used for both comparison inputs; a project's `.prettierrc` must never
change the acceptance rule.

## Context

- `scripts/dispatch/workflow-text.mjs`: `sameWorkflowApartFromPin`
  currently ignores pin and line-ending changes only, and is used by both
  `scripts/dispatch/init.mjs` and `scripts/dispatch/upgrade.mjs`.
- ST-79 and ST-69 established strict managed-workflow ownership checks;
  this story preserves their substantive protection.
- During the v0.2.0 rollout, formatting the installed workflow's single
  quotes to double quotes caused `upgrade` to refuse it. No code from the
  consuming project is needed to reproduce that formatting class.
- ST-74 standardizes newly generated artifacts; this story must work for
  installations created *before* ST-74 lands.
- Crew decision, 2026-11-09: accept formatting-only differences, keep
  rejecting changes that cannot be proved formatting-only. Considered and
  rejected: YAML object equivalence without comments or key order, and an
  unconditional ignore of whitespace or quote changes.

## Open questions

*(none)*
