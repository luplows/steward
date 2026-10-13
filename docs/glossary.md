# Glossary

The words steward's documents, stories and prompts use, each with one meaning. Where a word is
used in more than one sense today, its entry lists each sense, so that a reader can tell which is
meant; **Proposed renames**, at the bottom, gives each its own word.

Where code defines a thing, the code is the authority and the entry names it. Restatements here are
for reading and must not drift from the files named.

## How the words are chosen

Decided 2026-10-12 by the owner, with the planning session.

- **One verb per actor, and one actor per verb.** Every act names who does it, and no two actors
  share a verb. So "who did this?" always has one answer, which is what rules such as "only the
  sweep merges" and "the dispatcher decides no verdict" depend on.
- **Steward's own mechanisms take aviation names.** A steward is cabin crew: the role keeps order
  and looks after the flight while others fly it and control it. Aviation also gives "land", the
  verb steward already uses for merging, a setting where it makes sense, and words for the rest of
  the landing chain that most readers already know.
- **What steward does not own keeps its own name**: GitHub's and git's words (pull request,
  commit, branch, push, check, `mergeable_state`), and names fixed in code or in the verdict
  marker (`pass`, `pass-with-observations`, `block`, `review/agent`), unless a story changes the
  code.
- **Dated records keep the words they were written with.** "Decided by the owner" names the
  person who decided, and is not rewritten (**owner**, below).

Considered and not chosen, for the verbs: plain literal words with no theme, which leaves the
most overloaded words ("run", "check", "ready") needing a qualifier everywhere; and a landing
metaphor with no rule behind it. For the theme: a house steward (rounds, house rules), which fits
the role but gives "land" no sense; and nautical words (a watch, a berth, a pilot bringing a ship
in, shipshape), which fit the steward's care for order but make most readers picture aircraft
when they read "land".

## People and sessions

- **owner** — in this repository's records, the owner of `luplows/steward`, the person who made
  the decisions recorded as "(owner, date)" or "decided … by the owner". A record term, not a role:
  steward's design names the role **crew**. Elsewhere in the documents today "owner" also means the
  crew and the operator; see **Proposed renames**. Not GitHub's `OWNER` association, which is one
  of the three the gate honours (**honoured**).
- **crew** — any contributor to a project whom the gate honours (**honoured**). The crew writes or
  approves units, marks pull requests ready, decides what is next, and asks the controller for a
  rotation. A project may have one person in its crew or several. Plain alternative:
  **maintainer**, GitHub's word for the same people.
- **operator** — the member of the crew who runs steward from their machine, under their own
  GitHub credential. The dispatcher's pushes and comments are theirs, and a coder session can
  reach their SSH key (`docs/harness-outline.md`, "Never", 2). Named for now as crew; recorded so
  that a rule about one machine's credential is not read as a rule about every contributor.
- **planning session** — the session that plans with the crew and writes and refines stories
  (`docs/planning-session.md`). Called Session A until 2026-10-12.
- **release review** — the periodic walkthrough of what has landed, which ends in a release tag
  (`docs/agent-workflow-design.md`, "The release review"). Called Session B until 2026-10-12. Not
  yet run.
- **controller** — the session the owner has asked to run `scripts/dispatch/` by hand, doing
  ATC's work (`docs/controller.md`). Called the dispatcher session until 2026-10-12.
- **coder** — a session started by the dispatcher to implement a unit. It commits; the dispatcher
  pushes its branch and opens its pull request.
- **reviewer** — a session started by the dispatcher to judge one pull request at one head. It
  returns a verdict and writes nothing.

## Steward's parts

- **steward** — the product: the scripts, prompts and workflow files in this repository, which a
  project uses. Older text also calls it "the harness", "the engine" and "the workflow"; the last
  is also GitHub's name for a file under `.github/workflows/`. Proposed: **steward** only.
- **project** — a repository that uses steward. This repository is both steward and a project:
  its own work is reviewed and landed through its own gate (`AGENTS.md`).
- **dispatcher** — two senses today: the dispatch scripts, which hold no model
  (`docs/agent-workflow-design.md`, "The dispatcher is a script"); and, in "the dispatcher
  pushes", whichever runs them, the scripts or the controller. The outline also calls the
  review side "a review-and-land dispatcher". Proposed: **ATC**.
- **lander** — `scripts/dispatch/land.mjs`, which asks the sweep to merge one pull request once it
  is landable, and never merges itself. Proposed: **pilot**.
