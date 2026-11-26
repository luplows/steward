---
id: ST-110
title: Ignore a settings key steward does not know
tier: normal
kind: product
depends_on: []
model: null
blocked: null
---

## Intent

As a member of the crew, I want steward to read a project's `steward.config.json` that has a key
it does not know, so that a release can add a setting without breaking every steward that runs at
an older release, such as the one coordinator that serves all my projects.

## Acceptance criteria

- [x] **AC-1** — `readSettings` (`scripts/dispatch/settings.mjs`) accepts a file with a top-level
      key it does not know, and ignores the key: the settings it returns hold only the keys it
      knows. It no longer refuses an unknown key.
- [x] **AC-2** — The same holds inside `setup`: an unknown key there is accepted and ignored
      (`validateCommand`).
- [x] **AC-3** — `RETIRED_KEYS` is removed, since `check` is now an unknown key like any other.
      A file with `check` is still accepted and the settings have no `check`, as ST-105 made them,
      and `upgrade`'s migration `ST-105-remove-check` still removes it.
- [x] **AC-4** — Every key `readSettings` knows is still required, and is still validated as now:
      a missing key and a value of the wrong form are each refused, naming the file and the key.
- [x] **AC-5** — The docs say what is valid now:
      - `docs/settings.md`'s list at the top: an unknown key is ignored, not an error; the
        bullet about `check` says it is ignored as any unknown key is; and `usageLimits` in this
        file is ignored, not refused.
      - `docs/settings.md`'s bullet "A key that becomes required breaks a project until it adds
        the key" adds the order an upgrade then takes: each project upgrades to the release first,
        while the coordinator still runs the older one, which ignores the new key; the coordinator
        moves to the new release after.
      - `docs/outline.md`, "Settings" ("a missing or unknown key is an error"), says that a
        missing key is an error and an unknown key is ignored, with the crew's decision of
        2026-11-25.
      - `docs/agent-workflow-design.md`'s one passage that says an unknown key is refused, on
        `storyPrefix` ("is refused as an unknown key"), is corrected.
- [x] **AC-6** — This story's **Planned** marker in `docs/agent-workflow-design.md`, "Settings"
      ("An unknown key is ignored"), is removed, and the passage is corrected wherever what was
      built differs.
- [x] **AC-7** — Tests, in `scripts/dispatch/settings.test.mjs`, replace each test that expects an
      unknown key to be refused, and each asserts the file is read and the key is not in the
      settings returned. They are "OQ-135/AC-3 - throws naming the file and the problem when an
      extra key is present", "ST-105/AC-1: a file without check is accepted, and an unknown key is
      still refused", "ST-18/AC-2: an unknown top-level key names the file and the key",
      "ST-18/AC-2: an unknown key inside %s names its parent", "ST-34/AC-3: refuses usageLimits as
      an unknown key" and "ST-41/AC-1: refuses storyPrefix as an unknown key, naming it". The
      tests of a missing key and of a value of the wrong form stay as they are.

## Out of scope

- A warning or report naming an ignored key. A misspelled key still shows, since every key is
  required: the file then lacks the key it meant, and that is refused.
- The user config (`scripts/dispatch/user-config.mjs`) and `stories/stories.json`
  (`scripts/dispatch/story-prefix.mjs`). Each is read only by the steward on the machine that holds
  it, so no older release reads a newer file.
- Optional keys, or defaults in steward's code. Every key steward knows stays required.
- Changing ST-107. Its key is required by the release that has it, and this story is what lets an
  older coordinator read a project that has it.

## Constraints

- Every key of `steward.config.json` is required, with no default in the code
  (`docs/settings.md`).

## Context

- The crew decided on 2026-11-25 that the settings reader ignores an unknown key, in place of the
  owner's decision of 2026-10-11 that an unknown key is an error (`docs/outline.md`, "Settings").
- Why: one coordinator serves every project on the machine, at one release, and reads each
  project's settings from `main` before it reviews a pull request (`executeReview`,
  `scripts/dispatch/review.mjs`) or lands one (`landSettings`,
  `scripts/dispatch/coordinator-scheduler.mjs`, which lands nothing for a project whose settings
  it cannot read). A release that adds a required key, such as ST-107's `protectedPaths`, is then
  read by no coordinator: an older one refuses the new key, and a newer one refuses a project that
  lacks it, that project's own upgrade pull request included. With this story in the older
  release, projects upgrade first and the coordinator after.
- This does not help the step from `v0.3.0`, whose reader refuses an unknown key: a key added in
  the same release as this story still meets the problem. So this story lands in a release before
  any release that adds a key, ST-107's included.
- Unknown keys are refused today at `settings.mjs` in `readSettings` (the loop over
  `ALLOWED_KEYS`) and in `validateCommand` (the loop over `COMMAND_KEYS`).

## Open questions

*(none)*
