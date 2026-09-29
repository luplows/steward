---
id: OQ-101
title: Run the loop on a Windows scheduled task, with a lock, a startup check and a run log
tier: next
kind: workflow
depends_on: [OQ-73, OQ-80, OQ-81, OQ-82, OQ-83, OQ-86]
model: sonnet
blocked: null
---

## Intent

As the owner, I want the loop to wake itself every 15 minutes while my
machine is on, so that a story I hand over with Session A is reviewed, landed
and worked through without anyone starting anything. When nothing is ready, a
run starts no model session and costs nothing. Two runs must never overlap,
an interrupted run must not be tripped over silently, and I want a record of
what each run did.

## Acceptance criteria

- [ ] **AC-1** — **Registering the task.** `node scripts/dispatch/schedule.mjs
      install` registers a Windows scheduled task, and `uninstall` removes it.
      The task:
      - runs the loop's entry point (OQ-86, with OQ-83's reviews) from the
        repository's main checkout, every 15 minutes;
      - starts only when the machine is on mains power;
      - starts no new instance while one is running.

      `install` accepts `--max-stories N` and passes it to every run. The
      command that registers the task is built by an exported function,
      tested without running it: its arguments, the interval, the power
      condition and the no-overlap setting.
- [ ] **AC-2** — **A lock, which a dead holder does not keep.** Every run of
      the loop, scheduled or started by hand, first takes a lock file under
      `%LOCALAPPDATA%\tw-loop\`, recording its process id and start time.
      - A run that finds the lock held by a live process exits at once, with
        status `locked`, having fetched and started nothing.
      - A run that finds a lock whose process no longer exists takes it over,
        and says so (`stale-lock`) in the run log.
      - The lock is released on every exit path, including an error.

      Tests cover a live holder, a dead holder, and release after an error.
- [ ] **AC-3** — **An interrupted run is reported, not tripped over.** After
      taking the lock and before anything else, the loop looks for what an
      interrupted run leaves: a `tw-coder-*` worktree in `git worktree list`,
      or a local `story/*` branch. If it finds either, it writes their names
      to the run log with status `interrupted`, and exits having dispatched and
      reviewed nothing. Tests cover a leftover worktree, a leftover local
      branch, and a clean checkout that goes on.
- [ ] **AC-4** — **A run log.** Every run appends exactly one line to
      `%LOCALAPPDATA%\tw-loop\runs.log`, as one JSON object, whatever its
      outcome, including `locked`, `interrupted` and an error. The object
      holds the start time, the duration, the final status, and one entry per
      action the run took:
      - each pull request reviewed, with its verdict;
      - each pull request landed;
      - each story run, with OQ-48's final status for it.

      A run that did nothing records status `nothing-ready` and no actions.
      Tests cover each of those shapes.
- [ ] **AC-5** — `docs/agent-workflow-design.md`, "Running unattended": every
      `**Planned (…)**` marker that names OQ-101 is resolved as that
      document's "Reading this document" note says.

## Out of scope

- **The usage threshold.** OQ-102.
- **Notifications** beyond the run log, such as a toast or a message to a
  phone. The owner chose the log alone on 2026-09-28.
- **The watchdog**, and anything that runs while the machine is off
  (`docs/agent-workflow-design.md`, "Watchdog").
- **Running on anything but Windows.**
- **Resuming an interrupted story.** AC-3 reports it and stops. Clearing it up
  is the owner's, and resuming a story is OQ-48's AC-9.

## Constraints

- Node, ESM, no new runtime dependencies.
- The scheduled task holds no credential of its own. It runs as the owner,
  as the loop does when started by hand.
- Switching the task on is the owner's step, after this story lands. The
  story delivers `install`; it does not run it.

## Context

- Decided by the owner on 2026-09-28, in the dispatcher session, while
  planning how Session A's pull requests reach the queue:
  - a Windows scheduled task every 15 minutes wakes the loop, and GitHub's
    own cron is not used, because it delivered about 5% of its runs
    (`docs/agent-workflow-design.md`, "Watchdog");
  - the loop's own stops are reported in a local run log only;
  - before the task is switched on, OQ-81 and OQ-82 must be built (nothing
    automatic lands without them), and so must OQ-73 and OQ-80. Hence
    `depends_on`.
- What an interrupted run leaves, stage by stage, is in
  `docs/agent-workflow-design.md`'s failure table ("The dispatcher is
  interrupted mid-story") and OQ-86's AC-4. `dispatchCoder` creates its local
  `story/` branch before the install or the session, and works in a
  `tw-coder-*` directory under the system temp directory.
- OQ-86's AC-6 adds `--max-stories N`, which AC-1 passes through.
- The owner's hand-run review scheduler, `scheduled-reviews.mjs` with a
  one-off Windows task, is the precedent for starting a script from Task
  Scheduler on this machine. It lives outside the repository.

## Open questions

*(none)*
