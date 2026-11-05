---
id: ST-80
title: Have the reviewer report every blocking finding it finds in one review
tier: next
kind: product
depends_on: []
model: null
blocked: null
---

## Intent

As the owner, I want a review to report every blocking finding it finds, not
stop at the first, so that an author can fix them in one round and the round
bound is not spent finding them one at a time. In the owner's words: "I want as
many fixes to be caught as reasonable. I don't expect the list to be perfect -
that's a bad metric for software." On playground #10, two reviews of one head
blocked on two different parts of the pull request's description, and either
review could have reported both.

## Acceptance criteria

- [ ] **AC-1** — `.claude/prompts/reviewer.md`, "Your verdict", says that once
      one item fails, the reviewer carries on through every applicable item of
      the checklist and the whole diff, and reports each blocking finding it
      finds in the same verdict, findings in the description and in the change
      alike.
- [ ] **AC-2** — The same text says that the list is not expected to be
      complete, and that a finding is still reported only when it is real:
      "Calibration"'s "Do not manufacture findings to look thorough" stands, and
      is not contradicted.
- [ ] **AC-3** — Nothing else in `reviewer.md` changes, and neither does
      `REVIEW.md`, `templates/review-checklist.md` or any code.
- [ ] **AC-4** — The `**Planned (ST-80)**` marker in
      `docs/agent-workflow-design.md` loses `ST-80`.

## Out of scope

- How blocks count toward the round bound. A block on the description still
  counts like any other (crew, 2026-11-05; design doc, "What the gate
  enforces", item 3).
- Any promise that a review finds everything, or a measure of how many
  findings a review misses.
- ST-71's change to the Verification guidance.

## Constraints

*(none)*

## Context

- `.claude/prompts/reviewer.md`: "Calibration" and "Your verdict". Today only
  observations carry "Report every such finding".
- A spawned coder cannot edit `.claude/prompts/`: it gives AC-1 and AC-2 as a
  `### Proposed prompt edit`, as `.claude/prompts/coder.md` describes, or the
  crew has the story built by hand.
- Playground #10's verdicts, 2026-11-04 at 06:22:19 and 06:24:03 UTC:
  "Reading the pull request body", item 1, then "Integrity", item 1, on the
  same head.

## Open questions

*(none)*
