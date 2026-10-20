---
id: ST-41
title: Move the story prefix out of steward's settings, into the story convention's own stories/stories.json
tier: next
kind: workflow
depends_on: []
model: null
blocked: null
---

## Intent

As a member of the crew of a project that installs steward, I want `steward.config.json` to hold
nothing about how steward's own stories are numbered, so that a project with no story files has no
key for them, and steward's core does not depend on how a project formats its units. The prefix
belongs to the story convention, so it lives in a file of that convention's own.

## Acceptance criteria

- [ ] **AC-1** — `storyPrefix` is no longer a key of the settings: `readSettings`
      (`scripts/dispatch/settings.mjs`) drops it from `ALLOWED_KEYS`, refuses a file that holds it
      as an unknown key, naming it, as for any other unknown key, and returns no `storyPrefix`.
      `STORY_PREFIX_RE` goes from `settings.mjs`. Tests in `settings.test.mjs`: a file with every
      other key and no `storyPrefix` is read; one with `storyPrefix` is refused, naming it.
- [ ] **AC-2** — A new file, `stories/stories.json`, holds steward's prefix:
      `{ "prefix": "ST" }`. One reader, in steward's story tooling, reads it from a project root:
      it refuses, naming the file and the problem, a missing file, invalid JSON, a key other than
      `prefix`, or a `prefix` that is not 1 to 8 capital letters. Tests show each.
- [ ] **AC-3** — Steward's story tooling takes the prefix from that reader and reads no settings
      file for it: the story lint (`scripts/lint-stories.mjs`, `lintAll` and `lintDocs`), story
      containment (`scripts/dispatch/story-containment.mjs`) and the queue reader (`loadQueue`,
      `scripts/dispatch/queue.mjs`).
- [ ] **AC-4** — The engine's coder takes the prefix from the same reader, and reads no settings
      file for it: `coder.mjs` (`dispatchCoder`, `retryStory` and its command line), `story.mjs`
      (`runStory` and its command line), and `loop.mjs` through `loadQueue`. A comment at each
      read says it is a stopgap, which the coder's stories own and will rework with the coder's
      readiness setting.
- [ ] **AC-5** — `scripts/no-project-literals.test.mjs` guards steward's own prefix, `ST-`, and
      steward's own repository, `luplows/steward`, in place of tower-workshop-paths' `OQ-` and
      `luplows/tower-workshop-paths`, in the modules it checks today, and its own cases show it
      finding each in a regular expression, a string and a template literal, and not in a
      comment.
- [ ] **AC-6** — `steward.config.json` and `FIXTURE_SETTINGS`
      (`scripts/dispatch/settings-fixture.mjs`) lose `storyPrefix`, and no test writes it into a
      settings file; a test that needs another prefix writes a `stories/stories.json`.
      `docs/settings.md` loses its `storyPrefix` row, and its copy of this repository's file and
      its sentence on which keys steward's scripts use no longer name it.
- [ ] **AC-7** — `stories/README.md` says the prefix is `stories/stories.json`'s `prefix`, and
      that a project with no story files has no such file.
- [ ] **AC-8** — Every **Planned** marker naming ST-41 in `docs/agent-workflow-design.md` is
      resolved, as its "Reading this document" note says.

## Out of scope

- How a coder finds ready units in a project that does not keep steward's stories: the coder's
  readiness setting, and the coder's stories that rework this stopgap.
- `review.mjs`: it reads no prefix; its unit comes from the pull request's `Unit:` line.
- `init` (ST-44), which neither reads nor writes the prefix.
- Renaming or renumbering any story.

## Constraints

*(none)*

## Context

- **Decided on 2026-10-11 by the owner** (`docs/outline.md`, "Settings": "`storyPrefix` leaves
  steward's settings … the core does not depend on how a project formats its units"), and **on
  2026-10-19 by the owner** where the prefix goes: `stories/stories.json`, the story convention's
  own file (design doc, Part 3, "Decided so far", "Steward installs in another project as a review
  gate, through `init`").
- Every reader of `storyPrefix` today (`grep -rn storyPrefix scripts`, 2026-10-19), outside
  tests:
  - `scripts/dispatch/settings.mjs`: `ALLOWED_KEYS` (line 28) and its validation (lines 159 to
    175);
  - `scripts/dispatch/queue.mjs`, `loadQueue` (line 272), which `loop.mjs` calls (line 220) and
    `queue.mjs`'s own command line runs;
  - `scripts/dispatch/coder.mjs`: `dispatchCoder` (line 371, passed to `loadQueueAt`),
    `retryStory` (line 677) and the command line (line 855, then `takeChoice`, `mainRetry` and
    `usage`);
  - `scripts/dispatch/story.mjs`: `runStory` (line 297) and the command line (line 425);
  - `scripts/dispatch/story-containment.mjs` (line 219);
  - `scripts/lint-stories.mjs`: `lintDocs` (line 378) and `lintAll` (line 411).
- Tests that write `storyPrefix` into a settings file: `cli.test.mjs`, `coder.test.mjs`,
  `loop.test.mjs`, `queue.test.mjs`, `review.test.mjs`, `settings.test.mjs`,
  `story-containment.test.mjs`, `story.test.mjs`, `lint-stories.test.mjs` and
  `scripts/report/review-verdicts.test.mjs`.
- `scripts/no-project-literals.test.mjs` (OQ-129) checks `queue.mjs`, `lint-stories.mjs`,
  `coder.mjs`, `story.mjs` and `review.mjs` for `OQ-`, and `coder.mjs`, `land.mjs`, `loop.mjs`,
  `review.mjs`, `story.mjs` and `scripts/report/review-verdicts.mjs` for
  `luplows/tower-workshop-paths`, outside a comment.
- `stories/README.md`, lines 5 to 7: "The prefix is `steward.config.json`'s `storyPrefix`".

## Open questions

*(none)*
