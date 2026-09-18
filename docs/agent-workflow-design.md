# Agent-Driven Development Workflow

**Status:** Design v2 — architecture settled, implementation sequenced in [`migration-plan.md`](migration-plan.md)
**Last updated:** 2026-09-18
**Target:** `luplows/tower-workshop-paths`

> v2 supersedes the first draft. It incorporates the gap analysis against `origin/main @ e06e677`,
> adopts the mechanisms the existing repo got right, and revises three things the first draft got
> wrong: the deployment model, the execution environment, and the nature of the dispatcher.

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

```
stories/
  OQ-49-import-player-info.md      ← open
  OQ-50-share-levels-via-link.md
  done/
    OQ-42-agent-review-gate.md     ← completed, moved by its own PR
```

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

1. Session A writes a story. Open questions empty.
2. Dispatcher picks the highest-tier, lowest-id ready story; creates a worktree and the branch
   `story/OQ-49-import-player-info`.
3. Coder implements, tests green, opens a **draft** PR, marks it ready.
4. CI passes.
5. Dispatcher spawns the reviewer, which returns a structured verdict.
6. Dispatcher posts `review/agent` = `success` on the head SHA.
7. The landing sweep merges it (squash) once `mergeable_state` is `clean`.

### Failure paths

The majority of the interesting behaviour.

| Situation | Route |
|---|---|
| Reviewer returns `block` | Findings → coder respawned with story + findings. **Max 2 rounds.** |
| Still failing after 2 rounds | `blocked:` set on the story, `review-blocked` label applied, human queue. Round count **derived from `block` verdicts on the PR**, not stored. |
| Story was wrong, not the code | `blocked:` set with the reason → Session A |
| Coder hits ambiguity mid-story | `blocked:` + the specific question → Session A |
| Branch stale | Rebase; if it fails, kick back rather than merge against a moved world |
| Spawn died / timed out / hit budget | Dispatcher records it and moves on; the watchdog surfaces it |

**The outlet valve must never prompt.** A spawned session that asks a question with nobody attached
hangs — one observed instance sat blocked for eight minutes. Invocations pass
`--permission-prompts none` so anything that would prompt is denied instead of blocking, and the
coder's escape route is **write-and-exit**: set `blocked:` with the question, exit.

### Retry is bounded, and the bound is derived

Two rounds, then stop. Uncapped retries are how you get forty commits of an agent arguing with
itself. A reviewer session is fresh each time and cannot know how many rounds preceded it, and a
prose bound honoured by agents remembering is not a mechanism — that is the existing OQ-48.

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

The same derivation feeds the circuit breaker: on the second `block`, the dispatcher sets
`blocked:` on the story and applies `review-blocked`, which is what finally makes the breaker in
`land-approved.yml` count a signal something reliably produces.

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

This also materially improves the self-marking problem. The thing that posts a verdict is
version-controlled, reviewable, testable code that can only report what the reviewer returned.
That is not cryptographic independence — closing that properly still needs a second GitHub
identity — but "read the script and see it cannot fabricate" is a real improvement over "trust the
orchestrating agent."

### Invocation shape

Sketches, not literal — the prompts are rendered from files with the story injected.

```bash
# Coder — can edit, inside its own worktree
claude -p "$(render .claude/prompts/coder.md OQ-49)" \
  --add-dir "$WORKTREE" \
  --model "$STORY_MODEL" --effort medium \
  --permission-mode acceptEdits \
  --permission-prompts none \
  --max-budget-usd 6 \
  --output-format json

# Reviewer — structurally unable to write, holds no credentials
claude -p "$(render .claude/prompts/reviewer.md OQ-49 $PR)" \
  --model opus --effort high \
  --disallowedTools Edit Write NotebookEdit "Bash(git push:*)" "Bash(gh:*)" \
  --permission-prompts none \
  --max-budget-usd 3 \
  --output-format json
```

Two flags are load-bearing:

- **`--permission-prompts none`** — anything that would prompt is denied rather than hanging.
  Directly answers the observed hang.
- **`--max-budget-usd`** — a hard spend ceiling per invocation. Turns "how much can one runaway
  story cost" into a number chosen in advance.

### Credential minimalism

**The reviewer holds no GitHub write access.** It returns a structured verdict on stdout; the
dispatcher posts the status.

This is not convenience. In the existing workflow the reviewer prompt accreted one fix per failed
run — credential hunting after sessions could not post, "do not ask questions" after one hung —
until the assembled text read *find tokens on disk, tell nobody, act with elevated access*, and a
reviewer correctly refused it as an injection attack. Each addition was locally reasonable; nobody
re-read the whole.

Removing the reviewer's need to post anything **deletes that section of the prompt** rather than
rewording it. Applies equally to Session B, which writes stories, not statuses.

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
  (`gh workflow run land-approved.yml`) until a reliable one is chosen. See OQ-50.
- **One PR per run.** `mergeable_state` is computed asynchronously, so a second merge in the same
  pass decides on stale data.
- Oldest first, so nothing starves.
- **Re-checks `review/agent` directly** rather than trusting `clean`, because a required check
  vanished from protection once. Prevention, not detection.
- **`--match-head-commit`**, which refuses the merge if anything was pushed between the check and
  the call.
- Circuit breaker at five `review-blocked` PRs, with exemptions for `breaker-override` and
  workflow-only diffs so a tripped breaker is not a trap.

The one change: `review-blocked` must be **applied by the dispatcher** when a story exhausts its
two rounds — the bound being derived from the PR's own `block` verdicts rather than remembered.
Today the label is applied by hand, so the breaker counts a signal nothing reliably produces.

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
- Coder rebases before opening the PR; cap branch age rather than merging against a moved world.

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

Nothing currently aggregates verdicts. The data exists — every verdict is a commit status plus a
comment. Add the third verdict state first, or the measurement is meaningless. Then a scheduled
workflow can collect it. This is the existing OQ-47.

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

### GitHub mechanics

- **`mergeable_state`**: `clean` (all *required* checks green), `blocked` (required check
  failing/pending), `unstable` (only non-required), `dirty`, `behind`, `unknown`. The
  `blocked`/`unstable` split is the only way to tell from outside whether a check is required.
- **Computed asynchronously** — never merge twice in one pass.
- **Workflow trigger decides which branch a workflow runs from.** `pull_request` runs from the PR
  branch; `issue_comment`, `schedule`, `workflow_dispatch` run from the **default branch**, so they
  cannot be tested on the PR that introduces them. **Mitigation: move logic out of `run:` blocks
  into committed scripts with unit tests.** The untestable surface shrinks to YAML wiring.
- **`GITHUB_TOKEN` pushes do not trigger further workflows.**
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
