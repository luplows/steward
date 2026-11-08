---
id: ST-87
title: Migrate a project's own settings between steward versions with versioned migrations
tier: later
kind: product
depends_on: [ST-69]
model: null
blocked: null
---

## Intent

As a member of the crew upgrading steward in a project, I want a change a release makes to
project-owned settings to be applied by a migration written for that release, like a database
schema migration, so that an upgrade can carry settings forward as well as workflows, and each
change is explicit, reviewable and tested.

**This is a draft.** No release has needed a settings migration yet: ST-69's upgrade derives
the workflows from the templates at the two pins and makes only explicit, unambiguous settings
changes. Write this story's criteria when the first release changes `steward.config.json`, the
review checklist's format or the pull request template in a way a project must follow, and use
that change as its first migration.

## Acceptance criteria

- [ ] **AC-1** — Provisional: each release that changes project-owned settings carries a
      migration naming the version it applies to and what it changes, applied by
      `steward upgrade` in version order between the installed pin and the target.
- [ ] **AC-2** — Provisional: a migration that cannot apply cleanly is refused, naming the file
      and the reason, and the upgrade opens no pull request.

## Out of scope

- Workflow files, which ST-69 derives from the templates at the pins.
- Downgrades and rolling a migration back.

## Constraints

*(none)*

## Context

- ST-69, AC-7: an upgrade preserves compatible choices and proposes only explicit, unambiguous
  changes; a substantial migration of project-owned settings is a separate story.
- Crew discussion, 2026-11-07: the owner proposed migrations generated per release, as for a
  database schema. For workflows, the templates at the two pins already say what changes, so a
  migration earns its keep only for project-owned settings.

## Open questions

- Is a migration code in steward's package, a declarative file, or generated from the
  difference between two versions' settings schemas?
- Where are migrations kept so that an upgrade from any older pin finds all of them: in the
  running package, or read from `luplows/steward` at each version as ST-69 reads templates?
- Which release first needs one?
