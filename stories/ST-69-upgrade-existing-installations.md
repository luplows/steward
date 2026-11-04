---
id: ST-69
title: Upgrade an existing Steward installation to a newer release
tier: next
kind: product
depends_on: [ST-56]
model: null
blocked: null
---

## Intent

As a member of the crew using Steward in an existing project, I want a deliberate way to upgrade
its installed Steward integration to a newer release, so that I can take improvements without
reinstalling from scratch or silently replacing the project's own choices.

## Acceptance criteria

Provisional only. This is a starter draft for 0.2, not a dispatchable implementation contract.
Refine or split it after the Open questions are resolved.

- [ ] **AC-1** — Placeholder: define an observable upgrade from an existing pinned Steward
      installation to a specifically selected newer release, including how the crew sees and
      approves every project change before it takes effect.
- [ ] **AC-2** — Placeholder: define and test the handling of existing configuration, checklists,
      workflow files and other project-owned changes, including clear refusals and recovery steps
      when an upgrade cannot be completed safely.
- [ ] **AC-3** — Placeholder: document the supported starting versions, upgrade procedure and
      verification of the effective installed version; make the release's required project actions
      clear.

## Out of scope

- Building upgrade support for 0.1.0; the first release uses the current installation path.
- Changing a project's unit conventions or rewriting its planning artifacts.
- Implicitly activating a project, starting the coordinator or enabling unattended landing.
- ST-65's optional first-install polish (clone removal, PR title/body customization and rerun
  conveniences), unless the crew explicitly finds a shared requirement while refining.

## Constraints

- Keep installation and local activation separate, and preserve the crew's authority over
  project changes and landing.
- Scope the eventual safety acceptance criteria to the supported upgrade workflow and threat
  model, rather than promising safe migration under every Git or concurrent-process setup.

## Context

- Crew proposal, 2026-11-03: prioritize a usable upgrade path during the 0.2 milestone. Its
  behavior and final 0.2 inclusion remain to be agreed; this draft does not authorize coding.
- `scripts/dispatch/init.mjs` (ST-56) creates a reviewable installation pull request and only
  adds missing files. Running it again does not replace existing pinned workflows or a project's
  `steward.config.json` and checklist, so it is not an upgrade mechanism.
- `templates/workflows/` contains the thin GitHub workflows whose Steward version references are
  filled during installation. `docs/release-review.md` requires release notes to record actions
  a project must take when moving to a new tag.
- ST-65 (`stories/ST-65-init-follow-ups.md`) holds first-install conveniences proposed for 0.2.
  This story concerns *already installed* projects and should be checked for overlap with ST-65
  before either story is dispatched.
- `docs/outline.md`, "0.2.0 — Automated coding vertical slice", is the current milestone
  definition; placing upgrade work alongside it is a proposal, not yet an amendment to the
  design of record.

## Open questions

- What is the smallest supported 0.2 upgrade: move the thin workflow pins from v0.1.0 to v0.2.0
  only, or also update installed templates, settings or local configuration?
- How does the crew request and approve an upgrade: a new command, an `init` mode, or a documented
  procedure that opens a reviewable pull request? What is the expected branch and PR behavior?
- How are customized checklists, existing or edited workflow files, pull request templates and
  project configuration preserved or selectively updated? When should the upgrade refuse?
- Which source versions and target references are supported, and how is the installed version
  identified when workflow pins disagree or an installation is partial?
- Do local coordinator state, active projects or user configuration require migration or an
  explicit stop/restart, or are they independent of upgrading the project integration?
- What should verification and recovery cover: first upgrade from 0.1.0, idempotent rerun,
  interrupted attempt, partial install, rollback and both issue/file-unit projects?
- Is this one implementable story or should it be split into a reviewable workflow-pin upgrade
  followed by additional migration work? Confirm its place within the 0.2 milestone.
