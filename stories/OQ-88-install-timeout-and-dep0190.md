---
id: OQ-88
title: Bound the dispatch install with a timeout, and start it on Windows without DEP0190
tier: normal
kind: workflow
depends_on: []
model: sonnet
blocked: null
---

## Intent

As the owner running the loop unattended, I want the `npm ci` that starts every
dispatched session to end within a known time, so that a hung install stops the
dispatch instead of holding the loop forever. I also want it started on Windows
without the Node deprecation warning it prints today, so that its output is not
noise and it does not depend on a pattern Node has deprecated.

## Acceptance criteria

- [ ] **AC-1** — `scripts/dispatch/install.mjs` exports `INSTALL_TIMEOUT_MS`,
      set to 10 minutes, and the install is stopped when it runs longer. Its
      comment gives the measurements the value rests on (see **Context**).
      `installDependencies` takes the limit as an option that defaults to
      `INSTALL_TIMEOUT_MS`, so a test need not wait ten minutes. Stopping it
      stops the whole process tree, as `spawn.mjs` does for a session: on
      Windows the install runs `npm.cmd` under a shell, so killing only the
      direct child would leave `npm` running. A stopped install rejects with a message
      naming the timeout, so `coder.mjs` and `review.mjs` each return
      `install-failed` as they already do for any rejection.
- [ ] **AC-2** — Starting the install passes no argument list together with
      `shell: true`, which is what Node 24 reports as DEP0190. On Windows the
      command is still fixed text with nothing interpolated into it. A test
      asserts, through an injected process starter, that no call combines
      `shell: true` with a non-empty argument array, on both a Windows and a
      non-Windows platform value.
- [ ] **AC-3** — Tests, with the process starter injected:
      - an install that never exits is stopped at the limit it was given, its
        tree is killed, and the rejection names the timeout;
      - an install that exits 0 resolves;
      - an install that exits non-zero rejects with the last lines of its
        output, as today.
- [ ] **AC-4** — The install still gets exactly the `cwd` and `env` its caller
      passes, and reads neither from the process. OQ-78's tests for that, in
      `coder.test.mjs` and `review.test.mjs`, are unchanged and pass.

## Out of scope

- Changing what is installed, or replacing `npm ci`.
- Timeouts on the sessions themselves: `spawn.mjs` already has
  `DEFAULT_TIMEOUT_MS` and `DEFAULT_STALL_MS`.
- Retrying a failed or timed-out install. It stops the dispatch, as a failed
  install does today.

## Constraints

- Node, ESM, no new runtime dependencies.

## Context

- `scripts/dispatch/install.mjs` runs
  `execFile('npm', ['ci'], { shell: process.platform === 'win32', … })` with
  no `timeout`. Its comment gives the reason for the shell: "On Windows `npm`
  is `npm.cmd`, which Node will not spawn without a shell." It has no test
  file of its own; callers inject a fake `install`.
- DEP0190, reproduced on Node v24.19.0 on 2026-09-27 with
  `execFile('npm', ['--version'], { shell: true })`: "Passing args to a child
  process with shell option true can lead to security vulnerabilities, as the
  arguments are not escaped, only concatenated."
- How long `npm ci` takes, measured 2026-09-27: on CI, over the last 30
  completed `ci.yml` runs, the "Run npm ci" step took 2 s at the median and
  5 s at most (from the Actions jobs API's step times). On a Windows machine
  that runs the dispatch (Node v24.19.0), it took 3 s on each of three runs.
  Neither is a cold npm cache, which was not measured. Ten minutes is far
  clear of all of these and still ends a hung install.
- `scripts/dispatch/spawn.mjs`: "a timeout that leaves a process running is a
  leak, not a timeout". Its `killTree` (not exported) uses `taskkill /T /F` on
  Windows and a process-group kill elsewhere.
- Both callers turn a rejection into `install-failed`: `coder.mjs` (after
  `git worktree add`) and `review.mjs` ("a failed install stops the
  dispatch").
- Raised by the reviewer session on 2026-09-27, in the notes from reviewing
  #151.

## Open questions

*(none)*
