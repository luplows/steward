# Steward: harness outline

**Status:** draft, being refined with the owner from 2026-10-07, in pull request #199.

The harness is named **steward** (decided 2026-10-07 by the owner; R10 in the design document).

This is the harness's product outline: who it is for, what it is for, and what matters most. It is
to the harness what `Project-Outline.md` is to tower-workshop-paths. It lives here until the
workflow moves to a repository of its own (OQ-115), and becomes that repository's outline on the
day of the move. How the harness works, and the decisions about the move, are in
`docs/agent-workflow-design.md`, which moves with it.

Everything below is the owner's, stated on 2026-10-07, unless it says otherwise.

## What it is

- **A harness that takes units of work through a code, review and merge loop.** It picks up work
  marked ready, codes it, reviews it, and merges it into the mainline branch.
- **It surfaces problems**, probably as GitHub issues, as OQ-112 does for a stuck story.
- **It keeps working while other ready work remains**, up to a point where too much has stopped
  without merging. Today two separate limits come closest: two or more open `loop-stuck` issues
  stop the queue (`STUCK_ISSUE_LIMIT`, `scripts/dispatch/loop.mjs`), and five or more open
  `review-blocked` pull requests narrow what the sweep lands (the circuit breaker in
  `.github/workflows/land-approved.yml`). Neither counts a unit stopped for another reason, such as
  red CI at its own bound, which leaves `blocked:` on a draft pull request with no label and no
  issue. Whether "too much stopped" should be one measure is open.

## Who it is for

**The owner, across the owner's own projects.** The repository is public (R8 in the design
document), so some setup help is worth exposing, but other users are not the main concern.

## Why

**To keep the owner on decisions and ideas, not on code and on reviewing individual tests.** Even
a review-and-land pipeline alone, without the coder, would be worth having.

The cost today runs the other way: the owner's time is going into edge cases in setting up the
harness, so the main project is barely moving. That is why the move to a repository of its own is
wanted sooner rather than later.

## Never

Three things the harness must never do. Each says how it is held today; this restates the code for
readability and must not drift from the files named.

1. **Never merge without a verdict.** Only the sweep merges, and it re-checks that `review/agent`
   is `success` on the head itself before merging (`.github/workflows/land-approved.yml`, "Belt
   and braces"), rather than trusting branch protection.
2. **Never push directly to main.** Every push the dispatcher makes is built by `pushArgs` or
   `claimPushArgs` in `scripts/dispatch/coder.mjs`, and both refuse `main`
   (`assertPlainBranch`). A coder session may not run `git push` (its allowlist grants none and
   denies it), but it can still reach the owner's SSH key. OQ-73 is scoped to the GitHub token and names SSH
   keys out of scope, but its chosen mechanism, a container for coder sessions (decided 2026-10-08,
   built after the move), would close this too. This matters more
   on the second project: its account is on GitHub Free, so nothing on GitHub stops a push to
   `main` there (R6 in the design document).
3. **Always bound the sessions it spawns.** Each session has a spend ceiling (`--max-budget-usd`,
   `ROLE_DEFAULTS` in `scripts/dispatch/invocation.mjs`), a timeout and a stall interval
   (`DEFAULT_TIMEOUT_MS` and `DEFAULT_STALL_MS`, `scripts/dispatch/spawn.mjs`). The spend ceiling
   is a Claude Code flag, so any other company's tool must supply its own bound before it runs a
   role (M1 and M3 in the design document).

## The view

**For deciding what is next, and seeing what is in flight.** For now, one project at a time: the
current one. It may become a product of its own one day, but not now.

It meets two of the design's principles: status is derived, not stored, and tier is priority and
nothing else (R7 in the design document). A view that reads derived status and writes only what
the owner decides (readiness, priority) keeps both.

## Not now

- A view across all projects, or the view as a separate product.
- Publishing to npm (R2 in the design document).
- Setup help beyond what the owner needs, though it is welcome.

## What matters most

In order (confirmed 2026-10-08 by the owner):

1. **The review-and-land pipeline**: every change reviewed against what it was for, and landed
   only on a verdict.
2. **Keeping going**: working through ready work unattended, and surfacing problems where the
   owner will see them.
3. **The view** for deciding what is next and seeing what is in flight.
