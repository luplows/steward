---
id: ST-34
title: Read the machine's settings: the usage limits, and each role's default and available choices
tier: next
kind: workflow
depends_on: [ST-31]
model: sonnet
blocked: null
---

## Intent

As a member of the crew, I want what depends on the computer steward runs on, rather than on the
project, kept in a settings file of that computer's own, outside any checkout: the usage limits,
which describe my plan, and for each role a default choice of tool, model and effort, and the
choices available besides it. A project's settings then make no assumption about which models a
computer uses, and a role is not limited to one model or one effort.

## Acceptance criteria

- [ ] **AC-1** — A new module, `scripts/dispatch/machine-settings.mjs`, exports
      `readMachineSettings({ env, homedir })`. It reads the file that `env.STEWARD_SETTINGS`
      names when that is set, and otherwise `<homedir>/.steward/settings.json`. Like
      `readSettings`, it holds no default for any value: a missing file, invalid JSON, a missing
      or unknown key, or a value of the wrong form is an error naming the file and the key with
      all its parents (for example `roles.reviewer.available.opus.effort`).
- [ ] **AC-2** — The file is an object with exactly the keys `usageLimits` and `roles`:
      - `usageLimits` has the form ST-31 gave it in the project's settings (`coder` and
        `reviewer`, each with `session` and `weekly`, integers from 1 to 100);
      - `roles` has exactly the keys `coder` and `reviewer`. Each is an object with exactly the
        keys `default` and `available`. `available` is a non-empty object mapping a choice's name
        (matching `/^[a-z0-9][a-z0-9._-]*$/`) to an object with exactly the keys `tool`, `model`
        and `effort`: `tool` is `"claude"`, the only tool accepted until ST-32; `model` is a
        non-empty string; `effort` is one of `low`, `medium`, `high`, `xhigh` and `max`.
        `default` names a key of `available`.
- [ ] **AC-3** — `usageLimits` leaves the project's settings: `readSettings` refuses it as an
      unknown key, and it goes from this repository's `steward.config.json` and from
      `scripts/dispatch/settings-fixture.mjs`. `reviewPullRequest`, `dispatchCoder` and
      `retryStory` take the limits from the machine's settings, read once per call before the
      usage check, through an injectable option so that tests read no real file.
- [ ] **AC-4** — The coder runs the choice its unit names: when the story's `model:` names a key
      of `roles.coder.available`, that choice's `model` and `effort`; when the story has no
      `model:`, the coder's `default`. A story whose `model:` names no available coder choice is
      not started: `dispatchCoder` and `retryStory` return
      `{ status: 'choice-unavailable', storyId, choice }`, before anything is claimed, made or
      installed.
- [ ] **AC-5** — The reviewer runs its `default` choice's `model` and `effort`, unless that model
      is the one its unit names for the coder (`unitModel`, `review.mjs`, read through
      `roles.coder.available` when it names a choice there), compared as `chooseReviewerModel`
      compares models today. Then it runs the first other choice in `roles.reviewer.available`,
      in the file's order, whose model differs. When none differs, `reviewPullRequest` returns
      `{ status: 'reviewer-unavailable', reason }` and starts no session.
      `ROLE_DEFAULTS` in `scripts/dispatch/invocation.mjs` keeps each role's `maxBudgetUsd`, and
      no longer holds a model or an effort.
- [ ] **AC-6** — Tests, named `ST-34/AC-<n>`, with the file's path, its text and the environment
      injected:
      - `readMachineSettings` reads the file `STEWARD_SETTINGS` names, and otherwise the one under
        `homedir`; accepts a valid file; and rejects a missing file, a missing or unknown key at
        each level, a `tool` other than `"claude"`, an `effort` not in the list, an empty
        `available`, and a `default` that names no choice, each error naming its key;
      - `readSettings` rejects a project file that still has `usageLimits`;
      - a coder runs the choice its story names, the default when it names none, and returns
        `choice-unavailable` for a name not in `available`, claiming nothing;
      - a reviewer runs its default; runs the next differing choice when the default's model is
        the coder's; and returns `reviewer-unavailable` when no choice differs, starting no
        session;
      - the usage check reads its limits from the machine's settings.
- [ ] **AC-7** — Documents:
      - a new `docs/machine-settings.md` gives the file's path, the `STEWARD_SETTINGS` override,
        each key's form, and an example of a whole file;
      - `docs/settings.md` no longer lists `usageLimits`, and says where it went;
      - `README.md` says that a machine running steward needs the file, and links the new
        document;
      - `AGENTS.md`'s "Where things are documented" lists the new document;
      - `docs/glossary.md`'s **machine settings** entry loses its "(planned: ST-34)" note, and
        names `docs/machine-settings.md`;
      - every `**Planned (ST-34)**` marker in `docs/agent-workflow-design.md` loses `ST-34`, and
        each passage is corrected wherever what was built differs.

## Out of scope

- The crew choosing another available choice for a run by hand, and ATC choosing one when the
  default is over its usage: ST-35.
- A tool other than Claude Code: ST-32 adds Codex, for the reviewer.
- Each role's budget, `maxBudgetUsd`, which stays in the code.
- What `init` writes, and creating the file for the crew.

## Constraints

- Node, ESM, no new runtime dependencies.

## Context

- **Decided on 2026-10-15 by the owner** (design doc, Part 3, "Decided so far", "The machine
  steward runs on has settings of its own"): tool, model and effort are the machine's, not the
  project's; the usage limits move there too; the file lists a default and the choices
  available, since the coder especially should not be limited to one model or effort; it lives
  in the user's profile, with an environment variable to point elsewhere. Three tiers choose
  among the available: the unit, as today's `model:` does for the coder (this story); the crew,
  overriding for a run it starts by hand; and ATC, when one choice is out of usage and another
  is not (both ST-35).
- `ROLE_DEFAULTS` (`scripts/dispatch/invocation.mjs`) today is
  `coder: { effort: 'medium', maxBudgetUsd: 6 }` and
  `reviewer: { model: 'opus', effort: 'high', maxBudgetUsd: 3 }`. The coder's model is its story's
  `model:`, and `chooseReviewerModel` (`review.mjs`) falls back to `sonnet` when the reviewer's
  `opus` is the story's model.
- `usageLimits` was made a required key of the project's settings by ST-31
  (`scripts/dispatch/settings.mjs`, `validateUsageLimits`). Its form does not change here.
- `claude --help` gives `--effort`'s levels as low, medium, high, xhigh and max (Claude Code
  2.1.301, 2026-10-15).
- Every review and coder run on a machine needs the file once this lands. The crew writes it on
  each machine that runs steward before the next rotation there, the controller's included.

## Open questions

*(none)*
