# Glossary

The words steward uses, and what each one means. Where older text, or tower-workshop-paths, uses
another word for the same thing, the entry ends with it. Dated records keep the words they were
written with.

Where a file defines the thing, the entry names it, and the file is the authority.

## People

- **crew** — the people a project trusts to work on it with steward: any contributor whose GitHub
  association the gate honours (**honoured**). The crew writes units, marks pull requests ready,
  decides what comes next, and asks the controller for a rotation. *Formerly: the owner.*
- **owner** — in this repository's dated records, the owner of `luplows/steward`, who made the
  decisions recorded as "(owner, date)".
- **planning session** — the session that plans with the crew and writes stories
  (`docs/planning-session.md`). *Formerly: Session A.*
- **release review** — the periodic walkthrough of what has landed, ending in a release tag. Not
  yet run. *Formerly: Session B.*
- **controller** — the session asked to run steward's dispatch scripts by hand, doing ATC's work
  (`docs/controller.md`). *Formerly: the dispatcher session.*
- **coder** — a session ATC starts to implement a unit. It commits; ATC pushes its branch and opens
  its flight.
- **reviewer** — a session ATC starts to judge one flight at one head. It returns a verdict and
  writes nothing.

## Steward and its parts

- **steward** — the product: the scripts, prompts and workflow files in this repository, which a
  project installs. *Formerly: the harness, the engine, the workflow.*
- **project** — a repository that uses steward. This repository is both steward and a project.
- **ATC** (air traffic control) — steward's dispatch scripts, `scripts/dispatch/`, which hold no
  model. ATC runs a rotation: it decides which flights get a reviewer, starts sessions, pushes and
  opens a coder's flight, posts verdicts, and has the pilot request landing. *Formerly: the
  dispatcher.*
- **pilot** — `scripts/dispatch/land.mjs`. It requests landing for one flight once that flight is
  landable, and never merges itself. *Formerly: the lander.*
- **runway** — `.github/workflows/land-approved.yml` ("Land approved PRs"), the only thing that
  merges. It takes one landing per run: the flight its `pr` input names, or else the oldest
  landable one. It checks `review/agent` on the head again before merging, and deletes merged
  heads (`scripts/land/delete-merged-heads.mjs`). *Formerly: the sweep.*
- **the gate** — `.github/workflows/review-gate.yml` ("Review gate"), which turns a verdict marker
  into the `review/agent` status. Older text also uses "the gate" for the whole path to `main`,
  and "the gate only" for review and landing without a coder.
- **circuit breaker** — the runway's limit: once five open flights carry `review-blocked`, it lands
  only those labelled `breaker-override` or whose diff is confined to `.github/workflows/`
  (`scripts/land/runway.mjs`, which `land-approved.yml` runs).
- **inspection** — a check that raises, as GitHub issues, any merge to `main` or to a release
  branch without a passing verdict, and any pull request into either left pending or holding too
  long. It checks a release branch as it checks `main`. Run after each rotation, and by a
  scheduled workflow a project may keep. *Formerly: the watchdog.*
- **flight log** — the local logs steward's scripts write, such as the pilot's
  `logs/land-latency.jsonl`.
- **loop** — `scripts/dispatch/loop.mjs`, tower-workshop-paths' single loop of story, coder,
  review, retry and land. Not run on steward. Steward's design has two sides instead, coding and
  review, and the review side runs in rotations.

## Flights

- **flight** — a pull request, as steward handles it from opening to landing. Used in steward's
  design documents and this glossary; rules and instructions say "pull request".
- **unit** — the piece of work a flight implements, in whatever form the project keeps it: a file
  in the repository or a GitHub issue.
- **story** — steward's own form of unit: a file under `stories/` with the schema in
  `stories/README.md`. A project need not use stories.
- **flight plan** — the unit a flight links to, with a `Unit:` line in its body, or `Unit: none`.
- **rotation** — one run of the review side: it reviews open flights that need a verdict, up to a
  cap, then has the pilot request landing for each that is cleared, runs inspection, and exits. The
  command is `node scripts/dispatch/cli.mjs rotation`. *Formerly: a pass.*
- **clearance** — what a flight needs before the pilot requests landing: a passing verdict at its
  head, and green on the checks the settings name.
- **landing** — the runway merging a flight. The pilot **requests landing**; only the runway
  **merges**.
- **holding** — a flight that has passed review but is not yet cleared, such as one whose checks
  are still running. A later rotation tries again.
