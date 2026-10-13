# Steward: harness outline

> **OQ numbers.** This document was written in tower-workshop-paths, and moved to steward with its
> history. An `OQ-<n>` in it means a tower-workshop-paths story, found in that repository's
> `stories/done/` or `Completed-Questions.md`. Steward's own stories are numbered `ST-<n>`.

> **Session names.** The planning session was called Session A, and the release review Session B,
> until 2026-10-12 (owner). Older commits and pull requests, and tower-workshop-paths, use those
> names.

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

**Revised 2026-10-12 by the owner: any trusted contributor to a project can use steward**, not
only its owner, so steward's design names the people it serves by their role, the crew
(`docs/glossary.md`), rather than as one owner. The code already works this way: the gate honours
any author whose association is `OWNER`, `MEMBER` or `COLLABORATOR` (`HONOURED_ASSOCIATIONS`,
`scripts/land/check-author.mjs`). Unchanged: the projects are the owner's own, and other people's
projects are not the main concern.

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

Started 2026-10-09 by the owner with the planning session, after the move was paused to define
steward first (design doc, "Portability", "Decided so far"). The sections above say who steward is
for and why; this one works out what it does, and where it ends and a project begins. It follows
"What matters most", so it starts with review and land. Each statement is the owner's, dated, unless
it says otherwise; what is still open says so.

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
  steward shipping a planning session, as tower-workshop-paths has in its Session A
  (its `docs/session-a.md`).
- **Tests and CI are an important part of review, but steward does not require a test structure**
  (owner, 2026-10-10). A possibility: a hook into a CI script that the project configures. How
  the hook sits with "Steward enforces nothing about CI" was taken up the same day: see that line's
  revision (Land, below). For reference (the planning session, from `main` at `b2a02bf`): the
  reviewer's prompt assumes `npm test` (`reviewer.md`, lines 78, 220 and 234), and both sessions
  start from `npm ci` (`install.mjs`, line 20), which no project setting changes: `settings.mjs`
  accepts no key beyond `repo` and `storyPrefix` (line 20).
