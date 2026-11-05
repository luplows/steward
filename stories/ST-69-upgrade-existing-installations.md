---
id: ST-69
title: Upgrade an existing Steward installation to a newer release
tier: next
kind: product
depends_on: [ST-56, ST-78]
model: null
blocked: null
---

## Intent

As a member of the crew using steward in an existing project, I want a mostly automatic upgrade from v0.1.0 to v0.2.0 through a reviewable pull request, so I can adopt improvements without reinstalling or losing project choices.

## Acceptance criteria

- [ ] **AC-1** — `steward upgrade --to v0.2.0` prepares a draft pull request targeting the project's `main`, reporting its URL. It does not merge or mark ready, change protection, activate the project, start or stop the coordinator, or authorize coding.
- [ ] **AC-2** — Identify the installed version from managed workflow references on `main`. For the supported v0.1.0 installation, propose v0.2.0. Missing, inconsistent or unrecognized references cause refusal naming the findings; a consistent v0.2.0 installation is a reported no-op with no PR.
- [ ] **AC-3** — Compare installed Steward-managed workflow files with the corresponding v0.1.0 templates allowing only version-pin substitution. Customized managed files cause refusal naming each file and explaining manual reconciliation, without silently replacing or attempting a general merge.
- [ ] **AC-4** — Propose v0.2.0 managed workflows and pins, preserving which optional workflows were installed. Tests inspect resulting workflow contents and references. Do not change unrelated project files.
- [ ] **AC-5** — Inspect `steward.config.json` and its configured review-rules file from `main`. Preserve compatible choices; propose only target-release changes established by explicit, unambiguous migration rules, explaining each project-owned edit. Where a project-policy decision is required, report it without guessing.
- [ ] **AC-6** — Validate the proposed result against the target release's applicable settings requirements and ST-78's review-rule parser before claiming the upgrade is ready for crew consideration. An invalid result identifies the affected file and reason and is not reported as validated.
- [ ] **AC-7** — The draft PR names source and target versions, changed managed files, any justified project-owned changes, validation outcome, unresolved actions and manual post-merge steps; it makes no claim the project was already upgraded.
- [ ] **AC-8** — On failed preparation report any remaining branch, clone or PR and how to recover. Tests cover a no-op, inconsistent pins, customized workflows, invalid proposed rules and a failed preparation; do not claim rollback without evidence.
- [ ] **AC-9** — Document the bounded v0.1.0-to-v0.2.0 process, approval and effective-pin verification, and any *manual* coordinator stop/restart required. The command never changes local coordinator or per-user state.
- [ ] **AC-10** — Resolve the `**Planned (ST-69)**` marker in `docs/agent-workflow-design.md` in the implementing PR, correcting the design passage if necessary.

## Out of scope

- Arbitrary historical upgrades, downgrades, general migration engines, automatic rollback or conflict resolution.
- Automatic approval, merge, local activation, coordinator lifecycle changes or authorization to code.
- Arbitrary Git configurations, concurrent upgrade processes and mid-preparation external edits.
- Changing the client's unit conventions or planning artifacts.
- ST-65's first-install conveniences, ST-73's release stabilization and ST-74's fresh-install formatting.
- Repairing the initial installation/protection/activation checklist defect (ST-78).

## Constraints

- Changes enter a client through a crew-reviewed PR, never a direct push to `main`.
- Managed workflow files may be updated when unmodified. Project configuration and review rules are project-owned but may be read and receive explicitly justified, deterministic proposed edits.
- The bounded threat model is one crew member running an upgrade from an ordinary checkout without a concurrent modifying process. Do not promise broader Git safety.

## Context

- Crew decision, 2026-11-04: target an automatic but reviewable 0.1-to-0.2 upgrade, refusing customized managed workflows and disagreeing pins; leave coordinator follow-up manual; validate the proposed result.
- ST-44 and ST-56 establish initial installation and its draft PR. Repeating `init` does not repin installed workflows.
- ST-65, ST-73 and ST-74 cover first-install convenience, release-version preparation and fresh-install formatting respectively; avoid overlapping those stories.
- ST-78 provides shared review-rule validation; ST-48 records installation validation evidence.
- `templates/workflows/`, `scripts/dispatch/init.mjs` and `docs/release-review.md` supply the existing installed-workflow and release context.

## Open questions

- Before dispatch, inspect the final v0.1.0 artifact and specify the exact managed file set and pin comparison that defines a supported installation.
- If v0.2.0 requires substantial migration of project-owned configuration, decide whether to separate that migration rather than expanding this story.
