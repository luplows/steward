---
id: ST-101
title: Hide Windows console windows during coordinator-run coding
tier: fix
kind: product
depends_on: [ST-93]
model: null
blocked: null
---

## Intent

As a crew member running steward's coordinator on Windows, I want an approved handoff to be coded
without console windows flashing on my desktop, so that unattended coding is as unobtrusive as
unattended review already is (ST-70).

## Acceptance criteria

- [x] **AC-1** — The Git helper `git` in `scripts/dispatch/coder.mjs` supplies `windowsHide: true`
      in its Node child-process options. `gitOrNull` and `remoteTip`, and every other caller,
      inherit it through that helper.
- [x] **AC-2** — A regression test in `scripts/dispatch/windows-hide.test.mjs`, alongside
      ST-70's, calls `coder.mjs`'s `git` with `execFile` replaced, and fails if `windowsHide: true`
      is missing. It asserts the command, the arguments (`-c core.quotepath=off` and then the
      caller's), the working directory and `maxBuffer` as well. It needs no repository, GitHub or
      model session.
- [x] **AC-3** — The changed call still runs the same command with the same arguments, working
      directory, environment (the caller's `env` merged over `process.env`, when one is given),
      `maxBuffer` and output and error handling. The fix changes whether a window is visible, and
      nothing about branches, commits, pushes or credentials.

## Out of scope

- Console windows opened by the coder session itself or its descendants, such as the Claude CLI's
  or Codex's own tool processes. ST-70 left the reviewer's descendants out in the same way.
- The Git helpers of `loop.mjs`, `story.mjs`, `rotation.mjs`, `story-containment.mjs` and
  `attribution-check.mjs`, which the coordinator's handoff coding does not call, and
  `init.mjs`'s synchronous helper, which ST-70 also left alone.
- A shared child-process wrapper, or any change to manual terminal commands.
- Changing the coordinator's start, process lifetime, recovery or stop.

## Constraints

- The supported case is the one ST-70 states: one OS user running one detached coordinator on
  Windows. The scope is the direct child processes steward starts while the coordinator codes a
  handoff.

## Context

- Reported during the 0.3.0 release review's coding step on 2026-11-16. The coordinator, started
  from the candidate `d90d7e9` of `release/v0.3.0`, was coding handoff H-1 for
  tower-workshop-paths, and the crew saw console windows open. The crew chose to fix this for
  0.3.0 before the tag. The report is an observation, and it does not say which process each
  window belonged to.
- The coordinator runs `handoff-coder.mjs`, which imports `git`, `gitOrNull`, `remoteTip`,
  `claimBranch`, `commitSessionWork`, `pushBranch`, `readGitIdentity` and `cleanUp` from
  `scripts/dispatch/coder.mjs`. Each runs Git through `coder.mjs`'s `git` helper, whose
  `execFile` call passes no `windowsHide` (`git grep -n "execFileAsync('git'"
  scripts/dispatch/coder.mjs`).
- Already hidden on that path: the coder session (`scripts/dispatch/spawn.mjs`), the Codex coder
  (`codex.mjs`), the project's `setup` (`install.mjs`), the coordinator's owned-checkout update
  (`project.mjs`), and the coordinator's own detached process (`coordinator.mjs`).
- ST-70 (`stories/done/ST-70-hide-console-windows-during-automatic-review.md`) made the same change for
  automatic review, and its tests are in `scripts/dispatch/windows-hide.test.mjs`, which replaces
  `execFile` through `vi.mock('node:child_process')`.
- Once the fix reaches the release branch, the release review runs the coding step again and
  watches for windows. That is the evidence a desktop gives, which a diff cannot.

## Open questions

*(none)*
