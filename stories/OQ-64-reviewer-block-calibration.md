---
id: OQ-64
title: Make the reviewer block on defects rather than recording them as observations
tier: fix
kind: workflow
depends_on: []
model: sonnet
blocked: null
---

## Intent

As the owner of the review gate, I need `pass-with-observations` to mean *"real,
but not this diff's obligation"* rather than *"a defect I decided not to fail
on"*, so that a verdict of `success` is evidence the diff is sound rather than
evidence the reviewer was reluctant.

## Acceptance criteria

- [ ] **AC-1** — `reviewer.md` names the conditions that **must** produce
      `block`, rather than leaving it to "does an applicable item fail": the
      diff introduces a defect, the diff states something false, an acceptance
      criterion is not genuinely satisfied, or something in the story's **Out of
      scope** is present.
- [ ] **AC-2** — The prompt states a decidable test for the boundary. The
      candidate is *a finding you would fix if you were the author is a block,
      not an observation* — a question the reviewer can actually answer, unlike
      "is this worth blocking?"
- [ ] **AC-3** — `pass-with-observations` is defined by what it is **for** —
      findings that are real but not this diff's responsibility: pre-existing,
      adjacent, or a suggestion — rather than as the residual category for
      anything short of certainty.
- [ ] **AC-4** — `REVIEW.md`'s three-verdicts table says the same thing.
      Round 2 of #109 was a fix applied to one prompt and not its mirror; this
      story must not repeat it.
- [ ] **AC-5** — The existing anti-overcorrection language survives: *a reviewer
      that fails everything gets switched off*, and *do not manufacture findings
      to look thorough*. The goal is moving genuine defects out of the middle
      state, **not** raising the overall block rate.
- [ ] **AC-6** — The change is validated against recorded history rather than
      asserted. #109 carries five rounds of verdicts at known head SHAs
      (`41372c17`, `503dbdb`, `c0ba530`, `ef09284`, `1aca6c8`), four of them
      `pass-with-observations` whose findings the author then fixed. Re-running
      the revised prompt against at least the round-3 and round-4 heads should
      produce `block`, and the round-5 head should still produce `block` for the
      reason it already did. A calibration change that cannot be shown to change
      a known-wrong verdict is not evidence of anything.

## Out of scope

- The reviewer's or coder's capability sets — OQ-62 and OQ-63. This story
  changes judgment, not access.
- The verdict-recording mechanism, the marker format, and the gate workflow.
  `block` already maps to `failure` and that plumbing works.
- Adding new checklist items to `REVIEW.md`. The items are not the problem; how
  a finding against one is graded is.

## Constraints

*(none)*

## Context

Raised after #109, which took five review rounds. The first four returned
`pass-with-observations` across seven findings, and **the author fixed every one
of them** — including a defect the diff itself introduced (the no-story render
mode breaking) and a false security claim in the document that defines the gate.
A finding the author turns around and fixes is, by its own evidence, a defect
rather than an observation.

The evidence is not one-sided, which is why this is filed rather than built. See
**Open questions**.

- `.claude/prompts/reviewer.md` — "Calibration" and "Your verdict"
- `REVIEW.md` — "The three verdicts", which carries the same soft framing
- [#109](https://github.com/luplows/tower-workshop-paths/pull/109) — the five
  rounds, each recorded as a comment against a known head SHA

## Open questions

- **The evidence now points at a narrower defect than this story assumes.**
  Across #109, #112 and #115 the reviewer blocked correctly and unprompted on
  *code* defects — a deny rule shadowing its own allow rule, three tests named
  for an AC and exercising none — and twice returned a clean `pass` whose
  summary carried prose defects it placed below the finding threshold: a
  citation attributed to the wrong document, a count that understated the
  story's own premise, a code block granting push to `main`. The author fixed
  every one of those immediately, which is the tell. So the pattern is not
  *"won't block"* — it is **under-weighting prose, citation and documentation
  errors relative to code defects.** If that holds up, AC-1's trigger list is
  the wrong shape: it should name *what kind of wrongness* counts, not only
  *where the wrongness is*. Test this against the replay in AC-6 before writing
  the fix.
- **Is the reviewer actually mis-calibrated, or was #109 an unrepresentative
  PR?** Round 5 returned a `block` that was specific, correct and unprompted —
  against a PR whose subject was the reviewer's own prompt. So the gate demonstrably
  *can* block. It is possible the first four rounds reflect a genuinely
  marginal series of findings on a docs-only change rather than a systematic
  reluctance, and that changing the prompt would trade a real problem for a
  noisier gate. One PR is a small sample, and it is the most self-referential
  one this repository has produced.
- **Which of the proposed changes are warranted?** AC-1 to AC-3 are cheap and
  hard to argue against. A fourth option — requiring the reviewer to state, per
  finding, why it chose `pass-with-observations` over `block` — is the strongest
  lever and the most likely to overcorrect into blocking on nits. Whether to
  include it should be decided against AC-6's replay, not in advance.
- **Does this survive OQ-63?** If the coder stops holding a credential, the cost
  of a wrong `pass` drops, because the gate is no longer the only thing between
  a coder and `main`. That may lower this story's tier on its own.
