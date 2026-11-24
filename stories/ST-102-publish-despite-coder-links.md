---
id: ST-102
title: Open a coded handoff's pull request when the coder writes its own unit link
tier: fix
kind: product
depends_on: [ST-92]
model: null
blocked: null
---

## Intent

As a crew member who approved a handoff for a project steward installed, I want the coordinator to
open the pull request for the coded work even when the coder's description has its own `Unit:` line
or closing reference, so that coding does not stop on a `Unit:` line that the project's pull
request template or rules ask for, as the template `init` adds to a project without one does,
while the pull request still names only the unit ATC approved.

## Acceptance criteria

- [ ] **AC-1** — `publishHandoff` in `scripts/dispatch/handoff-publish.mjs` no longer refuses a
      coder's body for its `Unit:` lines or closing references (`coder-link-conflict`). Before the
      body is composed, it removes each line of the coder's body that starts `Unit:` (the lines
      `coderLinkLines` finds today), and changes each closing keyword that precedes an issue
      reference in what remains to `Refs`, as `neutralizeClosing` does. The rest of the coder's
      text is kept as before: verification statements, sections and attribution, with its outer
      blank space, line endings and `Coder:` lines handled as today.
- [ ] **AC-2** — The final body is still checked before it is sent, unchanged: `findUnitLink` under
      the project's current `unitLinks` must find exactly ATC's unit, and the only closing
      reference must be ATC's own `Closes #<n>` for an Issue handoff and none for a file. A body
      that fails that check is still not sent.
- [ ] **AC-3** — The result says what was removed or changed, so the crew can see it: a published
      result carries the coder's original lines that were removed or neutralized (empty when
      none), and the pull request's "Handoff provenance" section says how many lines of the
      coder's body ATC removed or neutralized, or that it changed none.
- [ ] **AC-4** — `coder-link-conflict` is removed from the outcomes publishing can return, from
      `README.md`'s list of them and its description of the body, and from every other place
      outside `stories/` that names it (`git grep -n "coder-link-conflict" -- ':!stories'`);
      stories keep the name as their record. `README.md`'s description of the body says that a
      coder's `Unit:` lines are removed and its closing keywords changed to `Refs`.
- [ ] **AC-5** — `.claude/prompts/coder-handoff.md` still tells the coder not to write a `Unit:`
      line or a closing reference, and adds that this holds even where the project's pull request
      template or rules ask for one, since ATC writes that line.
- [ ] **AC-6** — Tests in `scripts/dispatch/handoff-publish.test.mjs` replace those that expect
      `coder-link-conflict`. They cover a file handoff and an Issue handoff whose coder body has a
      `Unit:` line (as the template's first line, and with text after it, as in the two cases in
      Context); a coder's `Closes #<n>` naming the same Issue and another Issue; a closing
      reference inside a quoted command; and a body with none, which is published unchanged. Each
      asserts the final body, the provenance count and the result's removed lines. No real model
      or GitHub mutation runs.
- [ ] **AC-7** — This story's id is taken out of the **Planned** marker in
      `docs/agent-workflow-design.md`, "Approved coding handoffs and sequential execution", and the
      passage is corrected wherever what was built differs.

## Out of scope

- The coder's attribution.
- Reopening a handoff that already stopped with `coder-link-conflict` (H-1 and H-2 on this
  machine). A stopped handoff stays stopped, as now; its branch is opened by hand.
- Any change to how the runway closes an Issue, or to `findUnitLink`.
- Changing the project's own template or `REVIEW.md`, or the template `init` writes.

## Constraints

- ATC alone decides the unit and the closing reference. Nothing of the coder's may add a second
  `Unit:` line or a closing reference to the pull request; AC-2's check is the guard.
- A removed line is removed whole. A neutralized keyword keeps the reference it preceded, so the
  coder's text still says what it referred to.

## Context

- Found in the 0.3.0 release review's coding step, on tower-workshop-paths. Both handoffs it
  coded stopped with `coder-link-conflict` after the branch was pushed, and no pull request was
  opened:
  - H-1 (OQ-139, 2026-11-16, coordinator at the candidate `d90d7e9`): the coder's body had
    `Unit: stories/done/OQ-139-touch-sticky-hover.md`.
  - H-2 (OQ-141, 2026-11-18, coordinator at `b83253c`): the coder's body had
    ``Unit: stories/OQ-141-share-format-stable-ids.md (moved to `stories/done/`, all 7 ACs ticked)``.
  The crew decided on 2026-11-18 that this blocks the release.
- The cause is a conflict of instructions. The handoff prompt says not to write a `Unit:` line
  (`.claude/prompts/coder-handoff.md:87`), but the pull request template `init` adds when a
  project has none starts with one (`templates/pull_request_template.md:1`), and a project's own
  template or rules may require it, as tower-workshop-paths's `REVIEW.md` does ("which starts
  with a `Unit:` line"). The coder followed the project twice.
- ST-92's AC-3 (`stories/done/ST-92-publish-handoff-pr.md`) allowed either: "Sanitize or reject
  coder-supplied conflicting `Unit:` lines and closing-keyword Issue links". It was built as a
  refusal (`coderLinkLines` and the `coder-link-conflict` check in `publishHandoff`). This story
  chooses sanitizing.
- `neutralizeClosing` already exists in `handoff-publish.mjs`, used on ATC's discrepancy reason.
- When this reaches the release branch, the release review runs the coding step again on a new
  unit, and follows the pull request through review and landing.

## Open questions

*(none)*
