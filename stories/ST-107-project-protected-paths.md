---
id: ST-107
title: Let a project set its own protected paths
tier: normal
kind: product
depends_on: [ST-106, ST-110]
model: null
blocked: null
---

## Intent

As a member of the crew, I want my project's settings to say which paths land only by hand, so that
I can protect a file my checks depend on, such as a script CI runs, or protect less, rather than
live with a list fixed in steward's code.

## Acceptance criteria

- [ ] **AC-1** — `readSettings` (`scripts/dispatch/settings.mjs`) requires a new key,
      `protectedPaths`, with no default in the code: an array, possibly empty, of distinct strings.
      An entry ending in `/` means that folder and everything under it; any other entry means
      exactly that file. An entry is valid when it, with one trailing `/` removed, passes
      `isRulesFilePath` (`scripts/dispatch/rules-file-path.mjs`), which is reused rather than
      restated: so no empty entry, no absolute path, no backslash, no empty or `..` segment, and
      no control character, backtick, `<` or `>`. A missing key, a value that is not an array, a
      duplicate and an invalid entry are each refused with an error that names the file and the
      key, as for the other keys.
- [ ] **AC-2** — `init` writes `protectedPaths` in the `steward.config.json` it adds
      (`settingsBody`, `scripts/dispatch/init.mjs`), as
      `[".github/workflows/", "<checklist>", "steward.config.json", ".claude/"]`, `<checklist>`
      being the `rulesFile` it writes.
- [ ] **AC-3** — `upgrade` gains an entry in `MIGRATIONS` (`scripts/dispatch/upgrade.mjs`), after
      `ST-105-remove-check`, that adds `protectedPaths` to a project's `steward.config.json` that
      lacks it, with the list of AC-2 and the project's own `rulesFile` value as `<checklist>`, and
      changes nothing else in the file. Its explanation, in the upgrade pull request's body, says
      that steward now reads the protected paths from the settings, that the list added is the one
      steward used before, and that the project may change it. A file that already has the key is
      left as it is.
- [ ] **AC-4** — The runway (`scripts/land/runway.mjs`), in unattended mode, reads
      `protectedPaths` from `steward.config.json` on `main`, and a pull request is protected when
      a path of AC-2 of ST-106 (each added, changed or deleted file, and both sides of a move)
      matches an entry: starts with a folder entry, or equals a file entry, compared
      case-sensitively. An empty list protects nothing. An unattended landing whose
      `protectedPaths` on `main` is missing or invalid by AC-1's rules is refused, with the reason,
      as a malformed `landWhen` is. It no longer reads `rulesFile` for this.
- [ ] **AC-5** — A pull request that changes `protectedPaths` is judged by the list on `main`, not
      by its own: with the list of AC-2, it changes `steward.config.json`, so it lands only by
      hand.
- [ ] **AC-6** — The pilot (`scripts/dispatch/land.mjs`) and the coordinator take the list from the
      settings they read, `createLandContext` takes `protectedPaths` in place of `rulesFile`, and
      every caller passes it. Their behaviour is otherwise ST-106's.
- [ ] **AC-7** — The fixed list ST-106 added to steward's code is removed, and nothing reads it.
- [ ] **AC-8** — The docs describe the setting: `docs/settings.md` gains a row in the keys table
      (its form, what it is for, and what `init` writes) and a section on how entries match, and
      says that `upgrade` adds the key; the glossary's **protected path** entry says the paths are
      the settings' `protectedPaths`; and `README.md`'s description of protected paths, from
      ST-106, says the same. `docs/settings.md`, "This repository's file", shows the file as
      `upgrade` leaves it, with `protectedPaths`, and says that steward's own file gains the key
      when steward upgrades to a release with this story, as it says for `check`.
- [ ] **AC-9** — This story's **Planned** marker in `docs/agent-workflow-design.md`, "Merging"
      ("Protected paths land only by hand"), is removed, and the passage is corrected wherever what
      was built differs.
- [ ] **AC-10** — Tests, in the existing test files of `settings.mjs`, `init.mjs`, `upgrade.mjs`,
      `runway.mjs` and `land.mjs`, cover:
      - a valid list, an empty one, and each refusal of AC-1 (missing, not an array, a duplicate,
        an absolute path, a `..` segment, a backslash, an empty entry, `/` alone);
      - `init`'s file holding the list of AC-2, with a checklist path other than `REVIEW.md`;
      - `upgrade` adding the key with the project's `rulesFile`, leaving every other key as it was,
        `land` included, and making no settings change when the key is there;
      - the runway skipping, unattended, a pull request that changes a folder entry's file and one
        that changes a file entry, landing one that changes `docs/x.md` under an empty list,
        judging a change to `protectedPaths` by `main`'s list, and refusing an unattended landing
        when `protectedPaths` on `main` is missing or invalid;
      - the pilot using the list its context was given;
      - steward's own `steward.config.json`, which has no `protectedPaths` until steward's own
        upgrade (Out of scope): each test that reads it with `readSettings` reads it with the key
        added as this story's migration adds it, in a temporary project, and says why in a
        comment, as "ST-29/AC-7" says why it leaves out `check`. Each still checks what it checks
        now. They are, in `scripts/dispatch/settings.test.mjs`, "OQ-122/AC-2", "ST-29/AC-7"
        (which also compares the file with `docs/settings.md`'s copy), "ST-34/AC-3: this
        repository's steward.config.json has no usageLimits" and "ST-41/AC-1: this repository's
        steward.config.json has no storyPrefix", and, in `scripts/land/checks-green.test.mjs`,
        "ST-24/AC-3: steward.config.json has a landWhen the function accepts".

## Out of scope

- Patterns other than a folder or an exact file, such as globs.
- Protecting a path from a manual landing. A person's request lands any pull request that passes
  the gate.
- Changing what the reviewer does with a pull request that changes a protected path.
- Removing paths from a project's list on upgrade, or changing a list the project already has.
- Adding `protectedPaths` to steward's own `steward.config.json`. Steward's coordinator and
  workflows run v0.3.0, whose `readSettings` refuses an unrecognised key, so steward's own
  `upgrade` to a release with this story adds it, through this story's migration, as ST-105's did
  for `check` (crew, 2026-11-25). Until then a command that reads steward's own file with
  `readSettings` from a checkout of `main`, such as a rotation, refuses it.

## Constraints

- Every key of `steward.config.json` is required, with no default in the code
  (`docs/settings.md`). A project's file without `protectedPaths` is refused until `upgrade` or
  the crew adds it.

## Context

- ST-106 fixes the list in steward's code: `.github/workflows/`, `.claude/`,
  `steward.config.json` and the `rulesFile` value, read from `main`. It lands first.
- ST-110 makes `readSettings` ignore a key it does not know. It is released before this story, so
  that a coordinator at that release reviews and lands each project's upgrade to the release with
  this story, which adds `protectedPaths`, and moves to that release after (`docs/settings.md`, as
  ST-110 leaves it).
- `isRulesFilePath` refuses an empty segment, so a folder entry's trailing `/` is removed before
  it is checked.
- `MIGRATIONS` holds one entry, `ST-105-remove-check`; a migration may not change `land`
  (`planConfig`, `upgrade.mjs`).
- `settingsBody` (`init.mjs`) writes every key `readSettings` requires.
- ST-105 left `check` in steward's own file for the same reason
  (`stories/done/ST-105-retire-check-setting.md`, Out of scope), and `settings.test.mjs`'s
  "ST-29/AC-7" leaves it out of its comparison.

## Open questions

*(none)*