- **Priority is probably the order in which work is started, since the order it finishes in is not
  deterministic** (the owner's leaning, 2026-10-10, still to be thought through). For reference
  (the planning session, from `main` at `b2a02bf`): tower-workshop-paths orders ready stories by
  `tier`, then lowest id (`stories/README.md`, line 129).
- **Parallel work, on one machine or across several, is wanted but is not in the MVP** (owner,
  2026-10-10). For reference (the planning session, from `main` at `b2a02bf`): the dispatcher runs
  one story at a time, and the design doc names a merge queue as required before parallel dispatch
  (line 1013).
- **Looking back is ideally a walkthrough of the product** (owner, 2026-10-10). Whether it is
  steward's is open. Tower-workshop-paths' design has its Session B (here, the release review) for
  this, a periodic walkthrough of `main` that ends in a release tag (design doc, "The shape"), but
  it has not yet run there, so its scope is unknown (owner, 2026-10-10); `origin` has no tags (the
  planning session, 2026-10-10).
- **"What it is" and "What matters most", above, were revisited in light of these** (the planning
  session, 2026-10-10, who noted they put review and land first, left the coder implied, and
  mentioned neither planning, priority, parallel work nor looking back). The owner revised both the
  same day, from a draft by the planning session.

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
  steward provides, or the project supplies its own lookup. For reference (the planning session,
  from `main` at `b2a02bf`): in tower-workshop-paths the diff is the pointer. `review.mjs`'s
  `resolveStory` takes the unit to be the story file the diff moves into `stories/done/`, refuses a
  pull request whose `story/` branch names a story its diff does not move, and refuses one that
  moves two.
- **Refined 2026-10-11 by the owner: how the link is written and read.**
  - **The dispatcher finds the link deterministically**, by parsing the pull request body, so that
    no model is involved: a line `Unit: <link>`, or, for an issue, one of GitHub's closing keywords
    (`Closes #n`). Considered and not chosen: going on inferring the unit from the diff, as
    `resolveStory` does today. It could be deterministic too, but it fits only one project's story
    convention.
  - **A file unit is a path in the repository, read from `main`**, not from the pull request's
    head: the unit as it stood before the work, which the pull request cannot edit into agreement
    with itself. The reviewer still sees any edit to it in the diff. A path means steward stores
    nothing about where a project keeps its units.
  - **The link may point only into this repository**: a file in it, or one of its issues.
  - **A pull request whose link is missing is still reviewed, and the review does not pass. The
    reviewer decides that, not the dispatcher**, by the project's rules, as the bullet above has
    it (owner, 2026-10-11, asked whether steward should record the block itself): only judgment
    can tell a code change from a docs change, and a pull request that writes the document it
    would link to has nothing to link. The dispatcher tells the reviewer, deterministically, which
    of four it found: a link it read, a link it could not read and why, `Unit: none`, or no
    `Unit:` line at all. Considered and not chosen: the dispatcher recording `block` itself for
    any pull request with no readable link.
  - **`Unit: none` says the pull request implements no unit** (owner, 2026-10-11), so the reviewer
    judges only whether that is believable for the diff, rather than guessing. Open: whether and
    how the line is required. The planning session's options: the pull request template carries it;
    the dispatcher always writes it on a pull request it opens; or a check on the pull request body,
    posted by steward's gate, fails without it, which would sit with "Steward enforces nothing
    about CI" (Land, below).
  - **A setting lists the kinds of link a project uses** (owner, 2026-10-11): `issue` (`Unit: #n`
    or a closing keyword), `file` (`Unit: <path>`) and `other` (`Unit:` and any text, which the
    dispatcher passes to the reviewer unread, so that a link into another tracker works without an
    integration). A list, not one value, since a project may use more than one kind. An empty list
    means the project links no units: the reviewer works from the pull request body and the rules.
    A missing setting is an error that names it, as every setting is in `settings.mjs` today,
    so that "never decided" is not taken for "no units". This is not one of the lookups considered
    on 2026-10-09 (bullet above): the pull request still points at its unit, and the setting says
    only which kinds of pointer steward reads. What follows (the planning session, 2026-10-11): a
    coder can take work only from `issue` or `file`, since coder work always needs a unit it can
    read (Loops, below), so a project with only `other`, or none, is review-only. Open: the default
    `init` writes.
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
- **What the example rules file contains is left for later** (owner, 2026-10-09). **Begun
  2026-10-11 by the owner**, going through steward's own `REVIEW.md` section by section with
  the planning session: the example leaves out what is one project's choice, which a project adds to
  its own copy, while steward's own `REVIEW.md` keeps it. Left out of the example so far:
  - a Docs check on named files: steward's keeps it for `README.md`, since steward's README is to
    be a large part of what it delivers. The owner's reason for leaving it out: the drift it
    guarded against in tower-workshop-paths has mostly gone, now that other places record what
    used to drift;
  - no coverage tooling, which is a project's own rule;
  - a particular way of marking a unit done, such as ticking acceptance criteria or moving a
    story file into `stories/done/`, since steward does not impose how a project manages
    completed units.

  Decided the same day for steward's own `REVIEW.md` (owner, from the planning session's proposals;
  its sections are ST-21's AC-5):
  - today's item 1, "the work is on a feature branch with a pull request; nothing was pushed
    directly to `main`", is dropped: a reviewer only ever sees a pull request, and a direct push
    is never reviewed, so it can neither break nor catch it. Branch protection, or on a
    repository without it the watchdog, is what guards `main`; `CLAUDE.md` (now `AGENTS.md`) keeps
    the rule for sessions;
  - "Every pull request" gains a claims item: statements a pull request adds about how the
    repository works, in documents, comments, commit messages or its body, are true at its
    head. Today only a story's claims are checked (item 22). Considered and not chosen: leaving
    the body's statements to "Integrity" alone. Not in the example: it is the discipline
    steward's own project chose (`CLAUDE.md`, now `AGENTS.md`, "Claims about this repository");
  - "Changes to code" applies to workflow files and prompts as well as code and tests, to start
    with;
  - a code change must link its unit, `Unit: none` being accepted only where no unit could
    exist, such as a pull request that writes the unit; added once the reviewer is given the
    unit note (ST-22).
- **The rules file's shape** (owner, 2026-10-11, from the planning session's proposals):
  - **The reviewer reads the rules from `main`**, put into its prompt by the dispatcher, not from
    the pull request's head, so that a pull request cannot loosen the rules it is judged by. A
    change to the rules is still in the diff for the reviewer to see. For reference (the planning
    session, 2026-10-11): today `reviewer.md` tells the reviewer to read `REVIEW.md` in its checkout
    (line 171), which is the pull request's head.
  - **The file holds rules only.** How steward works (the verdict marker, the three verdicts, a
    review with no verdict, what the gate's workflow enforces, how the coder's pull request is
    opened) goes in the reviewer's prompt and steward's own documents. The owner's reason: today's
    `REVIEW.md` grew those parts because it was the living process the reviewer was built from.
    "Reading the PR body" is a rule, so it stays, as a section of the example file.
  - **A section is a heading, then one `Applies when:` line in plain words, then its items.** The
    reviewer judges the line, and a section without one always applies.
  - **Each section numbers its own items, and a finding cites the section and the item** (owner,
    2026-10-11). Steward cannot control how a project adds its own rules to the file, so it does
    not impose one numbering across it. Considered and not chosen (the planning session's proposal):
    integers across the whole file, never renumbered, which would have kept the verdict format as it
    is. What follows (the planning session, 2026-10-11): the verdict's `item`, an integer
    `review.mjs` checks today (line 170), becomes a section and an item; and the story that was to
    close `REVIEW.md`'s numbering gaps (design doc, R1) has nothing left to do once its sections are
    numbered on their own.
  - **The reviewer's comment lists every section, marked applied or not, with a one-line reason for
    each not applied**, so that a section skipped wrongly is visible.
  - **A setting names the rules file's path.** `init` copies steward's example there, as a default
    and an example of the format, and does not overwrite a file already at that path. A missing
    setting is an error, as for every setting.
  - **A rules file that is missing from `main`, or does not parse, is an error: steward records no
    verdict, the pull request stays pending, and the pass reports it** (the planning session's
    judgement, to which the owner deferred, 2026-10-11). The other option was a quiet skip, which
    leaves the pull request just as pending but tells nobody. A file does not parse when, for
    example, it has no sections, a section has no items, or a section numbers two items the same.
    The dispatcher parses it before starting a reviewer, so a bad file costs no review. The planning
    session's further proposal, not yet decided: the same parser as a command a project may run in
    its own CI, so that a pull request that breaks the file is caught before it lands, since
    otherwise every review after it stops.

### Land

- **Steward enforces nothing about CI** (owner, 2026-10-09). The lander relies on the project's
  own settings for when a pull request may merge, and nothing in steward uses CI to decide when to
  go on: tower-workshop-paths' `story.mjs` waits for the `ci.yml` run before it reviews
  (`waitForCi`), and that wait goes.
- **Revised 2026-10-10 by the owner: steward cannot enforce CI at install, because it does not know
  what the project uses, but it could once it learns what the project wants.** The line above
  stands for what steward assumes at install; these refine it (owner, 2026-10-10):
  - **Steward learns it from the project's steward settings.** Considered and not chosen (the
    planning session's list): `init` detecting the setup with nothing written down; reading the
    required checks from GitHub's branch protection or rulesets, which an unprotected repository
    does not have (R6); and describing it in the rules file, which steward itself cannot act on.
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
    project's choice goes). What follows (the planning session, 2026-10-10): the reviewer can read
    only the CI results that have finished when it looks.
  - **The reviewer may read the CI results, but does not run CI itself**: GitHub already does.
  - **Revised 2026-10-11 by the owner: the review and CI are two peer checks on the same head,
    joined at the merge.** Neither feeds the other. CI answers whether the head builds and its
    checks pass; the reviewer answers whether it does what its unit asked, by the project's rules;
    and the lander merges only once the checks the settings name, `review/agent` among them, are
    green. Asked how the reviewer and CI work in tandem, after the planning session noted that
    GitHub has no notion of CI of its own, only checks on a commit (check runs, such as each GitHub
    Actions job, and commit statuses), and that `review/agent` is already one: `review-gate.yml`
    posts it as a commit status, beside the `test` job of the workflow this repository names `CI`
    (`ci.yml`). Considered and not chosen (the planning session's proposal): the dispatcher handing
    the reviewer a snapshot of the head's checks, with a log excerpt for each failed job, as it
    hands it the pull request body. What follows (the planning session, 2026-10-11): the reviewer is
    not given CI results, and a red check the settings name stops the merge whatever the verdict.
  - **The reviewer does not run the project's whole check command; it runs only the narrower
    commands that settle a particular claim**, such as one test file, a search or a diff of one
    path (owner, 2026-10-11, from the planning session's recommendation). CI, as the peer check,
    already shows whether the checks pass, and on a bigger project the whole command can take a long
    time. The owner accepts what follows: a pull request body that claims a count of passing tests
    is no longer checked against a run of its own by the reviewer, and a false count is stopped only
    at the merge, by the red check, not reported as a finding. Considered and not chosen: the
    reviewer running the whole check command, as `reviewer.md` tells it to run `npm test` today
    ("Verify rather than accept", line 219).
  - **The coder runs the project's check command before its work is pushed**, which also makes the
    wait before the review matter less. For reference (the planning session, at `4f2f0fd`): in
    tower-workshop-paths the coder session commits and the dispatcher pushes (`pushBranch`,
    `coder.mjs` line 233). The prompt asks the session to report `ready` only when "the suite is
    green" (`coder.md`, line 276), but in prose that names no command, and the dispatcher runs no
    check before it pushes. **The coder session runs it, so that it can make changes when the check
    fails; steward's own script does not run it again before the push, since on a bigger project
    the check can take a long time** (owner, 2026-10-10). Considered and not chosen: steward's
    script running it, alone or as well. What follows (the planning session, 2026-10-10): nothing
    deterministic runs the check before the push, so a coder that skips it is caught only by the
    checks the lander waits for, which is only where the project has CI.
  - **Whether a project must have CI at all is open.** The owner leans against making CI a
    prerequisite, but every project of the owner's will have CI, so requiring it is possible.
  - **The command that prepares a fresh checkout goes in the settings beside the check command,
    and steward calls it `setup`** (owner, 2026-10-10, from the planning session's proposal).
    Considered and not chosen: `install`, which names only a dependency install, where a project may
    need more, such as generating code. For reference (the planning session, from `main` at
    `b2a02bf`): today it is `npm ci`, which `install.mjs` calls "the dependency install both
    dispatched sessions start from" (lines 2 and 20), and tower-workshop-paths' CI runs it as
    `'Setup: npm ci'` (`ci.yml`, line 32).
- **A project says in its steward settings which checks must pass before the lander merges**, and
  installing steward writes the default, **every check on the head green** (the owner leaned this
  way on 2026-10-09, and confirmed it on 2026-10-10). This was asked for a repository with no
  branch protection, where GitHub enforces nothing and anyone with write access can merge or push
  to `main` (design doc, R6). For reference (the planning session, from `main` at `b2a02bf`): the
  lander merges only when GitHub reports `mergeable_state` `clean` (`land.mjs` line 191,
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

### Settings

Decided 2026-10-11 by the owner, from the planning session's proposals, unless a line says
otherwise. The key names are the planning session's working names; the story that builds each
settles it.

- **One file, `steward.config.json`, flat for now, apart from each command (below).** Steward's
  code holds no default for any key: `init` writes a starting value for each into the file, where
  the project sees it, and a missing or unknown key is an error that names it, as `settings.mjs`
  does today (owner, 2026-10-11, asked whether the time limits start with defaults: "I want to
  write in the limit, not store it in code"). Considered and not chosen: optional keys with
  defaults in steward's code. Grouping other keys is left until the coder's keys make the groups
  clear.
  What follows, accepted by the owner: a key that becomes required breaks a project until it adds
  it, which a project meets only when it moves its pin, and which each version's update notes
  must name. Required keys are hoped to be added rarely (owner). Not chosen for now: a version
  field in the file.
- **`storyPrefix` leaves steward's settings** (owner, 2026-10-11): the core does not depend on how
  a project formats its units. What follows (the planning session, 2026-10-11): `review.mjs`'s
  `resolveStory` goes with the unit link (Review, above); steward's own story lint and story
  containment are its own convention (design doc, "Decided so far", 2026-10-10), so they keep the
  prefix in tooling of their own; `scripts/no-project-literals.test.mjs`, which keeps the prefix
  out of the code, changes with it; and how a coder finds ready units waits for the coder's
  readiness setting (Loops, below).
- **`setup` and `check`: one command each, run through the platform's shell**, with a project
  encouraged to point each at a script of its own (such as `npm run check`) rather than chain
  commands, since only simple forms behave alike in Windows' `cmd` and in `sh`. Not chosen: an
  argument list run without a shell. `null` is allowed for either, written explicitly: for
  `setup`, the project needs nothing but the worktree; for `check`, there is no check, which
  suits only a project without a coder.
  - `setup` is run by the dispatcher, in the session's environment without credentials, before
    a reviewer or a coder session starts, in the checkout that session will use. A failure starts
    no session. The reviewer always gets it, since its narrower commands need what it prepares.
  - `check` is run by the coder session itself (Land, above), so it is in effect a line of the
    coder's prompt. What follows (the planning session, 2026-10-11): its program must be one the
    coder's allowlist admits, which today means `npm`, `npx` or `node`.
  - **Each command is written with its own time limit, as one value**, so that `null` leaves no
    time limit behind with nothing to time, and every command added later takes the same shape:
    `"setup": { "command": "npm ci", "timeoutMinutes": 5 }`, or `"setup": null`. Given a
    command, its time limit is required, and missing is an error naming it (owner, 2026-10-11,
    from the planning session's proposal, after the owner noted that a required time limit beside a
    `null` command would be strange). Considered and not chosen: a time limit as a key of its own,
    required only when its command is not `null`; and one always required, even beside `null`.
    What `init` writes, the planning session's suggestion accepted by the owner: 5 minutes for
    `setup`, and 10 minutes for `check`. What follows (the planning session, 2026-10-11): the coder
    runs `check` as one shell call, and a shell call is cut off at 10 minutes (`SHELL_TIMEOUT_MS`,
    `scripts/dispatch/invocation.mjs`), so a longer limit also needs that bound raised, and the
    stall interval with it (`DEFAULT_STALL_MS`, `scripts/dispatch/spawn.mjs`). ST-7 plans a time
    limit for today's install; it is reworded for `setup`.
- **`landWhen`: which checks must be green before the lander merges**, either every check on the
  head (what `init` writes, as decided on 2026-10-10) or a list of check names.
  - **When GitHub reports a pull request `blocked` though the checks `landWhen` names are green,
    steward does not ask the sweep to merge it, says so in what it reports, and tries again
    later** (owner, 2026-10-11): "if the state is readable before spawning the land process, we
    should respect that it isn't ready". `blocked` then means branch protection requires
    something `landWhen` does not name, such as another required check or an approval, and
    GitHub would refuse the merge anyway. Steward's own rule stays `landWhen`. Considered and not
    chosen: triggering the sweep regardless, which is just as safe, since GitHub refuses the
    merge, but fails a sweep run on every pass until the requirement clears; and treating
    `blocked` as a rule of steward's own.
- **A project can turn steward's landing off** (owner, 2026-10-11, asked whether `review/agent`
  should be optional for projects with other gating rules). Steward still reviews and posts
  `review/agent`, but does not merge; the project merges by its own rules. Steward then never
  merges without a verdict, because it never merges there (Never, above). Considered and not
  chosen: a setting that turns off the lander's need for a passing verdict, which would make the
  first of the three rules a project's choice.
- **`unitLinks` and `rulesFile`**: as decided under Review, above.
- **Kept out of the settings:** the cap on reviews per pass, a command-line option (Loops,
  below); the machine label, which belongs to a machine, so stays `TW_MACHINE_LABEL`; and the
  base branch, the remote and the stories directory, constants until a project needs otherwise
  (design doc, R3).
- **Later: which commands the reviewer and the coder may run** (owner, 2026-10-11). It probably
  needs to be a setting, for a project that is not built with Node, and may look different once
  coder and reviewer sessions run in containers (design doc, R5).

### Loops

- **A review loop and a coding loop, separately** (the owner's idea, 2026-10-09; decided by the
  owner on 2026-10-10, for now, to see how it plays): the coder picks up work, and the reviewer
  picks up any open pull request. How a coder picks up the reviewer's feedback was taken up on
  2026-10-09, in the bullets below. Considered and not chosen: one run taking a unit through
  coding, review and retry, which is what tower-workshop-paths does. For reference (the planning
  session, from `main` at `b2a02bf`): today one run of `story.mjs` takes a story through coder, CI,
  review and retry, and `writer-prs.mjs` already reviews and lands the open pull requests the loop
  did not open.
- **The review side is a review-and-land dispatcher, not a loop that keeps running** (owner,
  2026-10-11, asked how the review loop is shaped). It decides which pull requests get a reviewer
  and spawns them, and lands what has passed. It runs on a defined trigger, one **pass** per run,
  and does not run all the time, so that each run picks up updates to steward. Considered and not
  chosen: a process that keeps running and polls, which keeps the code it loaded at start. **The
  trigger, to start with, is an agent session: the dispatcher session starts each run** (owner,
  2026-10-11). Other triggers, such as a scheduled task (ST-11) or a GitHub event, are left for a
  later discussion. The owner would accept as the MVP a dispatcher session that triggers both
  coder runs and review-and-land passes. What follows (the planning session, 2026-10-11): that reads
  "Keeping going" (What matters most, above) as working through ready work without the owner's
  hands, not without any session attending, so a scheduled task is not needed for the MVP. A pass,
  as the planning session defined it the same day and the owner accepted:
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
  landable within its bounds (`BLOCKED_BOUND_MS`, `MAX_TOTAL_WAIT_MS`). What follows (the planning
  session, 2026-10-11): once reviews stop waiting for CI, a pull request can pass review before its
  checks finish. In `writer-prs.mjs` as it is, a pull request whose landing gave up would never be
  landed, since a later call skips any pull request that has a verdict at its head; retrying the
  landing in every pass closes that.
- **A pass reviews at most a set number of pull requests** (owner, 2026-10-11), so that a whole
  pass, not only each session, has a ceiling on what it spends. The planning session suggested 5,
  set on the command line. The owner expects rarely to have more than a couple of pull requests in
  flight.
- **One machine runs the review side, for now** (owner, 2026-10-11). Several machines are wanted
  later, and the pass is built so that adding them is small. Ideas kept for then, none decided:
  - landing is already safe across machines: each trigger names its pull request, and the sweep
    re-checks it before merging;
  - reviewing is the exposure, since two machines could review the same head and both pay, though
    `review.mjs` notices the race before recording a verdict. A pass could first post a claim
    comment naming its machine (`TW_MACHINE_LABEL`), the head and the time, and other passes
    would skip a head with a fresh claim (the planning session, 2026-10-11);
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
  only one of two racing coders succeeds (the planning session, 2026-10-10). The owner accepts what
  follows (2026-10-10): the claim moves the head, so the block is no longer at the head and no other
  coder takes the pull request, and `review/agent` is cleared until the next review; and the claim
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
