---
id: ST-4
title: Make the reviewer block on defects rather than recording them as observations
tier: fix
kind: workflow
depends_on: [ST-33]
model: sonnet
blocked: "Built by hand: changes .claude/prompts/reviewer.md, which a spawned coder session cannot edit (docs/agent-workflow-design.md, A spawned session cannot edit .claude/prompts/)"
---

## Intent

As the owner of the review gate, I need `pass-with-observations` to mean *"real,
but not this diff's to fix"* rather than *"a defect I decided not to fail on"*,
so that a verdict of `success` is evidence the diff is sound rather than
evidence the reviewer was reluctant.

## Acceptance criteria

- [ ] **AC-1** — `.claude/prompts/reviewer.md` names the conditions that
      **must** produce `block`, whatever kind of text they are found in (code,
      a test, a comment, a prompt, a story, a doc or the pull request body):
      the diff introduces a defect, the diff states something false, an
      acceptance criterion is not genuinely satisfied, the diff contradicts the
      design of record or another story, or something in the unit's **Out of
      scope** is present.
- [ ] **AC-2** — The prompt states a decidable test for the boundary: *a
      finding you would fix in this pull request if you were its author is a
      block, not an observation.*
- [ ] **AC-3** — `pass-with-observations` is defined by what it is **for**:
      findings that are real but not this diff's to fix, because they were
      there before it, lie outside it, are a suggestion, or follow a decision
      the unit or the owner already recorded. "Your verdict" and
      "Calibration" in `reviewer.md` say this, and neither describes it as a
      doubt the reviewer chose not to block on. Every other place in
      `reviewer.md` that sends a verdict to `pass-with-observations`, such as
      a refused command that left a claim unverified, agrees with this
      definition or names the claim it could not check instead.
- [ ] **AC-4** — The language against overcorrection stays: *a reviewer that
      fails everything gets switched off*, and *do not manufacture findings to
      look thorough*. The goal is moving genuine defects out of the middle
      state, **not** raising the block rate on sound pull requests.
- [ ] **AC-5** — The change is validated against steward's own verdicts rather
      than asserted. With the revised prompt, the reviewer is run once on each
      of four heads, as `buildInvocation` renders it, against `REVIEW.md` from
      `main`, posting nothing. Each reads its unit as it was on `main` when it
      was reviewed, at its merge base: on `main` today, #34's unit,
      `stories/ST-30-spike-adds-draft-stories.md`, is in `stories/done/`.
      `readUnit` (`scripts/dispatch/unit.mjs`) reads a unit at
      `origin/<base>:<path>`, so `<base>` is a branch name, not a SHA: each
      replay names a branch on `origin`, or a local ref under
      `refs/remotes/origin/`, that points at its merge base. The four:
      - #41 at `14366c1` returns `block`, with a finding for the gap in ST-34's
        AC-5 that its verdict recorded as an observation (`model: null`);
      - #34 at `da6e5c5` returns `block`, with a finding for the comment it
        added above `idsAtBase`, which says the story lint holds filenames
        equal to frontmatter ids in `stories/retired/` too. Its verdict
        recorded that as an observation, and #38 then corrected it;
      - #39 at `3a7dcea` returns `pass-with-observations` or `pass`, since its
        one observation was there before the diff;
      - #37 at `c67ce61` returns `pass`, as it did.

      Each run's verdict, findings and cost are recorded in
      `docs/agent-workflow-design.md`, "Trials and measurements", including any
      that does not come out as listed. A run that does not is not repeated
      until it does: the prompt is changed and all four are run again.
- [ ] **AC-6** — `docs/agent-workflow-design.md`: every `**Planned (ST-4)**`
      marker loses `ST-4`, and each passage is corrected wherever what was
      built differs.

## Out of scope

- Requiring the reviewer to say, for each observation, why it is not a block.
  It is the strongest lever and the likeliest to overcorrect; file it
  separately if the replay in AC-5 shows AC-1 to AC-3 are not enough.
- The reviewer's or coder's tools and permissions. This story changes judgment,
  not access.
- The verdict-recording mechanism, the marker format and the gate workflow.
  `block` already maps to `failure`.
- Adding items to `REVIEW.md`. The items are not the problem; how a finding
  against one is graded is.
- Running checks during the review: ST-33.

## Constraints

*(none)*

## Context

Formerly tower-workshop-paths OQ-64, raised after its #109, whose first four
review rounds returned `pass-with-observations` on findings the author then
fixed. Refined on 2026-10-16 by the owner, after #41's review.

- Steward's record, counted from the verdict markers on its pull requests #1
  to #41 on 2026-10-16: 52 verdicts, of which 37 `pass-with-observations`,
  7 `block` and 8 `pass`, with 64 observations.
- #41's verdict found ST-34's AC-5 contradicting the design of record, which
  "Changes to stories", item 6, forbids, and filed it under that item as an
  observation. `reviewer.md`'s "Your verdict" says `block` when "at least one
  applicable item fails". AC-5 was fixed in the pull request that refined this
  story, before ST-34 was started.
- #34's verdict recorded as an observation a false claim the diff made in a
  code comment, above `idsAtBase` in
  `scripts/dispatch/story-containment.mjs`; #38 corrected the comment.
- `.claude/prompts/reviewer.md` — "Calibration" and "Your verdict".
  `REVIEW.md` has no verdict table to keep in step.
- `docs/agent-workflow-design.md` — "Verdict states", and Part 3, "Decided so
  far", "A finding the author would fix is a block".
- ST-33 changes `reviewer.md` first, so the replay in AC-5 runs the prompt as
  ST-33 leaves it.

## Open questions

*(none)*
