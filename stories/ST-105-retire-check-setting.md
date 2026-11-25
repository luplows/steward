---
id: ST-105
title: Retire the check setting, which nothing runs
tier: normal
kind: product
depends_on: []
model: null
blocked: null
---

## Intent

As a member of the crew setting up a project, I want steward's settings to hold only what steward
uses, so that I am not led to set a `check` command that nothing runs, and so that the coder's
pre-flight check is whatever my project's own instructions name.

## Acceptance criteria

- [ ] **AC-1** — `readSettings` (`scripts/dispatch/settings.mjs`) no longer requires `check`. When
      the file has it, with any value, it is accepted and ignored, and the settings it returns have
      no `check`. Every other key is validated as now, and any other key the file does not allow is
      still refused.
- [ ] **AC-2** — `init` writes no `check` key in the `steward.config.json` it adds
      (`scripts/dispatch/init.mjs`).
- [ ] **AC-3** — `upgrade` makes its first settings change: an entry in `MIGRATIONS`
      (`scripts/dispatch/upgrade.mjs`) that removes `check` from a project's `steward.config.json`
      when it is there, and changes nothing else in the file. Its explanation, in the upgrade
      pull request's body, says that steward no longer reads `check`, and that the project's own
      instructions name the checks a coder runs. An upgrade of a project whose file has no `check`
      makes no settings change.
- [ ] **AC-4** — The docs no longer describe a `check` setting, and say that the coder's pre-flight
      check is what the project's own instructions name (its `AGENTS.md`, `CLAUDE.md`,
      `CONTRIBUTING.md`, `README.md` or `package.json`): `docs/settings.md` (the keys table, the
      "`setup` and `check`" section, the example, and "flat apart from `setup` and `check`"),
      `README.md`'s description of `steward.config.json`, `docs/glossary.md`'s "pre-flight check",
      and the current passages of `docs/outline.md` and `docs/agent-workflow-design.md` that name
      the setting. `docs/settings.md` says that a file with `check` is still accepted, and that
      `upgrade` removes it.
- [ ] **AC-5** — This story's **Planned** markers in `docs/agent-workflow-design.md` are removed,
      and the passages are corrected wherever what was built differs.
- [ ] **AC-6** — Tests, in the existing test files of `settings.mjs`, `init.mjs` and `upgrade.mjs`,
      cover:
      - a file without `check`, and files with `check` as `null`, as a valid command and as an
        invalid value, all accepted with no `check` in the result;
      - an unknown key still refused;
      - `init`'s file having no `check`;
      - `upgrade` removing `check` with its explanation, leaving every other key as it was, `land`
        included;
      - `upgrade` making no settings change when there is no `check`.

## Out of scope

- Running a check from ATC, before or after the push. The coder session runs the pre-flight
  check, and ATC does not run it again (`docs/agent-workflow-design.md`, "The coder session runs
  the pre-flight check").
- Steward's own `steward.config.json`, which keeps `check` for now. Its coordinator, and its
  workflows once ST-82 pins them, run v0.3.0, whose `readSettings` requires the key. Steward's own
  `upgrade` to a release with this story removes it.
- Refusing `check` in a later release, once projects have upgraded past it.
- The `setup` setting, which ST-7 built and the handoff coder uses.

## Constraints

- A project's `steward.config.json` that is valid at v0.3.0 stays valid.

## Context

- Found after the 0.3.0 release (TWP Session A for tower-workshop-paths' owner, 2026-11-25). At
  `v0.3.0` nothing runs `check`. Leaving out test files (15 lines, in 7 of them) and matches of
  the plain word "check", `git grep` of `scripts/` and `.claude/prompts/` finds the setting only
  in `settings.mjs` (lines 29 and 165, validated), `settings-fixture.mjs` and `init.mjs:611`
  (`check: null`). The handoff coder reads `setup` and `rulesFile` only, and its prompt tells the
  coder to run "the project's own checks, as its instructions or its `package.json` or equivalent
  say". `docs/settings.md:25` still calls `check` "the command that checks a change, which the
  coder runs".
- The crew chose (2026-11-25) to retire the setting, not to give it a use: the coder already
  follows the project's own instructions, which is where a project names its checks.
- `MIGRATIONS` in `upgrade.mjs` is the place for an explicit, unambiguous change a release makes
  to a project's settings. It is empty: no release has needed one (ST-97, ST-98).

## Open questions

*(none)*
