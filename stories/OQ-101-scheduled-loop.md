---
id: OQ-101
title: Run the loop on a Windows scheduled task, with a lock, a startup check and a run log
tier: next
kind: workflow
depends_on: [OQ-73, OQ-80, OQ-81, OQ-82, OQ-83, OQ-86, OQ-109, OQ-110, OQ-111, OQ-112]
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
        loop's own worktree (OQ-109), every 15 minutes;
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
      interrupted run leaves: a `tw-coder-*` worktree in `git worktree list`.
      For each one it finds, it:
      - makes sure there is an open issue for it, in the same way and with
        the same title, label and no-duplicate rule as OQ-112's AC-4. The
        title is `Loop: <OQ-n> is stuck` when the worktree is on a
        `story/OQ-<n>-*` branch, and `Loop: leftover worktree <directory
        name> is stuck` otherwise. The body names the machine label (OQ-110's AC-8), the worktree's
        path, its branch, and the paths `git status --porcelain` reports in
        it;
      - records it as an action in the run log (AC-4);
      - leaves the worktree as it is.

      The run then goes on. A worktree's story is skipped by OQ-110's and OQ-111's rules,
      because the branch is on `origin` or local. A leftover local
      `story/*` branch is OQ-111's to push and skip, and OQ-112's to report, not this
      check's. Tests cover a leftover worktree on a story branch, which gets
      an issue while the run goes on, an existing issue left alone, and a
      clean checkout.
- [ ] **AC-4** — **A run log.** Every run appends exactly one line to
      `%LOCALAPPDATA%\tw-loop\runs.log`, as one JSON object, whatever its
      outcome, including `locked` and an error. The object holds the start
      time, the duration, the final status, and one entry per action the run
      took:
      - each leftover worktree found (AC-3), with its issue;
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
  phone. The owner chose the log alone on 2026-09-28. A stuck story and a
  leftover worktree are the exceptions: OQ-112 and AC-3 raise them as GitHub
  issues (decided 2026-10-01).
- **The watchdog**, and anything that runs while the machine is off
  (`docs/agent-workflow-design.md`, "Watchdog").
- **Running on anything but Windows.**
- **Resuming an interrupted story**, or removing its worktree. AC-3 reports
  it and goes on. Clearing it up is the owner's, and resuming a story is
  OQ-48's AC-9.

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
  - the loop's own stops are reported in a local run log only. On
    2026-10-01 the owner added GitHub issues for stuck stories (OQ-110, since split into OQ-110 to OQ-112), and
    gave the loop its own worktree (OQ-109);
  - before the task is switched on, OQ-81 and OQ-82 must be built (nothing
    automatic lands without them), and so must OQ-80 and the stories that
    put coder sessions in a container. OQ-73 is now the spike that recommends
    those stories (rewritten 2026-10-09); its `depends_on` entry stands for
    them until Session A repoints it (OQ-73's AC-4). Hence `depends_on`.
- What an interrupted run leaves, stage by stage, is in
  `docs/agent-workflow-design.md`'s failure table ("The dispatcher is
  interrupted mid-story") and OQ-86's AC-4. `dispatchCoder` creates its local
  `story/` branch before the install or the session, and works in a
  `tw-coder-*` directory under the system temp directory.
- AC-3 cannot tell a leftover worktree from one a hand-run on the same
  machine is using at that moment. The lock (AC-2) covers only runs of the
  loop. Such a run's worktree is reported too. This is a known limit,
  expected to be rare, since hand-runs seldom overlap the scheduled loop.
- OQ-86's AC-6 adds `--max-stories N`, which AC-1 passes through.
- The owner's hand-run review scheduler, `scheduled-reviews.mjs` with a
  one-off Windows task, is the precedent for starting a script from Task
  Scheduler on this machine. It lives outside the repository.

## Open questions

*(none)*
