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

- [ ] **AC-1** — An installed managed YAML workflow still matches the
      template at its installed pin when only the pin or line endings differ.
      Otherwise, `upgrade` uses a deterministic comparison in Steward's own
      code, of a *bounded, explicitly documented* set of presentation-only
      YAML transformations. It accepts transformations only when the underlying
      YAML scalar values, keys, comments (including order), block-scalar content,
      GitHub expressions, command text and permissions remain unchanged. For
      example, it may recognize equivalent single- and double-quoted YAML
      scalar values with escaping handled correctly. It does not invoke Prettier
      or read a client's formatting configuration.
- [ ] **AC-2** — If the fallback comparison cannot prove that a difference
      is among its supported presentation-only transformations, `upgrade`
      refuses to replace the workflow before cloning, pushing or opening a PR
      and identifies the file. Unsupported or malformed YAML, modified triggers,
      permissions, commands, expressions or comments, added or removed entries,
      and changed repositories in pin references cannot be accepted merely
      because their YAML syntax parses.
- [ ] **AC-3** — The shared workflow identity check used by `init` also recognizes
      proven formatting-only differences without losing its existing distinction
      between managed and project-modified workflows. Neither command rewrites
      existing client workflows as a side effect of comparing them. An accepted
      upgrade still proposes the *target-pin* Steward template, not a merge of
      the project's formatting into the target template.
- [ ] **AC-4** — Steward's own offline CI tests run one exactly pinned
      Prettier *development dependency* with default YAML formatting options
      against the current managed workflow templates and the managed templates
      at each release tag (at least `v0.1.0` and `v0.2.0`). The tests prove
      that the runtime comparator accepts each resulting formatting-only
      variant, including relevant
      quotes, indentation and line wrapping, while refusing representative
      functional changes, altered comments, other-repository references,
      malformed and unsupported differences. Exercise the shared comparator,
      `init` recognition and `upgrade` preflight, and prove refused upgrades
      make no branch, push or PR. These tests never run in a client command.
- [ ] **AC-5** — Prettier is an exact pinned `devDependency` of Steward
      only; neither `init` nor `upgrade` nor any other client command imports,
      executes or depends on it, including when installed with
      `npx --package=github:luplows/steward#...`. Implement the comparison
      using Steward's own code without adding a new runtime package. Document
      the supported transformation set, the fail-closed boundary and the
      build/test-only role of Prettier. No client project must configure or
      install a formatter.
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

The threat model is ordinary formatting changes to Steward-managed workflows,
not arbitrary YAML equivalence. The runtime comparison accepts only recognized,
tested presentation transformations; unsupported changes fail closed. Steward
uses one pinned default Prettier version as a development test oracle, not in
client commands. A client's `.prettierrc` cannot change the acceptance rule.

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
- Crew decision, 2026-11-09; refined after PR #151 review, 2026-11-10:
  accept only proven formatting-only differences; refuse others. Prettier is
  a build/test-time dev dependency only because every client gate, runway and
  inspection invocation installs Steward via `npx --package=github:luplows/steward#...`,
  and a runtime dependency would burden all of those commands. Considered and
  rejected: runtime Prettier, parsed-YAML equivalence that drops comments or
  key order, and unconditional whitespace or quote normalization.

## Open questions

*(none)*
