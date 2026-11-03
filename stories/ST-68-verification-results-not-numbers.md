---
id: ST-68
title: Ask a Verification section for numbers only where a result is a measurement
tier: next
kind: product
depends_on: []
model: null
blocked: null
---

## Intent

As a project using steward's example checklist, I want a change with nothing to measure to be able
to meet "Integrity", item 1, so that a review does not block a documentation change for having no
numbers, and whether it blocks does not depend on how the reviewer reads the item that time.

## Acceptance criteria

- [ ] **AC-1** — **The item asks for results, and for numbers only from a measurement.** In both
      `templates/review-checklist.md` and `REVIEW.md`, "Integrity", item 1, reads, wrapped as the
      file's other items are:

      > The **Verification** section gives each command run and its actual result, rather than an
      > assertion that checks passed. A result that is a measurement gives its numbers, taken the
      > same way across a before/after comparison. A change no project check applies to says so,
      > and gives a command showing what changed, such as a diff, with its output.

- [ ] **AC-2** — **Nothing else in either checklist changes.** The diff of each file changes only
      that item's lines, so "Integrity" keeps its four items in both, and items keep their numbers.
- [ ] **AC-3** — **The design record says it is built.** The `**Planned (ST-68)**` marker in
      `docs/agent-workflow-design.md`, Part 3, "Decided so far", on "`Integrity`, item 1, asks for
      numbers only from a measurement", is removed.

## Out of scope

- The "Numbers, not claims" comments in `templates/pull_request_template.md` and
  `.github/pull_request_template.md`. Their example is a measurement, and the checklist, not a
  comment, is what a pull request is reviewed against.
- "Reading the pull request body" in either checklist. Its requirement of a command and its actual
  result still holds, and the new wording keeps to it.
- `.claude/prompts/reviewer.md`, and any other prompt.
- A test pinning the checklist's wording. The existing test of the example's sections and item
  counts (`scripts/dispatch/rules.test.mjs`) still applies, and this story adds no logic.
- Running a review to observe the new wording. The release walkthrough (`docs/release-review.md`)
  reviews pull requests against the example checklist.

## Constraints

*(none)*

## Context

- `templates/review-checklist.md` — the example checklist; `init` copies it into a project
  (`scripts/dispatch/init.mjs`). `REVIEW.md` is steward's own, with the same item 1 today.
- The dry run on `luplows/playground`, 2026-11-03, at `b96243c`, against the example checklist:
  - #4's Verification ran `git diff` and said "There is nothing to run in this repository". It
    passed.
  - #6's and #8's each ran `git diff origin/main --stat` and said only `README.md` changed. Each
    had a block on "Integrity", item 1, for having no actual numbers. Each had other blocks as well.
- `docs/agent-workflow-design.md`, Part 3, "Decided so far" — the decision, with what was not chosen.

## Open questions

*(none)*
