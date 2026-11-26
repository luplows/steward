---
id: ST-106
title: Land a pull request that changes a protected path only by hand
tier: normal
kind: product
depends_on: []
model: null
blocked: null
---

## Intent

As a member of the crew, I want a pull request that changes how my project is reviewed or landed
(its workflows, its checklist, its settings, its `.claude/` folder) to be reviewed as any other but
landed only when a person asks, so that a change to the gate itself, most likely written by a coder,
never lands unattended.

## Acceptance criteria

- [ ] **AC-1** — The **protected paths** are a fixed list in one module of steward's code, used by
      the runway and the pilot alike: everything under `.github/workflows/`, everything under
      `.claude/`, `steward.config.json`, and the project's checklist, the path its `rulesFile`
      setting names. A path is protected when it starts with `.github/workflows/` or `.claude/`, or
      is exactly `steward.config.json` or exactly the `rulesFile` value, compared case-sensitively.
      `AGENTS.md` and `CLAUDE.md` are not on the list.
- [ ] **AC-2** — A pull request **changes a protected path** when any file in its diff against its
      base, as GitHub lists the pull request's files, is protected: one added, changed or deleted,
      and, for a moved file, either its old path (`previous_filename`) or its new one. The function
      that decides it returns the protected paths it found, each once.
- [ ] **AC-3** — The runway (`scripts/land/runway.mjs`), in unattended mode, reads `rulesFile` from
      `steward.config.json` on `main`, as it reads `land` and `landWhen`, and takes the list from
      the steward release it runs, never from the pull request or a caller. An unattended landing
      whose `rulesFile` on `main` is missing or is not a valid path (`isRulesFilePath`,
      `scripts/dispatch/rules-file-path.mjs`) is refused, with the reason, as a malformed
      `landWhen` is.
- [ ] **AC-4** — In unattended mode the runway skips a candidate that changes a protected path,
      merging nothing for it, with a log line that names the pull request, every protected path it
      changes, and that it lands only by a manual request. A run given that pull request (`pr`)
      lands nothing; a run given none goes on to the next candidate. A tripped circuit breaker's
      workflow-only exemption does not lift this skip.
- [ ] **AC-5** — In manual mode the runway does not apply AC-4: a manual request that meets every
      other condition lands a pull request that changes a protected path. Everything else the
      runway checks is unchanged in both modes.
- [ ] **AC-6** — The pilot (`landPullRequest`, `scripts/dispatch/land.mjs`), in unattended mode,
      with or without `once`, reads the pull request's files once it has read the pull request
      open at its head, before it reads that head's status or checks. When the pull request changes
      a protected path it returns the new status `protected-paths`, with `paths`, the protected
      paths it changes, and dispatches nothing. The read is a request the module's allowlist
      (`ALLOWED`, `assertAllowedRequest`) permits: `GET` of the pull request's files, 100 to a
      page, every page read. `createLandContext` takes the settings' `rulesFile`, and every caller
      passes it. In manual mode (`steward land <pr-number>`) the pilot reads no files and AC-6
      does not apply.
- [ ] **AC-7** — A rotation's line for such a pull request (`describeLanding`,
      `scripts/dispatch/rotation.mjs`) shows `protected-paths` and names the paths.
- [ ] **AC-8** — `steward coordinator status` shows, in text and in `--json`, the pull requests
      waiting for a manual landing: each of the latest landing scan's candidates whose attempt
      returned `protected-paths`, with its project, number, head and the protected paths it
      changes, and that it lands only by `steward land <pr-number>`. A new landing scan's attempts
      replace the list. The last landing attempt is shown as now.
- [ ] **AC-9** — The docs describe protected paths:
      - `docs/glossary.md` gains a **protected path** entry, naming the list's module, and its
        **landable** entry says that, for unattended landing, the pull request also changes no
        protected path;
      - `docs/settings.md`, "`land`", says that unattended landing does not land a pull request
        that changes a protected path, and that `steward land <pr-number>` does;
      - `README.md`, "Landing: unattended and manual", says the same, with the list;
      - `README.md`, "Upgrading steward in a project", says that the upgrade's pull request changes
        `.github/workflows/`, so it lands only by hand, with `steward land <pr-number>`, once it
        has passed review.
