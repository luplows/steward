---
id: ST-28
title: Keep a checklist section's lead text when parsing it, and give the git-backed rules tests time
tier: normal
kind: workflow
depends_on: []
model: sonnet
blocked: null
---

## Intent

As a member of the crew, I want `parseRules` to keep every line of a section, so that nothing a
checklist says is silently missing from its parse when something other than the reviewer's prompt
reads it. Today a section's text before its first numbered item is dropped. I also want the
`readRules` tests, which build git repositories before each test, not to fail on a slow machine for
want of time.

## Acceptance criteria

- [ ] **AC-1** — Each section `parseRules` returns (`scripts/dispatch/rules.mjs`) has a `lead`: the
      text between its heading, or its `Applies when:` line when it has one, and its first
      numbered item, trimmed, and `''` when there is none. Items, conditions and the problems
      `parseRules` reports are unchanged.
- [ ] **AC-2** — A test, named `ST-28/AC-1`, parses a section with a lead paragraph after its
      `Applies when:` line and one without a condition, and asserts each `lead`. The existing
      `ST-20/AC-<n>` tests still pass, changed only where they compare whole section objects, to
      include `lead`.
- [ ] **AC-3** — `parseRules` run on this repository's `REVIEW.md` gives "Reading the pull request
      body" a `lead` that contains "Check the content of each section", and a test, named
      `ST-28/AC-3`, asserts it.
- [ ] **AC-4** — In `scripts/dispatch/rules.test.mjs`, the `readRules` tests and their `beforeEach`
      run with a 30-second timeout, set in that file. `vitest.config.mjs` is unchanged.

## Out of scope

- Giving the lead text to the reviewer some other way: the prompt carries the whole checklist
  already (`{{RULES}}`, `.claude/prompts/reviewer.md`).
- Checking a verdict's citations against the lead: a finding cites a section and an item.
- Timeouts in any other test file.

## Constraints

*(none)*

## Context

- `scripts/dispatch/rules.mjs`, `parseRules`: lines after the heading go to the section; an
  `Applies when:` line, if it is the first non-blank one, becomes `appliesWhen`; after that, a line
  is kept only once an item has started (`else if (items.length > 0)`), so lines before the first
  item are dropped.
- `REVIEW.md`, "Reading the pull request body": three paragraphs and a list before its item 1.
- `scripts/dispatch/review.mjs` injects the whole checklist into the prompt, and uses the parse to
  list the sections and to check each finding's section and item. Nothing reads the dropped text
  today.
- `scripts/dispatch/rules.test.mjs`, `describe('readRules')`: its `beforeEach` runs thirteen `git`
  commands to build a bare origin, a seed and a clone. Vitest's default timeouts are 10 seconds for
  a hook and 5 seconds for a test, and `vitest.config.mjs` sets neither.
- Raised in #15's review (ST-20), and placed by the owner on 2026-10-14 as one small story.

## Open questions

*(none)*
