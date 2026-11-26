---
id: ST-109
title: Make ATC the coordinator's other name, and retire the controller
tier: normal
kind: product
depends_on: [ST-104]
model: null
blocked: null
---

## Intent

As a member of the crew, I want "ATC" to mean the coordinator I start on my machine, which handoffs
go to and which coordinates coding, review and landing, and I want no separate controller role, so
that the words match how steward is run now: the coordinator does the automatic work, and manual
work is a crew member, or a session they ask, running `steward` commands.

## Acceptance criteria

- [ ] **AC-1** — `docs/glossary.md`:
      - **ATC** is redefined as the coordinator's other name: the process running on the machine,
        started with `steward coordinator start` (or `steward atc start`), which handoffs go to and
        which coordinates coding, review and landing. It no longer defines ATC as
        `scripts/dispatch/`.
      - **coordinator** keeps its name and says that ATC is its other name, and ends with a
        *Formerly* note for the controller, the session a member of the crew asked to run steward's
        dispatch scripts by hand.
      - The **controller** entry is removed.
      - **crew** no longer says that the crew asks the controller for a rotation.
      - The entries that name ATC as the doer of something a manual command also does name steward
        instead: **coder** and **reviewer** (`steward coder` and `steward review` start them too),
        **grounded** (`steward coder` does not start such a story), and, under **Acts**, **take**,
        **start**, **push**, **open** and **post**.
- [ ] **AC-2** — `steward atc start`, `steward atc status [--json]` and `steward atc stop` are the
      same commands as `steward coordinator start`, `status` and `stop`: `atc` is an entry of
      `COMMANDS` in `scripts/dispatch/cli.mjs` that runs `scripts/dispatch/coordinator.mjs`, so
      each gives the same output and exit code as its `coordinator` form. The coordinator's usage
      text (`USAGE`, `coordinator.mjs`) names both forms, and `cli.mjs`'s list of commands includes
      `atc`.
- [ ] **AC-3** — `docs/controller.md` is removed. `AGENTS.md` loses the controller's row in "Which
      instructions are yours" and in "Where things are documented"; its "Every session" rule on
      `land-approved.yml` says that only the crew, by hand, or the pilot, run by the coordinator or
      by a `steward` command a member of the crew runs or asks a session to run, may trigger it;
      and its example worktree names in "Opening a pull request" no longer include `controller`.
- [ ] **AC-4** — `docs/planning-session.md`, "Handing it over", says that once the crew marks the
      pull request ready the coordinator reviews it, and lands it where the project's `land` is
      `true`, and that a block on the description alone is fixed by editing the description, then
      having a member of the crew, or a session they ask, run
      `steward review <pr-number> --rereview`. It no longer tells the planning session to ask the
      controller for a rotation or a re-review.
- [ ] **AC-5** — Every other current mention of the controller is reworded so that manual work is
      a member of the crew, or a session they ask, running `steward` commands, or is removed:
      - `README.md`, "From the crew", which links `docs/controller.md`;
      - `docs/release-review.md` ("The controller reviews and lands it");
      - `docs/agent-workflow-design.md`, Parts 1 and 2: "The shape" (its first paragraph, its
        diagram's review side, and the **Controller** row of its roles table), "Merging" (the
        bullet "Started independently of the work"), the section "The controller", "Credential
        minimalism" (its pointer to "The controller"), "Watchdog" (who runs `inspect` after each
        rotation), D13 under "Defining steward", and Part 2's "Happy path" (step 7) and "Running
        unattended" (the controller's hand-runs). The section "The controller" becomes a section on
        manual work that keeps what is still true of it (the pilot as the only agent-run way to the
        runway, a manual command's worktree, `--repo` and its manual checkouts, the rotation's
        stops) and drops what describes only the controller session;
      - `scripts/dispatch/review.mjs`, a header comment naming `docs/controller.md`;
      - the tests that read `docs/controller.md`: `scripts/dispatch/inspect.test.mjs`,
        "ST-29/AC-10: the controller reports inspect's output and exit code, which does not stop the
        rotation", is removed, and `scripts/dispatch/review-admission.test.mjs` checks `README.md`
        alone where it checks `README.md` and `docs/controller.md`.

      `git grep -n -i controller` then finds the word only in `stories/`, `releases/`, dated
      records (Part 3 of `docs/agent-workflow-design.md`, and the decision in `docs/outline.md`,
      "The review side runs in rotations", dated 2026-10-11), a fixture's folder name in
      `scripts/dispatch/rotation.test.mjs` (`steward-controller`), and
      `scripts/land/thin-workflows.test.mjs`, which checks that the workflow templates do not
      contain the word.