- [ ] **AC-10** — This story's **Planned** marker in `docs/agent-workflow-design.md`, "Merging"
      ("Protected paths land only by hand"), is removed, and the passage is corrected wherever what
      was built differs.
- [ ] **AC-11** — Tests, in the existing test files of `runway.mjs`, `land.mjs`, `rotation.mjs`
      and `coordinator.mjs` or `coordinator-scheduler.mjs`, and beside the new module, cover:
      - each kind of protected path (a workflow, a file under `.claude/`, `steward.config.json`,
        the `rulesFile` value, a checklist named by a `rulesFile` other than `REVIEW.md`), and
        `AGENTS.md`, `CLAUDE.md` and a path that merely contains a protected one (such as
        `docs/.github/workflows/x.yml`) not protected;
      - a move into and a move out of a protected folder, each detected;
      - the runway skipping such a pull request unattended, naming the paths, for a run given it
        and for a run given none that goes on to land an older or newer unprotected one; landing it
        manually; refusing an unattended landing when `rulesFile` on `main` is missing or invalid;
        and skipping it unattended under a tripped breaker though it touches only
        `.github/workflows/`;
      - the pilot returning `protected-paths` with `paths` and dispatching nothing, with and
        without `once`, reading every page of files, and not reading files in manual mode;
      - the allowlist accepting the files request and still refusing any other;
      - the rotation's line, and the coordinator's status in text and `--json`.

## Out of scope

- A crew member's manual landing, by `steward land <pr-number>` or by dispatching the runway with
  `mode: manual`. It is the person's explicit request, and lands a protected path as anything else.
- Files outside the list that still affect the checks, such as a `package.json` script that CI
  runs. ST-107 lets a project add such paths.
- A project-adjustable list. ST-107 moves the list into the project's settings.
- Pushes or merges that bypass the gate, such as a push to `main` by someone allowed to make one.
- Changing what the reviewer does. A pull request that changes a protected path is reviewed exactly
  as now.
- Restricting what a coder may change. ST-108 removes the restriction it has.
- A pull request with more changed files than GitHub lists for it (at most 3,000), whose unlisted
  files are not read. The circuit breaker's workflow-only exemption reads the same list.

## Constraints

- The threat model: a change to the files that define how a project is reviewed and landed, most
  likely written by a model, by a coder, landing without a person's explicit request. Unattended
  landing is what it protects. The runway, which reads the list from the release it runs and
  `rulesFile` from `main`, is the enforcement; the pilot's and the coordinator's checks only save a
  dispatch and say why.

## Context

- The runway reads `land`, `landWhen` and `unitLinks` from `steward.config.json` on `main` through
  the API (`readAuthorization`, `scripts/land/runway.mjs`), and refuses an unattended landing unless
  `land` is `true` there. It already lists a pull request's files, for the circuit breaker's
  workflow-only exemption (`touchesOnlyWorkflows`, `WORKFLOWS_DIR`), from
  `repos/<repo>/pulls/<n>/files`, paginated.
- The pilot's allowlist, `ALLOWED` in `scripts/dispatch/land.mjs`, permits four requests today:
  the pull request, the head's status, its check runs and the one dispatch.
- `landPullRequest` is called unattended by `rotation.mjs`, by the coordinator
  (`coordinator-scheduler.mjs`, which reads each project's settings from its owned checkout of
  `main`), and by `story.mjs` and `writer-prs.mjs`; `createLandContext` is also called by
  `loop.mjs` and by `land.mjs`'s own `main`.
- `steward upgrade` opens a pull request that replaces the managed workflows under
  `.github/workflows/`, so with this story it is a protected change.
- `isRulesFilePath` (`scripts/dispatch/rules-file-path.mjs`) is the one definition of a valid
  `rulesFile`.
- The decision is the crew's, 2026-11-25, recorded in `docs/agent-workflow-design.md`, "Merging",
  with the options considered.

## Open questions

*(none)*
