---
id: ST-20
title: Read the project's rules file from main and parse it into sections
tier: next
kind: workflow
depends_on: [ST-18]
model: sonnet
blocked: null
---

## Intent

As a member of the crew, I want steward to read a project's rules file as it stands on `main` and
parse it into sections, each with the condition under which it applies and its own numbered items,
and to refuse a file it cannot parse, so that a pull request is judged by rules it cannot loosen,
and a broken rules file is caught before any review is paid for. This story builds the module; ST-21
puts it into the review.

## Acceptance criteria

- [x] **AC-1** — A new module, `scripts/dispatch/rules.mjs`, exports `parseRules(text)`, a pure
      function. A section starts at each line beginning `## `, and its name is the rest of that
      line. Text before the first section is the file's preamble. In a section:
      - the first non-blank line, if it begins `Applies when:`, is the section's condition, and
        the rest of that line is its text; otherwise the section has no condition, which means it
        always applies;
      - each line beginning with a number, a full stop and a space (`3. `) starts an item, and
        the item runs until the next item or the end of the section; lines starting `### `
        inside a section belong to it.
- [x] **AC-2** — `parseRules` returns `{ ok: true, preamble, sections }`, each section
      `{ name, appliesWhen, items }` and each item `{ number, text }`, or `{ ok: false, problems
      }` listing every problem it found, each naming the section. A file does not parse when it
      has no section, when a section has no item, when one section numbers two items the same,
      or when two sections have the same name.
- [x] **AC-3** — `readRules({ repoDir, base, rulesFile })` reads the file with
      `git show <remote>/<base>:<rulesFile>` in `repoDir`, so the copy on `main`, never a pull
      request's head, and parses it. A file missing from `main` returns `{ ok: false, problems }`
      naming the path, as an unparseable one does. It never throws for either.
- [x] **AC-4** — Each section numbers its own items: two sections may each have an item 1.
      Numbers within a section need not be consecutive.
- [x] **AC-5** — Tests in `scripts/dispatch/rules.test.mjs`, named `ST-20/AC-<n>`, cover: a file
      of several sections with and without a condition, read back as sections and items; each
      problem in AC-2, alone and together; the same item number in two sections, accepted; a file
      present at a branch's head but not on `main`, reported missing.
- [x] **AC-6** — The `**Planned (ST-20)**` marker in `docs/agent-workflow-design.md` loses
      `ST-20`, and the passage is corrected wherever what was built differs.

## Out of scope

- Giving the rules to the reviewer, the verdict format, and converting steward's own `REVIEW.md`:
  ST-21.
- A command that runs the parser for a project's own CI: proposed by the planning session on
  2026-10-11 and not decided (`docs/agent-workflow-design.md`, "Open questions", D7).
- Judging whether a section applies, which is the reviewer's.
- What the example rules file contains (left for later by the owner).

## Constraints

- Node, ESM, no new runtime dependencies.

## Context

- `docs/outline.md`, "Defining steward", "Review", "The checklist's shape": the
  decisions this story builds; the options considered are in `docs/agent-workflow-design.md`,
  "The outline's reasoning".
- `REVIEW.md` today: one numbering across the file, with `## ` sections and `### ` subsections,
  and steward's mechanism mixed in. ST-21 converts it; this module need not parse today's file.

## Open questions

*(none)*
