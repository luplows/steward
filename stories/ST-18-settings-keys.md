---
id: ST-18
title: Read and validate the review side's settings keys
tier: next
kind: workflow
depends_on: []
model: sonnet
blocked: null
---

## Intent

As the owner, I want `steward.config.json` to hold the settings the review side needs, each
checked when it is read, so that the stories that use them can rely on a value being present
and well formed, and a project that leaves one out is told which.

## Acceptance criteria

- [ ] **AC-1** — `readSettings` in `scripts/dispatch/settings.mjs` accepts and returns these
      keys besides `repo` and `storyPrefix`, which are unchanged:
      - `setup` and `check`: each either `null` or an object with exactly the keys `command`
        (a non-empty string) and `timeoutMinutes` (a positive integer);
      - `landWhen`: either the string `"all-checks"` or a non-empty array of distinct,
        non-empty strings;
      - `land`: a boolean;
      - `unitLinks`: an array, possibly empty, of distinct values from `"issue"`, `"file"`
        and `"other"`;
      - `rulesFile`: a non-empty string that is a relative path with forward slashes, neither
        absolute nor containing a `..` segment.
- [ ] **AC-2** — Every key is required. A missing key, an unknown key (top level, or inside a
      `setup` or `check` object), or a value of the wrong form throws an error naming the file
      and the key, with its parent for a nested one (for example `setup.timeoutMinutes`).
      Nothing is defaulted: `readSettings` holds no value of its own for any key.
- [ ] **AC-3** — Steward's own `steward.config.json` gains:
      `"setup": { "command": "npm ci", "timeoutMinutes": 5 }`,
      `"check": { "command": "npm run check", "timeoutMinutes": 10 }`,
      `"landWhen": "all-checks"`, `"land": true`, `"unitLinks": ["file"]` and
      `"rulesFile": "REVIEW.md"`. `package.json` gains a `check` script running lint and then
      Vitest, as CI does.
- [ ] **AC-4** — Tests in `scripts/dispatch/settings.test.mjs` cover, for each new key: a valid
      value read back unchanged, and each invalid form in AC-1 and AC-2 rejected with the key
      named. `null` is accepted for `setup` and for `check`; `[]` is accepted for `unitLinks`.
- [ ] **AC-5** — Every test fixture that writes a `steward.config.json` holds every required key,
      so that the full suite passes. The committed-file test ("OQ-122/AC-2") expects AC-3's
      values.
- [ ] **AC-6** — A new `docs/settings.md` lists every key with its form, what it is for, and
      what `init` will write, and says that an empty `unitLinks` means the project links no
      units. `README.md` and `AGENTS.md`'s "Where things are documented" table each point at it.
- [ ] **AC-7** — The `**Planned (ST-18)**` marker in `docs/agent-workflow-design.md` loses
      `ST-18`, and the passage is corrected wherever what was built differs.

## Out of scope

- Using any new key: `setup` (ST-7), the rules file (ST-20, ST-21), unit links (ST-19, ST-22),
  `land` (ST-23) and `landWhen` (ST-24) each take their key into use in their own story.
- Removing `storyPrefix`, which the queue, the story lint and the coder still read
  (`docs/harness-outline.md`, "Settings").
- Grouping keys beyond the `setup` and `check` objects, and a version field.
- A key for which commands the reviewer and coder may run (later, by the owner's decision).

## Constraints

- Node, ESM, no new runtime dependencies.

## Context

- `docs/harness-outline.md`, "Defining steward", "Settings": the decisions this story builds,
  with the options considered.
- `scripts/dispatch/settings.mjs`: `ALLOWED_KEYS` is `['repo', 'storyPrefix']` today, and its
  header says it "Holds no default for either value".
- Twelve test files mention `steward.config.json` (`grep -rln steward.config.json
  --include=*.test.mjs scripts`, on 2026-10-11): `cli`, `coder`, `land`, `loop`, `queue`,
  `review`, `settings`, `story-containment` and `story` in `scripts/dispatch/`,
  `scripts/lint-stories.test.mjs`, `scripts/no-project-literals.test.mjs` and
  `scripts/report/review-verdicts.test.mjs`. Those that write one write only `repo` and
  `storyPrefix` today; some were made to by the bootstrap's B7b (`docs/steward-bootstrap.md`).
- `package.json` scripts today: `lint` (`oxlint`) and `test` (`vitest run`).

## Open questions

*(none)*
