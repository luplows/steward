---
id: ST-44
title: "init: set a project up for steward's review gate, asking at the terminal, overwriting nothing"
tier: next
kind: workflow
depends_on: [ST-29, ST-41, ST-42, ST-43]
model: null
blocked: null
---

## Intent

As a member of the crew of a project that is to use steward's review gate, I want one command, run
in my project's checkout, that asks me what it needs, writes everything the gate needs and tells
me what it left alone, so that installing steward is a pull request in my project and not an
afternoon of copying files from steward's repository. It runs no model.

## Acceptance criteria

- [x] **AC-1** — `steward init`, a new command in `cli.mjs`'s `COMMANDS`, runs in a project's
      checkout and starts no model session. It never overwrites a file that is already there:
      for each file it would write, it either writes it or prints that it left the one there,
      naming the path. A test runs it twice in a temporary repository and shows the second run
      writes nothing and names every file.
- [x] **AC-2** — **Asking.** By default it asks each question below at the terminal, showing its
      default. Every question can also be answered by a command-line flag, and `--yes` accepts
      the default of every question not answered by a flag. With no terminal (stdin not a TTY)
      and a question neither answered by a flag nor covered by `--yes`, it refuses, naming the
      question and its flag, and writes nothing. Tests: every question answered by flags; `--yes`
      alone; no TTY and no answers, refused; an answer at the terminal, with the terminal
      injected.
- [x] **AC-3** — **`steward.config.json`.** It writes the file with a value for every key
      `readSettings` requires, so that `readSettings` reads it, which a test shows:
      - `repo`, from the `origin` remote's URL (`owner/name`, from an `https` or an `ssh` URL);
        without an `origin` it can read as a GitHub repository, it writes no settings file and
        says why;
      - `unitLinks`, asked: any combination of `file`, `issue` and `other`, or none, written `[]`;
        default `["file", "issue"]`. The question says that `other` covers a tracker steward cannot
        read yet, whose link is passed to the reviewer unread;
      - `rulesFile`, asked: default `REVIEW.md`;
      - `land`, asked: default `true`;
      - `inspectAfterHours` (ST-29), asked: default `24`;
      - `setup` and `check`: `null`, since only a coder uses them;
      - `landWhen`: `"all-checks"`.
- [x] **AC-4** — **The example checklist.** It copies the example checklist (ST-43), byte for
      byte, to the `rulesFile` path; a file already there is left and reported.
- [x] **AC-5** — **The thin workflow files.** It writes the thin workflow files (ST-42) into
      `.github/workflows/`, with the tag placeholder filled with `v` and the `version` in the
      `package.json` of the steward that ran it. A test runs it from a steward whose `version` is
      `9.8.7` and finds `v9.8.7` in each file it wrote, and no placeholder left.
- [x] **AC-5a** — **A commit in place of the tag.** `--ref <commit>`, which no question asks and
      `--yes` leaves unset, fills the tag placeholder (ST-42) with that commit's full SHA in
      place of the tag, in every workflow file it writes, so that the release review's
      walkthrough can install a release branch's commit before its tag exists
      (`docs/release-review.md`). Anything other than 40 hexadecimal characters is refused before
      anything is written. Tests: a run with `--ref` and a SHA finds that SHA in each file it
      wrote and no `v<version>`; a run with `--ref v0.1.0`, or with a short SHA, is refused and
      writes nothing.
- [x] **AC-6** — **Inspection.** It asks whether to add inspection's workflow (ST-29), default yes,
      and on a yes writes it in the thin form ST-42 gives the gate's files, pinned as they are, and
      says that inspection's first run may raise, as issues, earlier merges and commits on `main`
      within its window that had no passing verdict, which the crew closes once. The package carries
      that thin file, and the test ST-42 adds is extended to keep it in step with steward's own
      `inspection.yml` except for how steward is started. Whatever the answer, it creates the
      `inspection` label when the repository does not have it.
- [x] **AC-7** — **Labels.** It creates every label steward reads or applies today,
      `review-blocked`, `breaker-override` and `inspection`, leaving one that exists as it is, and
      prints each it created or found. The labels are listed in one place in the code, which a
      test compares with the labels the gate's, the runway's and inspection's commands apply and
      read. A later story that adds a label adds it there.
- [x] **AC-8** — **The pull request template.** Only when the project has no pull request template
      in any place GitHub reads one from (`pull_request_template.md` at the root, in `docs/` or in
      `.github/`, or a `PULL_REQUEST_TEMPLATE/` directory in any of those), it writes
      `.github/pull_request_template.md` from a template the package carries, which holds nothing
      particular to steward: the `Unit:` line, then What changed, Verification and Docs check, the
      last asking which documentation the change affects and what was updated, or why none needed
      it. Steward's own template is unchanged. When the project has one, it edits nothing, and
      reports when no `Unit:` line is in it, naming the file. Tests: no template; a template in
      `docs/` with no `Unit:` line; one in `.github/` with one; and the written template names
      neither `AGENTS.md` nor `README.md`.
