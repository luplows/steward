---
id: ST-21
title: Review against the rules file from main, in sections, and cite section and item
tier: next
kind: workflow
depends_on: [ST-20]
model: sonnet
blocked: "Built by hand in an interactive session, not dispatched, until steward's coder works (decided 2026-10-11 by the owner; docs/agent-workflow-design.md, Portability, Decided so far)"
---

## Intent

As the owner, I want every review to be judged by the project's rules as they stand on `main`,
given to the reviewer in its prompt, with the reviewer saying which sections it applied, which it
did not and why, and citing each finding by section and item, so that a pull request cannot
loosen its own rules, a skipped section is visible on the pull request, and a project can number
its rules as it likes. I want steward's own `REVIEW.md` to be the first file in that form, holding
rules only.

## Acceptance criteria

- [ ] **AC-1** — `review.mjs` reads the rules with ST-20's `readRules`, from the settings'
      `rulesFile` on `main`, before any setup or session. A file that is missing or does not
      parse ends the review with a new result, `rules-unreadable`, carrying the problems: no
      session starts, nothing is recorded, and the pull request stays pending.
- [ ] **AC-2** — The rules file's text reaches the reviewer through a new `{{RULES}}` placeholder
      in `.claude/prompts/reviewer.md`, bounded as the other injected values are
      (`wrapInjectedBlock`). The prompt no longer tells the reviewer to read `REVIEW.md` from its
      checkout. It tells it to decide which sections apply from each section's `Applies when:`
      line, and that a section without one always applies.
- [ ] **AC-3** — The verdict the prompt asks for has each finding as `{ section, item, severity,
      text }`, `section` a section's name and `item` an item number in it, and a `sections` list
      naming every section of the rules once, each `{ name, applied }`, with a non-empty
      `reason` when `applied` is false. `parseReviewerVerdict` rejects, as malformed, a verdict
      whose finding names a section or item the rules do not have, or whose `sections` list
      leaves one out, names one twice, names one the rules do not have, or lacks a reason for one
      not applied. A malformed verdict is handled as today: one more session, then
      `malformed-verdict`.
- [ ] **AC-4** — The recorded comment cites each finding by section and item, and then lists
      every section, applied or not, with the reason for each not applied, before the marker
      line. The marker line is unchanged, so `review-gate.yml`, `apply-review-blocked.mjs` and
      `review-verdicts.mjs` read it as before.
- [ ] **AC-5** — `REVIEW.md` is converted into the form ST-20 parses, holding rules only, in these
      sections, each with its own numbering from 1: "Reading the pull request body" (always),
      "Every pull request" (always), "Changes to code" (applies when the diff changes code or
      tests), "Integrity" (always), "Conformance to the unit" (applies when the pull request
      implements a unit) and "Changes to stories" (applies when the pull request adds or changes
      a file under `stories/` without implementing one). Every rule of today's items 1 to 7, 9 and
      11 to 25 is kept, worded as today except: item 3 names `README.md` only; item 4, about
      `Open-Questions.md`, is removed; and item 5 checks `stories/` (with `done/` and `retired/`)
      and the branches on `origin`. The pull request body gives the mapping from each old item
      number to its new section and item.
- [ ] **AC-6** — What `REVIEW.md` held about how steward works ("For the reviewer: reporting a
      verdict", with its subsections, and "For the coder: opening a PR") moves to a new
      `docs/review-mechanics.md`, which `CLAUDE.md`'s "Where things are documented" table lists,
      except what the reviewer itself must follow, which is in `reviewer.md` already or added
      there.
- [ ] **AC-7** — Every reference to a `REVIEW.md` item number in `CLAUDE.md`,
      `docs/session-a.md`, `stories/README.md`, `.claude/prompts/coder.md`,
      `.claude/prompts/reviewer.md`, and the comments and messages of `scripts/dispatch/` and
      `scripts/land/`, names the section and item instead. `grep -rn "item [0-9]" ` over those
      paths, given in the pull request body, shows what remains and why.
- [ ] **AC-8** — Tests: `review.test.mjs` covers AC-1 (missing and unparseable rules, with no
      session spawned), AC-3 (each rejection, and a valid verdict accepted) and AC-4 (the
      comment's text); `ST-21/AC-5`, in a test file of its choosing, parses the committed
      `REVIEW.md` with `parseRules` and checks its section names and conditions.
- [ ] **AC-9** — The `**Planned (ST-21)**` marker in `docs/agent-workflow-design.md` loses
      `ST-21`, and the passage is corrected wherever what was built differs.

## Out of scope

- How the unit is found: ST-19 and ST-22. `resolveStory` and the `{{STORY}}` placeholders are
  unchanged here.
- The reviewer's narrower commands in place of the whole check: ST-22.
- Changing any rule's substance beyond AC-5's three exceptions.
- What steward's example rules file for other projects contains, and `init`.
- `docs/gap-analysis.md`, `docs/migration-plan.md`, `docs/steward-bootstrap.md` and the fixtures
  under `test/fixtures/`, which are records of their time and keep their item numbers.

## Constraints

- Node, ESM, no new runtime dependencies.
- The prompt, the parser and `REVIEW.md` change in this one pull request: a reviewer given the new
  file with the old output format, or the old file with the new one, would be rejected.

## Context

- `docs/harness-outline.md`, "Defining steward", "Review", "The rules file's shape": the
  decisions this story builds. Section names must be unique so that a finding's `section` names
  one (ST-20's AC-2).
- Sizing (Session A, 2026-10-11): this is one cut-over rather than three stories because the
  prompt's output, the parser and the file's form only work together.
- `scripts/dispatch/review.mjs`: `parseReviewerVerdict` requires an integer `item` (line 170) and
  `formatFindings` writes `**Item <n>**`.
- `.claude/prompts/reviewer.md` line 171 tells the reviewer to read `REVIEW.md` in its checkout,
  which is the pull request's head.
- `grep -rln -E "items? [0-9]+"` on 2026-10-11 found item numbers in `docs/session-a.md`,
  `stories/README.md`, both prompts, `coder-env.mjs`, `invocation.mjs` (a different list's item)
  and `review.mjs`.
- A spawned coder session cannot edit `.claude/prompts/` (`docs/agent-workflow-design.md`, "A
  spawned session cannot edit `.claude/prompts/`"); this story is built by hand.

## Open questions

*(none)*
