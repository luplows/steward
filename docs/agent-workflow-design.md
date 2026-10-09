# Agent-Driven Development Workflow

**Status:** Design v2 — architecture settled, implementation sequenced in [`migration-plan.md`](migration-plan.md)
**Last updated:** 2026-09-18
**Target:** `luplows/tower-workshop-paths`

> v2 supersedes the first draft. It incorporates the gap analysis against `origin/main @ e06e677`,
> adopts the mechanisms the existing repo got right, and revises three things the first draft got
> wrong: the deployment model, the execution environment, and the nature of the dispatcher.

> **Reading this document: goal state, marked.** This document records the design as decided,
> including parts not yet built, so that anyone deciding what to build next works towards the goal
> state. A passage that is decided but not built starts **Planned (OQ-n)**, naming the story or
> stories that will build it. A decision is written here, marked, in the same pull request that
> records it (usually the one that writes its story), so it reaches `main` when it is made. The
> pull request that implements a story takes that story's id out of every marker that names it,
> and corrects the passage wherever what was built differs. A marker naming several stories keeps
> the others and stays until the last of them is built; only then does the marker go. Each such
> story has an acceptance criterion saying so. The convention dates
> from 2026-09-25. Passages written before then may describe unbuilt parts without a marker; the
> migration plan tracks those. `scripts/lint-stories.mjs` fails CI if a marker names a story whose
> file is already in `stories/done/`, or a numeric id with no story file at all.

---

## Purpose

A repeatable loop for building software where agents implement and review, and the human stays in
the two places where judgment is most expensive and least automatable: **deciding what to build**
and **deciding what is fit to release**.

The goal is not "agents write code." It is a system where work can only enter the product through
one explicit, gated path, so quality is a property of the pipeline rather than of any individual
prompt.

---

## Principles

Resolve new situations against these rather than inventing mechanisms.

**1. Artifacts, not conversations.** Every handoff is a file or a PR. Chat context dies with the
session, cannot be diffed, and cannot be replayed.

**2. One explicit loop.** Exactly one path into the product: story → coder → reviewer → merge.
Anything that doesn't fit is adapted or is a named exception. The moment there are two ways in,
the one without gates becomes the default under pressure.

**3. Spend on judgment, save on mechanics.** Planning and review are judgment. Dispatch is
mechanics — and therefore should not involve a model at all.

**4. Merge is a consequence, not a decision.** Whoever merges only executes a decision already
recorded. This is what makes automated merging safe.

**5. Enforce with tools, not prose.** "Do not write code" in a prompt gets violated the first time
the agent sees a one-line typo. An invocation without `Edit` cannot violate it. Prose has no
compiler — this project has twice shipped documentation instructing agents to do impossible things.

**6. Eliminate context, don't manage it.** Every unit of work starts cold and reads its inputs from
disk. Nothing accumulates across units.

**7. An unsupervised author optimizes for the success criterion.** The cheapest path to "green" is
not always the intended one. Every gate is designed against that, not merely against broken code.
*(Adopted verbatim in spirit from the existing `REVIEW.md`, which states it better than the first
draft of this document did.)*

---

## The shape

```
  ┌─ SESSION A (human, frequent) ──────────────────────────────┐
  │  vision · refinement · story authoring · triage of kickbacks│
  └────────────────────────┬───────────────────────────────────┘
                           │ writes
                    stories/OQ-NN-*.md
                           │ reads
  ┌────────────────────────▼───────────────────────────────────┐
  │  DISPATCHER  —  a script, no model, no context              │
  │  picks one ready story → worktree → coder → PR → reviewer   │
  │  → posts verdict status → lets the gate land it             │
  └────────────────────────┬───────────────────────────────────┘
                           │ lands on
                         main ──────────► alpha channel (Pages)
                           │
  ┌────────────────────────▼───────────────────────────────────┐
  │  SESSION B (human, periodic)                                │
  │  walkthrough of accumulated main · verdicts · fix stories   │
  │  → tag vN = reviewed checkpoint                             │
  └─────────────────────────────────────────────────────────────┘
```

| Role | Interaction | Model | Writes code? |
|---|---|---|---|
| **Session A** — planning | Frequent, conversational | Opus / high | No |
| **Dispatcher** | None | **None — it is a script** | No |
| **Coder** | None | Sonnet (per-story override) | Yes |
| **Reviewer** | None | Opus / high — *never the coder's model* | **No** (tool-enforced) |
| **Session B** — release | Periodic, conversational | Opus / high | No |

---

## The story artifact

### Format

One file per story. **OQ numbering is preserved** — those identifiers are referenced throughout the
codebase, workflow comments, and `Completed-Questions.md`, and the "never reused, never renumbered"
rule stays. Only the container changes.