- **the sweep** — one run of `.github/workflows/land-approved.yml` ("Land approved PRs"), the only
  thing that merges. One pull request per run: the one its `pr` input names, or else the oldest
  landable one (the workflow's header comment). It re-checks `review/agent` on the head itself
  before merging, and deletes merged heads (`scripts/land/delete-merged-heads.mjs`). Not to be
  confused with "nothing to sweep" in `stories/README.md` and the design doc's "Status is
  derived", which mean there is no stored status to tidy. Proposed: **runway**.
- **the gate** — three senses today: `.github/workflows/review-gate.yml` ("Review gate"), which
  turns a verdict marker into the `review/agent` status; the whole path a change takes to `main`,
  review and checks and the sweep; and "the gate only", a project or a stage with review and land
  but no coder.
- **circuit breaker** — the sweep's limit: once five open pull requests carry `review-blocked`, it
  lands only those with `breaker-override` or a diff confined to `.github/workflows/`
  (`land-approved.yml`, "Circuit breaker").
- **watchdog** — a planned scheduled check that would raise anything stuck, and any merge to
  `main` without a passing verdict (`docs/agent-workflow-design.md`, "Watchdog"). Not built.
  Proposed: **inspection**.
- **loop** — `scripts/dispatch/loop.mjs`, tower-workshop-paths' single loop of story, coder,
  review, retry and land, which is not to be run on steward as it is configured (owner,
  2026-10-12; design doc, "Portability", "Decided so far"). The outline's "a review loop and a
  coding loop" means the two sides of steward's design; the review side is not a loop that keeps
  running but one pass per run (`docs/harness-outline.md`, "Loops").

## Work and its records

- **unit** — the piece of work a pull request implements, in whatever form the project keeps it:
  a file in the repository or a GitHub issue (`docs/harness-outline.md`, "Review"). Steward's
  general word.
- **story** — steward's own form of unit, and tower-workshop-paths': a file under `stories/` with
  the schema in `stories/README.md`. A project need not use stories.
- **`Unit:` line** — the line in a pull request body that links its unit, or says `Unit: none`
  (planned, ST-19 and ST-26). Proposed: **flight plan**, for the unit as linked.
- **verdict** — the reviewer's result on one head: `pass`, `pass-with-observations` or `block`.
- **marker** — the hidden line in the verdict comment that the gate reads
  (`<!-- agent-review head=… verdict=… -->`).
- **findings**, **observations** — what a verdict comment reports: findings on a `block`,
  observations on a `pass-with-observations`.
- **`review/agent`** — the commit status the gate posts from the marker: `success` for `pass` and
  `pass-with-observations`, `failure` for `block`, pending until then. A required check.
- **check** — two senses today: a GitHub check on a commit (a check run or a commit status, such as
  `test` or `review/agent`); and the `check` command in a project's settings, which a coder runs
  before its work is pushed (planned, ST-18). Proposed for the command: **pre-flight check**.
- **rules file** — the file of rules a pull request is reviewed against: `REVIEW.md` here, a
  setting in a project (planned, ST-18 and ST-20). `AGENTS.md` calls it "the checklist". Proposed:
  **checklist**.
- **settings** — a project's `steward.config.json`, read by `scripts/dispatch/settings.mjs`.
- **`setup`** — the settings command that prepares a fresh checkout before a session starts
  (planned, ST-18 and ST-7). Today `npm ci` (`scripts/dispatch/install.mjs`).
- **queue**, **tier**, **kind**, **AC** — from the story schema (`stories/README.md`).

## States

- **ready** — three senses today: a story status, derived from its file (`stories/README.md`); a
  pull request that is not a draft, which for the planning session's is the owner's go-ahead
  (`docs/planning-session.md`, "Handing it over"); and a unit the project's readiness setting calls
  ready, which a coder may take (planned; `docs/harness-outline.md`, "Loops").
- **draft** — two senses today: a story status, while its Open questions hold anything; and a
  draft pull request, which the sweep never lands (`scripts/land/select-candidates.mjs`).
- **blocked** — four senses today: a story whose `blocked:` field is set, read by
  `scripts/dispatch/queue.mjs` and `scripts/lint-stories.mjs`; the `block` verdict; GitHub's
  `mergeable_state` `blocked`, a required check not green; and the `review-blocked` label, which
  `review-gate.yml` applies at three blocking verdicts. Proposed for the story: **grounded**.
- **held** — the `blocked:` reason "Held until steward's coder works", on the stories moved from
  tower-workshop-paths. Also, in prose, holding a pull request back.
- **parked** — ST-14's `blocked:` reason.
- **stuck** — a story whose branch is on `origin` with no open pull request and no recent claim,
  raised as a `loop-stuck` issue; two or more open stop the loop (`STUCK_ISSUE_LIMIT`,
  `scripts/dispatch/loop.mjs`).
- **waiting**, **done**, **retired**, **in-progress**, **in-review** — story statuses
  (`stories/README.md`).
- **honoured** — an author whose GitHub association is `OWNER`, `MEMBER` or `COLLABORATOR`
  (`HONOURED_ASSOCIATIONS`, `scripts/land/check-author.mjs` and `scripts/dispatch/review.mjs`); and
  a verdict from such an author. Only honoured authors' pull requests are landed, and only their
  markers count.
- **landable** — what `land.mjs` waits for before asking the sweep: not a draft, no
  `review-blocked`, `review/agent` `success` on the head, and `mergeable_state` `clean`
  (`land.mjs`'s header).
- **pending** — a head with no recorded verdict.

## Acts

Who does each, today.

- **write**, **refine** a story — the planning session, with the crew.
- **mark ready** — the author of a pull request; for the planning session's, only on the owner's
  word.
- **dispatch** — four senses today: the dispatcher starting a coder on a story; starting any
  session; GitHub's `workflow_dispatch`, the event `land.mjs` sends to start the sweep; and "what
  dispatches from where" in `stories/README.md`, meaning what the queue reads.
- **take**, **claim** — a coder taking work; the claim commit the dispatcher pushes on a coder's
  new branch so that no other run takes the same story (`claimPushArgs`,
  `scripts/dispatch/coder.mjs`).
- **spawn**, **start** — the dispatcher starting a coder or reviewer session
  (`scripts/dispatch/spawn.mjs`).
- **push**, **open** a pull request — the dispatcher, for a coder's work; a session that makes its
  own changes, for its own (`AGENTS.md`, "Opening a pull request").
- **review** — the reviewer. **Re-review**: a fresh review of a head that already has a `block`,
  with `review.mjs --rereview`.
- **post** a verdict — the dispatcher, as a marker comment. **Record** — the gate, as
  `review/agent`.
- **land** — the lander asking the sweep, or the owner running the sweep by hand (`AGENTS.md`,
  "Every session"). **Merge** — the sweep only. **Trigger** — sending the `workflow_dispatch` that
  starts the sweep.
- **pass** — three senses today: the verdict; tests or checks succeeding; and one run of the review
  side, which reviews open pull requests up to a cap and lands what has passed
  (`docs/harness-outline.md`, "Loops"; planned, ST-25). Proposed for the run: **rotation**.
- **run** — any one execution: of a script, a workflow, CI, `story.mjs` or the loop. Say which.
- **retire** — the planning session moving a story to `stories/retired/` (`stories/README.md`,
  "Lifecycle").

## Proposed renames

Each row is a proposal until a pull request applies it across the files. **Agreed** means the
owner agreed the word on 2026-10-12; **proposed** means the planning session put it forward the
same day and it is not yet confirmed; **open** means not decided; **applied** means a pull
request has made the rename across current text. New text uses an agreed word
from the day it is agreed (`AGENTS.md`, "Every pull request"; owner, 2026-10-12), so the documents
align as they are touched.

| Today | Proposed | Status | Note |
|---|---|---|---|
| owner, as a role | **crew** | agreed | Dated records keep "owner". "Maintainer" documented as the plain alternative. Applying it is also a rule change wherever a rule names the owner (for example, who may run the sweep by hand), to be decided rule by rule. |
| owner, as whoever runs steward | **crew** | agreed | "Operator" documented, for rules about one machine's credential. |
| dispatcher (the scripts) | **ATC** (air traffic control) | agreed | Decides which flights get a reviewer, starts sessions, posts verdicts, and has the pilot request landing. |
| dispatcher session | **controller** | applied | The session that works ATC by hand. Applied across current text, with `docs/dispatcher-session.md` renamed `docs/controller.md`; dated records keep "dispatcher session". |
| lander, `land.mjs` | **pilot** | agreed | The pilot **requests landing** for one flight. |
| pass, the review-and-land run | **rotation** | agreed | Frees "pass" for the verdict and plain English. |
| the sweep, `land-approved.yml` | **runway** | proposed | One landing at a time; "only the runway merges". |
| a pull request | **flight** | proposed | In steward's own prose only; GitHub's word stays wherever GitHub is meant. |
| a passing verdict at the head and green checks | **clearance** | proposed | What the pilot needs before requesting landing. |
| the unit a pull request links | **flight plan** | proposed | |
| passed review, checks not yet green | **holding** | proposed | Landing never waits; a later rotation tries again. |
| sent back by a `block` | **go-around** | proposed | |
| a story with `blocked:` set | **grounded** | proposed | The field keeps its name until a story changes the queue and lint. |
| the shared stop measure for both loops | **ground stop** | proposed | The measure itself is open (`docs/harness-outline.md`, "Loops"). |
| circuit breaker | circuit breaker | proposed | Kept: aircraft have them. |
| rules file | **checklist** | proposed | |
| the `check` command | **pre-flight check** | proposed | Separates it from GitHub's checks. |
| tidying merged heads, worktrees and scratch checkouts | **turnaround** | proposed | |
| watchdog | **inspection** | proposed | |
| local logs | **flight log** | proposed | |
| harness, engine, the workflow | **steward** | proposed | |
| tower | — | open | Unassigned. |
| the gate's three senses | — | open | |
| dispatch's four senses | — | open | ATC **starts** a session; a coder **takes** work. |
| ready's three senses | — | open | |
| draft's two senses | — | open | |
