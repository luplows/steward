# Steward: product outline

> **OQ numbers.** This document was written in tower-workshop-paths, and moved to steward with its
> history. An `OQ-<n>` in it means a tower-workshop-paths story, found in that repository's
> `stories/done/` or `Completed-Questions.md`. Steward's own stories are numbered `ST-<n>`.

Steward's product outline: who it is for, what it is for, what it must never do, what matters
most, and the owner's decisions defining it. How steward works is in
[`agent-workflow-design.md`](agent-workflow-design.md), and the questions still open about it are
there too, under "Open questions", "Defining steward". The words are those of
[`glossary.md`](glossary.md).

Everything below is the owner's, stated on 2026-10-07, unless it says otherwise.

## What it is

Revised 2026-10-10 by the owner, from the end goal ("Defining steward", "What steward is for").

- **A path from a ready unit of work to a merged change: automated coding and review, merged only
  on a verdict.** It takes units marked ready, starting them in the order the project sets, codes
  them, has each pull request reviewed against its unit and the project's rules, and merges it on
  a passing verdict once its checks have passed.
- **It does not plan the work**, and it need not be the only way work is done in a project. Units
  come from however the project plans; readiness and priority are the project's settings.
- **It surfaces problems**, probably as GitHub issues, as OQ-112 does for a stuck story.
- **It keeps working while other ready work remains**, up to a point where too much has stopped
  without landing: the ground stop (`glossary.md`), whose measure is open (design doc, "Open
  questions", D1).

## Who it is for

**The crew of the owner's own projects.** Any trusted contributor to a project can use steward,
not only its owner (revised 2026-10-12 by the owner), so steward names the people it serves by
their role, the crew (`glossary.md`), rather than as one owner. The code already works this way:
the gate honours any author whose association is `OWNER`, `MEMBER` or `COLLABORATOR`
(`HONOURED_ASSOCIATIONS`, `scripts/land/check-author.mjs`). The projects are the owner's own, and
other people's projects are not the main concern. The repository is public (R8 in the design
document), so some setup help is worth exposing.

## Why

**To keep the crew on decisions and ideas, not on code and on reviewing individual tests.** Even
a review-and-land side alone, without the coder, would be worth having.

## Never

Three things steward must never do. Each says how it is held today; this restates the code for
readability and must not drift from the files named.

