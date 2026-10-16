---
id: ST-31
title: Start no coder or reviewer session while the plan's usage is over the settings' limit
tier: next
kind: workflow
depends_on: []
model: sonnet
blocked: null
---

## Intent

As a member of the crew, I want ATC to read my plan's usage before it starts a coder or a
reviewer session, and to start none when either window is over the limit the settings give that
role, so that steward cannot run through my plan's allowance. Coders stop earlier than reviewers,
so that work already in flight still gets its review, and so that a coder is not cut off mid-run
by the plan's own limit. When the usage cannot be read, nothing starts.

## Acceptance criteria

- [ ] **AC-1** — A new module, `scripts/dispatch/usage.mjs`, exports `readUsage`. It runs the
      Claude executable (`resolveClaudeExecutable`, `scripts/dispatch/spawn.mjs`) as
      `claude -p /usage --output-format stream-json --verbose`, with no shell, in the directory it
      is given, and reads the `usage_report.rate_limits.limits` rows from the message that carries
      them. It returns `{ ok: true, session, weekly }`, each `{ percent, resetsAt }`:
      - `session` from the row whose `kind` is `session`;
      - `weekly` from the row whose `kind` is `weekly_all`. No other row is read for the weekly
        window, the per-model `weekly_scoped` included.

      It returns `{ ok: false, reason }` when the command fails or times out, when no message
      carries `usage_report`, when `rate_limits` is `null`, when either window has no row, or when
      a window's `percent` is not a number. The run is given a time limit of 30 seconds. The
      process runner is injectable, so tests start no real session.
- [ ] **AC-2** — A new required settings key, `usageLimits`, read and validated by
      `readSettings` (`scripts/dispatch/settings.mjs`): an object with exactly the keys `coder` and
      `reviewer`, each an object with exactly the keys `session` and `weekly`, each an integer from
      1 to 100, the percentage at or over which that role starts no session. Anything else is an
      error naming the file and the key with its parents (for example `usageLimits.coder.weekly`).
      This repository's `steward.config.json` and the test fixtures
      (`scripts/dispatch/settings-fixture.mjs`) gain:

      ```json
      "usageLimits": {
        "coder": { "session": 70, "weekly": 75 },
        "reviewer": { "session": 90, "weekly": 90 }
      }
      ```
- [ ] **AC-3** — `reviewPullRequest` (`scripts/dispatch/review.mjs`) checks usage once per call,
      after it has decided to review and before it installs dependencies or starts the first
      session:
      - **over the limit**: when either window's `percent` is at or over the reviewer's limit for
        that window, it starts no session and returns
        `{ status: 'over-usage', window, percent, limit, resetsAt }`, naming the first window over,
        `session` before `weekly`;
      - **unreadable**: when `readUsage` returns `ok: false`, it starts no session and returns
        `{ status: 'usage-unknown', reason }`.

      A second session for a malformed verdict (OQ-121) is not checked again.
- [ ] **AC-4** — `scripts/dispatch/coder.mjs` makes the same check, with the coder's limits:
      `dispatchCoder` before it claims a story's branch, and `retryStory` before it installs
      dependencies. Each returns the same two statuses, with the story's id. A coder session
      already running is never stopped.
- [ ] **AC-5** — The header comments of `review.mjs` and `coder.mjs` say that each checks usage
      before starting a session, and name the two statuses. `docs/controller.md` needs no change:
      a status other than `recorded` is that pull request's outcome, and the rotation goes on
      ("Reporting and stopping").
- [ ] **AC-6** — Tests, named `ST-31/AC-<n>`, with the process runner and `readUsage` injected:
      - `readUsage` parses a stream holding `session` 20 and `weekly_all` 21, and one holding
        `weekly_all` 21 and `weekly_scoped` 40 (taking `weekly_all`'s 21); and returns `ok: false`
        for a failed run, a timeout, no `usage_report`, `rate_limits: null`, a missing `session`
        row, a stream whose only weekly row is `weekly_scoped`, and a `percent` that is not a
        number;
      - `readSettings` accepts the value in AC-2, and rejects a missing `usageLimits`, a missing or
        extra key at each level, 0, 101 and 70.5;
      - `reviewPullRequest` returns `over-usage` at the limit exactly and one over it, for each
        window, and `usage-unknown`, without installing or starting a session in any of them; and
        reviews as before one under the limit;
      - `dispatchCoder` returns each status without claiming a branch, and `retryStory` without
        installing.
- [ ] **AC-7** — `docs/settings.md` lists `usageLimits` in its table, describes its form in a
      section of its own, and shows it in "This repository's file". Its statement that the file is
      flat apart from `setup` and `check` names `usageLimits` too.
- [ ] **AC-8** — Every `**Planned (ST-31)**` marker in `docs/agent-workflow-design.md` loses
      `ST-31`, and each passage is corrected wherever what was built differs.

## Out of scope

- Reading usage for a tool other than Claude Code, Codex's included: ST-32's open question.
- `loop.mjs` and `story.mjs`'s retries, pausing and resuming: ST-12, which uses this check.
- Stopping a session that is running.
- Watching the `rate_limit_event` messages a running session emits.
- What `init` writes for `usageLimits`.

## Constraints

- Node, ESM, no new runtime dependencies.
- Of what `/usage` returns, nothing is printed, logged or stored beyond each window's `percent`
  and `resetsAt`.

## Context

- **Decided on 2026-10-15 by the owner, with the planning session** (design doc, Part 3, "Decided
  so far", "No session starts while the plan's usage is over a limit"): coders stop at 70% of the
  5-hour window and 75% of the weekly one, reviewers at 90% of each, and an unreadable usage starts
  nothing.
- **The trial behind AC-1** (design doc, "Trials and measurements", "Reading the plan's usage
  from a script", 2026-10-15): `claude -p /usage --output-format stream-json --verbose` cost $0,
  made no model call (0 turns), took about 2 seconds, and returned rows `session` (20%) and
  `weekly_all` (21%) in `usage_report.rate_limits.limits`. Run from Git Bash, `/usage` is
  rewritten into a Windows path unless `MSYS_NO_PATHCONV=1` is set, and the run then goes to the
  model; a run with no shell, as AC-1 asks, is not affected.
- Claude Code documents `usage_report` as experimental, and attaches it only to a session signed
  in with a claude.ai credential that shows its plan type or carries the `user:profile` scope, on
  an account not billed by usage (Agent SDK reference, TypeScript, read 2026-10-15). An API-key
  session never gets it, so under AC-3 and AC-4 it starts nothing: `usage-unknown`.
- `reviewPullRequest` today installs dependencies (`installDependencies`) before the first
  session. `dispatchCoder` claims the branch (`claimPushArgs`) before its install, and
  `retryStory` installs before its session.
- ST-29 also adds a required settings key, `inspectAfterHours`. Whichever lands second merges the
  other.

## Open questions

*(none)*
