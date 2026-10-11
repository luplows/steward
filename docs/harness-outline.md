# Steward: harness outline

> **OQ numbers.** This document was written in tower-workshop-paths, and moved to steward with its
> history. An `OQ-<n>` in it means a tower-workshop-paths story, found in that repository's
> `stories/done/` or `Completed-Questions.md`. Steward's own stories are numbered `ST-<n>`.

**Status:** draft, being refined with the owner from 2026-10-07: in pull request #199, which
merged on 2026-10-08, and now in #248.

The harness is named **steward** (decided 2026-10-07 by the owner; R10 in the design document).

This is the harness's product outline: who it is for, what it is for, and what matters most. It is
to the harness what `Project-Outline.md` is to tower-workshop-paths. It lives here until the
workflow moves to a repository of its own (OQ-115), and becomes that repository's outline on the
day of the move. How the harness works, and the decisions about the move, are in
`docs/agent-workflow-design.md`, which moves with it.

Everything below is the owner's, stated on 2026-10-07, unless it says otherwise.

## What it is

Revised 2026-10-10 by the owner, from the end goal ("Defining steward", "What steward is for"). The
first two bullets replace "A harness that takes units of work through a code, review and merge
loop", stated on 2026-10-07; the last two are unchanged.

- **A path from a ready unit of work to a merged change: automated coding and review, merged only
  on a verdict.** It takes units marked ready, starting them in the order the project sets, codes
  them, has each pull request reviewed against its unit and the project's rules, and merges it on
  a passing verdict once its checks have passed.
- **It does not plan the work**, and it need not be the only way work is done in a project. Units
  come from however the project plans; readiness and priority are the project's settings.
- **It surfaces problems**, probably as GitHub issues, as OQ-112 does for a stuck story.
- **It keeps working while other ready work remains**, up to a point where too much has stopped
  without merging. Today two separate limits come closest: two or more open `loop-stuck` issues
  stop the queue (`STUCK_ISSUE_LIMIT`, `scripts/dispatch/loop.mjs`), and five or more open
  `review-blocked` pull requests narrow what the sweep lands (the circuit breaker in
  `.github/workflows/land-approved.yml`). Neither counts a unit stopped for another reason, such as
  red CI at its own bound, which leaves `blocked:` on a draft pull request with no label and no
  issue. Whether "too much stopped" should be one measure is open; the owner's view is that the
  two loops should probably stop together ("Defining steward", "Loops").

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
   denies it), but it can still reach the owner's SSH key. OQ-73 is scoped to the GitHub token and
   names SSH keys out of scope, but its chosen mechanism, a container for coder sessions (decided
   2026-10-08, built after the move), would close this too. This matters more on the second
   project: its account is on GitHub Free, so nothing on GitHub stops a push to `main` there (R6
   in the design document).
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

Revised 2026-10-10 by the owner. The MVP, in order:

1. **Review you can trust**: every pull request reviewed against its unit and the project's rules,
   and merged only on a verdict, once its checks have passed. It installs on its own, with little
   to configure.
2. **Automated coding**: coders take ready units, and pull requests whose latest verdict is a
   block, in the order the project sets. Each runs the project's check command before its work is
   pushed. A project opts in.
3. **Keeping going**: working through ready work unattended, and surfacing problems where the
   owner will see them.

After the MVP, in order:

1. **The view**, for deciding what is next and seeing what is in flight.
2. **Parallel work**, on one machine or several.
3. **Looking back**: a walkthrough of the product, if that is steward's at all.

Superseded: the order confirmed on 2026-10-08 by the owner was the review-and-land pipeline, then
keeping going, then the view. The revision names the coder, which that order left implied, draws
the MVP line, and moves the view below it, ahead of parallel work (owner, 2026-10-10).

## Defining steward

Started 2026-10-09 by the owner with Session A, after the move was paused to define steward first
(design doc, "Portability", "Decided so far"). The sections above say who steward is for and why;
this one works out what it does, and where it ends and a project begins. It follows "What matters
most", so it starts with review and land. Each statement is the owner's, dated, unless it says
otherwise; what is still open says so.

### What steward is for

- **The end goal** (owner, 2026-10-10, talked through to give the priorities a direction): to plan
  work with one or more agents and hand it to coders to carry out; to have that work reviewed
  before it merges, so the owner can trust what is delivered; to set the priority of work, so that
  several ready items are worked through in order; to run work in parallel, to deliver more sooner;
  and to look back at what has been done, so the owner keeps in touch with the state of the
  project. Not all of it need be steward's: working out which is the point of this section.