1. **Never merge without a verdict.** Only the runway merges, and it re-checks that `review/agent`
   is `success` on the head itself before merging (`scripts/land/runway.mjs`, "Belt
   and braces"), rather than trusting branch protection.
2. **Never push directly to main.** Every push ATC makes is built by `pushArgs` or
   `claimPushArgs` in `scripts/dispatch/coder.mjs`, and both refuse `main`
   (`assertPlainBranch`). A coder session may not run `git push` (its allowlist grants none and
   denies it), but it can still reach the owner's SSH key. OQ-73 was scoped to the GitHub token
   and named SSH keys out of scope. ST-6, the spike that took it over, now asks about SSH keys for
   both the coder and the reviewer (2026-10-15), and the mechanism it recommends, a container
   unless the spike shows another is better (chosen 2026-10-08), would close this too. This
   matters more on the second project: its account is on GitHub Free, so nothing on GitHub stops a
   push to `main` there (R6 in the design document).
3. **Always bound the sessions it starts.** Each session has a spend ceiling (`--max-budget-usd`,
   `ROLE_DEFAULTS` in `scripts/dispatch/invocation.mjs`, which holds each role's budget), a
   timeout and a stall interval (`DEFAULT_TIMEOUT_MS` and `DEFAULT_STALL_MS`,
   `scripts/dispatch/spawn.mjs`). The spend ceiling
   is a Claude Code flag, so any other company's tool must supply its own bound before it runs a
   role (M1 and M3 in the design document).

## The view

**For deciding what is next, and seeing what is in flight.** For now, one project at a time: the
current one. It may become a product of its own one day, but not now.

It meets two of the design's principles: status is derived, not stored, and tier is priority and
nothing else (R7 in the design document). A view that reads derived status and writes only what
the crew decides (readiness, priority) keeps both.

## Not now

- A view across all projects, or the view as a separate product.
- Publishing to npm (R2 in the design document).
- Setup help beyond what the crew needs, though it is welcome.

## What matters most

Revised 2026-10-10 by the owner. The MVP, in order:

1. **Review you can trust**: every pull request reviewed against its unit and the project's rules,
   and merged only on a verdict, once its checks have passed. It installs on its own, with little
   to configure.
2. **Automated coding**: coders take ready units, and pull requests on a go-around, in the order
   the project sets. Each runs the project's pre-flight check before its work is pushed. A project
   opts in.
3. **Keeping going**: working through ready work unattended, and surfacing problems where the
   crew will see them.

After the MVP, in order:

1. **The view**, for deciding what is next and seeing what is in flight.
2. **Parallel work**, on one machine or several.
3. **Looking back**: a walkthrough of the product, if that is steward's at all.

## Product roadmap

Agreed by the crew on 2026-10-26. These are release outcomes, not claims that the capabilities
already exist, fixed release dates, or another backlog. `stories/` remains the backlog and its
readiness rules still apply. The design of record records decisions and implementation markers;
this section is the authority for milestone scope. It refines the older MVP ordering above.

### 0.1.0 — Install and automatic review

A developer installs steward into an existing GitHub project through a reviewable installation
PR, explicitly activates that project on their machine, and receives independent automated reviews
without starting rotations by hand. Installing files and enabling a project locally are separate
acts: finding a checkout or merging an installation PR does not authorize machine execution.

The milestone includes review-only installation defaults (ST-55), explicit manual gated
landing (ST-54), and one authoritative automatic coordinator **per OS user**, for projects
the user has explicitly activated. It supports start, status and graceful stop; one automatic
reviewer at a time per user; bounded resource use and fair scanning; duplicate automatic
work prevention and safe restart. Independent manual review, rotation and landing commands
do not join the coordinator's admission or concurrency policy, and may overlap.
**Shared E-stop is not a 0.1 requirement**, but resource/session bounds and restart safety are.

Validate on two existing client projects with different unit conventions, preserving their native
planning practices (ST-48). Review and every landing still use the existing gate. **Unattended
landing is not required for 0.1.0.** ST-54 precedes ST-55 so review-only installation retains an
explicit manual landing path without changing its standing authorization.

### 0.1.5 — Optional unattended landing

An optional checkpoint for project-authorized automatic landing of eligible PRs after all required
review and CI checks pass. Landing remains opt-in, independently of automatic review and local
activation. The crew may combine or adjust this checkpoint if implementation evidence justifies
it; the version is a planning checkpoint, not a release promise.

### 0.2.0 — Automated coding vertical slice

The crew explicitly hands steward an existing work item. Steward durably records that
authorization, schedules handed-over work in approval order, runs a bounded coder, and creates a
linked PR. File-based units and GitHub Issues are supported without imposing steward's own story
schema, priorities or completion convention on clients. Durable authorization is a crew decision;
execution status remains derived where possible. Resource bounds, duplicate-work prevention and
recovery after restart belong in this first slice, not in a later hardening release. The legacy
tier/id queue is not automatically the authorization or scheduling mechanism for this slice.

### 0.3.0 — Automated fixing

Respond to blocking reviews and qualifying failed checks through bounded correction attempts on
the existing work, followed by fresh independent review of each changed head. Persist or derive
retry bounds across restarts, and escalate when progress stops or the bound is reached. Failed
setup, cancelled checks and unrelated infrastructure failures must not cause indefinite retries.
Which failed checks qualify and the retry/recovery contracts require story refinement.

### 0.4.0 — Credential isolation

Investigate and implement stronger isolation of coding and reviewing agents from machine
credentials and unrelated files. ST-6 remains the investigation; its findings must lead to
implementation and validation work. The crew deliberately deferred this from 0.2/0.3 because of
technical complexity and potential impact on usability. It is not an early-release dependency.
Earlier releases must accurately document their security limitations; no credential or filesystem
isolation may be claimed until implemented and validated. Existing tool restrictions, timeouts,
usage limits and review safeguards still apply before isolation.

### Toward 1.0

Automated coding and automated fixing are both essential before 1.0, together with demonstrated
reliability, recovery, resource safety and use across projects. **Shared per-user E-stop is
required before 1.0:** it terminates registered local manual and automatic processes, blocks
new supported execution until explicit reset, and reports uncertain termination. It cannot
retract a remote GitHub workflow that has already been dispatched. This is a later story,
not a 0.1 dependency. A graphical board, distributed execution, universal backlog
integrations and sophisticated per-handoff cancellation remain optional.

### Follow-up planning and existing work

Existing story IDs are preserved. ST-52 is explicitly revised in this planning PR to replace
its superseded draft rotation-lock criteria; other existing story ACs are unchanged. No story
is retired or silently replaced. Reconcile the remaining overlaps before dispatch:

| Existing work | Relationship to the roadmap and next planning action |
|---|---|
| ST-48 | Retains crew-only two-client installation and gate validation. Refine its dependencies/evidence after ST-56 and the automatic scheduler exist, including activation and unattended review; manual evidence alone does not prove all of 0.1.0. |
| ST-52 | Revised in this PR: durable per-user reservations apply only to coordinator-dispatched automatic reviews, not manual rotations or reviews. The story depends on ST-58 and ST-59; it does not implement recovery (ST-60), scheduling (ST-61) or a second rotation lock. |
| ST-6 | Schedule the owner-run investigation and the implementation it recommends for 0.4. Reconcile earlier coder/scheduler dependencies when those stories are refined; deferring isolation does not mean it already exists. |
| ST-11 / ST-12 | Held stories address the old loop's scheduler and retry pause/resume. Reconcile their useful requirements with the new coordinator, resource bounds and restart contracts; do not start the frozen coder loop to satisfy automatic review. |
| ST-2 | Starvation promotion conflicts with approval-order scheduling of explicit handoffs. Decide its disposition with the crew before refining the coding queue; do not dispatch it as the 0.2 scheduling rule. Steward's current story queue stays tier/id ordered until separately changed. |
| ST-53 | Separately refines the pilot's wait behaviour and frozen-loop callers. ST-54 changes authorization, preserves existing wait bounds, and does not consume or resolve ST-53. |

ST-57 (activation), ST-58 (coordinator controls), ST-59 (bounded review-only work)
and the revised ST-52 (automatic review admission) define the first coordinator units.
Coordinator recovery, fair scheduling, the ST-48 evidence amendment, deferred E-stop,
durable handoff and fixing require separate refinement. No future mechanism is claimed
implemented here.

### Release preparation

The existing `release/v0.1.0` branch and draft PR #86 are older release preparation, not evidence
that this redefined 0.1.0 target is delivered. This planning PR changes neither. Once the required
work is delivered, the crew must reconcile that preparation through `docs/release-review.md`,
without moving or deleting an existing release branch or tag. Steward's own release-review
procedure remains specific to this repository; it is not a generic client feature.

## Defining steward

Started 2026-10-09 by the owner with the planning session. The sections above say who steward is
for and why; this one works out what it does, and where it ends and a project begins. It follows
"What matters most", so it starts with review and land. Each statement is the owner's, dated,
unless it says otherwise. The options considered for each, and what follows from it, are in the
design doc, "The outline's reasoning", under the same headings.

### What steward is for

- **The end goal** (owner, 2026-10-10, talked through to give the priorities a direction): to plan
  work with one or more agents and hand it to coders to carry out; to have that work reviewed
  before it merges, so the crew can trust what is delivered; to set the priority of work, so that
  several ready items are worked through in order; to run work in parallel, to deliver more sooner;
  and to look back at what has been done, so the crew keeps in touch with the state of the
  project. Not all of it need be steward's: working out which is the point of this section.
- **Steward's purpose is to provide a path to automated code and review** (owner, 2026-10-10). It
  does not dictate how a project plans its work, and it need not be the only way work is done in a
  project. So steward does not provide a planning session: it takes units however they were
  planned, and readiness is the project's setting (The two sides, below).
- **Tests and CI are an important part of review, but steward does not require a test structure**
  (owner, 2026-10-10). A possibility: a hook into a CI script that the project configures. How
  the hook sits with "Steward enforces nothing about CI" was taken up the same day: see that line's
  revision (Land, below).
- **Parallel work, on one machine or across several, is wanted but is not in the MVP** (owner,
  2026-10-10).
- **Looking back is ideally a walkthrough of the product** (owner, 2026-10-10). Whether it is
  steward's is open (design doc, "Open questions", D3).

### Review

- **When a pull request appears, a reviewer is started to check that it implements what it is
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
  section of the example checklist, not a check steward makes before the review: the reviewer
  decides what is a code change, as it decides which sections apply, and a project can change the
  condition (owner, 2026-10-09). The cost is a review session for a pull request without a link.
- **Refined 2026-10-11 by the owner: how the link is written and read.**
  - **ATC finds the link deterministically**, by parsing the pull request body, so that no model
    is involved: a line `Unit: <link>`, or, for an issue, one of GitHub's closing keywords
    (`Closes #n`).
  - **A file unit is a path in the repository, read from `main`**, not from the pull request's
    head: the unit as it stood before the work, which the pull request cannot edit into agreement
    with itself. The reviewer still sees any edit to it in the diff. A path means steward stores
    nothing about where a project keeps its units.
  - **The link may point only into this repository**: a file in it, or one of its issues.
  - **A pull request whose link is missing is still reviewed, and the review does not pass. The
    reviewer decides that, not ATC**, by the project's rules, as the bullet above has it (owner,
    2026-10-11, asked whether steward should record the block itself): only judgment can tell a
    code change from a docs change, and a pull request that writes the document it would link to
    has nothing to link. ATC tells the reviewer, deterministically, which of four it found: a link
    it read, a link it could not read and why, `Unit: none`, or no `Unit:` line at all. A body
    with more than one link, or with `Unit: none` and a link, is reported as several, none read
    (ST-19; owner, 2026-10-15).
  - **`Unit: none` says the pull request implements no unit** (owner, 2026-10-11), so the reviewer
    judges only whether that is believable for the diff, rather than guessing. Whether and how the
    line is required is open (design doc, "Open questions", D4).
  - **A setting lists the kinds of link a project uses** (owner, 2026-10-11): `issue` (`Unit: #n`
    or a closing keyword), `file` (`Unit: <path>`) and `other` (`Unit:` and any text, which ATC
    passes to the reviewer unread, so that a link into another tracker works without an
    integration). A list, not one value, since a project may use more than one kind. An empty list
    means the project links no units: the reviewer works from the pull request body and the rules.
    A missing setting is an error that names it, as every setting is in `settings.mjs` today,
    so that "never decided" is not taken for "no units".
- **A pull request that implements no unit is still reviewed, against the project's own rules**
  (owner, 2026-10-09, raised for a write-story pull request; tower-workshop-paths could not work
  otherwise).
- **One reviewer prompt, steward's; the rules are the project's, in sections that each say when
  they apply; and the reviewer names the sections it applied** (owner, 2026-10-09, asked whether
  instructions should differ for a code change and a docs change). The prompt holds what is the
  same in every project, how to review; a project's rules say what good means there. Steward does
  not sort pull requests into kinds itself: the reviewer decides which sections apply, and naming
  them in its verdict shows when one was skipped.
- **Steward gives an adopting project an example checklist**, with a basic set of sections and
  conditions that the project modifies and adds to (owner, 2026-10-09).
- **The example is a copy: once adopted, the project owns its checklist** (owner, 2026-10-09).
  Steward keeps update notes on what changes in the example between versions.
- **What the example checklist contains was left for later** (owner, 2026-10-09). **Begun
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
    repository without it inspection, is what guards `main`; `AGENTS.md` keeps the rule for
    sessions;
  - "Every pull request" gains a claims item: statements a pull request adds about how the
    repository works, in documents, comments, commit messages or its body, are true at its
    head. Until then only a story's claims were checked. Not in the example: it is the
    discipline steward's own project chose (`AGENTS.md`, "Claims about this repository");
  - "Changes to code" applies to workflow files and prompts as well as code and tests, to start
    with;
  - a code change must link its unit, `Unit: none` being accepted only where no unit could
    exist, such as a pull request that writes the unit; added once the reviewer is given the
    unit note (ST-22).
- **The checklist's shape** (owner, 2026-10-11, from the planning session's proposals):
  - **The reviewer reads the rules from `main`**, put into its prompt by ATC, not from the pull
    request's head, so that a pull request cannot loosen the rules it is judged by. A change to
    the rules is still in the diff for the reviewer to see.
  - **The file holds rules only.** How steward works (the verdict marker, the three verdicts, a
    review with no verdict, what the gate's workflow enforces, how the coder's pull request is
    opened) goes in the reviewer's prompt and steward's own documents. The owner's reason:
    `REVIEW.md` had grown those parts because it was the living process the reviewer was built
    from. "Reading the pull request body" is a rule, so it stays, as a section of the example
    checklist.
  - **A section is a heading, then one `Applies when:` line in plain words, then its items.** The
    reviewer judges the line, and a section without one always applies.
  - **Each section numbers its own items, and a finding cites the section and the item** (owner,
    2026-10-11). Steward cannot control how a project adds its own rules to the file, so it does
    not impose one numbering across it.
  - **The reviewer's comment lists every section, marked applied or not, with a one-line reason for
    each not applied**, so that a section skipped wrongly is visible.
  - **A setting names the checklist's path.** `init` copies steward's example there, as a default
    and an example of the format, and does not overwrite a file already at that path. A missing
    setting is an error, as for every setting.
  - **A checklist that is missing from `main`, or does not parse, is an error: ATC posts no
    verdict, the pull request stays pending, and the rotation reports it** (the planning session's
    judgement, to which the owner deferred, 2026-10-11). A file does not parse when, for example,
    it has no sections, a section has no items, or a section numbers two items the same. ATC
    parses it before starting a reviewer, so a bad file costs no review.

