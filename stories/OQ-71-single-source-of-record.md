---
id: OQ-71
title: Give each cross-referenced claim one authoritative home
tier: next
kind: workflow
depends_on: []
model: sonnet
blocked: null
---

## Intent

As anyone reading this repository to decide what to build, I want each rule about
how the workflow operates to be stated once, so that following a citation lands
me on the current version rather than a superseded copy of it.

## Acceptance criteria

- [ ] **AC-1** — `docs/agent-workflow-design.md` carries a table naming each
      cross-document claim in AC-3 to AC-6, its **one** authoritative location,
      and every file that refers to it. The table is the thing a later session
      consults before restating a rule, so it lists referrers even where they are
      correct today.
- [ ] **AC-2** — Every location that is not authoritative for a claim either
      links to the authority without restating the claim's substance, or is
      marked as a summary naming what it must not drift from. The second form
      exists because a prompt cannot send an agent to another file mid-task;
      `.claude/prompts/coder.md` already uses it for the allowlist — *"that
      function is the authority — this block is a reader's summary of it and must
      not drift from it."* A restatement carrying neither a link nor that marking
      fails this criterion.
- [ ] **AC-3** — **The credential model.** Authority: the design doc's
      "Credential minimalism". `REVIEW.md`'s "For the coder: opening a PR" no
      longer states that the runner's credential is "scoped to pull-request
      writes but, like the coder's, not to commit statuses or workflow
      dispatch" — that claim is false, was corrected in the design doc and
      `coder.md` by #119, and survived in `REVIEW.md`, which both corrected
      passages then pointed readers at by name.
- [ ] **AC-4** — **The retry bound and who applies `review-blocked`.**
      Authorities: OQ-48's AC-3 for the number of blocking verdicts, and OQ-80
      for applying the label (OQ-80 took over what were OQ-48's AC-6b and AC-6c
      on 2026-09-25), until each is implemented; after that, the code it names.
      Every statement of the bound, or of who applies the label, links to its
      authority or is marked as a restatement per AC-2. That includes
      `docs/agent-workflow-design.md`, where #143 made the number point at OQ-48
      but left the label restated: the "Failure paths" row "Still failing at the
      bound" names `review-gate.yml` without OQ-80. A passage that names OQ-80 as
      the story building it counts as a link. The marked restatements today are
      `REVIEW.md` ("What the workflow enforces", item 3) and OQ-80's AC-1, which
      OQ-80's Constraints mark. Historical records are exempt, because they
      record what was true then: `Completed-Questions.md`, `stories/done/`,
      OQ-48's Context, and the migration plan's "Overtaken" notes.
- [ ] **AC-5** — **The circuit-breaker threshold and its exemptions.**
      Authority: `.github/workflows/land-approved.yml`. No document states the
      numeric threshold; each points at the workflow. A test asserts that, by
      extracting the threshold from the workflow and failing if that number
      appears as a breaker threshold in any `.md` file — the check forbids the
      duplication rather than trying to keep two copies equal.
- [ ] **AC-6** — **The verdict vocabulary and its status mapping.** Authority:
      `REVIEW.md`'s "The three verdicts". `reviewer.md`'s "Your verdict" table,
      `review-gate.yml`'s header comment and the design doc each link or are
      marked per AC-2. The deprecated `fail` spelling is stated once, with its
      reason, rather than in each.
- [ ] **AC-7** — Stale cross-references found while doing the above are fixed,
      and a test asserts the property generally: every `OQ-<n>` citation that
      names a containing file names the file the entry is actually in. `CLAUDE.md`
      cited "`Open-Questions.md`, OQ-42" when OQ-42's entry has been in
      `Completed-Questions.md` since it was resolved, and
      `Completed-Questions.md:252` links `[OQ-48](Open-Questions.md)` after OQ-48
      was refined into `stories/`.

## Out of scope

- **Rewriting `docs/migration-plan.md`.** Its own header forbids it — the plan
  "is kept as it was written rather than rewritten as it is executed", and where
  a step was overtaken "that is noted inline rather than edited away". Steps 2, 4
  and 6 are superseded by OQ-68, OQ-69 and OQ-48 and get **inline annotations**
  saying so. Editing the steps themselves fails this.