- [ ] **AC-6** — Every current passage that uses "ATC" to mean steward's scripts is reworded to
      "steward", "steward's scripts", or the command or module that does the work, whichever reads
      correctly. The set is what `git grep -n -w ATC` finds outside `stories/`, `releases/`, Part 3
      of `docs/agent-workflow-design.md` and other dated records (a passage dated as a decision,
      such as "(owner, 2026-10-11)"): the docs (among them `README.md`, `AGENTS.md`,
      `docs/outline.md`, `docs/user-config.md`, `docs/release-review.md`, and Parts 1 and 2 of
      `docs/agent-workflow-design.md`, its roles table and its section "ATC is scripts" included),
      the prompts, and the code, its comments and test names included. A use stays "ATC" only
      where the coordinator is the only thing that does what it says:
      `.claude/prompts/coder-handoff.md` (only the coordinator calls `executeHandoff`) and the
      provenance lines `publishHandoff` writes in a pull request's body
      (`scripts/dispatch/handoff-publish.mjs`, and the tests that assert them) keep it.
      `.claude/prompts/coder.md` and `.claude/prompts/reviewer.md` say "steward", or name the
      commands that start their sessions, in place of "ATC", their opening sentences included,
      since the coordinator is not the only thing that starts them. A test that asserts a prompt's
      wording follows it: `scripts/dispatch/coder.test.mjs`, "ST-99/AC-3: … asks a Codex
      coder for a ## Commit message section", which asserts the same sentence in both coder
      prompts, and `scripts/dispatch/invocation.test.mjs`, "ST-39/AC-2", which asserts the
      reviewer prompt's "ATC fetched every branch on `origin`".
- [ ] **AC-7** — `docs/agent-workflow-design.md` gets a section for manual work in place of "The
      controller" (AC-5), and the **Planned (ST-109)** marker on "ATC is the coordinator, and the
      controller retires", at the end of the section headed "ATC is scripts" at `e8e59e9`, is
      removed, with the passage corrected
      wherever what was built differs.
- [ ] **AC-8** — Tests: in `scripts/dispatch/cli.test.mjs`, that `COMMANDS.atc` and
      `COMMANDS.coordinator` are the same module, and that `steward atc status` and
      `steward coordinator status` give the same output for the same state; in
      `scripts/dispatch/coordinator.test.mjs`, that the usage text names both forms.

## Out of scope

- Renaming the coordinator's files, commands, record or state folder. `coordinator` stays, and
  `atc` is an alias.
- Dated records, which keep the words they were written with (`AGENTS.md`).
- Stories. A story's own pull request may not change another story, or anything else under
  `stories/` (`checkStoryContainment`, `scripts/dispatch/story-containment.mjs`). The pull request
  that wrote this story reworded `stories/README.md`'s "ATC" and the controller in ST-6, ST-8 and
  ST-27 to read correctly under either meaning.
- Changing what any command does, apart from adding the alias.

## Constraints

- Breaking changes are acceptable: only the owner's projects use steward (crew, 2026-11-25).

## Context

- `scripts/dispatch/cli.mjs` runs each command by starting the module `COMMANDS` names as its own
  process with the same argv; `coordinator` maps to `scripts/dispatch/coordinator.mjs`.
- `steward` offers, among others, `review` (with `--rereview`), `land`, `rotation`, `inspect`,
  `coder`, `story`, `loop`, `project`, `handoff`, `init` and `upgrade` (`COMMANDS`).
- `.claude/prompts/coder.md:3` ("The prompt ATC starts a coder session with, to implement one
  story"): its story coder is started by `steward coder`, `steward story` and `steward loop`, and
  not by the coordinator. `.claude/prompts/reviewer.md:3`: its reviewer is started by the
  coordinator and by `steward review` and `steward rotation`. Only the coordinator calls
  `executeHandoff` and `publishHandoff` (`README.md`, "Executing an approved handoff" and
  "Publishing a handoff's pull request").
- ST-104 (`stories/ST-104-attribution-default-when-silent.md`) keeps "ATC copies what you write
  unchanged" in both coder prompts (its AC-1). This story waits on it, so the two are built in
  turn: after ST-104, this story rewords `coder.md`'s copy to "steward", by AC-6, and
  `coder-handoff.md`'s copy stays. ST-104's file is not changed here, since its own pull request
  moves it to `stories/done/`, where it keeps the words it was built with.
- This story touches the same documents as ST-106 and ST-108 (`docs/glossary.md`, `README.md`,
  `docs/agent-workflow-design.md`), so which lands first is the planning session's call.
- The crew's decision, 2026-11-25, recorded in `docs/agent-workflow-design.md`, "ATC is scripts".

## Open questions

*(none)*