### Land

- **Steward enforces nothing about CI** (owner, 2026-10-09). The pilot relies on the project's
  own settings for when a pull request may land, and nothing in steward uses CI to decide when to
  go on: tower-workshop-paths' `story.mjs` waits for the `ci.yml` run before it reviews
  (`waitForCi`), and that wait goes.
- **Revised 2026-10-10 by the owner: steward cannot enforce CI at install, because it does not know
  what the project uses, but it could once it learns what the project wants.** The line above
  stands for what steward assumes at install; these refine it (owner, 2026-10-10):
  - **Steward learns it from the project's steward settings.**
  - **`init` writes default entries, then explores the repository to surface options, as a
    deterministic script**, so it does not learn from prose. What it explores is open (design
    doc, "Open questions", D8).
  - **Two ways to set up, later: one declarative, which runs without AI, and one meant to be run
    with an AI helper** (owner, 2026-10-11), since steward is meant to be used with AI tools. What
    each covers is open (design doc, "Open questions", D9).
  - **The pilot waits for the checks the settings name**: kept, as the next bullet says.
  - **Steward does not wait for CI before it starts a review, and does wait for all checks before
    it lands** (owner, 2026-10-10, after first being on the fence: a coder's work almost always
    passes CI, and when it does not, the cause is usually the coder's configuration). So today's
    `waitForCi` goes, as the line above already says. "All checks" means the checks the project's
    settings name, and the default is still every check (owner, 2026-10-10, asked whether the
    project's choice goes).
  - **The reviewer may read the CI results, but does not run CI itself**: GitHub already does.
  - **Revised 2026-10-11 by the owner: the review and CI are two peer checks on the same head,
    joined at the merge.** Neither feeds the other. CI answers whether the head builds and its
    checks pass; the reviewer answers whether it does what its unit asked, by the project's rules;
    and the pilot requests landing only once the checks the settings name, `review/agent` among
    them, are green. Asked how the reviewer and CI work in tandem, after the planning session noted
    that GitHub has no notion of CI of its own, only checks on a commit (check runs, such as each
    GitHub Actions job, and commit statuses), and that `review/agent` is already one:
    `review-gate.yml` posts it as a commit status, beside the `test` job of the workflow this
    repository names `CI` (`ci.yml`).
  - **The reviewer does not run the project's whole pre-flight check; it runs only the narrower
    commands that settle a particular claim**, such as one test file, a search or a diff of one
    path (owner, 2026-10-11, from the planning session's recommendation). CI, as the peer check,
    already shows whether the checks pass, and on a bigger project the whole command can take a long
    time. **Revised 2026-10-15 by the owner:** the reviewer runs no check at all, a single test file
    included, and settles a claim by reading, searching or diffing (`agent-workflow-design.md`,
    Part 3, "Decided so far", "The reviewer runs no checks").
  - **The coder runs the project's pre-flight check before its work is pushed**, which also makes
    the wait before the review matter less. **The coder session runs it, so that it can make changes
    when the check fails; steward's own script does not run it again before the push, since on a
    bigger project the check can take a long time** (owner, 2026-10-10).
  - **The command that prepares a fresh checkout goes in the settings beside the pre-flight check,
    and steward calls it `setup`** (owner, 2026-10-10, from the planning session's proposal).
- **A project says in its steward settings which checks must pass before steward lands a pull
  request**, and installing steward writes the default, **every check on the head green** (the
  owner leaned this way on 2026-10-09, and confirmed it on 2026-10-10). This was asked for a
  repository with no branch protection, where GitHub enforces nothing and anyone with write access
  can merge or push to `main` (design doc, R6).
- **What installing steward sets up** (owner, 2026-10-09, asked what can record and enforce a
  verdict, and what to do if the answer is nothing):
  - It always writes the gate's workflow files (the one that turns the reviewer's verdict into the
    `review/agent` status, and the runway), the labels the runway reads, the project's steward
    settings with the default landing rule, and the example checklist.
  - **Revised 2026-10-23 by the owner:** installing sets no branch protection, and asks nothing
    about it. A separate, optional command, `steward protect`, sets it once the gate is on `main`,
    and asks nothing either, since running it is the crew's yes: it is what changes the
    repository's settings. A project set up without protection is a complete way to use steward.
  - It offers inspection, never forces it (**revised 2026-10-23 by the owner:** no longer compared
    with an offer of branch protection, which installing no longer makes): a check that opens an
    issue for any merge to `main` without a passing verdict (design doc, "Watchdog"). Inspection
    checks each release branch as it checks `main`. It also raises a pull request left pending or
    holding longer than the project's settings allow, runs after each rotation, and runs on a
    schedule only if the project keeps its workflow (owner, 2026-10-15).
  - Where GitHub offers no branch protection, as on a private repository on GitHub Free,
    `steward protect` says plainly that nothing on GitHub then enforces the gate (**revised
    2026-10-23 by the owner:** installing no longer says so). Steward's own runway still checks the verdict
    on the head before each merge it makes (`scripts/land/runway.mjs`, "Belt and braces").

### Settings

Decided 2026-10-11 by the owner, from the planning session's proposals, unless a line says
otherwise. The key names are the planning session's working names; the story that builds each
settles it.

- **One file, `steward.config.json`, flat for now, apart from each command (below).** Steward's
  code holds no default for any key: `init` writes a starting value for each into the file, where
  the project sees it, and a missing or unknown key is an error that names it, as `settings.mjs`
  does today (owner, 2026-10-11, asked whether the time limits start with defaults: "I want to
  write in the limit, not store it in code"). Grouping other keys is left until the coder's keys
  make the groups clear.
- **`storyPrefix` leaves steward's settings** (owner, 2026-10-11): the core does not depend on how
  a project formats its units.
- **`setup` and `check`: one command each, run through the platform's shell**, with a project
  encouraged to point each at a script of its own (such as `npm run check`) rather than chain
  commands, since only simple forms behave alike in Windows' `cmd` and in `sh`. `check` is the
  pre-flight check. `null` is allowed for either, written explicitly: for `setup`, the project
  needs nothing but the worktree; for `check`, there is no check, which suits only a project
  without a coder.
  - `setup` is run by ATC, in the session's environment without credentials, before a reviewer or
    a coder session starts, in the checkout that session will use. A failure starts no session.
    The reviewer always gets it, since its narrower commands need what it prepares. **Revised
    2026-10-15 by the owner:** `setup` runs before a coder session only. The reviewer runs no
    checks, so nothing is installed before a review (`agent-workflow-design.md`, Part 3, "Decided
    so far", "The reviewer runs no checks").
  - `check` is run by the coder session itself (Land, above), so it is in effect a line of the
    coder's prompt.
  - **Each command is written with its own time limit, as one value**, so that `null` leaves no
    time limit behind with nothing to time, and every command added later takes the same shape:
    `"setup": { "command": "npm ci", "timeoutMinutes": 5 }`, or `"setup": null`. Given a
    command, its time limit is required, and missing is an error naming it (owner, 2026-10-11,
    from the planning session's proposal, after the owner noted that a required time limit beside a
    `null` command would be strange). What `init` writes, the planning session's suggestion
    accepted by the owner: 5 minutes for `setup`, and 10 minutes for `check`. **Revised
    2026-10-19 by the owner:** `init` writes `null` for both, since only a coder uses them.
- **`landWhen`: which checks must be green before steward lands a pull request**, either every
  check on the head (what `init` writes, as decided on 2026-10-10) or a list of check names.
  - **When GitHub reports a pull request `blocked` though the checks `landWhen` names are green,
    steward does not ask the runway to land it, says so in what it reports, and tries again
    later** (owner, 2026-10-11): "if the state is readable before spawning the land process, we
    should respect that it isn't ready". `blocked` then means branch protection requires
    something `landWhen` does not name, such as another required check or an approval, and
    GitHub would refuse the merge anyway. Steward's own rule stays `landWhen`.
- **A project can turn steward's landing off** (owner, 2026-10-11, asked whether `review/agent`
  should be optional for projects with other gating rules). Steward still reviews and posts
  `review/agent`, but does not merge; the project merges by its own rules. Steward then never
  merges without a verdict, because it never merges there (Never, above).
  Revised by the crew, 2026-10-26: `land: false` disables unattended landing; an explicit
  `steward land <pr-number>` request may still land that PR at its named head through the same
  gate. A default workflow dispatch is not a manual override. The precise authorization contract
  is in the design doc, "Manual landing and review-only installation defaults".
  New installations write false by default, with explicit opt-in to unattended landing;
  existing configuration is preserved.
- **`unitLinks` and `rulesFile`**: as decided under Review, above.
- **Kept out of the settings:** the cap on reviews per rotation, a command-line option (The two
  sides, below); the machine label, which belongs to a machine, so stays `TW_MACHINE_LABEL`; and
  the base branch, the remote and the stories directory, constants until a project needs otherwise
  (design doc, R3).

### The two sides

- **A review side and a coding side, separately** (the owner's idea, 2026-10-09; decided by the
  owner on 2026-10-10, for now, to see how it plays): the coder picks up work, and the reviewer
  picks up any open pull request. How a coder picks up the reviewer's feedback was taken up on
  2026-10-09, in the bullets below.
- **The review side runs in rotations, not as a loop that keeps running** (owner, 2026-10-11,
  asked how the review side is shaped). ATC decides which pull requests get a reviewer and starts
  them, and has the pilot request landing for what has passed. It runs on a defined trigger, one
  **rotation** per run, and does not run all the time, so that each run picks up updates to
  steward. **The trigger, to start with, is an agent session: the controller starts each
  rotation** (owner, 2026-10-11). The owner would accept as the MVP a controller that starts both
  coder runs and rotations. A rotation, as the planning session defined it the same day and the
  owner accepted:
  1. Bring ATC's own worktree to `origin/main`, detached, and stop if it has anything
     uncommitted.
  2. List the open pull requests against `main` once. One opened later waits for the next
     rotation.
  3. Oldest first, review each that is not a draft, is from an author the gate honours, and has
     no verdict at its current head, up to a cap on reviews per rotation (below).
  4. Have the pilot request landing for each pull request with a passing verdict at its head that
     is safe to merge at that moment, one at a time, since the runway lands one per run. One whose
     checks are still running or are red is left alone.
  5. Exit, carrying nothing forward: the next rotation derives everything again from GitHub.
- **Landing never waits** (owner, 2026-10-11). A rotation checks once whether each passed pull
  request is safe to merge, and leaves one that is not for a later rotation. Landing can be retried
  freely, by any later rotation, for as long as the pull request is reported safe to merge.
  - **Revised 2026-10-24 by the owner: not waiting does not mean moving past as fast as
    possible.** A rotation waits for an event that finishes on its own within a known bound, such
    as two minutes for the gate to post `review/agent` after a verdict, so that a pull request
    passed in the rotation lands in it, and for nothing else: anything of unknown length, such as
    checks still running, is left for a later rotation. What a rotation reports must not be false
    about the state of things (ST-51).
- **A rotation reviews at most a set number of pull requests** (owner, 2026-10-11), so that a
  whole rotation, not only each session, has a ceiling on what it spends. The planning session
  suggested 5, set on the command line. The owner expects rarely to have more than a couple of
  pull requests in flight.
- **One machine runs the review side, for now** (owner, 2026-10-11). Several machines are wanted
  later, and the rotation is built so that adding them is small. On one machine, while a rotation
  is running, any later rotation is locked out (owner, 2026-10-24; ST-52); several machines, and
  several reviewers at once, are still to be solved. **Revised 2026-10-27:** this proposed
  rotation lock is superseded for 0.1. The coordinator is per OS user and prevents duplicate
  *automatic* work only; independent manual commands may overlap. Ideas kept for future
  distributed coordination, none decided:
  - landing is already safe across machines: each trigger names its pull request, and the runway
    re-checks it before merging;
  - reviewing is the exposure, since two machines could review the same head and both pay, though
    `review.mjs` notices the race before posting a verdict. A rotation could first post a claim
    comment naming its machine (`TW_MACHINE_LABEL`), the head and the time, and other rotations
    would skip a head with a fresh claim (the planning session, 2026-10-11);
  - or one machine runs the one authoritative ATC, which farms reviewer and coder sessions out to
    other machines (the owner's idea, 2026-10-11).
- **A pull request does not belong to a coder** (the owner's view, 2026-10-09, asked how a coder
  picks up the reviewer's feedback): any coder can take a pull request, read its linked unit and
  its review findings, and make the changes asked for. So a pull request on a go-around is work,
  as a ready unit is, and the round bound, counted from the pull request's own blocking verdicts,
  needs no coder to own it.
- **By default a coder may take any ready unit, and any pull request on a go-around, with the
  review's findings available to it** (owner, 2026-10-09), so that steward is easy to set up.
- **A coder claims its work with a claim commit, at first** (owner, 2026-10-09), as
  tower-workshop-paths does for a story (`coder.mjs`'s `claimPushArgs`, OQ-110). On a go-around
  the claim is a push that requires the branch to be still at the head the `block` was given at,
  so only one of two racing coders succeeds (the planning session, 2026-10-10).
- **Coder work always needs a unit** (owner, 2026-10-09): a pull request with no unit is reviewed,
  but no coder takes it.
- **Coders picking up work is opt-in, and what makes a unit ready is the project's setting**
  (owner, 2026-10-10). Review installs with its rules predefined and little to configure; the
  coder does not, since there is no way to ship readiness with installation alone. The default
  above applies to a project that has opted in.
