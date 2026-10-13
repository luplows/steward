---
id: ST-7
title: Run the project's setup command, within its time limit, instead of npm ci
tier: next
kind: workflow
depends_on: [ST-18]
model: sonnet
blocked: null
---

## Intent

As a member of the crew, I want the command that prepares a fresh checkout for a reviewer or a coder
to be the project's own `setup` setting, stopped at the time limit written beside it, so that
steward does not assume every project is prepared by `npm ci`, and a hung setup stops the dispatch
instead of holding it forever. I also want it started on Windows without the Node deprecation
warning today's install prints.

## Acceptance criteria

- [ ] **AC-1** — `scripts/dispatch/install.mjs` runs the project's `setup` setting in place of
      the fixed `npm ci`: its `command`, run through the platform's shell, in the `cwd` and with
      the `env` its caller passes, reading neither from the process. When `setup` is `null` it
      runs nothing and resolves.
- [ ] **AC-2** — A setup still running after its `timeoutMinutes` is stopped, with its whole
      process tree, as `spawn.mjs` stops a session: on Windows by `taskkill /T /F`, elsewhere by
      killing the process group. The limit is taken from the setting, and a test can pass a
      shorter one. A stopped setup rejects with a message naming the limit.
- [ ] **AC-3** — Starting the command never passes an argument array together with
      `shell: true`, which is what Node 24 reports as DEP0190. A test asserts this, through an
      injected process starter, on both a Windows and a non-Windows platform value.
- [ ] **AC-4** — `coder.mjs` and `review.mjs` read `setup` from the project's settings and pass
      it to the install. Any rejection still becomes their existing `install-failed` result.
- [ ] **AC-5** — Tests, with the process starter injected: a setup that never exits is stopped
      at its limit, its tree killed and the rejection names the limit; one that exits 0
      resolves; one that exits non-zero rejects with the last lines of its output, as today; and
      `null` starts no process.
- [ ] **AC-6** — OQ-78's tests that the install gets exactly the caller's `cwd` and `env`, in
      `coder.test.mjs` and `review.test.mjs`, pass, changed only as far as the settings fixture
      needs.
- [ ] **AC-7** — The `**Planned (ST-7)**` marker in `docs/agent-workflow-design.md` loses
      `ST-7`, and the passage is corrected wherever what was built differs.

## Out of scope

- Reading or validating the setting, which is ST-18's.
- The `check` command, which the coder session runs, not the dispatcher.
- Retrying a failed or stopped setup. It stops the dispatch, as a failed install does today.
- Renaming the `install-failed` result, or `install.mjs` itself.

## Constraints

- Node, ESM, no new runtime dependencies.

## Context

Formerly tower-workshop-paths OQ-88. Rewritten on 2026-10-11 by the planning session, with the
owner, for the `setup` setting (`docs/harness-outline.md`, "Settings"). Its earlier version bounded
the fixed `npm ci` at 10 minutes; the limit is now the project's, and steward's own is 5 minutes
(ST-18's AC-3).

- `scripts/dispatch/install.mjs` runs
  `execFile('npm', ['ci'], { shell: process.platform === 'win32', … })` with no `timeout`. Its
  comment gives the reason for the shell: "On Windows `npm` is `npm.cmd`, which Node will not
  spawn without a shell." It has no test file of its own; callers inject a fake `install`.
- DEP0190, reproduced on Node v24.19.0 on 2026-09-27 with
  `execFile('npm', ['--version'], { shell: true })`: "Passing args to a child process with
  shell option true can lead to security vulnerabilities, as the arguments are not escaped,
  only concatenated." A command given as one string, with no argument array, does not combine
  the two.
- How long `npm ci` took, measured 2026-09-27: on CI, over 30 completed `ci.yml` runs, 2 s at
  the median and 5 s at most; on a Windows machine that runs the dispatch, 3 s on each of three
  runs. Neither was a cold npm cache.
- `scripts/dispatch/spawn.mjs`: "a timeout that leaves a process running is a leak, not a
  timeout". Its `killTree` (not exported) uses `taskkill /T /F` on Windows and a process-group
  kill elsewhere.
- Both callers turn a rejection into `install-failed`: `coder.mjs` and `review.mjs`.

## Open questions

*(none)*
