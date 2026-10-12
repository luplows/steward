---
id: ST-26
title: Ask for a Unit line in steward's pull request template
tier: next
kind: workflow
depends_on: []
model: sonnet
blocked: null
---

## Intent

As the owner, I want every pull request opened on steward to say which unit it implements, or
`Unit: none`, on a line of its own, so that once the review reads the unit from the link (ST-22)
steward's own pull requests already carry one, and the reviewer need not guess whether a pull
request with no unit meant to have one.

## Acceptance criteria

- [ ] **AC-1** — `.github/pull_request_template.md` starts with a `Unit:` line, before "What
      changed", with a comment saying what it takes: a path to a file in this repository, such as
      a story under `stories/`; `#<n>` for one of this repository's issues; or `none` when the
      pull request implements no unit. The comment says the file is read from `main`, so a story
      the pull request moves into `stories/done/` is named by its path before the move.
- [ ] **AC-2** — `docs/session-a.md`, "Handing it over", says a story's pull request carries
      `Unit: none`, since it writes the unit rather than implementing it, and `CLAUDE.md`'s
      "Branches and pull requests" says every pull request fills the `Unit:` line along with the
      template's three sections.
- [ ] **AC-3** — `REVIEW.md`'s item on the pull request body's sections (item 2 today, or its
      successor after ST-21) is unchanged in substance: the `Unit:` line is not a fourth required
      section, and whether a missing one fails a review is for the rules to say (ST-21, ST-22).
- [ ] **AC-4** — `node scripts/dispatch/cli.mjs lint` and the full suite pass.
- [ ] **AC-5** — The `**Planned (ST-26)**` marker in `docs/agent-workflow-design.md` loses
      `ST-26`, and the passage is corrected wherever what was built differs.

## Out of scope

- Reading the line: ST-19 and ST-22.
- Making the line required by a check: left open by the owner (`docs/harness-outline.md`,
  "Review").
- The dispatcher writing the line on a pull request it opens for a coder: with the coder's
  stories.

## Constraints

*(none)*

## Context

- `docs/harness-outline.md`, "Defining steward", "Review": the `Unit:` line, `Unit: none`, and
  the options left open for requiring it.
- `.github/pull_request_template.md` today: three sections, "What changed", "Verification" and
  "Docs check", each with a comment.

## Open questions

*(none)*