- **go-around** — a flight sent back by a `block`, for a coder to fix.
- **landable** — what the pilot waits for before requesting landing: not a draft, no
  `review-blocked`, `review/agent` `success` on the head, and the checks the project's `landWhen`
  names green on the head, and a `mergeable_state` GitHub would merge in (`land.mjs`'s header).
- **turnaround** — tidying up after landings and rotations: merged heads, leftover worktrees and
  scratch checkouts.
- **release branch** — `release/vX.Y.Z`, cut by the release review for one release, from `main`
  or, for a patch release, from the newest release's tag, and changed only through pull requests.
  Its last commit is tagged, and it is kept (`docs/release-review.md`).

## Reviews

- **verdict** — the reviewer's result on one head: `pass`, `pass-with-observations` or `block`.
- **marker** — the hidden line in the verdict comment that the gate reads:
  `<!-- agent-review head=… verdict=… -->`.
- **findings**, **observations** — what a verdict comment reports: findings on a `block`,
  observations on a `pass-with-observations`.
- **`review/agent`** — the commit status the gate posts from the marker: `success` for `pass` and
  `pass-with-observations`, `failure` for `block`, and pending until a verdict is posted. A
  required check.
- **pending** — a head with no verdict yet.
- **re-review** — a fresh review of a head whose verdict is already a `block`
  (`review.mjs --rereview`).
- **honoured** — an author whose GitHub association is `OWNER`, `MEMBER` or `COLLABORATOR`
  (`HONOURED_ASSOCIATIONS`, `scripts/land/check-author.mjs`), and a verdict posted by one. Only
  honoured authors' flights land, and only their markers count.

## Checks, rules and settings

- **check** — a GitHub check on a commit: a check run or a commit status, such as `test` or
  `review/agent`.
- **CI** — the `test` job of `.github/workflows/ci.yml`. A required check.
- **checklist** — the file of rules a flight is reviewed against: `REVIEW.md` in this repository,
  and in a project the file its settings name (`rulesFile`), read from `main`
  (`scripts/dispatch/review.mjs`). *Formerly: the rules file.*
- **pre-flight check** — the `check` command in a project's settings, which a coder runs before its
  work is pushed. *Formerly: the `check` command.*
- **setup** — the `setup` command in a project's settings, which prepares a fresh checkout before a
  coder session starts; nothing is installed before a review. Today `npm ci` runs in its place
  (`scripts/dispatch/install.mjs`; planned: ST-7).
- **settings** — a project's `steward.config.json`, read by `scripts/dispatch/settings.mjs`, with
  its keys listed in `docs/settings.md`.
- **machine settings** — the settings of the computer steward runs on, kept outside any checkout:
  `~/.steward/settings.json`, or the file `STEWARD_SETTINGS` names. They hold the usage limits,
  and for each role a default choice of tool, model and effort, and the choices available. Read by
  `scripts/dispatch/machine-settings.mjs`, with its keys listed in `docs/machine-settings.md`.

## Stopping

- **grounded** — a story whose `blocked:` field is set, with the reason. ATC does not start it.
  The field keeps the name `blocked` in story files.
- **ground stop** — the point at which steward stops both its coding and its review, when too much
  has stopped without landing. How it is measured is not yet decided
  (`docs/agent-workflow-design.md`, "Defining steward", D1).
- **stuck** — a story whose branch is on `origin` with no open flight and no recent claim. It is
  raised as a `loop-stuck` issue, and two open issues stop the loop (`STUCK_ISSUE_LIMIT`,
  `scripts/dispatch/loop.mjs`).
- **`review-blocked`** — the label the gate puts on a flight after three `block` verdicts. Once the
  label has been removed by hand, only verdicts recorded since the latest removal count.
- **`mergeable_state` `blocked`** — GitHub's word for a pull request whose required checks are not
  all green. Not the same as a grounded story or a `block` verdict.

## Story statuses

Derived from the story files, as `stories/README.md` defines: **draft** (its Open questions hold
something), **grounded** (which the queue prints as `blocked`), **waiting** (on a `depends_on`
story), **ready**, **done** (in `stories/done/`) and **retired** (in `stories/retired/`). From git
and GitHub: **in-progress** (its branch exists) and **in-review** (a flight is open for it).

A pull request is also **ready** when it is not a draft. Marking one ready is its author's
hand-over; for the planning session's, it is the crew's go-ahead.

## Acts

- **write** a story — the planning session, with the crew.
- **mark ready** — a flight's author.
- **take** — a coder taking a ready unit, or (planned) a flight on a go-around. ATC pushes a
  **claim** commit first, so that no other coder takes the same work (`claimPushArgs`,
  `scripts/dispatch/coder.mjs`).
- **start** a session — ATC, for a coder or a reviewer.
- **push**, **open** — ATC, for a coder's work; any other session, for its own.
- **review** — the reviewer.
- **post** a verdict — ATC, as a marker comment. **Record** — the gate, as `review/agent`.
- **request landing** — the pilot. **Merge** — the runway only.
- **retire** — the planning session moving a story to `stories/retired/`.

## Proposed names

Not yet decided.

- **maintainer** — GitHub's word for the people steward calls the crew.
- **operator** — the member of the crew who runs steward from their own machine, under their own
  GitHub credential. Steward calls them crew for now.
