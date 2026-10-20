---
id: ST-43
title: Ship a basic example checklist in the package, with HTML-comment placeholders the reviewer never sees
tier: next
kind: workflow
depends_on: []
model: null
blocked: null
---

## Intent

As a member of the crew of a project that installs steward, I want steward to give me a basic
checklist that applies to any project running steward, with plain placeholders showing where my
project's own rules go, so that my pull requests are reviewed from the start against rules that
hold for any project, and the placeholders never reach the reviewer as rules.

## Acceptance criteria

- [ ] **AC-1** — `parseRules` (`scripts/dispatch/rules.mjs`) ignores HTML comments (`<!-- … -->`,
      on one line or across several): a comment adds nothing to a section's lead or items, and a
      `## ` heading or a numbered line inside a comment starts no section and no item. Tests: a
      file with comments parses to the same sections, leads and items as the file with them
      removed; a commented-out heading and a commented-out item are not parsed.
- [ ] **AC-2** — `readRules` returns, as the `text` the reviewer is given (`{{RULES}}`), the
      checklist with its HTML comments removed. A test reads a checklist holding a comment from a
      repository's `main` and shows the text has no `<!--` and keeps every rule.
- [ ] **AC-3** — The package carries an example checklist, one Markdown file, which `init` copies
      (ST-44). It starts from steward's `REVIEW.md` and keeps exactly these sections and items, in
      this order, worded with no story conventions:
      - "Reading the pull request body": its lead text and item 1, matching the template `init`
        writes (the package's, ST-44): the `Unit:` line and the sections What changed, Verification
        and Docs check;
      - "Every pull request": `REVIEW.md`'s items 1, 2 and 4, numbered 1 to 3;
      - "Changes to code", with its `Applies when:` line: item 1;
      - "Integrity": items 1 to 4;
      - "Conformance to the unit", with its `Applies when:` line: items 1 to 3 (completeness,
        fidelity, containment), with no ticking of acceptance criteria, no story file, no
        `ST-<n>` id and no sentence on `story-containment.mjs`.
- [ ] **AC-4** — The example leaves out: "Every pull request", item 3 (the claims item); the
      Docs check on named files ("Reading the pull request body", item 2, `README.md`); "Changes
      to code", item 2 (no coverage tooling); "Conformance to the unit", item 4 (a story file
      moved into `stories/done/`); and all of "Changes to stories". A test parses the example and
      shows exactly the sections of AC-3, with their item counts, and that none of `README.md`,
      `coverage`, `stories/`, `ST-`, `AGENTS.md` and `story-containment` is in it.
- [ ] **AC-5** — The example's placeholders for a project's own additions are HTML comments, at
      least one in the preamble saying where a project adds its own sections, one in a section
      saying where it adds its own items, and one in "Reading the pull request body" saying that a
      project whose pull request template differs from the one `init` writes names its own template
      and sections there. A test shows the example's text as `readRules` returns it holds none of
      them.
- [ ] **AC-6** — The example holds rules only: nothing on the verdict marker, the three verdicts,
      a review with no verdict, what the gate's workflow enforces, or how the coder's pull request
      is opened (`docs/outline.md`, "The checklist's shape", "The file holds rules only").
- [ ] **AC-7** — Every **Planned** marker naming ST-43 in `docs/agent-workflow-design.md` is
      resolved, as its "Reading this document" note says.

## Out of scope

- Steward's own `REVIEW.md`, which this story does not change, and which keeps what the example
  leaves out.
- Copying the example into a project, and the path it is copied to: `init` (ST-44).
- The update notes steward keeps on what changes in the example between versions
  (`docs/outline.md`, "Review"): the release review's.
- A tool that compares a project's checklist with the example (design doc, "Open questions", D6),
  and the parser as a command a project runs in its CI (D7).
- Telling the reviewer that comments are not rules: it never sees them (AC-2).

## Constraints

- A placeholder is an HTML comment, and nothing in a comment reaches the reviewer (AC-1, AC-2).

## Context

- **Decided on 2026-10-19 by the owner**, with the planning session (design doc, Part 3, "Decided
  so far", "Steward installs in another project as a review gate, through `init`"): a basic
  example checklist, applicable to any project running steward, with obvious placeholders for
  project-specific additions. HTML comments, removed before the reviewer sees the checklist, were
  chosen over telling the reviewer that comments are not rules, which relies on the model obeying,
  and over a separate setup guide; the cost, accepted, is that a comment can carry nothing to the
  reviewer. It follows `docs/outline.md`, "Review", "What the example checklist contains".
- `REVIEW.md`: sections "Reading the pull request body" (2 items), "Every pull request" (4),
  "Changes to code" (2), "Integrity" (4), "Conformance to the unit" (4) and "Changes to stories"
  (7). It holds no HTML comment (`grep -n "<!--" REVIEW.md`).
- `scripts/dispatch/rules.mjs`: `parseRules`, and `readRules`, whose `text` `review.mjs` gives the
  reviewer as `{{RULES}}` (`review.mjs`, line 516).
- `.github/pull_request_template.md`: the `Unit:` line, then What changed, Verification and Docs
  check, each with an HTML comment.
- `.claude/prompts/reviewer.md`, lines 111 to 112, calls the three sub-checks items 1 to 3 of the
  checklist's "Conformance to the unit". ST-40's AC-5 changes that to say they are the example
  checklist's, so this story's example keeps them as items 1 to 3 of that section.

## Open questions

*(none)*
