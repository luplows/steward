---
id: ST-63
title: Consolidate per-user configuration and add coordinator scan cadence
tier: next
kind: workflow
depends_on: []
model: null
blocked: null
---

## Intent

As a developer running Steward locally, I want one clearly named per-user configuration file for model choices, usage limits and coordinator options, so that automatic-review settings fit the existing configuration model without mixing operational state into editable settings.

## Acceptance criteria

- [x] **AC-1** — The canonical per-OS-user configuration is `<homedir>/.steward/config.json`, overridden only by a nonempty `STEWARD_CONFIG` path. The old `~/.steward/settings.json` and `STEWARD_SETTINGS` are no longer read or preferred; no automatic migration or fallback occurs. A missing selected file fails explicitly, naming the new path rather than silently accepting the old file. Tests cover default home resolution, environment override, both legacy inputs present, and a missing canonical file. The invoking user's home is used on Unix and Windows without requiring administrator privileges.

- [x] **AC-2** — Rename the per-user reader/module and its exported path/read APIs from “machine settings” to “user config” (`scripts/dispatch/user-config.mjs`, `userConfigPath`, `readUserConfig`). Update all current runtime consumers, injectable test seams, fixtures and imports—including reviewer, coder and retry paths—to read the new location. Preserve the existing validated meaning and selection behavior of `usageLimits`, `roles`, optional `tools`, model/effort choices, tool paths and per-tool usage refusals; no reviewer, coder, or landing authorization semantics change. Tests demonstrate equivalent choice and budget behavior before and after the rename.

- [x] **AC-3** — The validated JSON permits an optional top-level `coordinator` object alongside required `usageLimits` and `roles` and optional `tools`. If absent, the parsed configuration supplies `coordinator.scanIntervalMinutes: 15`; if present, `coordinator` has exactly one required key, `scanIntervalMinutes`, whose value is a positive JSON integer. There is **no product-imposed upper bound** (in particular no 60-minute cap): refuse only invalid or nonrepresentable values, including numbers for which conversion to milliseconds is not a safe integer. Reject unknown nested/top-level keys, zero, negatives, fractions, booleans and malformed objects with a path-and-key-specific error. Tests exercise 1, 15 and large multi-day intervals as well as refusal cases.

- [x] **AC-4** — A missing or invalid entire user configuration still fails closed for existing manual reviewer/coder calls; the default in AC-3 applies **only to the absent coordinator section of an otherwise valid file**. Reading configuration creates no activation record, coordinator ownership, review reservation or other runtime state. Future activation, recovery and cursor data stay in separate per-user state storage (planned under `~/.steward/state/`), never in `config.json`. Tests show no implicit activation or state write from parsing a valid configuration.

- [x] **AC-5** — The user config reader returns the effective scan interval to callers but implements **no scan loop, daemon, automatic reviewer, runtime config watcher or mutation command**. A subsequent read observes a valid file edit; the coordinator (ST-61) will apply the value at its next safe start, without requiring this story to implement ST-58's lifecycle. Tests verify the two distinct reads and that reading configuration alone starts no session. Editing by hand is sufficient for this story; a convenience `coordinator config set` command is not a prerequisite for 0.1.

- [x] **AC-6** — Replace the active machine-settings reference documentation with `docs/user-config.md`, update active links and terminology in `README.md`, `docs/glossary.md`, relevant dispatch documentation and current examples, and explain the **breaking local rename** and manual file/environment update for existing Steward developers. Keep the project's `steward.config.json` unchanged and distinctly documented. Preserve the historical ST-34 decision as history with a dated revision, rather than silently rewriting it. The implementing PR resolves its **Planned (ST-63)** marker in the design of record.

## Out of scope

- Automatic migration, dual-path reads, deprecated aliases or compatibility fallbacks for the old per-user settings file or environment variable.
- Adding or editing activated-project records, work reservations, recovery journals, coordinator ownership or scheduling cursors (ST-57, ST-58, ST-52 and ST-60).
- Scheduling, round-robin review, scan interval timers, dynamic live reload and a configuration-editing CLI (ST-61 or later).
- Changes to project `steward.config.json`, authorization, reviewer usage limits, chosen models or the existing GitHub gate.
- Adaptive retry/backoff and shared emergency stop.

## Constraints

- Configuration belongs to one OS user, not to the whole machine across accounts. A config override applies only to the invoking process and never authorizes coordinator activation.
- Missing/invalid required role and usage settings still refuse the operation. Numeric validation must not permit a timer conversion overflow.
- This is intentionally a breaking rename before client adoption; documentation must distinguish it from a claim that deployed installations were migrated.

## Context

- `scripts/dispatch/machine-settings.mjs` currently reads `STEWARD_SETTINGS` or `~/.steward/settings.json`, validates `usageLimits`, `roles` and optional `tools`, and exports `machineSettingsPath`, `readMachineSettings` and `coderChoice`.
- `docs/machine-settings.md`, `README.md`, `docs/glossary.md` and the design of record describe the existing interface. ST-34 in `stories/done/` records why role and budget settings belong outside project settings.
- ST-57–59 are being planned in draft PR #93. ST-57's path-specific mention of the old strict settings file and ST-58's “machine settings” terminology must be reconciled before those stories are implemented. The config rename is independent of the coordinator but should land before its scheduling work.
- ST-61 is the separate planned fair scheduler. Its 15-minute default and configurable positive integer scan interval are crew decisions; it should depend on this configuration contract. Automatic retry/backoff is not part of this story.
- Crew decision, 2026-10-27: no client deployments need migration; prefer the clearer per-user name, one editable config file and separate operational state. Suggested size: medium because existing manual command readers and documentation must all move together.

## Open questions

*(none)*