- [x] **AC-9** — **The machine's settings.** Only when the file is missing
      (`~/.steward/settings.json`, or the file `STEWARD_SETTINGS` names; `machineSettingsPath`), it
      asks for and writes it; a file that exists is not read, changed or replaced.
      `readMachineSettings` reads what it wrote, which a test shows. The defaults are Claude
      choices: for the reviewer, `opus`; for the coder, `sonnet` with strength 1 and `opus` with
      strength 2; usage limits for the coder of 70 (`session`) and 75 (`weekly`), and for the
      reviewer of 90 and 90. A Codex reviewer choice is offered only when `codex` is found on the
      `PATH` or the crew gives its path, which is then written as `tools.codex.executable`. When the
      crew takes it, `init` asks for its model and its effort, with no default for either, so that
      with no terminal a Codex choice needs both flags.
- [x] **AC-10** — **Branch protection.** It asks before it sets branch protection on `main`, with a
      default of no that `--yes` keeps, so that only a yes at the terminal or its flag sets it, and
      on a yes requires the `review/agent` check, with `enforce_admins` on, as steward's own `main`
      has it, and says that the project's own CI checks are the crew's to add. Where GitHub offers
      none, as on a private repository on GitHub Free, or the account cannot set it, it says so
      plainly, says that nothing on GitHub then enforces the gate, and goes on. A test with GitHub's
      answers injected shows a yes, a no, a refusal because the plan does not offer it, and a
      refusal for want of admin access.
- [x] **AC-11** — **What it leaves alone.** It neither reads nor writes `storyPrefix`,
      `stories/stories.json` (ST-41) or anything about story files; it does not touch the
      project's `package.json` or its CI workflows, and writes no after-sweep trigger; and it
      commits, stages and pushes nothing. A test shows `HEAD`, the index and `package.json`
      unchanged after a run, and no file under `stories/` read or written. Its last lines say that
      the crew commits what it wrote through a pull request of the project's own.
- [x] **AC-12** — It exits 0 when it finished, whatever it left alone or could not set, and
      non-zero, having written nothing more, when a request to GitHub fails other than as AC-10
      describes, when it refuses under AC-2, or when the checkout is not a git repository.
- [x] **AC-13** — `README.md`'s "Steward runs on this repository only" is replaced by how to set up
      another project with `init`, and its "Setup" says how the crew runs steward in a project: `npx
      --yes --package=github:luplows/steward#v<version> steward <command>`, the form the workflows
      use. `docs/settings.md`'s "What `init` will write" column says what `init` writes for each
      key, and its sentence "`init` is not built yet", with its **Planned** marker, goes.
- [x] **AC-14** — Every **Planned** marker naming ST-44 in `docs/agent-workflow-design.md` is
      resolved, as its "Reading this document" note says.

## Out of scope

- **Exploring the repository to surface options** (design doc, "Open questions", D8), and **the
  two other ways to set up** of D9, declarative without AI and AI-helped: left open.
- **Rulesets** where branch protection is not offered (D11).
- **The project's CI**: its checks, its after-sweep trigger, and requiring its checks in branch
  protection. A project's CI is its own ("Steward enforces nothing about CI").
- **Moving a project to a newer steward**: a pull request in the project that changes the tag in
  the workflow files; the crew types the new version in its commands.
- **The coding side**: the coder's readiness, its stories, and the prompts' project section.
- **Cutting `v0.1.0`**: the release review's, whose instructions are a separate pull request.

## Constraints

- Node, ESM, no new runtime dependencies.
- It reads GitHub with the crew member's own credential, as the other commands do
  (`gh auth token`), and changes the repository's settings only on the crew's yes (AC-10).

## Context

- **Decided on 2026-10-19 by the owner**, with the planning session (design doc, Part 3, "Decided
  so far", "Steward installs in another project as a review gate, through `init`"), including
  every question and default in AC-3, AC-9 and AC-10. The first project is pinpoint, a private
  Node repository on GitHub Free, whose units are GitHub issues; then tower-workshop-paths, by its
  own OQ-115.
- ST-29: `inspectAfterHours` (its AC-7) and `inspection.yml` (its AC-8). Its Out of scope says
  what `init` writes for `inspectAfterHours`, and how a project adopting steward avoids raising
  its own recent history, are `init`'s. `inspect` takes `--since-days`, default 7 (its AC-1).
- `docs/outline.md`, "Land", "What installing steward sets up", and "Settings": steward's code
  holds no default for any key, and `init` writes a starting value for each.
- `docs/settings.md`: the keys, and its "What `init` will write" column, which gives the values
  decided on 2026-10-19, and says that `init` is not built yet.
- `scripts/dispatch/machine-settings.mjs`: `machineSettingsPath` and `readMachineSettings`;
  `docs/machine-settings.md`, "An example".
- `.github/pull_request_template.md`: the `Unit:` line, then What changed, Verification and Docs
  check.
- GitHub reads a pull request template from `pull_request_template.md` at the root, in `docs/` or
  in `.github/`, and from a `PULL_REQUEST_TEMPLATE/` subdirectory of any of them (GitHub Docs,
  "Creating a pull request template for your repository", read 2026-10-19).
- Design doc, Part 3, R6: protected branches are not available to a private repository on GitHub
  Free. Steward's own `main` requires `test` and `review/agent` (`README.md`, "Setup").
- `README.md`, "Where it stands": "**Steward runs on this repository only.** `init`, which will
  set up another project, is not built yet."

## Open questions

*(none)*