- **Steward's purpose is to provide a path to automated code and review** (owner, 2026-10-10). It
  does not dictate how a project plans its work, and it need not be the only way work is done in a
  project. So steward does not provide a planning session: it takes units however they were
  planned, and readiness is the project's setting (Loops, below). Considered and not chosen:
  steward shipping a planning session, as tower-workshop-paths has in Session A
  (`docs/session-a.md`).
- **Tests and CI are an important part of review, but steward does not require a test structure**
  (owner, 2026-10-10). A possibility: a hook into a CI script that the project configures. How
  the hook sits with "Steward enforces nothing about CI" was taken up the same day: see that line's
  revision (Land, below). For reference (Session A, from `main` at `b2a02bf`): the reviewer's
  prompt assumes `npm test` (`reviewer.md`, lines 78, 220 and 234), and both sessions start from
  `npm ci` (`install.mjs`, line 20), which no project setting changes: `settings.mjs` accepts no
  key beyond `repo` and `storyPrefix` (line 20).
- **Priority is probably the order in which work is started, since the order it finishes in is not
  deterministic** (the owner's leaning, 2026-10-10, still to be thought through). For reference
  (Session A, from `main` at `b2a02bf`): tower-workshop-paths orders ready stories by `tier`, then
  lowest id (`stories/README.md`, line 129).
- **Parallel work, on one machine or across several, is wanted but is not in the MVP** (owner,
  2026-10-10). For reference (Session A, from `main` at `b2a02bf`): the dispatcher runs one story
  at a time, and the design doc names a merge queue as required before parallel dispatch (line
  1013).
- **Looking back is ideally a walkthrough of the product** (owner, 2026-10-10). Whether it is
  steward's is open. Tower-workshop-paths' design has Session B for this, a periodic walkthrough of
  `main` that ends in a release tag (design doc, "The shape"), but it has not yet run there, so its
  scope is unknown (owner, 2026-10-10); `origin` has no tags (Session A, 2026-10-10).
- **"What it is" and "What matters most", above, were revisited in light of these** (Session A,
  2026-10-10, who noted they put review and land first, left the coder implied, and mentioned
  neither planning, priority, parallel work nor looking back). The owner revised both the same day,
  from a draft by Session A.

### Review

- **When a pull request appears, a reviewer is spawned to check that it implements what it is
  supposed to** (owner, 2026-10-09). Left deliberately broad at first, since the specifics bear on
  other decisions.
- **The minimum steward needs from a project is the unit of work a pull request implements**
  (owner, 2026-10-09). Steward is not particular about the unit's form: the reviewer reads it as
  written, and steward does not parse it, lint it, or require acceptance criteria of it.
  **Refined 2026-10-10 by the owner, as for CI:** steward could be configured to lint a project's
  units, but does not ship with that turned on. A project's own story tooling, such as
  tower-workshop-paths' story lint and story containment, stays the project's (design doc,
  "Portability", "Decided so far").
- **A pull request points at its unit with a link** (owner, 2026-10-09). Steward reads two kinds: a
  file in the repository, from the checkout, and a GitHub issue (owner, 2026-10-09). Other kinds,
  such as a Jira item, are a future improvement. The base install requires the link for code changes
  only, and stops hard when it is missing or cannot be read (owner, 2026-10-09). The stop is a
  section of the example rules file, not a check steward makes before the review: the reviewer
  decides what is a code change, as it decides which sections apply, and a project can change the
  condition (owner, 2026-10-09). The cost is a review session for a pull request without a link. Two
  other ways of finding the unit were considered: the project's settings name one of a few lookups
  steward provides, or the project supplies its own lookup. For reference (Session A, from `main` at
  `b2a02bf`): in tower-workshop-paths the diff is the pointer. `review.mjs`'s `resolveStory` takes
  the unit to be the story file the diff moves into `stories/done/`, refuses a pull request whose
  `story/` branch names a story its diff does not move, and refuses one that moves two.
- **A pull request that implements no unit is still reviewed, against the project's own rules**
  (owner, 2026-10-09, raised for a write-story pull request; tower-workshop-paths could not work
  otherwise). In tower-workshop-paths today such a pull request is reviewed against `REVIEW.md`'s
  general items only, and against items 20 to 25 when it changes `stories/` (`reviewer.md`, "The
  story this PR is meant to implement").
- **One reviewer prompt, steward's; the rules are the project's, in sections that each say when
  they apply; and the reviewer names the sections it applied** (owner, 2026-10-09, asked whether
  instructions should differ for a code change and a docs change). The prompt holds what is the
  same in every project, how to review; a project's rules say what good means there. Steward does
  not sort pull requests into kinds itself: the reviewer decides which sections apply, and naming
  them in its verdict shows when one was skipped.
- **Steward gives an adopting project an example rules file**, with a basic set of sections and
  conditions that the project modifies and adds to (owner, 2026-10-09).
- **The example is a copy: once adopted, the project owns its rules file** (owner, 2026-10-09).
  Steward keeps update notes on what changes in the example between versions. A tool that compares
  a project's rules file with the example in the version it pins is a possibility, not decided
  (owner, 2026-10-09). Considered and not chosen: steward's default sections shipped in the package,
  which a project's file extends or switches off.
- **What the example rules file contains is left for later** (owner, 2026-10-09).

### Land

- **Steward enforces nothing about CI** (owner, 2026-10-09). The lander relies on the project's
  own settings for when a pull request may merge, and nothing in steward uses CI to decide when to
  go on: tower-workshop-paths' `story.mjs` waits for the `ci.yml` run before it reviews
  (`waitForCi`), and that wait goes.
- **Revised 2026-10-10 by the owner: steward cannot enforce CI at install, because it does not know
  what the project uses, but it could once it learns what the project wants.** The line above
  stands for what steward assumes at install; these refine it (owner, 2026-10-10):
  - **Steward learns it from the project's steward settings.** Considered and not chosen (Session
    A's list): `init` detecting the setup with nothing written down; reading the required checks
    from GitHub's branch protection or rulesets, which an unprotected repository does not have
    (R6); and describing it in the rules file, which steward itself cannot act on.
  - **`init` writes default entries, then explores the repository to surface options, as a
    deterministic script**, so it does not learn from prose. What it explores is open.
  - **Two ways to set up, later: one declarative, which runs without AI, and one meant to be run
    with an AI helper** (owner, 2026-10-11), since steward is meant to be used with AI tools. Noted
    for later and not yet refined: what each covers, and how the second sits with the bullet
    above, which makes `init` a deterministic script.
  - **The lander waits for the checks the settings name**: kept, as the next bullet says.
  - **Steward does not wait for CI before it starts a review, and does wait for all checks before
    it lands** (owner, 2026-10-10, after first being on the fence: a coder's work almost always
    passes CI, and when it does not, the cause is usually the coder's configuration). So today's
    `waitForCi` goes, as the line above already says. "All checks" means the checks the project's
    settings name, and the default is still every check (owner, 2026-10-10, asked whether the
    project's choice goes). What follows (Session A, 2026-10-10): the reviewer can read only the
    CI results that have finished when it looks.
  - **The reviewer may read the CI results, but does not run CI itself**: GitHub already does.
  - **Revised 2026-10-11 by the owner: the review and CI are two peer checks on the same head,
    joined at the merge.** Neither feeds the other. CI answers whether the head builds and its
    checks pass; the reviewer answers whether it does what its unit asked, by the project's rules;
    and the lander merges only once the checks the settings name, `review/agent` among them, are
    green. Asked how the reviewer and CI work in tandem, after Session A noted that GitHub has no
    notion of CI of its own, only checks on a commit (check runs, such as each GitHub Actions job,
    and commit statuses), and that `review/agent` is already one: `review-gate.yml` posts it as a
    commit status, beside the `test` job of the workflow this repository names `CI` (`ci.yml`).
    Considered and not chosen (Session A's proposal): the dispatcher handing the reviewer a
    snapshot of the head's checks, with a log excerpt for each failed job, as it hands it the pull
    request body. What follows (Session A, 2026-10-11): the reviewer is not given CI results, and
    a red check the settings name stops the merge whatever the verdict.
  - **The reviewer does not run the project's whole check command; it runs only the narrower
    commands that settle a particular claim**, such as one test file, a search or a diff of one
    path (owner, 2026-10-11, from Session A's recommendation). CI, as the peer check, already shows
    whether the checks pass, and on a bigger project the whole command can take a long time. The
    owner accepts what follows: a pull request body that claims a count of passing tests is no
    longer checked against a run of its own by the reviewer, and a false count is stopped only at
    the merge, by the red check, not reported as a finding. Considered and not chosen: the
    reviewer running the whole check command, as `reviewer.md` tells it to run `npm test` today
    ("Verify rather than accept", line 219).
  - **The coder runs the project's check command before its work is pushed**, which also makes the
    wait before the review matter less. For reference (Session A, at `4f2f0fd`): in
    tower-workshop-paths the coder session commits and the dispatcher pushes (`pushBranch`,
    `coder.mjs` line 233). The prompt asks the session to report `ready` only when "the suite is
    green" (`coder.md`, line 276), but in prose that names no command, and the dispatcher runs no
    check before it pushes. **The coder session runs it, so that it can make changes when the check
    fails; steward's own script does not run it again before the push, since on a bigger project
    the check can take a long time** (owner, 2026-10-10). Considered and not chosen: steward's
    script running it, alone or as well. What follows (Session A, 2026-10-10): nothing
    deterministic runs the check before the push, so a coder that skips it is caught only by the
    checks the lander waits for, which is only where the project has CI.
  - **Whether a project must have CI at all is open.** The owner leans against making CI a
    prerequisite, but every project of the owner's will have CI, so requiring it is possible.
  - **The command that prepares a fresh checkout goes in the settings beside the check command,
    and steward calls it `setup`** (owner, 2026-10-10, from Session A's proposal). Considered and
    not chosen: `install`, which names only a dependency install, where a project may need more,
    such as generating code. For reference (Session A, from `main` at `b2a02bf`): today it is
    `npm ci`, which `install.mjs` calls "the dependency install both dispatched sessions start
    from" (lines 2 and 20), and tower-workshop-paths' CI runs it as `'Setup: npm ci'` (`ci.yml`,
    line 32).
- **A project says in its steward settings which checks must pass before the lander merges**, and
  installing steward writes the default, **every check on the head green** (the owner leaned this
  way on 2026-10-09, and confirmed it on 2026-10-10). This was asked for a repository with no
  branch protection, where GitHub enforces nothing and anyone with write access can merge or push
  to `main` (design doc, R6). For reference (Session A, from `main` at `b2a02bf`): the lander
  merges only when GitHub reports `mergeable_state` `clean` (`land.mjs` line 191,
  `land-approved.yml` line 145), so today a failing check that is not required stops it too. Two
  other ways were considered: merge whenever GitHub allows, which on an unprotected repository
  means on the verdict alone; and keep requiring `clean` as steward's own rule.
- **What installing steward sets up** (owner, 2026-10-09, asked what can record and enforce a
  verdict, and what to do if the answer is nothing):
  - It always writes the gate's workflow files (the one that turns the reviewer's verdict into the
    `review/agent` status, and the sweep), the labels the sweep reads, the project's steward
    settings with the default merge rule, and the example rules file.
  - Where GitHub offers branch protection, it offers to set it, and asks first: it changes the
    repository's settings.
  - It offers a watchdog, never forces it, as it offers branch protection: a check that opens an
    issue for any merge to `main` without a passing verdict (design doc, "Watchdog", which
    describes it and is not built).
  - Where GitHub offers no branch protection, as on a private repository on GitHub Free, it says
    plainly that nothing on GitHub enforces the gate. Steward's own sweep still checks the verdict
    on the head before each merge it makes (`land-approved.yml`, "Belt and braces").
  - Open: whether GitHub's rulesets are available where branch protection is not. Only the branch
    protection limit is recorded (design doc, R6).

### Loops

- **A review loop and a coding loop, separately** (the owner's idea, 2026-10-09; decided by the
  owner on 2026-10-10, for now, to see how it plays): the coder picks up work, and the reviewer
  picks up any open pull request. How a coder picks up the reviewer's feedback was taken up on
  2026-10-09, in the bullets below. Considered and not chosen: one run taking a unit through
  coding, review and retry, which is what tower-workshop-paths does. For reference (Session A,
  from `main` at `b2a02bf`): today one run of `story.mjs` takes a story through coder, CI, review
  and retry, and `writer-prs.mjs` already reviews and lands the open pull requests the loop did not
  open.
- **The review side is a review-and-land dispatcher, not a loop that keeps running** (owner,
  2026-10-11, asked how the review loop is shaped). It decides which pull requests get a reviewer
  and spawns them, and lands what has passed. It runs on a defined trigger, one **pass** per run,
  and does not run all the time, so that each run picks up updates to steward. Considered and not
  chosen: a process that keeps running and polls, which keeps the code it loaded at start. Which
  trigger is open; until one is built, the dispatcher session starts each run. A pass, as Session
  A defined it the same day and the owner accepted:
  1. Bring the dispatcher's own worktree to `origin/main`, detached, and stop if it has anything
     uncommitted.
  2. List the open pull requests against `main` once. One opened later waits for the next pass.
  3. Oldest first, review each that is not a draft, is from an author the gate honours, and has
     no verdict at its current head, up to a cap on reviews per pass (below).
  4. Land each pull request with a passing verdict at its head that is safe to merge at that
     moment, one at a time, since the sweep lands one per run. One whose checks are still running
     or are red is left alone.
  5. Exit, carrying nothing forward: the next pass derives everything again from GitHub.
- **Landing never waits** (owner, 2026-10-11). A pass checks once whether each passed pull
  request is safe to merge, and leaves one that is not for a later pass. Landing can be retried
  freely, by any later pass, for as long as the pull request is reported safe to merge.
  Considered and not chosen: waiting, as `land.mjs` does today, polling until the pull request is
  landable within its bounds (`BLOCKED_BOUND_MS`, `MAX_TOTAL_WAIT_MS`). What follows (Session A,
  2026-10-11): once reviews stop waiting for CI, a pull request can pass review before its checks
  finish. In `writer-prs.mjs` as it is, a pull request whose landing gave up would never be landed,
  since a later call skips any pull request that has a verdict at its head; retrying the landing
  in every pass closes that.
- **A pass reviews at most a set number of pull requests** (owner, 2026-10-11), so that a whole
  pass, not only each session, has a ceiling on what it spends. Session A suggested 5, set on the
  command line. The owner expects rarely to have more than a couple of pull requests in flight.
- **One machine runs the review side, for now** (owner, 2026-10-11). Several machines are wanted
  later, and the pass is built so that adding them is small. Ideas kept for then, none decided:
  - landing is already safe across machines: each trigger names its pull request, and the sweep
    re-checks it before merging;
  - reviewing is the exposure, since two machines could review the same head and both pay, though
    `review.mjs` notices the race before recording a verdict. A pass could first post a claim
    comment naming its machine (`TW_MACHINE_LABEL`), the head and the time, and other passes
    would skip a head with a fresh claim (Session A, 2026-10-11);
  - or one machine runs the one authoritative dispatcher, which farms reviewer and coder sessions
    out to other machines (the owner's idea, 2026-10-11).
- **A pull request does not belong to a coder** (the owner's view, 2026-10-09, asked how a coder
  picks up the reviewer's feedback): any coder can take a pull request, read its linked unit and
  its review findings, and make the changes asked for. So a pull request whose latest verdict is a
  block is work, as a ready unit is, and the round bound, counted from the pull request's own
  blocking verdicts, needs no owner.
- **By default a coder may take any ready unit, and any pull request whose latest verdict is a
  block, with the review's findings available to it** (owner, 2026-10-09), so that steward is easy
  to set up.
- **A coder claims its work with a claim commit, at first** (owner, 2026-10-09), as
  tower-workshop-paths does for a story (`coder.mjs`'s `claimPushArgs`, OQ-110). On a blocked
  pull request the claim is a push that requires the branch to be still at the blocked head, so
  only one of two racing coders succeeds (Session A, 2026-10-10). The owner accepts what follows
  (2026-10-10): the claim moves the head, so the block is no longer at the head and no other coder
  takes the pull request, and `review/agent` is cleared until the next review; and the claim
  commit stays in the pull request's history, though not in `main`'s once the sweep squashes it.
- **Coder work always needs a unit** (owner, 2026-10-09): a pull request with no unit is reviewed,
  but no coder takes it.
- **Coders picking up work is opt-in, and what makes a unit ready is the project's setting**
  (owner, 2026-10-10). Review installs with its rules predefined and little to configure; the
  coder does not, since there is no way to ship readiness with installation alone. The default
  above applies to a project that has opted in.
- **The two loops should probably stop at the same time, so that a backlog of unreviewed pull
  requests does not build up** (the owner's view, 2026-10-10, asked whether each loop stops on its
  own measure or both on one). What counts as too much stopped, and how each stop reaches the
  owner, are open.