**Planned (OQ-128, OQ-129):** the prefix is a project setting, not part
of the code. A project's `steward.config.json` names its repository and its story prefix (`OQ`
here), and every story-id pattern the scripts use is built from it, so the same code can run a
queue numbered `ST-<n>` (decided 2026-10-08 by the owner, as the first step of moving the workflow
to its own repository). `scripts/dispatch/settings.mjs` reads and validates that file (OQ-122).
The default repository comes from it in five modules under `scripts/dispatch/` and in
`scripts/report/review-verdicts.mjs` (OQ-125). The queue reader — `queue.mjs`'s filename pattern,
frontmatter `id` check and `numericId`, `review.mjs`'s `resolveStory`, and `coder.mjs`'s
`loadQueueAt` — takes the prefix from it already (OQ-126), and so does the story lint,
`scripts/lint-stories.mjs` (OQ-127). OQ-128 takes the prefix from it
in `coder.mjs`'s and `story.mjs`'s story-id checks; OQ-129 fails a
test if either comes back into the code (split from OQ-122 on 2026-10-08 by the owner;
`review-verdicts.mjs`, and OQ-129 in this marker, added the same day from #222's review).

```
stories/
  OQ-49-import-player-info.md      ← open
  OQ-50-share-levels-via-link.md
  done/
    OQ-42-agent-review-gate.md     ← completed, moved by its own PR
  retired/
    OQ-55-declare-story-mechanisms.md  ← dropped unbuilt, moved by Session A
```

A story the owner decides not to build is retired, not deleted (decided 2026-10-07 by the owner).
It keeps its file and its number in a directory nothing dispatches from, so reviving it is a
`git mv`. `stories/README.md`, "Lifecycle", says how.

```markdown
---
id: OQ-49
title: Import current levels from playerInfo.dat
tier: normal               # fix | next | normal | later — priority only
kind: product              # product | workflow — never read by the dispatcher
depends_on: []             # [OQ-45] — dispatcher skips until those are done
model: sonnet              # per-story escalation
blocked: null              # null | "reason text" — set by a kickback
---

## Intent

As a player, I want to import my Workshop and Enhancement levels straight from the
game's save data, so that I don't have to type in every level to get started.

## Acceptance criteria

- [ ] **AC-1** — A file picker accepts a `playerInfo.dat` and reports a clear error
      for an unparseable one.
- [ ] **AC-2** — Workshop levels present in the file replace the entered values.
- [ ] **AC-3** — Enhancement levels present in the file replace the entered values.
- [ ] **AC-4** — Levels absent from the file are left untouched, not zeroed.

## Out of scope

- Interaction with OQ-22's Clear button — file separately if it matters.
- Any server-side parsing. Client-only per `Project-Outline.md`.

## Constraints

*(rare — binding implementation decisions; empty is the normal case)*

## Context

- `src/state/` — where entered levels live today
- OQ-24 — the original investigation, in `Completed-Questions.md`

## Open questions

*(must be empty to dispatch)*
```

### Why one file per story

- **Atomic.** A story's whole state is one file; two in-flight stories cannot conflict.
- **Machine-readable.** Frontmatter gives the dispatcher a schema to read and CI a schema to lint.
  A single 12 KB prose file gives neither.
- **Completion is a `git mv`** inside the story's own PR, not a cut-and-paste into an 82 KB
  archive. The move is visible in the diff and checkable by the reviewer.
- **Per-story history.** `git log stories/OQ-49-*.md` is the refinement trail.

`Completed-Questions.md` stays exactly as it is — a historical archive, grepped by OQ number. It is
not migrated. Only the handful of currently-open stories move.

### Status is derived, not stored

Only `blocked` is stored, because only it is not derivable. Everything else is read from the files,
from git and from GitHub. No status commits, no sweep, no drift.

**The statuses themselves, and what each is derived from, are specified in `stories/README.md`**,
and are deliberately not restated here. They were once: this document and that file each carried a
copy of the table, the copies disagreed within days, and a literal reading of the one here made the
queue reader unable to dispatch its own story. One authoritative statement, in the file closest to
the thing it describes.

What belongs here is the shape rather than the values. Status derives in **two layers** — what can
be known from the story files alone, and what needs git and GitHub — and that split is load-bearing.
Keeping the file-only derivation free of git is what lets the queue be read, tested and printed
without a repository in any particular state.

**Deliberately *not* a frontmatter field: the review round count.** It is derived by counting
`block` verdicts on the PR — see [Retry is bounded](#retry-is-bounded-and-the-bound-is-derived).
Storing it would mean a commit per round on a file that lives on `main` while the work lives on a
branch, and it would drift the moment anything wrote it inconsistently.

### Tier is priority, and nothing else

Four values, highest first:

| Tier | Means |
|---|---|
| `fix` | A defect or regression — Session B's blockers, rollback follow-ups. Absolute priority. |
| `next` | Deliberately prioritised ahead of the default. |
| `normal` | The default. Most stories. |
| `later` | Refined and dispatchable, but deliberately deferred. |

**Dependencies are not a tier.** `depends_on` already handles them mechanically and at the right
granularity, and the dispatcher already skips a story whose dependencies are not in `done/`. An
earlier vocabulary — `foundational | dependent | anytime | workflow` — mixed three axes: position
in the dependency graph, absence of a dependency, and subject matter. A story can be both workflow
and foundational, so forcing one value made the sort order arbitrary; and two of the four values
duplicated `depends_on` while being able to contradict it.

**Ordering:** by tier, then lowest id first, with one exception below. Deterministic, needs no
ordering file, and re-prioritising means editing one file's `tier`.

### Kind is for people, not the dispatcher

`kind: product | workflow` groups stories for reading — release-review assembly, or answering "how
much of this batch was tooling." **Nothing in the dispatcher reads it, and nothing in the ordering
may.** That is stated as a rule because a field that exists eventually attracts a sort: a future
change that orders by `kind` should be a visible violation of something written down rather than a
natural-looking extension. Adding a value is cheap for the same reason.

### The starvation valve

Tier-then-id does not starve stories *within* a tier, but a lower tier starves indefinitely while
higher-tier work keeps arriving. *(An earlier version of this document claimed the ordering "cannot
starve an old story." That holds only within a tier.)*

The valve, derived rather than remembered and therefore still deterministic:

> Among ready stories, if the one whose file has gone longest untouched exceeds the configured
> interval, it is dispatched next regardless of tier. At most one promotion per dispatch, and
> **never ahead of a ready `fix`.**

Four properties earn it:

- **Derived from git, not stored.** `git log -1` on the story file gives the age. A dispatcher
  restart cannot reset it — the same reasoning as the retry bound.
- **Self-limiting.** Once the aged story dispatches it is no longer the oldest, so the valve stops
  on its own. There is no rate to tune and no way for it to run greedily.
- **Last-touched, not created.** A story edited last week is being attended to, not starved.
  Creation date would promote a story that sat in draft for months and became ready yesterday.
- **`fix` is exempt.** A valve that can promote a `later` story ahead of a regression fix is worse
  than the starvation it solves.

The dispatcher records which rule selected the story. Without that, "why did it pick that one" is
unanswerable, and a promotion is indistinguishable from broken ordering.

### The readiness test

Review is [drift detection](#reviewer), so the reviewer can only catch drift from what was
**written down**. Anything Session A leaves unspecified is not drift — it is unspecified, and the
coder's choice stands unreviewed permanently.

The consequence is easy to miss: **a vague story does not produce a weak review, it produces a
review that cannot fail.** The gate silently stops working and the pipeline still shows green.

> **Could a reviewer, seeing only this story and the diff, tell whether the diff conforms?**

If no, the story is not ready. This is checkable while writing, which "is this story good?" is not.

### Sizing is a judgment, and it is Session A's

The counts — ≲ 5 files, ≲ 5 ACs — are a guideline, never a cap. A story is ready when Session A
agrees it is sized appropriately; the number informs that judgment rather than replacing it.

Making it a rule makes stories worse, and the failure is specific: an author held to "≤ 5 ACs"
complies by *merging* criteria into one that asserts two things — which is exactly what the
readiness test above exists to catch. The cap would trade away the property it was proxying for.

The better proxy is **distinct mechanisms, not criterion count.** Six criteria sharing one parser
and one reporting path are one story. Three criteria spanning a parser, a UI change and a CI
workflow are three stories wearing one id.

> **Is this one mechanism, or several that happen to ship together?**

**The obligation runs both ways.** Session A both authors the story and judges its size, and
nothing downstream checks that judgment — the reviewer compares the diff to the story and never
asks whether the story was too big; the schema lint counts structure, not scope. An oversized story
passes every gate in the system. So Session A must say so when scope is too large and propose the
split. Advisory, because the human decides — but not optional, or the cap has been deleted rather
than relaxed.

---

## The loop

### Happy path

1. Session A writes a story, with Open questions empty, and opens it as a pull request from the
   owner's account, as a **draft**. It marks the pull request ready only when the owner says so,
   and that is the owner's go-ahead for it to land (decided 2026-09-28; `docs/session-a.md`).
   Before every pick, and also on a run with nothing ready, the loop itself reviews any such open,
   non-draft pull request against `REVIEW.md`'s story-PR items and lands it on a passing verdict
   (OQ-83; `scripts/dispatch/writer-prs.mjs`). Only a pull request from an account with write
   access is reviewed at all, let alone landed (OQ-81). CI fails a coder's own
   pull request if it changes `stories/` beyond its own story's move, ticks and `blocked:` edit
   (OQ-82; `scripts/dispatch/story-containment.mjs`). **Planned (OQ-105):** it also fails one whose
   head branch names a `story/OQ-<n>-…` other than the story its diff moves.
2. Dispatcher picks the highest-tier, lowest-id ready story; creates a worktree and the branch
   `story/OQ-49-import-player-info`. The loop (`scripts/dispatch/loop.mjs`, OQ-86) skips a ready
   story whose `story/OQ-<n>-*` branch already exists on `origin` (`stories/README.md`'s
   `in-progress`), so a story stopped after its PR was opened, which still reads `ready` on `main`,
   is never dispatched again. A story that stops before it has a PR stops the loop instead, since
   nothing on `origin` would keep it from being dispatched again -- except that, straight after
   creating the branch and before the dependency install and the coder session, `dispatchCoder`
   makes an empty **claim commit** on it, naming the machine and the time, and pushes it to
   `origin` with `git push --force-with-lease=refs/heads/<branch>: origin <branch>` (`coder.mjs`'s
   `claimPushArgs`, OQ-110): the empty expected value means "must not already exist", so the push
   only ever creates the branch there, and a second claim of the same branch is refused. From the
   claim on, that commit -- not `origin/main` -- is the base the dispatch measures "committed
   beyond" from, so a session that commits nothing still ends `nothing-committed` as before, and
   `pickStory`'s existing check for a branch on `origin` skips the story on the next run. A failed
   claim push spends nothing (no install, no session) and leaves nothing behind: `branch-exists`
   when the branch is then on `origin` (a race with another machine), otherwise `claim-failed`
   carrying git's error. A story whose branch is only local is skipped too (`pickStory`, OQ-111): it
   is pushed to `origin` as it is with `claimPushArgs` before the skip, and the skip entry says
   whether the branch was on `origin` or only local, and for a local one, whether that push
   succeeded. A branch both local and on `origin` counts as on `origin`, whatever its local tip, and
   nothing is pushed for it. A skip of either kind gets a `Loop: OQ-n is stuck` issue (OQ-112,
   `loop.mjs`'s `pickStory` skip handling): always for a local-only branch, and for one on `origin`
   unless its claim is younger than `STUCK_AFTER_MS` -- a younger claim is most likely a dispatch
   still running, on this machine or another. A skipped story with an open pull request gets none,
   since the pull request already shows it (OQ-48's AC-8).
   Before picking, and only between
   stories, the loop fetches `origin` and checks out `origin/main`, detached, in its own worktree
   (`updateCheckout`, OQ-109), so its code, prompts and queue include everything already landed.
   If that worktree has anything uncommitted, it stops with status `dirty` and dispatches nothing.
   A story stopped with its PR open does not hold the update back.
   Each story then runs in its own process, so it loads the code as updated; the loop's own
   process keeps what it loaded at start.
3. Coder implements, tests green, commits, and emits the PR title/body and a
   draft-or-ready decision in its report. The dispatcher pushes the branch (`pushBranch` in
   `scripts/dispatch/coder.mjs`), so a model session has no write access to the remote, then opens
   the PR from that text, as a **draft** if the coder said draft.
4. CI passes. `scripts/dispatch/story.mjs` waits for it (`waitForCi`) before reviewing, so no
   review is spent on a head that cannot land.
5. Dispatcher spawns the reviewer, which returns a structured verdict.
6. Dispatcher posts the verdict as a marker comment, and `review-gate.yml` derives
   `review/agent` = `success` on the head SHA from it.
7. The landing sweep merges it (squash) once `mergeable_state` is `clean`. The owner
   triggers the sweep, or the owner or the dispatcher session (**The dispatcher session**, below)
   runs `scripts/dispatch/land.mjs` (OQ-50), which waits until the PR is landable, triggers it and
   waits for the merge. `story.mjs` calls `land.mjs`.
   The loop starts the next story only once this one has merged, or stopped with its stop fully
   recorded (OQ-86); anything else stops the loop. So every story it dispatches runs from a `main`
   that includes the last.

### Failure paths

The majority of the interesting behaviour.

| Situation | Route |
|---|---|
| Reviewer returns `block` | Findings → coder respawned with story + findings. **Bounded** at three blocking verdicts (`MAX_ROUNDS` in `scripts/dispatch/story.mjs`, OQ-48). The respawn (`retryStory` in `scripts/dispatch/coder.mjs`) works on the existing branch and pull request, replaces the PR body, never opens a second PR, and says whether its findings came from review or CI. It leaves the PR's draft state alone: `story.mjs` acts on a coder's `blocked:` or draft, and stops the story. |
| Still failing at the bound | Human queue. Round count **derived from `block` verdicts on the PR**, not stored. `review-gate.yml` applies `review-blocked` itself (OQ-80). `story.mjs` makes the PR a draft (OQ-87), then records `blocked:` in the story file on the story's own branch, as a commit it pushes with `pushBranch`. If the conversion to a draft fails it commits nothing, so a `blocked:` story is never left ready. The PR stays open, as a draft; `main`'s copy is not touched. |
| CI red on the head | A run that concluded `failure` → failure output → coder respawned on the same branch. Bounded separately at three (OQ-48's AC-4), derived from the PR's failed CI runs (`countRedCiRounds`); then `blocked:` on the branch, no label. |
| CI cancelled, timed out, or not finished within the dispatcher's wait | Not retried and not counted. The story stops, with `blocked:` on the branch naming the outcome. None of these is something a coder can fix (OQ-48's AC-5); `waitForCi`'s `red` result carries the run's `conclusion` to tell them apart. |
| CI failed in a setup step | A run that concluded `failure` only in setup steps (checkout, Node, `npm ci`, the browser install, or GitHub's `Set up job`) is treated like a cancelled run: not retried, not counted as a red round, and the story stops with `blocked:` naming the steps (`ci-setup-failed`). `ci.yml` marks its setup steps with a `Setup: ` name prefix that `ci.mjs`'s `isSetupStep` recognises, and `ci.test.mjs` checks the two agree. Decided 2026-10-07 by the owner, after a 403 from Playwright's browser CDN failed a run that the loop would have answered with a coder retry. Re-running CI is left to whoever runs the loop, so `ci.mjs` stays read-only. |
| A retry reports the coder's `blocked:`, a draft request or a failure; a review records no verdict; a retry after red CI pushes no commit; landing fails | The story stops. Only the results OQ-48's AC-2 names continue the run (the `decide*` functions of `story.mjs`); every other result stops it. Every stop with an open PR makes the PR a draft first, so nothing can land it, which keeps the rule that a `blocked:` story is always a draft. Then it records `blocked:` on the branch. |
| The reviewer's verdict does not parse | `reviewPullRequest` runs one more reviewer session, in the same worktree and with the same prompt, story, pull request, environment and model, before returning `malformed-verdict`; a second malformed reply stops the story as above, with both sessions' parse failures in the reason. Only a malformed verdict is re-run, never more than once, dependencies are not installed again, and each session keeps its own budget. Decided 2026-10-08 by the owner, so that one badly formatted reply does not stop a story. Before the second session the checkout is checked again, and if the first session changed it there is no second session and nothing is reset (decided 2026-10-08 by the owner): a reviewer that wrote to its checkout is worth seeing. Every result `reviewPullRequest` returns after running a session says how many it ran (1 or 2). |
| The dispatcher is interrupted mid-story | The owner resumes it from its PR number (`story.mjs OQ-n --pr <number>`, OQ-48's AC-9), which derives where it was from GitHub alone. Once the run has pushed, the story's branch on `origin` keeps it `in-progress`, so the loop (OQ-86) skips it; a run killed between its push and opening the PR leaves a branch with no PR, which the owner handles by hand. Killed before its claim push, the story has no branch on `origin` and the loop picks it again, but the killed run's local branch makes the dispatch return `branch-exists`, which stops the loop (OQ-86's AC-3 and AC-4). The claim push (OQ-110, above) means a run killed after it almost always leaves a branch every machine sees, since the claim lands before the install or the session starts. The loop skips a story whose branch is only local, after pushing it (OQ-111, above), and opens a `Loop: OQ-n is stuck` issue for either kind of skip (OQ-112, above). |
| Story was wrong, not the code | `blocked:` set with the reason → Session A |
| Coder hits ambiguity mid-story | `blocked:` + the specific question → Session A |
| Branch stale | Rebase; if it fails, kick back rather than merge against a moved world |
| Spawn died / timed out / hit budget | Dispatcher records it and moves on; the watchdog surfaces it. A coder dispatch that ends before a PR exists (a failed install or session, nothing committed, uncommitted changes, a failed push) stops the loop (OQ-86) rather than moving on. The claim pushed before the install or the session (OQ-110, above) stays on `origin` through that stop, so the next run skips the story instead of dispatching it again, with the `Loop: OQ-n is stuck` issue that skip now opens (OQ-112, above). A dispatch that stops before a pull request exists for a reason other than another run's claim (`branch-exists`) or the story going stale (`not-ready`) opens the same issue itself, directly, rather than waiting for the next run's skip. |

**The outlet valve must never prompt.** A spawned session that asks a question with nobody attached
hangs — one observed instance sat blocked for eight minutes. Invocations pass
`--permission-prompts none` so anything that would prompt is denied instead of blocking, and the
coder's escape route is **write-and-exit**: set `blocked:` with the question, exit.

### Retry is bounded, and the bound is derived

A fixed number of blocking verdicts, then stop. OQ-48 holds the number and the reasoning behind
it; this section deliberately does not restate it. Uncapped retries are how you get forty commits
of an agent arguing with itself. A reviewer session is fresh each time and cannot know how many
rounds preceded it, and a prose bound honoured by agents remembering is not a mechanism — that is
the existing OQ-48.

**The round count is derived from the PR, not stored.** Each round leaves a durable trace: a
findings comment and a `review/agent` status of `failure` on the head SHA it judged. Counting
`block` verdicts recorded on the PR gives the round count exactly, with no state to keep in sync.

This matters more than it looks. An earlier draft of this document put the count in "the
dispatcher's own run state," which contradicts
[principle 6](#principles) and the [derived-status model](#status-is-derived-not-stored): a
dispatcher restart would silently reset the bound, and a bound that resets when a process dies is
the bound not existing. Deriving it means the count survives restarts, machine reboots, and a
dispatcher rewritten from scratch — it is a property of the PR, which is where the evidence lives
anyway.

The same derivation feeds the circuit breaker. When the bound is reached, `story.mjs` makes the
PR a draft and sets `blocked:` on the story, on the story's own branch. `review-gate.yml` applies
`review-blocked` itself, because it sees every PR, including ones no dispatcher ran. That is what
makes the breaker in `land-approved.yml` count a signal something reliably produces.

---

## Execution model

**This is the largest revision from v1.** The documented pain of the existing workflow — no `gh`,
blocked network egress, sessions unreachable mid-flight, sessions dying at $0, ref deletion
refused — is *cloud-session* pain. Running the loop **locally** eliminates most of it at once.

### Everything runs locally

Verified on the owner's Windows machine: `claude` CLI 2.1.273, `gh` 2.100.0 authenticated as
`luplows`, node 24.21, git 2.51 with worktree support.

| | Cloud session | Local |
|---|---|---|
| `gh` CLI | absent | **present** |
| Network egress | policy-limited; `mytower.app` unreachable | **unrestricted** |
| Ref deletion | refused (HTTP 403) | **works** |
| Mid-flight control | cannot be messaged | **ordinary process** |
| Death at $0 | observed | **not applicable** |

The cost is that the machine must be on. For a solo project that is acceptable, and the
[watchdog](#watchdog) covers the case where it isn't.

### The dispatcher is a script

Not a Haiku agent — **a script, with no model in it at all.** It reads the story directory, derives
state from git and `gh`, invokes `claude -p`, parses structured output, and posts a commit status.
Every one of those is deterministic.

**Planned (OQ-123, OQ-130, OQ-131):** the script works on the project in the working directory,
not on the checkout it is loaded from: the engine (the scripts and the prompts) and the project
(its settings, stories and repository) can be in different places, so a project can run the
workflow installed as a dependency. One entry point, `scripts/dispatch/cli.mjs`, runs each command
(decided 2026-10-08 by the owner, as a step of moving the workflow to its own repository). OQ-123
does it for `coder.mjs`, `review.mjs`, `story.mjs` and `land.mjs`, OQ-130 for `loop.mjs`, and
OQ-131 adds `cli.mjs` (split from OQ-123 on 2026-10-08 by the owner).

This also materially improves the self-marking problem. The thing that posts a verdict is
version-controlled, reviewable, testable code that can only report what the reviewer returned.
That is not cryptographic independence — closing that properly still needs a second GitHub
identity — but "read the script and see it cannot fabricate" is a real improvement over "trust the
orchestrating agent."

### The dispatcher session

Decided 2026-09-28 by the owner. Until the loop runs unattended (OQ-86), the dispatch scripts are
run by hand, from a Claude Code session the owner has asked to act as dispatcher. That session
runs `coder.mjs`, `review.mjs`, `land.mjs` and `story.mjs`, and relays what they return. It is the
dispatcher's hands, not a coder or a reviewer: it writes no code for a story and decides no
verdict.

It runs them from a worktree of its own at a detached `origin/main`, never from the repository's
main checkout (decided 2026-10-06 by the owner, replacing the main checkout). Before each dispatch
it fetches `origin` and checks out `origin/main`, detached, as the loop's `updateCheckout` does.
The scripts run against the checkout they are loaded from (`DISPATCHER_ROOT`, `coder.mjs`), so the
session runs the code that has landed, and the main checkout is left free for whoever else is
working. This is a rule, not a mechanism: only the loop's `main` refuses a checkout with a branch
checked out (`requireOwnWorktree`, `scripts/dispatch/loop.mjs`).

**It may land, and only through `land.mjs`.** It runs `land.mjs`, directly or through `story.mjs`,
for a pull request whose head has an honoured `pass` or `pass-with-observations` verdict and green
CI. It never runs `gh workflow run land-approved.yml`, and never merges through the API or any
other way. No other agent session triggers the sweep. `CLAUDE.md`, "Branches and pull requests",
states the rule; this section is its rationale.

Why this is safe enough:

- **`land.mjs` decides nothing a script would not.** It triggers the sweep only once
  `review/agent` is `success` and `mergeable_state` is `clean` on the head, and the sweep re-checks
  both. The session can choose *when* to land, never *whether* a head passed: the verdict is the
  reviewer's, and `review/agent` is posted by `review-gate.yml`.
- **It is a rule, not a mechanism.** The session holds the owner's credential, as the script
  dispatcher does (**Credential minimalism**, below), so nothing but the rule stops it triggering
  the sweep some other way. The rule names `land.mjs` because that module's own allowlist permits
  the one dispatch and no other write.

The owner can require a go-ahead before the session lands particular pull requests, for example
ones that change `CLAUDE.md`, `REVIEW.md`, `.github/`, `.claude/` or this document. That is an
instruction to the session, lifted when the owner says so, and not part of this design.

### Running unattended

Decided 2026-09-28 by the owner, planning how Session A's pull requests reach the queue without a
dispatcher session in between.

- **Planned (OQ-101):** a Windows scheduled task starts the loop every 15 minutes while the machine
  is on, on mains power only. The task is a script: a run with nothing ready starts no model
  session. GitHub's cron is not used (**Watchdog**, below).
- **Planned (OQ-101):** a run takes a lock that a dead holder does not keep, and appends one line to
  a local run log. That log is how the owner hears about the loop's own stops. A leftover
  `tw-coder-*` worktree from an interrupted run is raised as a GitHub issue, as OQ-112 raises a
  stuck story, and the run goes on (decided 2026-10-01 by the owner). A blocked story pull request is also reported by
  GitHub's failure email, since a blocking verdict fails the gate's run.
- The loop runs from a worktree of its own, beside the repository and at a detached `origin/main`,
  created once by `node scripts/dispatch/loop.mjs --init [path]` (`initWorktree`,
  `scripts/dispatch/loop.mjs`, OQ-109). Between stories `updateCheckout` fetches `origin`, stops with
  status `dirty` if the worktree has anything uncommitted, and otherwise checks out `origin/main`,
  detached. `main` refuses, before fetching or dispatching anything, to run from a checkout that has
  a branch checked out (`requireOwnWorktree`). A dispatcher session's hand-runs also come from a
  worktree of their own, by rule rather than by that check (**The dispatcher session**, above).
- Stuck stories reach the owner as GitHub issues, one per story (OQ-112), so a
  leftover on one machine is seen from any (decided 2026-10-01 by the owner, who runs the loop on
  two machines). An issue names the machine by a label the owner sets, never its hostname, since
  the repository is public. A story whose branch is on `origin` with no open pull request is stuck
  unless its claim is younger than 2 hours (`STUCK_AFTER_MS`, `coder.mjs`'s `claimAgeMs`; this
  restatement must not drift from them). A younger claim is most likely a dispatch still running,
  on this machine or another, and a branch with no claim counts as stuck. With two or more open
  `loop-stuck` issues the queue stops completely: a run starts no coder session, review or landing
  (decided 2026-10-03 by the owner). One stuck story can be its own fault, while two suggest the
  loop's. The claim commit (above, OQ-110) names the machine by the same label, read from
  `TW_MACHINE_LABEL` (`coder.mjs`'s `machineLabel`): unset or empty is `unlabelled`, and a value
  that does not match `^[A-Za-z0-9._-]{1,32}$` stops the dispatch with `bad-machine-label` before
  anything is claimed, installed or spawned.
- `--max-stories N` caps how many stories one run starts (`scripts/dispatch/loop.mjs`, OQ-86); a
  story the loop skips as `in-progress` does not count against it.
- **Planned (OQ-102):** past a usage threshold, the loop starts no coder session, first dispatch or
  retry, but reviews and landing carry on, so every pull request ends with a review posted. A
  story that would have been retried is paused, and resumes on a later run under the threshold.
  What is measured, and over what window, is open.
- Any pull request from an account with write access (OQ-81) that passes review may land
  unattended, including one that changes this document, `CLAUDE.md`, `.github/` or `.claude/`.
  Marking it ready is the owner's go-ahead: Session A opens its pull requests as drafts and marks
  one ready only on the owner's word. A dispatched story's own pull request lands on a pass, as it
  does today: the story was the go-ahead.
- Before the task is switched on, OQ-81 and OQ-82 are built, so nothing lands automatically from an
  outsider or changes `stories/` from inside a coder's pull request, and so are OQ-73 (a coder
  cannot read the owner's stored token) and OQ-80 (the circuit breaker counts real blocks).
  OQ-101's `depends_on` holds this.

### Invocation shape

Sketches, not literal — the prompts are rendered from files with the story injected.

```bash
# Coder — can edit, inside its own worktree, which is the session's working
# directory (spawn.mjs's required cwd; no --add-dir). It commits and does not push
# (the dispatcher pushes, OQ-84); gh is neither allowlisted nor authenticated
# (OQ-63). The allowlist, read-only shell utilities included, is
# coderAllowedTools's alone (OQ-67).
claude -p "$(render .claude/prompts/coder.md OQ-49)" \
  --model "$STORY_MODEL" --effort medium \
  --permission-mode acceptEdits \
  --permission-prompts none \
  --allowedTools $(coderAllowedTools "$BRANCH") \
  --disallowedTools "Bash(gh:*)" "Bash(git push:*)" \
  --env "$(coderEnv)" \
  --max-budget-usd 6 \
  --output-format stream-json --verbose

# Reviewer — handed no credentials, denied the obvious write paths (see OQ-62)
claude -p "$(render .claude/prompts/reviewer.md OQ-49 $PR)" \
  --model opus --effort high \
  --disallowedTools Edit Write NotebookEdit "Bash(git push:*)" "Bash(gh:*)" \
  --allowedTools $(reviewerAllowedTools) \
  --permission-prompts none \
  --max-budget-usd 3 \
  --output-format stream-json --verbose
```

Both roles use `stream-json` rather than `json` so the stall check in `spawn.mjs` can see a session
working rather than only seeing silence until it ends (OQ-76). In print mode, `--output-format
stream-json` requires `--verbose` or the CLI exits 1. `claude --help` does not say so; the runner
established it by running CLI 2.1.281 (OQ-76's Context).

Both argument lists, both allowlists, the coder's environment and the rendered prompt are built by
`scripts/dispatch/invocation.mjs` (`buildInvocation`), which starts nothing (OQ-74). The prompt is
returned separately and never becomes an argument. `reviewerAllowedTools()` is the reviewer's
allowlist: the read-only `git` verbs plus `git merge-tree`, `Read Glob Grep TodoWrite`,
`npm`/`npx`/`node`, and `READ_ONLY_SHELL_UTILS` imported from `coder-env.mjs`, with no `git push`
and no `gh`. `git merge-tree` is the one `git` verb there that writes: it adds unreferenced tree
and blob objects and moves no ref, and it is kept in its own list in `invocation.mjs` so that the
rest stays read-only. Each list is
complete on its own, because `permissions.allow` in `.claude/settings.json` is ignored when the
workspace is not trusted. Untrusted values (`STORY`, `PR_BODY`, a retry's findings) are bounded with
`wrapInjectedBlock` by placeholder name: everything not declared a trusted inline token is wrapped.

`scripts/dispatch/review-tools.mjs` does the jobs that refused shell forms were
doing in reviews: a command repeated N times, a command's exit code, and sorted output. It runs only
commands the reviewer's allowlist admits, without a shell. On Windows it starts `npm` and `npx` as
`node` running npm's own CLI scripts, since they cannot start there without a shell; elsewhere it
starts them by name. For anything else the reviewer runs the parts as separate commands, or uses
`node -e`.

**What a reviewer's shell command may do is wider than `reviewerAllowedTools()`.** Checked
2026-09-28 with Claude Code 2.1.281, in a session with exactly the reviewer's arguments,
environment and kind of working directory: of twelve command shapes, eleven ran. Among them were
`sed -n 1p`, `ls | sort`, a `for` loop and `cd scripts && pwd`, none of which the allowlist names.
Only `echo "exit=$?"` was refused. So the permission layer also admits commands it recognises as
read-only, and refuses what it cannot confirm is safe, such as a `$?` expansion. This does not
widen what the reviewer can write: `node` was already on the allowlist (see "defence in depth"
below, and OQ-62). But it means the allowlist is a floor for reads, not a ceiling, and the
behaviour belongs to the Claude Code version, so a change of version can change it.

Three flags are load-bearing:

- **`--permission-prompts none`** — anything that would prompt is denied rather than hanging.
  Directly answers the observed hang.
- **`--max-budget-usd`** — a hard spend ceiling per invocation. Turns "how much can one runaway
  story cost" into a number chosen in advance.
- **`--allowedTools`** — what the session can actually do once prompting is off. This one is
  easy to leave out and the first hand-run of the loop did: `--permission-prompts none` plus
  `--permission-mode acceptEdits` covers file edits, and `.claude/settings.json` adds the
  project's npm/npx commands and read-only git — but nothing that writes to the repository, so
  `git commit` is silently **denied**. The coder does the work, runs the suite
  green, and then cannot commit it. (`git push` was denied the same way until OQ-84 moved the push
  to the dispatcher, which is why the coder's list now denies it on purpose.) The two flags are a pair — the first decides that
  nothing may prompt, the second decides what does not need to.

**The coder no longer holds a GitHub API credential at all (OQ-63).** It commits and emits the PR
title and body as the last thing in its report; the dispatcher pushes the branch and opens the pull
request with the owner's credential (**Credential minimalism**, below). (The coder's reach of git's own SSH
authentication is untouched by anything below; that is OQ-73's.) `gh` is not on the coder's allowlist, and `--env
"$(coderEnv)"` (`scripts/dispatch/coder-env.mjs`) strips `GH_TOKEN`, `GITHUB_TOKEN` and
`GH_ENTERPRISE_TOKEN` from its process environment and points `GH_CONFIG_DIR` at an empty
directory, so nothing capable of setting a commit status, dispatching a workflow, or writing to a
pull request is reachable — not through `gh` directly, not through `node -e` spawning `gh` or
`curl` via `child_process`, and not through an `npm`/`npx` script doing either, because none of
those paths can read a token that was never in the environment. This is the same shape as
**credential minimalism** below, applied to the coder rather than the reviewer, and it is the
reason `Bash(gh:*)` disappears from the coder's list entirely rather than being narrowed: there is
no longer a legitimate use for it to allowlist.

The reviewer's list is the mirror image, and narrower on purpose: `git` subcommands
enumerated rather than `Bash(git:*)`, so `git push` is not in the allowlist *before* the
`--disallowedTools` deny rule also removes it. Two barriers against the accidental path beats one.

The coder's `--disallowedTools` carries the same blanket `"Bash(git push:*)"` as the reviewer's
(`CODER_DISALLOWED_TOOLS` in `scripts/dispatch/coder-env.mjs`). Before OQ-84 it could not: the coder's
allowlist granted scoped push patterns, and a deny rule takes precedence over an allow rule, so the
deny would have shadowed them. The push is now the dispatcher's, `coderAllowedTools` grants none,
and the deny is a second barrier with nothing to shadow.

**That is defence in depth, not containment.** The same list grants `npm`, `npx` and `node`,
because verifying the author's claims means running the suite — and those are arbitrary execution.
`node -e` writes files despite `Edit`/`Write` being disallowed, and spawns `git push` despite the
deny rule, which matches a command *prefix* that `node …` never trips. A reviewer session today is
therefore **not** structurally unable to write; it is unwilling, because its prompt tells it to post
nothing. Claiming otherwise — an earlier draft of this section said "two independent reasons it
cannot push" — overstates the guarantee, and overstating a security property is worse than not
having it, because it stops people looking.

The tension is real rather than an oversight: **verification requires execution, and execution
defeats structural write-prevention.** Closing it needs the capability removed rather than the
command denied — a reviewer that runs with no SSH agent, no keyring access and no push-capable
credential, so that `git push` fails for want of authorisation rather than for want of permission.
That is the same conclusion **credential minimalism** reaches below by a different route, and it is
not built yet.

That narrowness has its own cost, and it is not symmetric with the coder's. A hole in the
**coder's** allowlist fails loudly and late — it cannot run a command it needs, and someone notices. A hole in
the **reviewer's** fails *quietly*: a reviewer that cannot run `npm test` or `git merge-base` can
still return a confident `pass`, having checked less than it thinks. The `git` verbs above are
therefore a deliberately broad set rather than a minimal one — not a complete one, since `blame`,
`rev-list`, `describe`, `remote`, `shortlog` and `config --get` are all plausible and none are
listed. Calling it complete would be the same overstatement this section exists to correct. They
are read-only except `git merge-tree`, which writes unreferenced objects (above). `ls-remote`,
`ls-tree` and `merge-tree` were added on 2026-09-24, after reviewers were refused all three while
checking branch listings and merge claims. The rest of the list is not read-only at all, per the
paragraph above.
`reviewer.md` instructs the
reviewer to treat a denied read-only command as a finding about its own invocation rather than
something to work around. An enumerated allowlist has to be maintained; the alternative is a gate
that silently reviews by reading.

**What a spawn actually costs**, measured across the OQ-63, OQ-66 and OQ-51 hand-runs rather than
guessed, so that the budget (`invocation.mjs`, OQ-74) and the timeout (`spawn.mjs`, OQ-65) are
picked from data:

| Role | Model | Cost | Wall time |
|---|---|---|---|
| Coder, first pass on a fresh story | sonnet | $0.96 – $3.17 | 3 – 16 min |
| Coder, retry round carrying findings | sonnet | $0.75 – $1.05 | 2.9 – 4.8 min |
| Reviewer, full diff plus re-running the suite | opus | $0.95 – $1.88 | 1.8 – 4.8 min |

Three things follow. The sketch's `6` and `3` are **generous** — no spawn has come close, and the
one that ended early ended on a session limit rather than the budget. *(No longer true, 2026-10-08:
OQ-122's first coder spent its whole `6`, $6.03 over 119 turns, and committed nothing. Its story
covered seven modules (`coder.mjs`, `land.mjs`, `loop.mjs`, `review.mjs`, `story.mjs`, `queue.mjs`
and `lint-stories.mjs`) and their tests. The owner chose to split it into smaller stories, OQ-122
and OQ-125 to OQ-129, rather than raise the budget: smaller stories are cheaper to run and to
review. OQ-123 was split the same way, into OQ-123, OQ-130 and OQ-131.)* A **retry round is
markedly cheaper than a first pass**, because the findings do the searching the coder would
otherwise pay for, so the expensive spawn is the first one rather than the loop. And a reviewer
costs about what a retry round does, so review is not the expensive half of a retry either. A
timeout wants to be well clear of 16 minutes, not tuned to the median.

**The reviewer range widened on contact with a real story.** These figures originally read
$0.95 – $1.38 and 1.8 – 2.7 min, taken from two reviews of docs-shaped PRs. OQ-51's four rounds ran
$1.24 – $1.88 and 3.0 – 4.8 min — every round outside the recorded wall-time range, and the top of
the cost range. Reviewing a diff with real logic in it costs more than reviewing prose, which is
obvious in hindsight and was not in the table. A timeout fitted to the original numbers would have
cut off every round of that story.

These are session observations, now from fourteen spawns, recorded here because nothing in the
repository captures them and a reviewer therefore cannot check them. Treat them as a starting point
to be replaced once the spawn modules record their own.

### Credential minimalism

**The reviewer is given no GitHub write access, and needs none.** It returns a structured verdict on
stdout; the dispatcher posts it as a marker comment, and `review-gate.yml` derives the status.

**"Given" is doing real work in that sentence.** Running locally, the reviewer runs as the owner,
on a machine where an SSH key and a `gh` keyring token are reachable — and its allowlist must
include `npm`/`node` so it can verify the author's claims, which is arbitrary execution. So it is
not *denied* write access; it is *handed* none and told to post nothing, on a machine where the
capability exists. That is a weaker property than the heading once implied, and the weaker version
is the true one. What makes it hold in practice is that no part of the prompt asks the reviewer to
post, so nothing pushes it toward looking — which is exactly the failure mode the paragraph below
describes, arrived at from the other side. Genuinely removing the capability means a reviewer with
no agent, no keyring and no push-capable credential; see the **invocation shape** section.

This is not convenience. In the existing workflow the reviewer prompt accreted one fix per failed
run — credential hunting after sessions could not post, "do not ask questions" after one hung —
until the assembled text read *find tokens on disk, tell nobody, act with elevated access*, and a
reviewer correctly refused it as an injection attack. Each addition was locally reasonable; nobody
re-read the whole.

Removing the reviewer's need to post anything **deletes that section of the prompt** rather than
rewording it. Applies equally to Session B, which writes stories, not statuses.

**The coder was first given a narrower credential rather than the same treatment, because it then
needed to push (OQ-63); since OQ-84 the dispatcher pushes, and it does not.** This was the more urgent of the two
gaps (OQ-63, filed `tier: fix` where the reviewer's twin, OQ-62, is `normal`): the coder's *goal* is
a landed PR, where the reviewer's prompt only ever tells it to post nothing and it gains nothing
from a merge. With the owner's `repo`-scoped token, a coder holding `Bash(gh:*)` could set
`review/agent` to `success` on its own head and then dispatch `land-approved.yml` — confirmed
against this repository the same way the reviewer's gap was, by probing with deliberately invalid
payloads and getting `422` (authorised, only validation failed) rather than `403` (denied). Both of
the rules this workflow is built on — *you do not clear your own gate*, *triggering the sweep is
the owner's* — were held by `CLAUDE.md`'s prose and nothing else. (The second has since been
widened to the dispatcher session running `land.mjs`; see **The dispatcher session**.)

The coder no longer pushes (OQ-84). The dispatcher pushes its branch, and the coder's allowlist
grants no `git push` and denies it outright. That removes the reason given above for treating the
coder differently from the reviewer. What still reaches the owner's stored credentials from a
coder session is OQ-73's.

So the coder's GitHub credential is removed rather than scoped: `coderEnv`
(`scripts/dispatch/coder-env.mjs`) hands it an environment with no `GH_TOKEN`, `GITHUB_TOKEN` or
`GH_ENTERPRISE_TOKEN`, and a `GH_CONFIG_DIR` pointed at an empty directory — so `gh`, and anything
that reaches the GitHub API the way `gh` does, has no credential capable of a commit status, a
workflow dispatch, or a pull-request write, regardless of whether the call is made directly, from
inside `node -e`, or from an `npm`/`npx` script. Git's own authentication over SSH is not touched
by any of that, which is why the push is the dispatcher's rather than something the coder is
trusted to do with it (OQ-84). The coder still cannot open its own PR — that capability moves to
whatever spawned it. "A coder session is trusted, not contained" — the wording this section carried
while OQ-63 was open — is no longer true of the write path that mattered; see `REVIEW.md`, "For the
coder: opening a PR".

**Corrected 2026-09-19, while writing OQ-68.** This paragraph used to claim the dispatcher holds a
*third, separately-scoped credential* with pull-request write but neither commit-status nor
workflow-dispatch, "so the thing that opens the PR still cannot clear the gate". That was never
true, and it could not become true without contradicting Phase 1: a dispatcher has to record
verdicts, and there is exactly one credential in this project — the owner's `repo`-scoped token.
**The dispatcher is a trusted user of it, and that is the design rather than a gap.**

What actually keeps the dispatcher from clearing its own gate is not credential scope, and saying
it was obscured the real mechanism:

- **The dispatcher does not decide the verdict.** It relays a judgement made by a separate session
  that holds no credential at all. A credential split inside one trusted script buys nothing,
  because the script holding both halves can always call both.
- **`review/agent` is posted by `review-gate.yml`, not by the dispatcher** — the workflow reads the
  marker comment and derives the status. So the dispatcher's output is a *comment*, and enforcement
  is a GitHub Actions job it does not control. That split is the guarantee, and it already exists.
- **Triggering `land-approved.yml` is the owner's, or `land.mjs`'s when the dispatcher runs it,
  whether the dispatcher is a script or the dispatcher session; no other agent session does.**
  Enforced as a tested prohibition in OQ-68 and OQ-48 rather than by scope on a token. For the
  dispatcher session it is a rule, not a mechanism (**The dispatcher session**, above). `land.mjs`
  (OQ-50) is the one module that triggers it. Its own allowlist permits that one dispatch (`main`,
  with the one input `pr` naming its pull request) and no other write, and neither `coder.mjs` nor `review.mjs` imports it. `github.mjs`'s prohibition stays as it is.

A genuinely separated credential needs a second GitHub identity, which is item 10 of the open
questions table below and is not built. Until it is, this section says what is true.

### Watchdog

The dispatcher is a script, so it cannot lose context — but it can stop, and nothing would notice.
Because state is derived, a **scheduled GitHub Action** can compute "is anything stuck?" from
branches and PRs alone, independently of the dispatcher, and survives the machine being off.

It should also check the observable consequence of branch-protection regression: **did any PR merge
without a successful `review/agent` status?** A required check vanished silently once. Reading
protection config needs admin scope; merge history needs none.

**Scheduled workflows are best-effort, and here they proved far worse than that.** A `*/15` cron on
`land-approved.yml` delivered about one run every five hours — roughly 5% of the configured rate,
with gaps of 4–5 hours. So: put nothing on a schedule whose *latency* matters. A watchdog is still
worth having, because it only has to notice eventually, but read its cadence as "sometime" rather
than as the cron expression. `land-approved.yml`'s schedule was removed for this reason; see OQ-50.

---

## The gate

### What CI runs

The governing problem: **the same context that decided how to implement also decided what to
assert.** A coder that misreads a story writes tests confirming the misreading. Green means
"internally consistent," not "correct."

Current CI — oxlint, Vitest, build, Playwright — runs in **~70 seconds**. That is fast enough that
**tiering is premature**; run everything on every push. Adopt a PR-subset / merge-queue-full split
only when E2E passes roughly five minutes.

Additions that earn their place now:

| Check | Why |
|---|---|
| **Story schema lint** | Frontmatter valid, required sections present, AC ids well-formed. Carries the schema burden now that stories are files. |
| **AC↔test traceability** | Every AC id in the story appears in at least one test name. Converts "did you do what was asked" from judgment into a gate. |
| **Existing-test-modification flag** | Flags any PR touching tests outside its own story's additions. Today this is `REVIEW.md` item 9 — prose the reviewer must notice. |

AC ids appear in test names directly:

```js
test('OQ-49/AC-4: levels absent from the file are left untouched', ...)
```

**Coverage stays absent.** A percentage floor produces coverage-shaped tests that assert nothing,
and agents are extremely literal about hitting a number. The existing deliberate absence is correct.

**Flakiness: no retries in the merge gate.** A flake blocks the dispatcher with nobody watching,
and a coder meeting an unrelated failure may "fix" it by weakening the assertion. Quarantine —
skip plus an auto-filed story — keeps the signal visible instead of burying it in a retry count.
Determinism requires fixed clock, seeded data, no external network, and **stable test IDs rather
than text or positional selectors**.

**Setup is cached and bounded.** CI caches Playwright's browser, keyed on the runner's OS and the
installed `@playwright/test` version, and on a hit installs only the system packages. The install
step has a 5-minute limit and tries twice within it, two minutes each; the job has a 20-minute
limit, well inside `story.mjs`'s 30-minute CI wait. `update-screenshots.yml` does the same with the
same key, so baselines are minted by the browser CI compares against. Decided 2026-10-07 by the
owner, after installs hung in apt and one browser download was refused, with no limit short of
GitHub's 360-minute default. Retrying the install is a retry of setup, not of a test, so it does not
contradict "no retries in the merge gate": the checks themselves still run once. `detect-drift.yml`'s
weekly install is left as it is (decided 2026-10-08 by the owner): it gates no pull request.

**Definition of green:** it builds, lint is clean, every AC has a named test, Vitest passes,
Playwright passes without retries, no pre-existing test was modified without story authorization,
and the story file validates.

### Reviewer

**The reviewer's job is drift detection, not quality assurance:**

> Does this diff do what the story said, all of what it said, and nothing it didn't?

Three sub-checks: **completeness** (every AC delivered), **fidelity** (the AC is genuinely
satisfied, not merely named in a test), **containment** (nothing outside scope).

**The reviewer is given the story.** This is the single most important correction to the existing
implementation, where the reviewer receives `REVIEW.md`, the diff and the PR body — but never the
OQ entry. Its scope items therefore compare the diff to *the PR's own account of itself*, both
written by the same worker. A worker that misread the story writes a body describing what it built
and a diff matching that body; every item passes. Drift is invisible.

That happened by over-applying a correct principle. *"A reviewer that knows what the change was
meant to do cannot see that the diff does something else"* is true of **the author's account**. It
is not true of **the authored story**, which is the standard the diff must meet.

So the reviewer receives: **story file, diff, checklist.** It does not receive the coder's session,
summary, reasoning, or any dispatcher commentary. Decorrelation preserved; drift detection enabled.

**The PR description is itself in scope.** After forming findings from the diff, check whether the
description honestly describes the change. Prose that oversells a diff is real signal.

**Verdict states:** `pass` / `pass-with-observations` / `block`. Binary pass/fail cannot express
what reviewers here already produce — real problems rightly surfaced and arguably rightly not
blocking. Without the third state the verdict record understates what review catches, and any
measurement built on it is meaningless.

**Model:** Opus, high effort, and **deliberately not the coder's model.** Fidelity is the hard part
— noticing that a test named `AC-3` doesn't exercise AC-3 is adversarial reading. And author and
reviewer sharing a model family means correlated blind spots: context isolation decorrelates
*knowledge*, not *reasoning style*. Opus-reviews-Sonnet buys both at once.

### Recording the verdict

A **required status check keyed to the head SHA**, posted by the dispatcher:

```bash
# Valid where gh exists — verified on the owner's machine (gh 2.100.0, account luplows).
# NOT available in spawned cloud sessions.
gh api -X POST "repos/$REPO/statuses/$SHA" \
  -f state=success -f context=review/agent \
  -f description='OQ-49: pass' -f target_url="$FINDINGS_URL"
```

Why a status rather than a PR review: GitHub forbids approving your own PR, which deadlocks a
single-account project. A commit status carries no such restriction. **This is already implemented
and already required in branch protection** — verified live alongside `test`, with
`enforce_admins: true`.

Properties worth preserving:

- **Stale by construction.** A new push leaves the head with no status; merge blocks until
  re-review. "No dismissal mechanism" is a platform guarantee, not a convention.
- **`pass-with-observations` maps to `success`** with the observations in the findings comment.
  Only `block` maps to `failure`.
- **A blocking verdict also fails the workflow run**, purely so GitHub's built-in failure
  notification fires. A job reporting success while recording a block is silent exactly when
  someone needs to hear about it.
- **Never a label as the verdict.** Labels don't attach to a SHA, so an approval survives later
  pushes. Derive labels *from* the status if wanted.

### Merging

**Nothing with judgment merges.** The existing `land-approved.yml` is the correct design and should
be kept essentially as-is:

- **Triggered independently of the work**, so it depends on no session being alive — a worker
  finishes long before its verdict arrives. This was a `*/15` schedule until 2026-09-18; GitHub
  delivered it at roughly 5% of that rate, so the trigger was removed and landing is explicit
  (`gh workflow run land-approved.yml`) until a reliable one was chosen. `land.mjs` (OQ-50) is
  that trigger: it triggers the sweep once a PR is landable, and re-triggers while the PR is still
  open. It never merges itself. `story.mjs` (OQ-48) calls it, and the owner or the dispatcher
  session may run it directly; nothing else does.
- **It lands only pull requests whose author has write access** (the same association set the gate
  honours for markers, `scripts/land/check-author.mjs`), because a landed `ready` story is work the
  loop will carry out (OQ-81).
- **One PR per run.** `mergeable_state` is computed asynchronously, so a second merge in the same
  pass decides on stale data. The same fact has a cost between runs: straight after a merge, other
  open PRs can read `unknown` for a while, and the sweep skips `unknown` rather than guessing. A
  run triggered soon after the previous merge can therefore land nothing even though a PR is ready.
  That is safe, and it is why back-to-back manual runs sometimes need one more. See **GitHub
  mechanics** below and OQ-50.
- **The named PR, or else the oldest.** The sweep takes an optional `pr` input, and `land.mjs`
  always names its own pull request in it. A run given a pull request considers only that one and
  lands nothing if it is not landable, so `land.mjs` lands what it was called for and nothing else.
  A run given none, such as the owner's `gh workflow run`, lands the oldest landable one, so
  nothing starves. Decided 2026-09-28: the loop decides which pull request is ready, and a sweep
  that lands a different one spends `land.mjs`'s triggers, can stop a story that passed, and lands
  pull requests nobody asked it to. The candidate choice is made in
  `scripts/land/select-candidates.mjs`, which is tested without running the workflow.
- **Re-checks `review/agent` directly** rather than trusting `clean`, because a required check
  vanished from protection once. Prevention, not detection.
- **`--match-head-commit`**, which refuses the merge if anything was pushed between the check and
  the call.
- Circuit breaker at five `review-blocked` PRs, with exemptions for `breaker-override` and
  workflow-only diffs so a tripped breaker is not a trap.

`review-blocked` is applied automatically when a pull request reaches the round bound, by
`review-gate.yml`, with the bound derived from the PR's own `block` verdicts rather than
remembered (OQ-80). **Planned (OQ-119):** removing the label by hand means "I have seen the cost,
proceed", so after a removal only blocks recorded since the latest removal count towards applying
it again, read from the pull request's `unlabeled` events (decided 2026-10-08 by the owner).

### Merge queue

Two PRs that pass independently can break together; neither one's CI ever ran against the other's
changes. A merge queue tests the post-merge state on temporary branches — and **the PR's own head
SHA never changes**, so the `review/agent` status survives. That is the property that makes it
adoptable: the previously-rejected alternative (refreshing every ready PR after each merge) reset
the gate on every in-flight PR.

Not urgent while the dispatcher runs one story at a time. Required before parallel dispatch.

Three things to get right:

- **Workflows need a `merge_group` trigger**, or checks never report and PRs sit forever.
- **"Require branches up to date" stays off.** Confirmed `strict: false`.
- **Verify** how an externally-posted `review/agent` interacts with required checks on the merge
  group. Robust workaround worth building preemptively: a `merge_group`-triggered workflow that
  resolves the originating PR, confirms `review/agent` was `success` on its head SHA, and reports
  itself green — correct however the semantics fall.

---

## Branching and releases

```
main ──────────────────────────────────────►  alpha channel (GitHub Pages)
 │                                             continuous, automatic
 ├─ story/OQ-49-import-player-info
 ├─ fix/OQ-51-date-format
 │
 └─ tag v0.4.0  ← Session B accepted this batch
```

`main` is the integration trunk. Story branches cut from it and squash-merge back. **Pages is the
alpha channel** — a preview shared with a few people for feedback, not the production target.

### Tags mark reviewed checkpoints

There is no production deployment target today. A tag therefore means *"Session B walked this batch
and accepted it"* — a reviewed checkpoint, not a deploy. When a production channel exists, it
deploys **from tags**, and the design does not otherwise change.

This is the correction to v1, which assumed Pages was production and prescribed either a `develop`
trunk or a tag-gated deploy. Neither is needed: an alpha channel *should* receive everything
continuously, because rough edges there are the point.

### Release branches are optional and deferred

Their purpose is to freeze a candidate while development continues. With one dispatcher working one
story at a time, the simpler thing is to **pause dispatch, review, tag, resume**. Cut
`release/vX.Y` only when you need to stabilise while other work keeps landing — most likely once
parallel dispatch arrives.

### Mechanics

- `story/OQ-49-slug` and `fix/OQ-51-slug` — parseable both ways, so any component can find the
  story from the branch and vice versa.
- **Squash-merge.** One story = one commit on main, which makes `git log <tag>..HEAD` a direct list
  of completed stories — Session B's input assembles itself.
- Branch protection: `test` + `review/agent` required, `enforce_admins: true`, no force-push, no
  deletions. **Already configured correctly.**
- Coder rebases before committing for the dispatcher to push and open the PR from; cap branch age rather than
  merging against a moved world.

### Rollback

Everything above prevents bad changes landing. This covers one landing anyway.

- **Caught by Session B** → a `fix/` story, ordinary loop, prioritised ahead of the queue.
- **Caught after a tag** → revert PR through the same loop, then a `fix/` story to redo it properly.
  Revert first, diagnose second.
- Session B asks both questions: *is this good to ship*, and **what did we ship that we shouldn't
  have.**

---

## Session B — the release review

Runs when a batch worth reviewing has accumulated (currently: human call, roughly every ten merged
PRs). This is the existing OQ-46, and it is the only thing standing between the owner and a silently
degrading mental model of their own app — every other guard is a *regression* detector that passes
when a change is self-consistent.

### Input assembly (mechanical)

- `git log <last-tag>..HEAD` → merged PRs → their stories in `stories/done/`
- **Reviewer findings recorded as `pass-with-observations`** — highest-yield items, because a
  machine already suspected something and chose not to stop the line
- Anything `blocked:` or deferred during the batch
- **Screenshot baselines that moved** across the batch — before/after from `e2e/__screenshots__/`

### The walkthrough

Organised by **user-visible capability**, not by PR or story. Several stories often compose into one
capability. Doing that grouping is Session B's first real piece of work.

Per capability: what it does now that it didn't before, in user language — then **put it on screen**,
driving the alpha deployment or a local dev server. That is the difference between reviewing work
and reviewing a summary of work. Then: contributing stories, what the reviewer flagged but let
through, and known gaps.

### Output

```
releases/v0.4.0-rc.md    ← capabilities, with a verdict on each
```

`accepted` / `accepted-with-followup` / `blocks-release`. Blockers become `fix/` stories that jump
the queue. Acceptance of the whole batch → tag.

**Explicitly not a gate on merging.** It does not block the loop or stop agents — a review that
halts all progress while waiting for a human stops being run.

### Feedback capture

The owner is clicking around, notices something is off, says so in plain language. Session B turns
that into a properly-formed story: clarifying questions, sizing, acceptance criteria, out-of-scope.

Which is what Session A does. **Session B is Session A wearing a different hat** — same
story-authoring discipline, different trigger (observed defect vs. envisioned feature). Share the
story-authoring skill; keep the sessions separate, since their surrounding context differs sharply.

### The scope-creep hazard

Looking at working software generates ideas. Session B holds a hard line: *"this is broken or
doesn't match what we agreed"* is a blocker; *"I now want more"* is a new story for Session A's
backlog, **not this release**. Without that split, releases stop shipping — and it feels reasonable
every single time.

---

## Quality beyond the gate

Every automated guard here is a **regression** detector. Ranked by value per effort:

**1. Reviewer on a different model than the coder.** The cheapest hedge against correlated blind
spots. Built into the model allocation above.

**2. Track escaped defects.** Block rate cannot answer "is review working." What matters is what
**got through**: every defect found at Session B or later, traced back to *which gate should have
caught this?* A frontmatter field on the fix story. The only signal measuring the whole system.

**3. Property-based testing.** The direct attack on coder-writes-both — a generator finds cases the
coder didn't think of, *including ones revealing it misread the story*. `fast-check`. This domain
has unusually natural invariants: a buy-order is always a valid purchase sequence, cost is monotonic,
the rollup view is a strict group-by of the granular view, identical input gives identical output.

**4. Golden tests for computed output.** Appearance is already guarded by screenshot baselines;
extending the same idea to buy-order output catches unintended changes nobody wrote an assertion for.

**5. Boundary validation on scraped data.** Fixtures are frozen; `mytower.app` is not. Every test
can pass while live data has drifted. The existing `detect-drift.yml` covers Workshop costs;
OQ-45 extends it to Enhancement data.

Later if wanted: mutation testing, differential testing for refactors.

### Measuring

OQ-47 built this as `scripts/report/review-verdicts.mjs`: a pure tally over the marker comments
that already exist, run on demand rather than by a scheduled workflow — its story scoped out a
logger, a dashboard, or storing the tally, since a second copy of the record could drift from it.

---

## Platform constraints

Facts to design within.

### Where commands run

**Every command in a prompt or doc must be qualified by where it runs.** This project has twice
shipped documentation instructing agents to do impossible things; both read perfectly well.

| | Local (owner's machine) | Spawned cloud session |
|---|---|---|
| `gh` CLI | present, authed | **absent** — MCP tools or REST |
| Ref deletion | works | **refused** (HTTP 403) |
| Network egress | unrestricted | policy-limited; `mytower.app` unreachable |
| GitHub Actions runner | — | `gh` **is** present there |

*Known live defect:* `REVIEW.md` tells the reviewer to get the head SHA with `gh pr view`, while
`.claude/reviewer-prompt.md` says there is no `gh` and gives the `git rev-parse` alternative. Moot
once the reviewer runs locally, but the document of record is currently wrong.

### A spawned session cannot edit `.claude/prompts/`

**Claude Code refuses `Edit` and `Write` to `.claude/prompts/` from a spawned `claude -p` session**,
as a sensitive path, with no approval surface to appeal to. Found when the OQ-63 coder tried to
deliver its own story's AC-8 and could not; it read the refusal as a deliberate guard against a
coder session rewriting its own spawn instructions, which is what it appears to be.

**Scoped to what was actually observed.** The refusals seen were on
`.claude/prompts/coder.md`, from a spawned session, for both `Edit` and `Write`. Whether the guard
covers all of `.claude/` — `settings.json` especially, which would matter more — is untested and
should not be assumed. Stating it wider than the evidence is the failure this whole section exists
to record.

The consequence is structural and easy to miss: **no coder can deliver a story that changes the
prompts.** That is not a rare case here — OQ-51, OQ-64 and OQ-66 all touch `.claude/prompts/`, and
OQ-63 did. A story whose acceptance criteria require prompt edits will be blocked on delivery no
matter how well the coder performs.

**An interactive session is not restricted the same way.** The same edits succeed from a session a
person is attached to. So the restriction is a property of the *spawn*, not of the file, which is
what makes the workaround legitimate rather than a bypass:

> **The coder emits, the dispatcher writes.** The coder publishes the intended change as a diff in
> its PR body, and whoever is running the loop applies it with `git apply`, by hand, in a separate,
> attributed commit. For this relay the "dispatcher" in the name is always a person, never the
> dispatcher script (see below). Used for the first time in #112, where the diff applied cleanly.

Until 2026-09-24 only this document described the relay, and `coder.md` did not. The OQ-52 coder
(#137) was refused its `coder.md` edit and, following its prompt, took the write-and-exit route and
set `blocked:`. `coder.md` now tells the coder to put a prompt edit in its PR body as a diff under
`### Proposed prompt edit`, to leave the dependent AC unticked, and to finish the rest as normal.

That is the same division of labour the loop already uses twice — the reviewer returns a verdict and
the runner records it, and under OQ-63 the coder emits a PR body and the dispatcher opens the PR.
Prompt edits are the third instance, with one difference: **the dispatcher script does not automate
this one**, whatever the principle's name suggests. OQ-70 considered applying the emitted diff
automatically and rejected it on 2026-09-19. That would mean a script taking patch text from a PR
body written by the agent under review and applying it to the one directory that agent is forbidden
to touch, and the paths it would check come from the same untrusted patch. So a story that changes a
prompt stays partly manual, permanently: whoever runs the loop applies the diff by hand, in a
separate, attributed commit (OQ-70, AC-7b).

### `GH_TOKEN=""` does not remove a credential

`gh` resolves an **empty** `GH_TOKEN` by falling back to the keyring, and overrides the keyring only
when the variable holds a non-empty value. Verified both ways against this repository: a bogus
non-empty token returns `HTTP 401`, while an empty one authenticates normally as the owner.

So a spawn that tries to de-credential a session by setting the variable to empty string **still has
a fully authenticated `gh`**, and nothing about it looks wrong. `coderEnv` avoids this by *deleting*
the variables rather than blanking them, which is why it works. Whoever implements OQ-62 — the
reviewer's half of the same problem — is the person most likely to reach for the empty string, which
is why this is recorded here rather than only in a code comment.

### A long shell command in a headless session

**A `-p` session loses a shell command that outlasts the shell timeout.** Claude Code moves the
command to the background and tells the session it will be notified when it finishes. The session
ends its turn to wait. A `-p` session ends when the model stops calling tools, so the CLI kills the
command and the session exits 0. `spawnSession` classifies that as `completed`. This is what
happened to OQ-86's first dispatch on 2026-10-01. The trials below (OQ-106) reproduce it, and test
three environment variables against it.

**How the trials were run.** Seven trial sessions on 2026-10-01, from 05:37 UTC, on the owner's
Windows machine. Every one ran Claude Code `2.1.281 (Claude Code)` (`claude --version`, run on the
binary `resolveClaudeExecutable` found). Each was started by `spawnSession` in
`scripts/dispatch/spawn.mjs`, with `role: 'coder'` except T7 (`role: 'reviewer'`). So the arguments
and environment were the ones `buildInvocation` builds, with these choices:

- **Model `haiku`** for every trial, to keep them cheap. Effort and the rest of the arguments were
  the role defaults: `--effort medium` for the coder, `--effort high` for the reviewer.
- **`maxBudgetUsd: 1`** for every trial.
- **`spawnSession`'s default `timeoutMs` and `stallMs`**: `DEFAULT_TIMEOUT_MS` and
  `DEFAULT_STALL_MS` in `spawn.mjs`. No trial was stopped. Every one has `stoppedFor: null`, exit
  code 0 and classification `completed`.
- **`baseEnv`** was the trial runner's `process.env`, with the variable under test added. Thirteen
  variables were removed first. The runner was a `node` script started from a Claude Code session,
  and that session had put them in its shell's environment. They name that session (its id, its
  pid, its messaging socket and token), so a trial must not inherit them. The thirteen are
  `CLAUDECODE`, `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_CODE_CHILD_SESSION`,
  `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`, `CLAUDE_CODE_ENABLE_TASKS`,
  `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_MESSAGING_SOCKET`,
  `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_SESSION_ID`,
  `CLAUDE_EFFORT` and `CLAUDE_PID`. A dispatcher started from a Claude Code session passes
  variables like these on to its sessions, because `baseEnv` defaults to `process.env` in
  `coder.mjs` and `review.mjs`. Whether any of them changes these results was not tested.
- **`buildInvocation` overrides none of the three variables under test** at this commit. The
  runner recorded each variable as it stood in `buildInvocation`'s returned `env`, which is what
  the session ran with. In every trial that was the value added, and unset for the other two.
- **Working directory:** a fresh, empty scratch directory per trial, outside this repository's
  tree. It was not a git repository.
- **Prompt:** a short instruction, not `coder.md` or `reviewer.md`. `<params>` was the parameter
  instruction given for each trial, and `<command>` its command:

  ```text
  This session is a short test of the Bash tool. Run the command below with the Bash tool, once, exactly as written. <params>

  <command>

  When you have the Bash tool's result, reply with that result quoted verbatim.
  ```

- **The slow command** was this `node -e` timer, with `N` set to 150 or 660. It writes
  `finished.txt` and prints one line when the time is up:

  ```bash
  node -e "setTimeout(()=>{require('fs').writeFileSync('finished.txt',new Date().toISOString());console.log('timer finished after N s')},N000)"
  ```

  "Ended before the command finished" compares the time `spawnSession` resolved with
  `finished.txt`'s modification time. The runner looked for the file one minute after the
  command's own end. Where the file never appeared, the background command's output file (the
  path in the shell result) was read afterwards.
- **What the shell tool returned** is taken from each session's transcript under
  `~/.claude/projects/`, found by the `session_id` in the session's JSON output. Each one is
  quoted below exactly as the transcript holds it.
- The trial script is not committed. Its full text is in the body of the pull request that added
  this subsection.

T4 runs no slow command, so it was run first on its own. That also showed that `haiku` accepts
the role's `--effort` argument before the six long trials were committed to it. Those six were
started together, from one `node` script run in the background.

Each trial below gives the Claude Code version (`2.1.281` for all seven), the variables set beyond
what `buildInvocation` produces, the command and how long it takes, what the shell tool returned,
whether the session ended before the command finished, and `total_cost_usd`.

**T1: Q1, the baseline.** Coder. **Added:** nothing. **Parameters:** "Do not set the timeout or
run_in_background parameters." **Command:** the timer at 150 s. **Shell tool returned**, 120 s
after the call:

```text
Command did not complete within its 120s timeout and was moved to the background (ID: bnr6zuyzk). Output is being written to: C:\Users\steve\AppData\Local\Temp\claude\C--Users-steve-AppData-Local-Temp-claude-C--Users-steve-AppData-Local-Temp-tw-coder-q5fluR-tree-d18945d5-43bb-47db-96d8-3ef89b5e9c52-scratchpad-oq106-scratch-T1\8ba9f7b6-730c-4f80-bd4c-2e56e973cecb\tasks\bnr6zuyzk.output. You will be notified when it completes. To check interim output, use Read on that file path.
```

**Ended before the command finished:** yes. The session ended at 134.9 s, with the final text "I've
run the command, but it needs 150 seconds to complete. The Bash tool's default timeout is 120
seconds, so the process was automatically moved to the background. I'll wait for it to finish."
`finished.txt` was never written. The background output file held only `[killed]`.
**`total_cost_usd`:** 0.0254879.
**Answer to Q1:** yes on both counts. With nothing added, the command was moved to the background
at 120 s. The session then ended its turn and exited, and the CLI killed the command.

**T2: Q2.** Coder. **Added:** `BASH_DEFAULT_TIMEOUT_MS=600000`. **Parameters:** as T1.
**Command:** the timer at 150 s. **Shell tool returned**, 150 s after the call:

```text
timer finished after 150 s
```

**Ended before the command finished:** no. The command finished at 05:40:21.230Z and the session
ended at 05:40:22.757Z. **`total_cost_usd`:** 0.0489788.
**Answer to Q2:** yes. The command finished in the foreground, and its output came back to the
session as the tool result.

**T3: Q3, a command past the timeout.** Coder. **Added:** `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.
**Parameters:** as T1. **Command:** the timer at 150 s. **Shell tool returned**, 120 s after the
call, marked as an error (`is_error: true`):

```text
Exit code 143
Command timed out after 2m 0s
```

**Ended before the command finished:** yes, because the command was stopped. It never wrote
`finished.txt`, and the session ended at 129.3 s. **`total_cost_usd`:** 0.0238691.
**Answer to Q3, first part:** the command was stopped at the shell timeout (exit code 143) and the
session saw it as an error. It was not moved to the background.

**T4: Q3, `run_in_background`.** Coder. **Added:** `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.
**Parameters:** "Set the run_in_background parameter to true. Do not set the timeout parameter."
**Command:** `node -e "console.log('background command ran')"`, which returns at once. The
session passed `"run_in_background": "true"`. **Shell tool returned**, marked as an error:

```text
<tool_use_error>InputValidationError: Bash failed due to the following issue:
An unexpected parameter `run_in_background` was provided</tool_use_error>
```

**Ended before the command finished:** not applicable. The command never ran. The session's own
summary listed the Bash tool's parameters as `command`, `description`, `dangerouslyDisableSandbox`
and `timeout`. **`total_cost_usd`:** 0.0536022.
**Answer to Q3, second part:** no. With the variable set, `run_in_background` is not a parameter of
the Bash tool, and a call that passes it is rejected before anything runs.

**T5: Q4.** Coder. **Added:** `BASH_MAX_TIMEOUT_MS=900000`. **Parameters:** "Set the timeout
parameter to 800000. Do not set the run_in_background parameter." The session passed
`"timeout": 800000`. **Command:** the timer at 660 s. **Shell tool returned**, 660 s after the
call:

```text
timer finished after 660 s
```

**Ended before the command finished:** no. The command finished at 05:48:52.842Z and the session
ended at 05:48:56.418Z. **`total_cost_usd`:** 0.0501535.
**Answer to Q4:** yes. With the maximum raised to 900000, an explicit timeout of 800000 took
effect, and a 660-second command finished in the foreground.

**T6: Q4's control.** Coder. **Added:** nothing. **Parameters:** as T5, and the session passed
`"timeout": 800000`. **Command:** the timer at 660 s. **Shell tool returned**, 600 s after the call:

```text
Command did not complete within its 600s timeout and was moved to the background (ID: bap4qokky). Output is being written to: C:\Users\steve\AppData\Local\Temp\claude\C--Users-steve-AppData-Local-Temp-claude-C--Users-steve-AppData-Local-Temp-tw-coder-q5fluR-tree-d18945d5-43bb-47db-96d8-3ef89b5e9c52-scratchpad-oq106-scratch-T6\75e687ec-29b6-45de-aa30-fce0bda017ce\tasks\bap4qokky.output. You will be notified when it completes. To check interim output, use Read on that file path.
```

**Ended before the command finished:** yes. The session ended at 615.6 s, saying it would "be
notified when it completes". `finished.txt` was never written, and the background output file held
only `[killed]`. **`total_cost_usd`:** 0.0251996.
**What T6 adds to Q4:** a timeout above the maximum is accepted without an error, then cut to the
maximum without saying so in advance: 800000 was asked for, and the result reports "its 600s
timeout". So the outcome in T5 is the raised maximum taking effect, not the explicit timeout alone.

**T7: Q5, the reviewer.** Reviewer (`role: 'reviewer'`, so the reviewer's allowlist and a plain
copy of `baseEnv`; unlike `review.mjs`, the runner did not pass `baseEnv` through `coderEnv`
first, which changes only credentials and `GH_CONFIG_DIR`). **Added:** nothing. **Parameters:**
as T1. **Command:** the timer at 150 s. **Shell tool returned**, 120 s after the call:

```text
Command did not complete within its 120s timeout and was moved to the background (ID: bk4qdpx2l). Output is being written to: C:\Users\steve\AppData\Local\Temp\claude\C--Users-steve-AppData-Local-Temp-claude-C--Users-steve-AppData-Local-Temp-tw-coder-q5fluR-tree-d18945d5-43bb-47db-96d8-3ef89b5e9c52-scratchpad-oq106-scratch-T7\ab4aee68-0bd8-445a-999a-abe88c86ba74\tasks\bk4qdpx2l.output. You will be notified when it completes. To check interim output, use Read on that file path.
```

**Ended before the command finished:** yes. The session ended at 133.2 s, saying "I'm waiting for
it to finish so I can provide you with the result." `finished.txt` was never written, and the
background output file held only `[killed]`. **`total_cost_usd`:** 0.0487476.
**Answer to Q5:** yes. A reviewer session behaves as T1 does.

All seven cost 0.2760387 USD together.

**What the trials do not show.** Each configuration was tried once, with `haiku`. The shell
tool's result comes from the CLI and should not depend on the model. Ending the turn after a
background notice is the model's choice. All three `haiku` sessions that got one (T1, T6, T7) made
it, and so did OQ-86's coder. Two things were not tried. One is a command past 600 s with
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` and `BASH_DEFAULT_TIMEOUT_MS=600000` together; T3 suggests
an exit 143 at 600 s. The other is an inherited `BASH_DEFAULT_TIMEOUT_MS` above 600000 raising the
maximum on its own. OQ-76 read that rule from the CLI's code. T2 and T5 agree with it but do not
test that case. Like the reviewer's shell check in "Invocation shape", all of this belongs to
Claude Code 2.1.281, and another version can change it.

**Recommendation.** This is a recommendation only. Acting on it is a later story, written by
Session A.

1. **Set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` in `coderEnv`** (T3, T4). A command past the
   timeout then fails as an error the session sees, instead of moving to the background and being
   killed silently when the session ends (T1, T6). It also takes `run_in_background` out of the
   Bash tool (T4). That costs little in a `-p` session, where a background command does not outlive
   the session anyway (T1, T6: `[killed]`). It does stop a session from running a command in the
   background and polling it, which is how this spike's own coder ran its trials. A later story
   that needs that would have to do without it.
2. **Set `BASH_DEFAULT_TIMEOUT_MS=600000` in `coderEnv`** (T2). A command up to 10 minutes long,
   such as a slow test suite, then finishes in the foreground without the session having to pass
   a `timeout`. With item 1, a command longer than that fails visibly rather than being lost (T3,
   by extension).
3. **Set `BASH_MAX_TIMEOUT_MS=600000` in `coderEnv`**, the planned value (T5, T6). T6 shows that
   600000 caps even an explicit `timeout` above it. T5 shows that a raised maximum lets one call
   run longer. That would also lengthen the longest stretch in which a session emits nothing.
4. **Set the same three variables, at the same values, in the reviewer's environment** (T7). Q5
   shows the reviewer is exposed in the same way. The reviewer's environment in `buildInvocation`
   is a plain copy of `baseEnv`. `review.mjs` currently passes `coderEnv`'s output as that
   `baseEnv`, so values set in `coderEnv` would reach a reviewer started through `review.mjs`.
   They would not reach one started through `buildInvocation` by any other caller, as T7 was. So
   they belong in `buildInvocation`'s reviewer branch too, which is where OQ-76's AC-5 already
   plans its pins for both roles.
5. **Add a line to `coder.md` about background commands, and the same to `reviewer.md`** (T1, T6,
   T7). Every session that was told a command had moved to the background ended its turn to wait.
   The line should say that a `-p` session ends when it stops calling tools, so no notification
   ever arrives. It should say never to end a turn to wait for a command. And if a command times
   out, the session should narrow it, or rerun it with an explicit `timeout` no higher than 600000.
   With item 1 in place the background notice should not appear. The line is the backstop if a
   later CLI version stops honouring the variable.

6. **OQ-76's AC-5, value by value.** OQ-76 plans to pin `BASH_DEFAULT_TIMEOUT_MS=120000` and
   `BASH_MAX_TIMEOUT_MS=600000` for both roles in `buildInvocation`, and to derive
   `DEFAULT_STALL_MS` from that maximum. Items 2 to 4 above already imply the answers. Here they
   are against each planned value:

   - **`BASH_DEFAULT_TIMEOUT_MS`: change 120000 to 600000** (T1, T7 against T2). At 120000, a
     command between 2 and 10 minutes long is moved to the background and lost when the session
     ends. At 600000 it finishes in the foreground. Pinning it to 120000 would pin the failure this
     spike studies.
   - **`BASH_MAX_TIMEOUT_MS`: keep 600000** (T6, T5). It is the bound that holds even against an
     explicit larger `timeout` (T6). Raising it lengthens the longest single call (T5).
   - **`DEFAULT_STALL_MS`: keep the planned derivation and value**, the pinned maximum plus a
     margin, which OQ-76 puts at 12 minutes. The default rises to 600000, but under the CLI's rule
     `Math.max(BASH_MAX_TIMEOUT_MS ?? 600000, BASH_DEFAULT_TIMEOUT_MS ?? 120000)` the maximum is
     still 600000. T6 shows a call cut off at 600 s with the maximum unset. So the longest single
     shell call, during which a session emits no event (OQ-76's Context), stays 10 minutes. The
     stall interval needs no more than OQ-76 already plans. If a later story raises
     `BASH_MAX_TIMEOUT_MS`, the stall interval must rise with it, to above the new maximum. The
     derivation OQ-76 plans makes that automatic. Until OQ-76 lands, output stays
     `--output-format json`, which is silent for the whole session, so `DEFAULT_STALL_MS` has to
     stay above a whole session's length. None of these trials changes that.

**Decided 2026-10-01 by the owner: background commands stay available.** Item 1 is not adopted.
Turning them off would mean a story that needs one has to be spotted and run differently. Once the
loop runs unattended, nothing would spot it, so the owner chose fewer special cases over the
guarantee. `buildInvocation` pins `BASH_DEFAULT_TIMEOUT_MS` and `BASH_MAX_TIMEOUT_MS` to `600000`
for both roles (`SHELL_TIMEOUT_MS` in `scripts/dispatch/invocation.mjs`), and removes
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` if the dispatcher's environment carries it (items 2 to 4,
with the default changed as item 6 says). `coder.md` and `reviewer.md` tell a session never to end
its turn while a command runs (item 5). **Planned (OQ-108):** a coder session that completes with
work left uncommitted is resumed once and told so. The resumed session's outcome, report and
commits are then used exactly as a first session's would be, so its report supplies the PR. That is the
backstop for a session that ends its turn anyway, whatever the story. Items 4 and 6 describe
OQ-76's AC-5 as it stood when the trials ran. The two pins have since moved to OQ-107. OQ-76's
AC-5 now holds the `DEFAULT_STALL_MS` derivation, from OQ-107's maximum, and the timeout below.

**Decided 2026-10-03 by the owner: a session's timeout rises to 60 minutes.** On 2026-10-02 the
20-minute stall interval stopped a working coder, the first OQ-110, about halfway through its
story. Its output was `--output-format json`, which is silent until the session ends.
`DEFAULT_TIMEOUT_MS` in `scripts/dispatch/spawn.mjs` goes from 30 to 60
minutes, together with the 12-minute stall interval that streamed output makes possible (OQ-76).
Once a session's output shows it working, the stall interval catches one that has hung, and
`--max-budget-usd` caps its spending. That leaves the timeout to stop a session that is busy but
not finishing, and 30 minutes is shorter than a real story needs.

### GitHub mechanics

- **`mergeable_state`**: `clean` (all *required* checks green), `blocked` (required check
  failing/pending), `unstable` (only non-required), `dirty`, `behind`, `unknown`. The
  `blocked`/`unstable` split is the only way to tell from outside whether a check is required.
- **Computed asynchronously** — never merge twice in one pass.
- **Recomputed after a merge, so other open PRs can read `unknown` for a while.** Observed on
  2026-09-24: #123 merged at 02:13:42Z, and a sweep run at 02:17:14Z
  (run 35946602221) skipped #125 as `unknown`. The next run, 35947256705 at 02:26:30Z, found it
  `clean` and landed it. That is one observation. How long the window lasts, and whether every open
  PR is affected, has not been measured. A trigger that fires straight after a merge should expect
  `unknown` rather than treat it as rare.
- **Workflow trigger decides which branch a workflow runs from.** `pull_request` runs from the PR
  branch; `issue_comment`, `schedule`, `workflow_dispatch` run from the **default branch**, so they
  cannot be tested on the PR that introduces them. **Mitigation: move logic out of `run:` blocks
  into committed scripts with unit tests.** The untestable surface shrinks to YAML wiring.
- **`GITHUB_TOKEN` pushes do not trigger further workflows.** The exceptions are
  `workflow_dispatch` and `repository_dispatch` (GitHub's documentation, read 2026-10-08). So the
  sweep's merges, made with `github.token`, started no `push` run of `ci.yml` or `deploy-pages.yml`
  on their own: the last ones made that way were on 2026-09-28. Both workflows (OQ-124) also run on
  `workflow_run` of `Land approved PRs`, and each job with no `needs:` skips unless the sweep moved
  `main` (`github.event.workflow_run.head_sha != github.sha`), so a sweep that landed nothing costs
  no runner. The sweep itself gains no permission, token or secret (decided 2026-10-08 by the
  owner; see "Portability", "Decided so far").
- **Converting a PR to draft is GraphQL only.** REST's "Update a pull request" takes `title`,
  `body`, `state`, `base` and `maintainer_can_modify`, with no `draft`; the GraphQL mutation
  `convertPullRequestToDraft` does it (checked 2026-09-25). `github.mjs`
  sends that one mutation (`convertPullRequestToDraft`), and its allowlist admits no other GraphQL.
- **Squash merges create a new commit**; leftover branches cannot be fast-forwarded afterwards.
- **Branch protection is not readable** from agent sessions (403). It *is* readable locally as the
  owner.

### Upstream blockers

**The Claude Code Action cannot authenticate** — `401 OAuth access token is invalid`, two
independently generated tokens, ten retries
([anthropics/claude-code-action#1614](https://github.com/anthropics/claude-code-action/issues/1614),
open, no maintainer response). The `ANTHROPIC_API_KEY` alternative works but introduces a second
billing stream, declined on cost-isolation grounds. **This is why review runs outside CI** — and
under the local execution model it no longer matters.

### Costs

| Thing | Cost | Wall clock |
|---|---|---|
| Worker session (one story, opens PR) | ~$2.41 | ~25 min |
| Reviewer session | $1.03 – $1.55 | 5–8 min |
| CI run (lint + unit + build + Playwright) | free | ~70 s |

Public repo, so Actions minutes are not a constraint; **model usage is.** A clean first pass is
~$3.70; worst case with two retries is ~$11. Story quality decides which you pay — *and*, per the
readiness test, whether the gate works at all. Both arguments point at Session A.

`--max-budget-usd` makes the ceiling explicit per invocation rather than discovered afterwards.

---

## Portability: other projects, other companies' models

Refined with the owner from 2026-10-07. The goals, the move's shape and its order are decided;
M4 (how a role names its model) and R7's issue queue are still
open, and both wait for the workflow's own repository. Each answer is recorded here, dated, in
the pull request that makes it.

### Goals

Decided 2026-10-07 by the owner.

1. **The owner can use the workflow in other projects.**
2. **Models from other companies can be used**, so that the work is not all done by similar
   models. This is the [reviewer-on-a-different-model](#quality-beyond-the-gate) hedge taken
   further: a different company's model decorrelates more than a different model from the same one.
3. **The workflow is insulated from any one AI model company** folding or pricing the owner out.
4. **This repository stays focused on the product**, not on the workflow.

The owner is starting to plan another project and wants to work the same way in both. That is
what makes goal 1 near-term: the second project is the workflow's first user outside this
repository.

### What the workflow is for

[`harness-outline.md`](harness-outline.md) holds the owner's own account of it (from
2026-10-07): what it is, who it is for, why, the three things it must never do, and the view for
deciding what is next. It is the harness's product outline, and moves with this document.

### Decided so far

- **The move comes first** (decided 2026-10-07 by the owner).
  **Planned (OQ-115, OQ-132, OQ-133, OQ-134):** the workflow moves to a repository of its own, and
  this repository uses it. **Planned (OQ-114):** once moved, coder and reviewer sessions run
  through an adapter per agent tool, so that a role can be given another company's model. OQ-114
  is a draft, to be split before it is dispatched; OQ-115 was split on 2026-10-08 (below).
- **Goal 3 is about AI model companies, not GitHub** (decided 2026-10-07 by the owner). The gate
  stays on GitHub. Moving the hosting would be a far larger migration, and would depend on the
  target platform's rules much more than switching models does.
- **The move comes before OQ-73 and before OQ-101, after OQ-118 and OQ-117 are built** (decided
  2026-10-07, revised 2026-10-08 by the owner). See R5.
- **Planned (OQ-73): coder sessions are isolated in a container** (decided 2026-10-08 by the
  owner). OQ-73, a spike, finds out how, and the stories it recommends build it. See R5.
- **A project takes the workflow as a package pinned by git tag**, with no npm publishing planned,
  runs the loop from its own worktree, and keeps thin gate workflow files written by an `init`
  command (decided 2026-10-07 by the owner). See R2.
- **The workflow's repository is public** (decided 2026-10-07 by the owner). If its stories come
  from issues, only issues a writer created or labelled may enter its queue. See R8.
- **The workflow is named `steward`**: the repository `luplows/steward` and the package `steward`
  (decided 2026-10-07 by the owner). See R10.
- **Its stories are numbered `ST-<n>`**, and every unbuilt workflow story moves except this
  repository's own, with its history (decided 2026-10-08 by the owner). See R1, R4 and R9.
- **The second project starts with the gate only** (decided 2026-10-08 by the owner). See R6.
- **The moving workflow stories are held here until the move**, and **steward starts with this
  repository's lines stripped from its prompts and `REVIEW.md`** (decided 2026-10-08 by the
  owner). See R4 and R1.
- **OQ-115 stays here and OQ-114 moves**, and the extracted history names this repository's pull
  requests in plain text (decided 2026-10-08 by the owner). See R4 and R1.
- **OQ-122 is split as small as it sensibly goes**, into OQ-122 and OQ-125 to OQ-129 (decided
  2026-10-08 by the owner, after its first coder spent its whole budget and committed nothing):
  smaller stories are cheaper to run and to review. All six are built here before the move, ahead
  of OQ-123, which is split the same way into OQ-123, OQ-130 and OQ-131 ("The move, in order",
  step 1). The test and CI follow-ups raised by that day's dispatch batch become one story,
  written after the move (decided 2026-10-08 by the owner).
- **Adopting steward is a hand-run cut-over, then dispatched clean-up** (decided 2026-10-08 by
  the owner, refining OQ-115). OQ-115 becomes the cut-over, owner-run with `blocked:` saying so:
  one pull request through the gate that pins steward and switches the gate's files to it, after
  which the owner starts the loop with steward's command. Then, on steward's engine and in this
  order, OQ-133 cuts `CLAUDE.md`, `REVIEW.md` and the stories README to this project's own rules,
  OQ-132 removes the moved code, and OQ-134 removes the moved documents (the order set on
  2026-10-09 by the owner, from #223's review: each needs what the one before it removes gone).
  Retiring the moved stories is Session A's, as soon as the bootstrap fixes the OQ-to-ST mapping.
  The tests that stay go to a new `scripts/ci-workflows.test.mjs`, which takes the setup-step prefix
  from the pinned package. The passages about this project go to `README.md` and
  `Project-Outline.md`: no project needs a document about steward (R1). Which rules are steward's
  and which this project's is settled; how steward's reach a project's sessions, and the form of
  this project's review items, are decided once steward is built. `docs/steward-bootstrap.md` moves
  to steward with its history (R1). OQ-115's old AC-1, a second project running the workflow, is
  dropped: that is steward's (R6, R7).
- **The bootstrap checklist gains D-7 and D-8** (decided 2026-10-08 by the owner): a rewritten `#N`
  is checked at the real run, and only tests of files that move go to steward. See R1.
- **The bootstrap checklist is agreed**, [`steward-bootstrap.md`](steward-bootstrap.md), with its
  six decisions (decided 2026-10-08 by the owner). Steward's copies of this document and of
  `CLAUDE.md` are stripped of this repository's own content at the bootstrap, and R1's list gains
  the files the dry run found missing (R1). ST-8, the copy of OQ-73, keeps its `blocked:` in
  steward, and steward's own first stories outrank the moved ones (R4).
- **After the sweep lands a pull request, CI and the Pages deploy run on `main` by `workflow_run`,
  and skip when the sweep did not move `main`** (decided 2026-10-08 by the owner, from four
  options: the sweep starting them by `workflow_dispatch`, which needs `actions: write`; this; a
  GitHub App token for the merge, which needs a secret per repository; and a personal access
  token, ruled out as a stored owner credential). Each project opts in in its own workflow files,
  and the sweep is unchanged. The skip matters for the owner's private repository, which draws on
  the plan's included minutes. Built here (OQ-124), a `fix` story, before the move; steward's
  `ci.yml` gets the same trigger at the bootstrap (`steward-bootstrap.md`, B6), and a project's thin
  files get it from `init` (R2).
- **OQ-73 is rewritten in place as a spike only** (decided 2026-10-09 by the owner): run by the
  owner with Session A, not dispatched, and held until the move, with `blocked:` saying both. Its
  outcome is a recommended split into the stories that build coder sessions in a container, which
  Session A writes with the owner. #209, OQ-73's earlier coder pull request, was closed unmerged
  and its branch deleted. The container runtime is left open, as the spike's open question. See
  R5.

### The move, in order

Decided 2026-10-08 by the owner. The engine is made project-neutral here first, where the loop
and gate already work, so that the workflow's repository can dispatch its own `ST-<n>` stories
from the day it exists. Today the `OQ` prefix is hardcoded in five modules, so it could not.

1. **Here, built by the loop:** OQ-118 then OQ-117 (CI), OQ-122 (a settings file with the
   repository and the story prefix, #210) and the stories split from it on 2026-10-08: OQ-125
   (the default repository from the settings), OQ-126, OQ-127 and OQ-128 (the story prefix from
   the settings, in the queue reader, the story lint, and `coder.mjs` and `story.mjs`) and OQ-129
   (a test that keeps both out of the code); then OQ-123 and OQ-130 (finding the project from the
   working directory and the scripts and prompts from wherever the engine is installed, #211, split
   on 2026-10-08) and OQ-131 (one command-line entry point). OQ-124 (CI and the Pages deploy on
   `main` after each landing) is also built here first, as a `fix` story.
2. **By hand, the owner with Session A (a bootstrap, not a story):** create `luplows/steward`,
   public; extract the moved paths with their history (`git filter-repo`, installed on the
   owner's machine on 2026-10-08 and tried in a dry run); renumber the moved stories `ST-<n>`, each
   naming its old OQ id; push `main`, the one direct push, made before any protection exists; then
   protect `main`, and give the repository its own CI, review gate and landing, running the engine
   from its own checkout. The steps are in [`steward-bootstrap.md`](steward-bootstrap.md).
3. **In steward:** `init` and the thin gate workflow files (R2); the second project's gate-only
   start (R6, R7); then OQ-73's container spike and the stories it recommends, and OQ-101.
4. **Here:** adopting steward (split 2026-10-08, "Decided so far"). OQ-115, the cut-over, by hand:
   pin steward and switch to the thin workflow files, then start the loop with steward's command.
   Then OQ-133 (the rule files), OQ-132 (the moved code) and OQ-134 (the moved documents), in
   that order, run on steward's engine. Session A retires the moved stories with a note naming
   each one's `ST-<n>`.

### What adopting steward needs from it

Found 2026-10-08 while refining OQ-115. Each is built in steward, before OQ-115 unless marked:

- **A tag to pin**, and **the loop's worktree installing the pinned engine** after each update
  (OQ-123's Out of scope).
- **`init` and the thin gate files** (R2), including OQ-124's after-sweep trigger.
- **The prompts' `{{REPO}}` slot and project section** (R1), so this project's lines come back.
- **Delivering steward's rules and checklist to a project's sessions**, and **a project's own
  review items to the reviewer** (R3). Before OQ-133. Today `coder.md` reads `CLAUDE.md` and
  `REVIEW.md` from the repository root, and `reviewer.md` reads `REVIEW.md` there.
- **The setup-step prefix exported** from the package, for this repository's
  `scripts/ci-workflows.test.mjs`. Before OQ-132.
- **The screenshot directory as a project setting.** `coder.mjs` line 125 (`main` at `c97aa50`)
  has `SCREENSHOT_DIR = 'e2e/__screenshots__/'`, this project's convention, in the coder's
  exception for new baselines (OQ-84). No deadline here, since the value is this repository's;
  before the second project has a coder.

### What ties the workflow to one company today

Checked on 2026-10-07 against `main` at `66c578d`:

- **The agent tool is the Claude Code CLI.** `spawn.mjs` finds its binary (`resolveClaudeExecutable`,
  or `CLAUDE_EXECUTABLE`). `invocation.mjs` builds the `claude -p` arguments, including Claude
  Code's tool-allowlist syntax (`Bash(git diff:*)` and so on, here and in `coder-env.mjs`).
  `outcome.mjs` classifies a session from the CLI's JSON result.
- **The guarantees on each role are enforced through that CLI.** The coder holds no credential and
  may not push or run `gh` (OQ-63, OQ-67, OQ-84; OQ-73 still planned). The reviewer cannot write
  (OQ-62 still planned). Those rest on Claude Code's allowlists and permission modes. Another tool
  has to provide each guarantee again, and show it holds, rather than inherit it.
- **The models are Claude model names.** The coder's is the story's `model:` field (`sonnet` in
  `stories/_TEMPLATE.md`). The reviewer's is `opus` (`ROLE_DEFAULTS`, `invocation.mjs`), unless
  that matches the story's model by name, in which case it is `sonnet` (`chooseReviewerModel`,
  `review.mjs`). "Different" is decided by comparing those names.
- **The prompts are written for that CLI.** `.claude/prompts/coder.md` and `reviewer.md` name its
  tools and its allowlist behaviour.

### What ties the workflow to this repository today

- The default repository comes from this repository's own `steward.config.json`
  (`scripts/dispatch/settings.mjs`, OQ-122, OQ-125), read in `coder.mjs`, `land.mjs`, `loop.mjs`,
  `review.mjs`, `story.mjs` and `scripts/report/review-verdicts.mjs`. Each also takes `--repo` to
  override it.
- The scripts run against the checkout they are loaded from (`DISPATCHER_ROOT`), and read this
  repository's `stories/` and `.claude/prompts/`.
- The gate is this repository's own workflows. `ci.yml` runs `scripts/dispatch/story-containment.mjs`.
  `land-approved.yml` runs `scripts/land/select-candidates.mjs`, `check-author.mjs` and
  `delete-merged-heads.mjs`. `review-gate.yml` derives `review/agent`.
- The rules the gate enforces mix the general with this project's own: `REVIEW.md`, `CLAUDE.md`,
  `stories/README.md`, `stories/_TEMPLATE.md` and this document.

### Open questions

**Models (OQ-114)**

- **M1. Which tools and models.** The owner's examples are OpenAI's GPT models. An adapter needs,
  from the tool: a non-interactive run from a prompt, a machine-readable result, restrictions on
  what the session may run, confinement to its working directory, and a time or cost bound.
  OpenAI's own documentation (developers.openai.com/codex/noninteractive, read 2026-10-07)
  describes the Codex CLI's `codex exec` for this: the prompt as an argument, `--json` for JSON
  Lines output, and `--sandbox read-only | workspace-write | danger-full-access`. Not yet run here.
  Its restrictions are a sandbox policy, not a per-command allowlist like Claude Code's, so M3
  applies in full. **Decided 2026-10-08 by the owner: the Codex CLI is the first adapter, for the
  reviewer (M2), after a spike** that runs it here and shows it can run `npm test` inside its
  read-only sandbox and return a verdict the gate can parse.
- **M2. Which role first.** **Decided 2026-10-08 by the owner: the reviewer.** Goal 2's value is largest there, and a
  reviewer that cannot write is a smaller guarantee to re-establish than a coder's.
- **M3. Guarantees before use.** **Decided 2026-10-08 by the owner:** no tool runs a role until that role's guarantees are
  shown to hold for it by tests, in the way the guarantee checks in OQ-73's Context test the
  coder's.
- **M4. How a story or role names its model.** Today a bare Claude model name. It needs the tool as
  well. OQ-54 (one declared default coder model) would be reworked or folded in. **Left open for
  the workflow's own repository** (owner, 2026-10-08): it works best as configurable for the
  specific job, rather than fixed per project.
- **M5. Prompts.** One prompt per role with per-tool parts, or one per tool? **Decided 2026-10-08
  by the owner: one prompt per role**, holding the role's rules once, with a small section per tool
  for that tool's specifics, so the rules cannot drift between tools.
- **M6. Switching away (goal 3).** **Decided 2026-10-08 by the owner:** replacing a tool for a role is a configuration change,
  with no code change beyond its adapter.

**A repository of its own (OQ-115)**

- **R1. What moves.** Proposed by Session A, 2026-10-07, from `main` at `21fdb52`; **decided
  2026-10-08 by the owner, as proposed**. It is the extraction list for the bootstrap ("The move, in
  order", step 2):

  | Moves to the workflow's repository | Stays here |
  |---|---|
  | `scripts/dispatch/` (with `story-containment.mjs`), `scripts/land/`, `scripts/lint-stories.mjs`, `scripts/report/review-verdicts.mjs`, and their tests | The product, its data scripts (`scripts/extract-*`, `generate-*`, `verify-workshop-costs.mjs`, `scripts/lib/`) |
  | `.claude/prompts/coder.md` and `reviewer.md`, with their project-specific lines stripped, and slots for them added later (below) | This project's stories: `stories/`, `stories/done/`, `stories/retired/`, `Completed-Questions.md`, `Open-Questions.md` |
  | `REVIEW.md` except items 8 and 10, which name Vitest, Playwright, the buy-order algorithm and screenshot baselines | `REVIEW.md` items 8 and 10, as this project's own review items |
  | The workflow rules in `CLAUDE.md` ("Branches and pull requests", "Claims about this repository", "Stories") | `CLAUDE.md`'s project rules ("Testing", screenshot baselines), plus a pointer to the workflow's rules |
  | `stories/README.md` and `_TEMPLATE.md`, as the story schema of record | A short `stories/README.md` pointing at the schema |
  | This document, `docs/harness-outline.md`, `docs/session-a.md`, `docs/migration-plan.md`, `docs/gap-analysis.md` | `Project-Outline.md` and `README.md`, which take this project's passages (below) |
  | The logic of `review-gate.yml` and `land-approved.yml`, and the containment step in `ci.yml` | Thin workflow files that call it (R2), `ci.yml`'s product checks, `deploy-pages.yml`, `detect-drift.yml`, `update-screenshots.yml` |
  | Added 2026-10-08 by the owner, after the dry run: `test/fixtures/`, the four built stories the moved tests read as fixtures (OQ-51, OQ-68, OQ-69, OQ-70; they become test fixtures in steward, not stories), `.github/pull_request_template.md`, `.oxlintrc.json` and `.gitignore` | The originals of all of these |
  | Added 2026-10-08 by the owner, refining OQ-115: `docs/steward-bootstrap.md`, the record of how steward was made | Nothing: OQ-134 removes it here |

  The prompts' project-specific lines are few. In `coder.md`: the repository name, the testing
  frameworks and screenshot-baseline rules, and `mytower.app` being reachable. In `reviewer.md`:
  the repository name. They become a `{{REPO}}` slot and a project section the project supplies,
  rendered by the same bounded injection as the story (`render.mjs`).

  **Decided 2026-10-08 by the owner: steward starts clean.** At the bootstrap, steward's copies
  of the prompts have this repository's lines stripped by hand: its name, Vitest and Playwright,
  the screenshot-baseline rules, `mytower.app`, and the pointer to `Completed-Questions.md`
  (`coder.md`). The slot and the project section are built in steward afterwards, before this
  repository adopts it (OQ-115), since this project's lines have to come back through them.

  **`REVIEW.md` items 8 and 10 are removed from steward's copy** (decided 2026-10-08 by the owner),
  leaving gaps in the numbering. A story in steward closes the gaps and updates every reference to
  an item number.

  A side effect worth having: in the workflow's repository the prompts need not live under
  `.claude/`, so a coder there could edit them directly, instead of through the emit-a-diff route
  (**A spawned session cannot edit `.claude/prompts/`**, above).

  **This document** (proposed by Session A, owner agreed to record it, 2026-10-07): it moves with
  the workflow and stays the workflow's design of record. At `66c578d` most of its 1,640 lines are
  about the workflow. The passages about this project stay here (placed 2026-10-08 by the owner,
  in `README.md` and `Project-Outline.md` rather than a document about the workflow; OQ-134):
  - "Branching and releases": Pages as the alpha channel, and tags as checkpoints;
  - in "Quality beyond the gate", the buy-order examples given for items 3 and 4 (property-based
    and golden tests; the techniques themselves move), and item 5, validating scraped data;
  - open question 9, the production deployment target.

  The tables comparing a cloud session with a local one ("Everything runs locally" and "Where
  commands run") give `mytower.app` as their example of network egress. That example is **dropped
  here, not placed** (decided 2026-10-08 by the owner, after #223's review): `README.md` already
  names `mytower.app` as the data source, and the coder prompt's line that it is reachable comes
  back through steward's project section (OQ-115). OQ-134 removes it with this document.

  The example story under "The story artifact" (a `playerInfo.dat` import) is replaced with a
  neutral one. `Project-Outline.md` stays the product's design of record. Once moved, a workflow
  design change lands in the workflow's repository, and this one sees it only as a version it
  chooses to take, which is goal 4.

  **Steward's copy is stripped of them at the bootstrap** (decided 2026-10-08 by the owner, as the
  prompts are): the passages above, and the example story, are removed or replaced in steward's
  copy before its first push, rather than left for a steward story. Steward's `CLAUDE.md` keeps
  the testing rules that hold for it (CI is required, tests go alongside new logic, in Vitest, no
  coverage tooling, green CI is not sufficient) and drops Playwright, screenshot baselines and the
  buy-order algorithm (decided 2026-10-08 by the owner).

  **The history moves with the code** (decided 2026-10-08 by the owner): the moved paths are
  extracted with their git history, for example with `git filter-repo`, so `git log` on a moved
  file in the workflow's repository still shows the commits and stories that shaped it.
  **Commit messages name this repository's pull requests in plain text** (decided 2026-10-08 by
  the owner): the extraction rewrites each `(#N)` as `(tower-workshop-paths PR N)`. Left as it was,
  `#N` would link to the workflow's repository's own #N. Written as `luplows/tower-workshop-paths#N`,
  it would add a cross-reference to each of this repository's pull requests when steward's `main`
  is pushed. **Extended 2026-10-08 by the owner, after a dry run of the extraction:** a bare `#N`
  in a commit body ("From #195's review…") is rewritten the same way, as
  `tower-workshop-paths PR N`. The dry run (from `main` at `d86080c`) kept 127 commits, whose
  bodies had 106 lines with a bare `#N`. Every one was this repository's pull request. A `#N` that
  follows a `/`, a `&`, or a letter or digit, such as `owner/repo#N`, is left alone.
  **Checked again at the real run** (decided 2026-10-08 by the owner, after the reviewer's
  observation on #215): that "every one" holds only for the paths extracted in the dry run.
  Commits `44b8afa` and `9f4ffb7` cite an upstream issue as a bare `#1614`, and are left out only
  because the paths they touch (`review.yml`, `Open-Questions.md`) do not move. So the fresh dry
  run lists every `#N` the rules rewrite, and checks each against this repository's pull requests.
  If any is not one, the bootstrap stops until the rule leaves it alone.

  **Only tests of files that move go to steward** (decided 2026-10-08 by the owner, after the
  reviewer's observation on #217, and widened by the owner the same day). A test that covers this
  repository's own flows stays here, even where it sits in a moved test file. The case found so
  far is `scripts/dispatch/ci.test.mjs`: OQ-117's tests read this repository's `ci.yml` Playwright
  steps, `update-screenshots.yml` and `package-lock.json`'s `@playwright/test`, and OQ-124's also
  read `deploy-pages.yml`, none of which steward has. Steward's copy drops them. OQ-118's tests,
  which read steward's own `ci.yml`, move. OQ-132 keeps the tests that stay, in a new
  `scripts/ci-workflows.test.mjs`, when it removes the moved code from this repository.
- **R2. How a project uses it.** Proposed by Session A, 2026-10-07; **decided 2026-10-07 by the
  owner, as proposed, with the git-tag pin** (below):
  - **A Node package with a command-line entry point**, added as a development dependency of each
    project and pinned to a tagged version. To begin with it is installed straight from the
    workflow's public repository by git tag, so no package registry account is needed; publishing
    to npm can come later.
  - **The loop runs from the project's own worktree, as now** (`loop.mjs --init`). Today every story
    runs the dispatch code as it is on `origin/main` (OQ-86). With a pinned dependency, that becomes
    the engine version `origin/main` pins, so a project takes a new workflow version only through
    a pull request of its own that changes the pin.
  - **The gate's workflow files stay in each project, but thin**: the triggers and permissions,
    then one step running the package's command. An `init` command writes them. This is preferred
    over GitHub's reusable workflows because the gate's logic already lives in scripts, and because
    each project keeps control of its own triggers, permissions and secrets.
    The files `init` writes include the after-sweep trigger and its skip condition (OQ-124's
    `workflow_run` on `Land approved PRs`; noted 2026-10-08 at the owner's decision, under
    "Decided so far"), so that a project's `main` is checked after each landing without spending
    minutes on a sweep that landed nothing.
  - The scripts stop finding the project relative to their own location (`DISPATCHER_ROOT`).
    They take the project from the working directory and its configuration (R3), and their
    prompts from the package.

  **Decided 2026-10-07 by the owner: the git-tag pin**, to keep it simple. Publishing to npm is not
  planned. The rest of R2 was accepted as proposed the same day: the loop runs from the project's
  own worktree, and thin gate files written by `init`, not GitHub's reusable workflows.
- **R3. What a project configures.** At least its repository, its CI commands (OQ-94), its own
  review items, and where its stories live. **Decided 2026-10-08 by the owner: for now, only what
  differs between the projects: the repository and the story id prefix**, in a settings file at
  the project root (OQ-122). The base branch, the remote, the stories directory and the CI workflow
  path are the same in all three repositories (`main`, `origin`, `stories/`,
  `.github/workflows/ci.yml`), so they stay constants until a project needs something else. The
  prompts' project section, a project's own review items, models and commit attribution come
  later; attribution matters once the second project has a coder, since its `AGENTS.md` forbids AI
  attribution.
- **R4. The workflow's own stories.** The new repository needs a queue of its own. Which of this
  repository's workflow stories move with it? **Decided 2026-10-08 by the owner: every unbuilt
  `kind: workflow` story moves, except those about this repository's own files**: OQ-117 and OQ-118
  (this repository's CI, built before the move, R5), OQ-72 (retiring this repository's
  `Open-Questions.md`) and OQ-94 (this repository's `CLAUDE.md`). OQ-71 moves: the claims it
  consolidates are in the workflow's documents. A story built before the move stays in
  `stories/done/` here, as history. A moved story takes the new repository's next number (R9) and
  names its old OQ id. OQ-124 to OQ-131, written on 2026-10-08, are built here before the move
  ("The move, in order", step 1), so they stay, as OQ-117 and OQ-118 do.

  **OQ-115 stays, and OQ-114 moves** (decided 2026-10-08 by the owner; OQ-115's clean-up stories,
  OQ-132 to OQ-134, stay with it, added 2026-10-08 when it was split). OQ-115 is this
  repository's adoption of steward, "The move, in order", step 4, so it is about this repository's
  own files, like OQ-72 and OQ-94. OQ-114, the adapters for other companies' models, is engine work
  and moves. It is not a prerequisite of the move and not a high priority. Its `depends_on:
  [OQ-115]` only meant "after the move", so it is dropped when the story is renumbered.

  **Held here until the move** (decided 2026-10-08 by the owner): the moving workflow stories
  that the loop would otherwise reach after step 1's stories carry `blocked:` saying so, so that
  they are built in steward rather than here. They are OQ-54, OQ-59, OQ-62, OQ-88, OQ-89, OQ-98,
  OQ-100, OQ-103, OQ-105, OQ-119 and OQ-120 (`normal` tier) and OQ-99 (`later`). The steward
  copies are renumbered with `blocked:` cleared; the copies here are retired by Session A, in a
  `write-story/` pull request, once the bootstrap's B1 has fixed the mapping (OQ-115's Out of
  scope).

  **In steward, two exceptions and an order** (decided 2026-10-08 by the owner, agreeing the
  bootstrap checklist; ST-8's revised 2026-10-09). ST-8, the copy of OQ-73, keeps the `blocked:`
  it has here, less "held until the move": it is a spike the owner runs with Session A, not
  dispatched (R5). ST-18, the copy of OQ-108, keeps the owner's own `blocked:`. And steward's own
  first stories (the prompts' `{{REPO}}` slot and project section, closing `REVIEW.md`'s numbering
  gaps, and `init` with the thin workflow files) are written at tier `next` before its loop first
  runs, so they come before the moved stories.
- **R5. When.** **Revised 2026-10-08 by the owner: the move comes before OQ-73**, once the story
  pull requests #204 to #208 (OQ-117 to OQ-121) have landed, and still before OQ-101. OQ-73's coder
  (#209) found that its candidate mechanism, a separate Windows account for spawns, needs an
  administrator to create the account, a separate Claude Code login, a way to start a process as
  that account from node, and access to the worktree. That makes OQ-73 three or four stories, and
  the owner chose not to hold the move for them. The credential isolation is built in the
  workflow's repository, where the second project gets it too.

  **Clarified 2026-10-08 by the owner:** OQ-118 and then OQ-117 are *built* before the move, not
  only written, because they fix CI itself and the move's own pull requests go through CI. The
  move does not wait for OQ-119, OQ-120 or OQ-121: whichever are built first move with the
  workflow, and the rest go to its queue (R4). Since the hold under R4, OQ-119 and OQ-120 are not
  built here; OQ-121 still is, ahead of OQ-122 in the queue.

  **OQ-73's mechanism is a container** (decided 2026-10-08 by the owner, replacing the separate
  Windows account in OQ-73's Context). **Planned (OQ-73):** coder sessions run in a container whose
  image the workflow's repository defines, with only the work and the agent tool's own login passed
  in, so no host keyring, `~/.ssh` or user profile is reachable. The reason is portability: a new
  machine needs one standard install (a container runtime) rather than account management, and
  the same image runs on Windows, macOS and Linux. It may also give the reviewer its read-only
  mount (OQ-62). **Revised 2026-10-09 by the owner:** OQ-73 is rewritten here, in place, as a
  spike only, run by the owner with Session A rather than dispatched, and held until the move.
  Its outcome is a recommended split into the stories that build this; the old story's checks
  stay in its Context as their proof. #209 was closed unmerged and its branch deleted the same
  day, and its findings are in the spike's Context. The container runtime is left open, as the
  spike's open question. Known questions for the spike: a git worktree's `.git` file holds an
  absolute host path, and `node_modules` on a bind mount from Windows is slow.
  The **Planned (OQ-73)** markers here and under "Decided so far" were added on 2026-10-08 at the
  owner's decision, after #199's review. The spike builds nothing, so its AC-5 leaves them in
  place, and the stories written from its recommendation take them over (its AC-4). They take
  those stories' `ST-<n>` once written in steward.

  Superseded: **decided 2026-10-07 by the owner: after OQ-73, before OQ-101.** The owner's build
  order is OQ-80 (landed as #203 on 2026-10-07), then OQ-73, then OQ-101, so the move comes after OQ-80 and
  OQ-73 land and OQ-101 is built in the workflow's repository. OQ-101's `install` registers a
  scheduled task per machine, and the second project needs one too, so building it once there
  avoids building it here and then moving it. Which repository's queue OQ-101 then sits in is R4.

  The question as it stood: the earlier proposal was to move after the whole build order, so that
  what moves is known to work unattended. Against that, the second project's planning has started,
  and every workflow story built here first is one more thing to move.
- **R6. The second project.** What it needs from the workflow decides how general R2 and R3 must
  be. Answered so far (owner, 2026-10-07): it is also a Node project on GitHub, in a **private**
  repository. **Decided 2026-10-08 by the owner: the gate only, at first.** The workflow reviews
  and lands the pull requests the owner or the owner's interactive sessions open there, each
  against the issue it closes, and runs no unattended coder until coder sessions are isolated
  (OQ-73's containers, R5). That is the review-and-land pipeline the owner called worth having on
  its own (`docs/harness-outline.md`, "Why"). The issue-as-story design it needs is R7.

  A private repository changes things this design assumes about this public one:
  - **Branch protection.** GitHub's documentation ("About protected branches", read 2026-10-07)
    makes protected branches available for private repositories only on GitHub Pro, Team or
    Enterprise, not GitHub Free. This repository's gate relies on them: `test` and `review/agent`
    are required checks, with `enforce_admins: true` (**Mechanics**, under **Branching and
    releases**, above). `land.mjs` and the sweep re-check `review/agent` themselves rather than
    trusting `clean`, but nothing else stops a direct push to `main`. The second project's account
    is on **GitHub Free** (owner, 2026-10-07), so on that project the gate is kept by the
    workflow's own checks and by rule, not by GitHub. **Accepted for now** (owner, 2026-10-07):
    the owner works alone. Contributors will be added only if they are trusted and understand the
    process and this limitation. Before bringing in anyone less trusted, the owner will upgrade to
    GitHub Pro or make the repository public, so that the guardrails are enforced by GitHub.
  - **Actions minutes.** **Costs**, above, says minutes are not a constraint *because the
    repository is public*. Private repositories draw on the plan's included minutes.
  - **Privacy choices made because this repository is public**, such as naming a machine by a
    label rather than its hostname (OQ-112), may be relaxed per project, but do not have to be.
- **R7. Where stories come from.** The second project keeps its stories as GitHub issues, not files
  under `stories/`. The queue could take either, by a per-project setting. Not yet refined: the
  file-based design leans on things an issue does not give for free, such as frontmatter the lint
  checks, `git mv` to `stories/done/` as completion, ticks in the diff, and story containment.

  Further out, the owner wants to explore a project board rather than a simple queue for managing
  stories and priority, and is trying a GitHub Project for that on the second project. That is not
  a requirement of the move (owner, 2026-10-07). It meets two principles here head on:
  [Status is derived, not stored](#status-is-derived-not-stored), where a board's columns are
  stored status; and [Tier is priority](#tier-is-priority-and-nothing-else), where a board's order
  is set by hand rather than derived from a field.

  **Decided 2026-10-08 by the owner: for the gate-only start (R6), only the reviewer's input.** The
  reviewer of a second-project pull request reads the issue it closes (`Closes #n`) as its story.
  The queue from issues (ready state, priority and dependencies, which that project keeps in its
  GitHub Project, labels and "blocked by" relationships) waits until that project gets a coder.
- **R8. Whether the workflow's repository is public or private.** **Decided 2026-10-07 by the
  owner: public**, with the condition below. The owner had leaned that way: the work is
  exploratory, the code is already public in this repository, and private brings no benefit the
  owner needs. R2's git-tag pin also assumes it, since installing from a private repository would
  need a credential on every runner and machine that installs it.
  Public makes it simple for any project to use, and keeps Actions minutes free. Private keeps it
  to the owner, but a project using it then needs access to it, by package registry
  authentication or GitHub's settings for sharing workflows from a private repository, and that
  bears on R2. One condition if public: anyone can open an issue or a pull request on a public
  repository. If its stories come from issues (R7), only issues a writer created or labelled may
  enter its queue, the same stance OQ-81 takes for landing pull requests.
- **R9. Story numbering in the new repository, and the old references.** This document cites OQ
  numbers 150 times, across 43 distinct ids (`main` at `66c578d`), and every one is this
  repository's story, in `stories/done/` or `Completed-Questions.md`. If the new repository also
  numbered its stories OQ-1 onwards, "OQ-73" would become ambiguous. Proposed (Session A,
  2026-10-07): the new repository's stories take a prefix of their own, for example `WF-<n>`.
  The OQ references this document carries over keep their numbers, with one note saying they mean
  tower-workshop-paths' stories, and where to find them. Continuing OQ numbering in the new
  repository was considered and set aside: it would tie the two repositories' numbering together
  for good, against goal 4. The prefix touches everything that matches `OQ-<n>` today: the queue
  reader's and lint's filename patterns, branch names (`story/OQ-<n>-…`), test names
  (`OQ-<n>/AC-<n>`) and the design doc's markers.

  **Decided 2026-10-08 by the owner: `ST-<n>`**, for steward (R10), not `WF-<n>`.
- **R10. The name of the repository and the package.** **Decided 2026-10-07 by the owner:
  `steward`**, the repository `luplows/steward` (no repository by that name existed under `luplows`
  on that date, by `gh repo view`) and the package `steward`. It looks after the work on the
  owner's behalf while the owner keeps the decisions, which is the "why" in
  [`harness-outline.md`](harness-outline.md). The owner wanted that future state settled first.

  The question as it stood: with the git-tag pin (R2), only the
  repository name is needed at the move; the package name is whatever its `package.json` says. The
  name should not name a model company (goal 3), and need not say "story" if units of work come
  from issues (R7).
---

## Deliberately excluded

- **More agent roles.** Two roles plus a script is the right complexity.
- **Agents conversing with each other.** Artifacts only.
- **A model in the dispatcher.** If it needs judgment, the schema is underspecified.
- **Merging without a recorded verdict.**
- **Coverage-percentage tooling.**
- **A `develop` trunk.** Unnecessary once Pages is understood as alpha.

---

## Open questions

| # | Question | Status |
|---|---|---|
| 1 | Queue location | **Resolved:** one file per story under `stories/`, OQ numbering preserved. |
| 2 | Reviewer local vs. CI | **Resolved: local** — Action cannot authenticate; now moot since everything runs locally. |
| 3 | Dispatcher implementation | **Resolved:** a local script, no model. |
| 4 | Release cut trigger | Open. Human call, roughly every ten merged PRs. |
| 5 | Fresh vs. resumed coder on retry | Open. Fresh matches the context principle; resumed may be cheaper. Untested. |
| 6 | Story sizing proxies | **Resolved:** guideline, not a cap. Session A's judgment governs readiness, and carries an obligation to push back when scope is too large. Better proxy is distinct mechanisms than criterion count — see [Sizing is a judgment](#sizing-is-a-judgment-and-it-is-session-as). |
| 7 | Verdict mechanism | **Resolved:** `review/agent` status, SHA-keyed. Already built and required. |
| 8 | What CI runs | **Resolved:** current suite plus schema lint, AC traceability, existing-test flag. No tiering at 70 s. |
| 9 | Production deployment target | Open. None today; Pages is alpha. Tags are checkpoints until one exists. |
| 10 | Second GitHub identity | Open. The only thing that fully closes self-marking. Cost: a machine account or App. |
| 11 | Other companies' models | Open. Goals decided 2026-10-07, and comes after the move; questions M1–M6 under [Portability](#portability-other-projects-other-companies-models). OQ-114. |
| 12 | The workflow in a repository of its own | Open. Goals decided 2026-10-07, and comes first; questions R1–R10 under [Portability](#portability-other-projects-other-companies-models). OQ-115. |
