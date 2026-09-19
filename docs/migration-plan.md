# Migration plan — getting the designed loop running

**Date:** 2026-09-18
**Companion to:** [`agent-workflow-design.md`](agent-workflow-design.md) · [`gap-analysis.md`](gap-analysis.md)
**Target:** `luplows/tower-workshop-paths`

> **Status: Phase 0 complete**, landed 2026-09-18 across
> [#98](https://github.com/luplows/tower-workshop-paths/pull/98)–[#104](https://github.com/luplows/tower-workshop-paths/pull/104).
> **Phase 1 — the dispatcher — is under way.** Step 1, `queue.mjs`, is delivered (OQ-49; see the
> note under [Order within Phase 1](#order-within-phase-1)). `github.mjs` (step 2) is next.
>
> The plan below is kept as it was written rather than rewritten as it is executed. What was
> planned is worth being able to compare against what happened: the phases here are the intent,
> and the merged PRs are the record. Where a step was overtaken by what was found doing it, that is
> noted inline rather than edited away.

---

## The strategy in one paragraph

The enforcement half of the loop already exists and is good — the gate, the landing sweep, branch
protection, the checklist discipline. What's missing is the **conveyor**: stories a machine can
read, a reviewer that receives them, and a dispatcher that drives the whole thing without a human
in the middle. So the plan front-loads the small changes that make the conveyor possible
(Phase 0, roughly a day), then builds the dispatcher (Phase 1, the bulk), then hardens and extends.
Everything after Phase 0 goes through the loop itself.

**Two decisions keep the early phases cheap:**

- **No big-bang backlog migration.** `Open-Questions.md` becomes the *idea backlog*; the new
  `stories/` directory is the *refined, dispatchable queue*. Session A's job is moving items across
  and attaching acceptance criteria. The file drains naturally as work is picked up. Nothing needs
  rewriting up front and no traceability is lost.
- **`deploy-pages.yml` doesn't change at all.** Pages is the alpha channel and *should* receive
  every merge continuously. The v1 recommendation to gate it on tags was based on a wrong
  assumption about what Pages was.

---

## Phase 0 — Make the conveyor possible

**Goal:** a story a machine can read, and a reviewer that receives it.
**Effort:** ~1 day. **Route:** ordinary PRs through the existing gate — it still works, and this is
exactly the kind of work it has been catching things on.

### 0.0 — Fix the stale checkout (do this first, it is 10 seconds)

> **Done.** The checkout was already on a fresh branch off `main` when Phase 0 started, and that
> branch is long gone. Kept because the hazard it describes — an agent session loading stale
> `CLAUDE.md` rules from a stale checkout — is the reason it was step zero.

The local working tree is on `claude/agentic-workflow-architecture-q3ay6a`, a branch deleted from
the remote, carrying a `CLAUDE.md` that predates the review gate. It still says *"A PR is ready to
merge as soon as CI is green — there is no separate human sign-off step."* **Any agent session
started in that checkout loads those instructions as project rules.**

```bash
git checkout main && git pull && git branch -D claude/agentic-workflow-architecture-q3ay6a
```

### 0.1 — The story format

**Deliverables:**

- `stories/_TEMPLATE.md` — the schema as a fillable file
- `stories/README.md` — what lives here vs. `Open-Questions.md` vs. `Completed-Questions.md`
- `stories/done/.gitkeep`
- One real story written in the new format (see [worked example](#worked-example) below)

**Do not migrate the existing eight open stories.** Move each one across when it is next picked up.

`Open-Questions.md` keeps its name — renaming would break grep references in
`Completed-Questions.md` and workflow comments — but its role is now documented as *unrefined
backlog*. Nothing dispatches from it.

### 0.2 — `REVIEW.md` gains story conformance

The checklist currently covers process and integrity, and does that well. It cannot detect story
drift because nothing in it references the story. Add a section:

```markdown
## Conformance to the story                     (PRs implementing a story)

16. **Completeness** — every acceptance criterion in the story is delivered.
    Name any that are not.
17. **Fidelity** — each AC is genuinely satisfied, not merely named in a test.
    A test named `OQ-49/AC-3` that does not exercise AC-3 fails this item.
18. **Containment** — nothing in the diff falls under the story's
    **Out of scope**, and nothing implements a decision the story left open.
19. The story file is moved to `stories/done/` in this PR.
```

Items 7 and 15 stay — they catch a different thing (self-consistency of the PR's own account) and
are cheap.

Also in 0.2, two corrections:

- **Add the third verdict state.** `pass-with-observations` maps to status `success`; only `block`
  maps to `failure`. Reviewers here already produce findings that fit nowhere in a binary.
- **Fix the `gh pr view` instruction.** `REVIEW.md` tells the reviewer to use `gh`;
  `reviewer-prompt.md` says there is no `gh`. Under local execution there is — but the document of
  record should say what is true, and should say *where* it is true.

### 0.3 — Rewrite the two prompts for local execution

`.claude/prompts/coder.md` and `.claude/prompts/reviewer.md` (moved from `.claude/*-prompt.md`,
since they are now rendered by a script rather than pasted by a human).

**Coder prompt changes:**
- Story is injected by the dispatcher, not looked up by the agent
- Environment section rewritten: `gh` **is** available, network **is** unrestricted, refs **can**
  be deleted
- Escape route: set `blocked:` in the story frontmatter and exit — never ask

**Reviewer prompt changes:**
- **Receives the story file.** The single most important change in this plan.
- Entire "Getting access" / `add_repo` section **deleted** — it holds no credentials and posts
  nothing. This is the section that drifted into injection shape; it goes away rather than getting
  reworded.
- Output is structured JSON on stdout, not a PR comment:
  ```json
  { "verdict": "pass|pass-with-observations|block",
    "findings": [{ "item": 17, "severity": "block", "text": "..." }],
    "summary": "..." }
  ```
- Re-read the assembled prompt end to end before shipping it, as a stranger would. The existing
  preamble about prompt drift is right and should survive the rewrite.

### Phase 0 exit criteria

- [x] A story exists in `stories/` with well-formed AC ids — OQ-49, `AC-1`–`AC-8`
- [x] `REVIEW.md` items 16–19 exist
- [x] Both prompts render against a story file — verified by assembling each against OQ-49: every
      placeholder used is documented, every documented one is used, and nothing is left
      unsubstituted. The *shape* of the result was wrong, which is OQ-51.
- [ ] One PR has been reviewed **by hand** against the new checklist, to confirm the items are
      checkable before a machine is asked to check them
      — **not satisfiable in Phase 0.** Items 16–19 are scoped to PRs *implementing* a story, and no
      Phase 0 PR does; the first that can is OQ-49's implementation. The intent was met regardless:
      seven PRs were hand-reviewed against items 1–15 and produced nine findings, seven of them from
      running a check rather than reading.

---

## Phase 1 — The dispatcher

**Goal:** the loop runs end to end without a human in the middle.
**Effort:** the bulk of the work — plan for several sessions.
**Route:** stories through the loop, dogfooding as it goes.

### Why node, not bash

The project is node 24 with Vitest already wired. A node dispatcher gets unit tests for free, which
is also the standing mitigation for *"there is no harness for GitHub Actions shell"* — logic lives
in tested modules, and any workflow becomes a thin caller.

### Shape

```
scripts/dispatch/
  queue.mjs        # read stories/, parse frontmatter, derive status, pick next
  queue.test.mjs
  spawn.mjs        # invoke claude -p, parse JSON, enforce timeout + budget
  spawn.test.mjs
  github.mjs       # gh wrappers: status post, PR state, labels
  github.test.mjs
  dispatch.mjs     # the loop
  dispatch.test.mjs
```

### Order within Phase 1

Each step is independently useful, so a stall leaves something working.

1. **`queue.mjs` + tests.** Read stories, derive status, honour `tier` / `depends_on` / `blocked`.
   Useful on its own: `node scripts/dispatch/queue.mjs` prints the queue.
   > **Done**, as OQ-49. The [worked example](#worked-example) below is kept as it was written —
   > the delivered story diverged from it (8 ACs, not 5; a fenced-code-block edge case found via
   > OQ-51; `depends_on`/`blocked` folded into one `## Open questions`/`waiting` precedence order
   > rather than separate ACs) — see `stories/done/OQ-49-read-story-queue.md` for what actually
   > shipped.
2. **`github.mjs` + tests.** Status posting, PR lookup, label application. Verify the posted status
   satisfies branch protection **before** anything depends on it.
3. **`spawn.mjs` + tests.** `claude -p` with `--permission-prompts none`, `--max-budget-usd`,
   `--output-format json`; timeout, non-zero exit, and malformed-output handling. **Every spawn
   needs a liveness check, not just a result read.**
4. **Reviewer-only dispatch.** Run the reviewer against an existing open PR, post the status. This
   is the highest-value half and it is testable against real PRs immediately.
5. **Coder dispatch.** Worktree creation, branch, `claude -p`, draft PR, mark ready.
6. **Full loop + retry bound.** Two rounds, then `blocked:` on the story and the `review-blocked`
   label — which finally makes the circuit breaker count a real signal (the existing OQ-48).
   **The round count is derived by counting `block` verdicts on the PR, not stored anywhere.** That
   is what makes the bound survive a dispatcher restart; a bound that resets when a process dies is
   not a bound. It also answers OQ-48's own open question about where the count should live.

### Worked example

Phase 1 step 1, written in the target format — both a template and the first thing to build:

```markdown
---
id: OQ-49
title: Read and rank the story queue
tier: workflow
depends_on: []
model: sonnet
blocked: null
---

## Intent

As the dispatcher, I need to know which story to work on next, so that story
selection is deterministic and needs no human or model judgment.

## Acceptance criteria

- [ ] **AC-1** — `queue.mjs` parses every `stories/*.md` frontmatter and fails
      loudly on a malformed one rather than skipping it.
- [ ] **AC-2** — Status is derived: `draft` when Open questions is non-empty,
      `ready` otherwise, `blocked` when `blocked` is non-null.
- [ ] **AC-3** — A story whose `depends_on` entries are not all in `stories/done/`
      is never returned as ready.
- [ ] **AC-4** — Ordering is by `tier`, then lowest id first; stable across runs.
- [ ] **AC-5** — Run as a script it prints the ordered queue with derived status.

## Out of scope

- Spawning anything. Selection only.
- Reading git or GitHub state — `in-progress` / `in-review` come later, in `dispatch.mjs`.

## Constraints

- Node, ESM, no new runtime dependencies. A frontmatter parser is a dev dependency at most.

## Context

- `stories/_TEMPLATE.md` — the schema
- `scripts/verify-workshop-costs.test.mjs` — the house style for a tested script

## Open questions

*(none)*
```

### Phase 1 exit criteria

- [ ] A story goes from `stories/` to merged with no human action between
- [ ] A blocking verdict round-trips: findings → fix commit → re-review → pass
- [ ] Two failed rounds produce `blocked:` plus the `review-blocked` label automatically
- [ ] The bound still holds after killing and restarting the dispatcher mid-story — proving the
      count is derived rather than remembered

---

## Phase 2 — Harden the gate

**Goal:** move the checks that are mechanical out of the reviewer's judgment.
**Route:** ordinary stories.

| Deliverable | Replaces |
|---|---|
| Story schema lint in CI | nothing — new burden created by Phase 0 |
| AC↔test traceability check | `REVIEW.md` 16 (partially — existence, not fidelity) |
| Existing-test-modification flag | `REVIEW.md` 9, currently prose the reviewer must notice |
| Static analysis: complexity, file size, duplication | nothing — craft floor |

**No CI tiering.** The suite runs in ~70 s. Revisit if Playwright passes ~5 minutes.

Each of these narrows what the reviewer spends judgment on, which is the whole point — the
checklist should shrink as CI grows.

---

## Phase 3 — Session B

**Goal:** close the loop the owner actually sits in. This is the existing OQ-46.

Phases 0–2 make it far cheaper than it would have been:

- `stories/done/` gives the batch's stories directly
- Squash-merge makes `git log <tag>..HEAD` the story list
- `pass-with-observations` findings become the high-yield attention list
- Screenshot baselines that moved give before/after images for free

**Deliverables:** a `/release-review` command or skill; `releases/` directory; tagging as the
acceptance act; the counter that raises the flag (the `SessionStart` hook already counts PRs and
has the machinery).

Worth doing before Phase 4 — parallel dispatch increases throughput, and throughput without a human
checkpoint is how the mental model degrades fastest.

---

## Phase 4 — Scale

**Goal:** more than one story in flight.

1. **Merge queue**, plus the `merge_group` bridge workflow that confirms `review/agent` on the
   originating PR's head SHA. Build the bridge preemptively — it is correct however the required-
   check semantics fall, and cheaper than debugging a stuck queue.
2. **Parallel dispatch** — N worktrees, N concurrent stories. Only after the queue exists;
   semantic conflict between independently-green PRs is otherwise unguarded.
3. **Watchdog** — a scheduled Action computing "is anything stuck?" from branches and PRs, plus
   *"did any PR merge without a successful `review/agent`?"* Survives the machine being off.
4. **Release branches**, if and when stabilising while work continues becomes necessary.

---

## Phase 5 — Depth

Independent of each other; pick by appetite.

- **Property-based tests** (`fast-check`) on the buy-order algorithm. The invariants are unusually
  natural here: a buy-order is always a valid purchase sequence, the rollup view is a strict
  group-by of the granular view, identical input gives identical output.
- **Escaped-defect tracking** — a frontmatter field on fix stories recording which gate should have
  caught it. The only measurement covering the whole system rather than one gate.
- **Verdict aggregation** (the existing OQ-47), which needs the third verdict state from Phase 0.
- **Boundary validation on Enhancement data** — the existing OQ-45.
- **A second GitHub identity**, the only thing that fully closes self-marking.

---

## What to do first

In order, tomorrow:

1. **`git checkout main && git pull`** — the stale checkout is a live hazard, not housekeeping.
2. **Read the design doc's [story artifact](agent-workflow-design.md) section**, and decide whether
   the frontmatter schema is what you want. Everything downstream reads it, so it is the cheapest
   thing to change now and the most expensive later.
3. **Write one story in the new format** — the `queue.mjs` one above is ready to use. Writing it
   will tell you more about whether the schema works than reviewing the schema will.
4. **Hand-review a PR against draft items 16–19** before asking a machine to. If you cannot check
   fidelity by hand from a story, a reviewer will not do better.

---

## Risks

**The story format is wrong and gets discovered late.** Mitigated by writing real stories in
Phase 0 and by the fact that `stories/` starts nearly empty — there is no corpus to migrate twice.

**The dispatcher is a bigger build than it looks.** Mitigated by ordering Phase 1 so each step
stands alone; reviewer-only dispatch (step 4) delivers most of the value and can be run by hand
against real PRs long before the full loop closes.

**Local execution means the machine must be on.** Accepted. The watchdog covers the case where it
isn't, and the alternative — cloud sessions — carries a documented failure catalogue that local
execution eliminates wholesale.

**Two queues coexist during the drain.** `Open-Questions.md` and `stories/` both hold work for a
while. Mitigated by documenting in `CLAUDE.md` that **nothing dispatches from `Open-Questions.md`**
— it is input to Session A, not to the loop.

**Review quality drops when the checklist grows.** Items 16–18 are judgment; 1–15 are mostly
mechanical. As Phase 2 moves the mechanical ones into CI, delete them from `REVIEW.md` rather than
leaving them. A checklist that only grows eventually gets skimmed.
