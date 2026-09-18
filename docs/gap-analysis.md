# Gap analysis — `luplows/tower-workshop-paths` vs. the workflow design

**Date:** 2026-09-18
**Analysed against:** `origin/main` at `e06e677` ("Close OQ-42: remove the review Action that never ran", #97)
**Companion to:** [`agent-workflow-design.md`](agent-workflow-design.md)

> **This is a dated snapshot, not a current account.** It was written against `e06e677` to inform
> the design, and Phase 0 has since closed most of what it identifies. It is kept because the
> *reasoning* behind several design decisions only makes sense against the state it describes.
> For where things actually stand, read [`migration-plan.md`](migration-plan.md) and `stories/`.

**Method.** Read from `origin/main` rather than the working tree — the local checkout sits on
`claude/agentic-workflow-architecture-q3ay6a`, a branch since deleted from the remote, and was
~42 files behind before fetching. Branch protection, rulesets, and PR state were read live via
`gh` as the repo owner.

---

## Summary

The enforcement layer is **further along than the design assumed**, and in several places built
better than the design specified. What is missing is not polish — it is the loop itself, plus one
structural gap that undermines the gate's stated purpose.

Three findings drive everything else:

1. **The reviewer is never given the story**, so the gate cannot detect story drift — which is
   the job it exists to do.
2. **`main` deploys to production on every merge**, which forecloses the release model the design
   assumes and makes the planned batch walkthrough a post-mortem rather than a gate.
3. **There is no dispatcher.** Orchestration is still a human-driven session.

---

## Finding 1 — the reviewer never sees the story

**The most consequential gap.** Review was defined as *drift detection: does this diff do what
the story said, all of it, and nothing else?* The gate as built cannot answer that question.

### Evidence

`.claude/reviewer-prompt.md`, "What to do", instructs the reviewer to:

1. Read `REVIEW.md`
2. Get the head SHA
3. Read the diff against the merge base
4. Read the PR body
5. Post findings

**No step reads `Open-Questions.md` or the OQ entry.** The asymmetry is explicit — the worker's
counterpart, `.claude/worker-prompt.md`, says: *"Read `CLAUDE.md`, `REVIEW.md`, and the OQ-N entry
in `Open-Questions.md`."* The worker receives the contract; the reviewer does not.

What `REVIEW.md` anchors scope to compounds it:

- **Item 7** — "The diff matches the **What changed** description."
- **Item 15** — "Scope was not widened beyond the task the PR set out to do."

Both compare the diff to *the PR's own account of itself* — and the same worker authored both
sides. A worker that misreads OQ-N writes a PR body describing what it actually built, and a diff
matching that body. Items 7 and 15 pass. Drift is invisible.

### What the gate does catch

Process conformance and integrity, and it does that well: template substantively filled, tests
present, no test weakened or deleted, no local workaround left in the diff, verification numbers
real rather than asserted. Both recorded `fail` verdicts came from this class and both were real.

This is worth having. It is simply a different gate than the one the design assumes.

### Why it happened

Over-application of a correct principle. The reviewer prompt argues, rightly, that *"a reviewer
that knows what the change was meant to do cannot see that the diff does something else."*

That is true of **the author's account** of the change. It is not true of **the authored story**,
which is the standard the diff is supposed to meet. The two got collapsed.

### Fix

Narrow and safe: **give the reviewer the OQ text**; keep withholding the worker's session,
summary, and reasoning. Decorrelation is preserved; drift detection becomes possible.

Blocked on a prerequisite: OQ entries are prose without enumerated acceptance criteria. "As a
player, I want X so that Y" plus discussion is not checkable item by item. The real work is
**AC ids on stories** — which is also what unlocks the AC↔test traceability check.

---

## Finding 2 — `main` is production

`.github/workflows/deploy-pages.yml` triggers on `push: branches: [main]`. Every merge deploys
to the live site. There are currently **no tags**.

This is the exact condition the design named as flipping the branching recommendation: release
branches work *as long as `main` deploys only to staging*. It does not.

### Fix — gate the deploy, not the merge

Do **not** introduce a `develop` trunk. Instead, change `deploy-pages.yml` to trigger on tag push
or release rather than on push to `main`:

- `main` stays the integration trunk — no second long-lived branch, no extra merge hop
- Tagging becomes the release act
- The batch walkthrough (OQ-46) gets something real to gate

Without this, OQ-46 reviews changes **that are already live**, which makes it a post-mortem rather
than a release gate. That is a materially weaker thing than the story intends.

---

## Finding 3 — no dispatcher

Orchestration is a human-driven session: someone decides what to work on, spawns a worker, notices
the PR, spawns a reviewer, and handles fallout. This is limitation #6 in the project's own
write-up, correctly diagnosed and unaddressed.

Everything documented below is scaffolding *around* a loop that is not yet automated. Supporting
evidence: the last twelve merged PRs (#86–#97) are almost entirely workflow construction, so the
loop has run on very little real feature work.

The design's answer — cold per-iteration dispatch with state derived from git and GitHub — is
directly compatible with what exists, because `land-approved.yml` already proves the pattern: a
scheduled job that reads state and acts without holding any.

---

## What already matches the design

Most of the enforcement layer. This is the strong part of the repo.

| Design element | Repo |
|---|---|
| Verdict as SHA-keyed required status check | `review/agent` — **verified live**: branch protection requires `test` and `review/agent`, `enforce_admins: true` |
| Commit status over PR review (self-approval restriction) | Same reasoning, same conclusion, documented in `review-gate.yml` |
| Verdict cannot outlive its commit | `pull_request` → pending; stale marker ignored; no dismissal mechanism |
| Merge executes a recorded decision, decides nothing | `land-approved.yml` — explicitly: *"this decides nothing at all"* |
| Neither coder nor reviewer merges | The sweep is the only merger |
| One merge per pass (async `mergeable_state`) | Implemented, rationale in comments |
| Files-only story queue | `Open-Questions.md` |
| No coverage-percentage floor | Deliberately absent, documented as deliberate |
| Outlet valve is write-and-exit, never prompt | `worker-prompt.md` "Working unattended" — correct, and for the right reason |
| Squash merge | Repo default, documented |
| "Require branches up to date" off | Confirmed: `strict: false` |
| Reviewer cold context | Explicit, with documented rationale |
| Scope creep is a named, checked criterion | `REVIEW.md` item 15 |

---

## Where the repo exceeds the design

Specific, and worth preserving through any refactor:

- **`--match-head-commit` on the merge call.** Closes the TOCTOU window between reading
  `review/agent` and merging. The design did not specify it; it is a genuine race.
- **Failing the gate workflow run on a blocking verdict**, purely so GitHub's built-in failure
  notification fires. The design called for a surfacing channel without naming a mechanism this
  cheap.
- **The sweep re-checks `review/agent` directly** rather than trusting `clean`, because branch
  protection silently lost a required check once. The design proposed a watchdog to *detect* that
  regression; this *prevents acting on it*, which is better placed.
- **The circuit-breaker exemption guard** — requiring at least one changed file so an empty file
  list cannot read as "workflows-only". A bug caught before production.
- **`REVIEW.md`'s "Reading the PR body"** — *"a template auto-populates, so an unfilled one is
  structurally identical to a filled one."* A failure mode the design did not anticipate.
- **The Integrity preamble** — *"an unsupervised author optimizes for the success criterion, and
  the cheapest path to 'green' is not always the intended one"* — states the coder-writes-both
  problem more generally and better than the design does.
- **Inline rationale discipline throughout.** `CLAUDE.md` names PR #92 as the incident that
  motivated the landing rule. Workflows carry essay-length comments explaining why. Better than
  most production repositories.

---

## Remaining gaps, ordered

### 1. No dispatcher
See Finding 3. Largest gap by volume of work.

### 2. Stories have no acceptance criteria, and open questions do not block dispatch
OQ-46 and OQ-48 both sit in the queue carrying unresolved **"Open questions:"** sections. Per the
design's [story readiness test](agent-workflow-design.md), such a story cannot produce a failable
review. Prerequisite for fixing Finding 1.

### 3. Reviewer holds GitHub write credentials
`reviewer-prompt.md` requires `add_repo` with `access: "push"` so the reviewer can post its own
marker. Already decided to change — the dispatcher should post the verdict and the reviewer should
hold nothing. The repo is the "before" picture, and that `add_repo` section is exactly the prompt
text that disappears.

### 4. Retry bound and `review-blocked` are unenforced
The project's own OQ-48, correctly diagnosed: the two-round bound is honoured by agents
remembering prose. The circuit breaker in `land-approved.yml` and the `SessionStart` banner both
count a signal nothing reliably produces.

### 5. No CI tiering, no AC traceability, no mechanical existing-test check
CI is a single `test` job (lint, Vitest, build, Playwright). `REVIEW.md` item 9 — no test skipped,
disabled, weakened or deleted — exists only as prose the reviewer must notice. The design makes it
mechanical.

### 6. Reviewer shares a model family with the worker
`reviewer-prompt.md` names the problem ("your prior about what 'looks right' is correlated with
theirs") and offers the checklist as mitigation. Running a different model remains untried and
remains the cheapest hedge available.

### 7. No merge queue
`rulesets` is empty; the repo uses classic branch protection. Semantic conflict between parallel
PRs is unguarded — the project's own limitation #9. Currently low-cost (zero open PRs), but this
is what bites once a dispatcher runs work in parallel.

### 8. No release concept, no rollback path
No tags, no release branches, no revert procedure. Everything is prevention.

### 9. No craft-quality cadence
Nothing checks for architectural drift at any altitude. Per the design, this belongs in periodic
tech-debt sweep stories plus static analysis — not in per-PR review.

---

## Live defects

Small, concrete, independently fixable.

**`REVIEW.md` instructs an unavailable tool.** Its reviewer section says to get the head SHA with
`gh pr view <N> --repo <owner/repo> --json headRefOid --jq .headRefOid`. `reviewer-prompt.md`
step 2 says *"There is no `gh` CLI in these containers"* and gives the `git rev-parse` alternative.
The prompt corrects the document of record — which works only while the prompt is read more
carefully than the checklist. This is a live instance of the project's own limitation #14.

**The local checkout is stale enough to be hazardous.** The working tree sits on a deleted branch
with a `CLAUDE.md` predating the review gate — it still says *"A PR is ready to merge as soon as
CI is green — there is no separate human sign-off step"*, instructs `gh pr create`, and claims
*"Nothing currently guards appearance"*. All three are now false. **Any agent session started in
this checkout loads those instructions as project rules.** Worth a `git checkout main && git pull`
before any local dispatch, and worth considering as a standing hazard of local workers.

---

## Suggested sequence

Ordered so each step unlocks the next rather than by size.

1. **Add acceptance criteria with ids to the story format**, starting with the next story written.
   Unblocks everything in Finding 1.
2. **Give the reviewer the OQ text**; add checklist items for completeness, fidelity and
   containment against the story. Closes Finding 1.
3. **Move the deploy trigger to tags.** One-line change; makes a release concept possible and
   turns OQ-46 into a real gate. Closes Finding 2.
4. **Move verdict posting to the dispatcher**, stripping credentials from the reviewer. Do this
   while building the dispatcher, not before.
5. **Build the dispatcher** — cold iterations, state derived from git/GitHub, external watchdog.
   Closes Finding 3 and the project's limitation #6; also the natural home for the retry bound
   (OQ-48).
6. **AC↔test traceability check in CI**, once AC ids exist and stories carry them.
7. **Merge queue**, before parallel dispatch — including the `merge_group` bridge workflow for
   `agent-review`.
8. **Run the reviewer on a different model.** Independent of everything above; can be done at any
   point.

Steps 1–3 are small and unlock disproportionate value. Step 5 is the bulk of the work.
