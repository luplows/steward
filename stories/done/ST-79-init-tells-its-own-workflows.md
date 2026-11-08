---
id: ST-79
title: Have init tell its own workflows from a project's, instead of calling the installation complete
tier: normal
kind: product
depends_on: []
model: null
blocked: null
---

## Intent

As a member of the crew installing steward, I want `init` to say when the
workflows it found are not the ones it writes, so that a project whose own
workflows share their names is not told that the installation is complete.
Today, when `main` has every file `init` installs, it prints "the installation
is already complete" and exits 0, whatever those files hold. It did so in
steward itself at `935fb5b`, whose workflows are its own, and
`releases/v0.1.0.md` lists it as a known issue.

The threat model is one member of the crew running `init` once from an
ordinary checkout. The check tells an honest mismatch apart; it is not a
defence against a file made to look like `init`'s.

## Acceptance criteria

- [x] **AC-1** — A function, exported from a module ST-69 can import, says
      whether a workflow's text is a template's text with only the pin
      different: the reference after `github:luplows/steward#`, whatever it is.
      Line endings are ignored. Tests: a template filled with two different pins
      matches; one with any other line changed, added or removed does not.
- [x] **AC-2** — When `main` has every file `init` would add, `init` compares
      each workflow it would write (`GATE_WORKFLOWS`, and `INSPECTION_WORKFLOW`
      when inspection is asked for) with this version's template through AC-1's
      function. When all match, it prints the message it prints today and exits
      0.
- [x] **AC-3** — When any does not match, it prints that the files are there
      but that each named workflow differs from what this version of `init`
      writes, so the installation is not this version's, and that a project's own
      workflows with these names must be removed or renamed before `init` can
      install. It makes no branch, commit, push or pull request, and exits 1.
- [x] **AC-4** — When some files are missing, so `init` opens its pull
      request, each workflow it kept that does not match is named as such in the
      body's list of files left, and in the closing message.
- [x] **AC-5** — `README.md`'s description of `init`, where it describes this
      case, says what AC-2 to AC-4 do. The `**Planned (ST-79)**` marker in
      `docs/agent-workflow-design.md` loses `ST-79`.

## Out of scope

- Files other than the workflows: `steward.config.json`, the checklist and the
  pull request template are the project's, and are not compared.
- Replacing or repinning an installed workflow. That is ST-69's upgrade.
- Telling an older version's workflows from a project's own. Both differ from
  this version's templates, and AC-3's message covers both.

## Constraints

*(none)*

## Context

- `scripts/dispatch/init.mjs`: `GATE_WORKFLOWS`, `INSPECTION_WORKFLOW`,
  `fillPin`, and the `added.length === 0` branch that prints the message.
- `templates/workflows/`: each pin is written as
  `github:luplows/steward#v{{STEWARD_VERSION}}`, or the `--ref` commit.
- ST-56 (`stories/done/ST-56-init-installation-pr.md`) decided the message for
  a complete installation; ST-69 uses AC-1's function to compare with the
  v0.1.0 templates.
- ST-48's record, `docs/validation/ST-48-review-installation.md`:
  tower-workshop-paths removed its old engine before `init` could install, and
  "Steward itself" records `init`'s run there.

## Open questions

*(none)*