- **`docs/gap-analysis.md`.** `CLAUDE.md` calls it a dated snapshot "kept for the
  reasoning rather than the state". Its claims are meant to be stale. Leave it.
- **`Completed-Questions.md`'s entries.** The archive is history; only the one
  broken link in AC-7 is touched, not the prose around it.
- **The coder allowlist drift check.** OQ-67's AC-3 already makes `coder.md`'s
  block checkable against `coderAllowedTools`. This story names that claim in
  AC-1's table and does not reimplement the check.
- **Deduplicating prose for its own sake.** Two documents describing the same
  mechanism in different words, for different readers, is not the defect. The
  defect is two documents making the same *load-bearing assertion* where one can
  go stale without the other noticing.

## Constraints

- Node, ESM, no new runtime dependencies, for the checks in AC-5 and AC-7.
- No claim may be corrected in one place and left in another. That is the failure
  this story exists to end, and repeating it inside this story's own diff is the
  obvious way to fail it.

## Context

Written after [#119](https://github.com/luplows/tower-workshop-paths/pull/119),
whose review found four documentation-consistency defects, three of which were
copies of a claim corrected elsewhere in the same pull request.

**This project has already diagnosed the problem and applied the fix once.** The
design doc's "Status is derived, not stored" says the derived-status table is
specified in `stories/README.md` "and deliberately not restated here", because
the two copies "disagreed within days, and a literal reading of the one here made
the queue reader unable to dispatch its own story". That is this story, generalised
to the claims that were not covered.

**The concrete evidence, all from one session:**

- The credential claim lived in three files. #119 corrected two and pointed both
  at the third.
- The breaker threshold is in the workflow; `CLAUDE.md` described what a *tripped*
  breaker does without saying what trips it, and a session inferred one label was
  enough — then asserted that in a verdict comment on a merged pull request and in
  the framing of a decision the owner made from it.
- The retry bound was "two rounds" in the design doc and the plan while OQ-48 set
  it to three, in the same repository, on the same day.
- `github.mjs`'s scope was "status posting, PR lookup, label application" in the
  plan and "posts no status, applies no label" in OQ-68 — and OQ-68 cites the plan
  step as its own scope.

`CLAUDE.md`'s **Claims about this repository** section is the behavioural half of
this: re-derive rather than recall. This story is the structural half — reducing
how many places there are to recall *from*. The two are complementary and neither
is sufficient, because a rule asking every future session to be careful competes
with one that removes the opportunity.

- `docs/agent-workflow-design.md`, "Status is derived, not stored" — the
  precedent, and the wording AC-2's link form should match
- `.claude/prompts/coder.md`, the allowlist block — the precedent for AC-2's
  marked-summary form
- `REVIEW.md`, "For the coder: opening a PR" — AC-3's live defect
- `.github/workflows/land-approved.yml` — AC-5's authority
- [#119](https://github.com/luplows/tower-workshop-paths/pull/119) — the review
  comment enumerating all four defects, with line numbers

## Open questions

- **May a prompt restate a rule at all, or must it link?** AC-2 allows a marked
  summary because an agent acting on `coder.md` cannot go and read
  `coder-env.mjs` mid-task, and `coder.md` already relies on that. But a marked
  summary is still a second copy that can drift — the marking makes the drift
  attributable, not impossible, and OQ-67's AC-3 exists precisely because that
  marking did not stop the block from drifting from the function. If a prompt may
  restate, the marked-summary form needs a rule about *what kind* of claim may be
  summarised (a list a reader needs in front of them) versus which must be a
  pointer (a threshold, a scope, an ownership rule). Settling this decides how
  much of AC-2 is mechanical and how much is judgement.

- **Should the checks in AC-5 and AC-7 be tests or a CI lint?** They assert
  properties of documentation, not of code, so `npm test` is an odd home —
  but OQ-61 is already adding a story-schema lint, and a second documentation
  linter may want to live alongside it rather than be invented separately. If
  OQ-61 lands first this story should extend it; if not, the two will need
  reconciling later. Worth deciding in what order they go.
