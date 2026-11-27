---
id: ST-103
title: Let the crew dismiss finished entries from the coordinator's status
tier: normal
kind: product
depends_on: []
model: null
blocked: null
---

## Intent

As a crew member reading `steward coordinator status`, I want to dismiss entries I have finished
with, so that the status shows only what still needs me, and not a growing list of old handoffs and
failed reviews whose pull requests were long since landed or settled by hand.

## Acceptance criteria

- [x] **AC-1** — `steward handoff dismiss <id>` dismisses a handoff that is `completed`, `stopped`
      or `interrupted`. It records the time of the dismissal on the handoff, with the same
      locked write the other `handoff` commands use, and says what it dismissed. It changes nothing
      else on the record: status, version, history, stop details and evidence stay as they are.
- [x] **AC-2** — `handoff dismiss` refuses, changing nothing, a handoff that is `pending`, `held`,
      `admitted` or `withdrawn`, one already dismissed, and an unknown ID, each with a reason that
      names the handoff's state. For `pending` and `held` it points to `withdraw`.
- [x] **AC-3** — `steward coordinator status` leaves dismissed handoffs out of its coding lists, in
      text and in `--json`. `steward handoff list` and `steward handoff show <id>` still show a
      dismissed handoff, marked as dismissed with its time.
- [x] **AC-4** — Dismissing a handoff does not release its source: `handoff add`, `reapprove` and
      `withdraw` treat a dismissed handoff as they treat it undismissed, and the coordinator never
      selects it.
- [x] **AC-5** — `steward coordinator dismiss <owner/name> <number> [<head>]` dismisses every
      failed review that `status` lists for that pull request ("Not reviewed again automatically"),
      or only the one of `<head>`, recording each with its time in a file of the crew's own,
      `dismissed-reviews.json`, which the coordinator never writes; it never writes `reviews.json`.
      The same write drops each earlier dismissal `status` would no longer list. It says how many it
      dismissed, and refuses, changing nothing, when there is none. It reads only the local records:
      no GitHub read or write.
- [x] **AC-6** — `status` leaves dismissed failed reviews out of that list, in text and in `--json`,
      and, with no dismissal, a failed head of a pull request a later head of which has started
      review since. A dismissal changes nothing about what is reviewed: a new head of that pull
      request is reviewed as now, and a head whose review failed is still not reviewed again
      automatically.
- [x] **AC-7** — `README.md` documents both commands where it describes `handoff` and the
      coordinator's `status`, and `handoff`'s and `coordinator`'s usage text lists them.
- [x] **AC-8** — Tests, in the existing test files of `handoff.mjs` and `coordinator.mjs`, cover:
      dismissing a completed and a stopped handoff, and its absence from `status` and presence in
      `list` and `show`; each refusal in AC-2; AC-4's `add` refusal for a dismissed stopped
      handoff's source; dismissing a pull request's failed reviews, and one head's, and their absence
      from `status`, with `reviews.json` unchanged; a failed head left out once a later head has
      started review; an earlier dismissal dropped once `status` would no longer list it; and the
      refusal when none is listed. No GitHub call runs.
- [x] **AC-9** — This story's id is taken out of the **Planned** marker in
      `docs/agent-workflow-design.md`, "Approved coding handoffs and sequential execution", and the
      passage is corrected wherever what was built differs.

## Out of scope

- Releasing a stopped or interrupted handoff's source for a new approval, or recoding it. The
  design leaves that to the crew to arrange, and this story does not change it.
- Deleting the coordinator's records. A dismissed handoff stays in `handoffs.json`, and no entry
  leaves `reviews.json`. Only the crew's own dismissals file drops entries, as AC-5 says.
- Dismissing anything automatically, for example when a pull request is merged or closed. AC-6's
  later head is not a dismissal: it is read from `reviews.json` alone, and nothing is recorded.
- Undoing a dismissal.

## Constraints

- A dismissal only hides an entry from `status`. It never changes what the coordinator selects,
  admits, reviews or lands.

## Context

- Found in the 0.3.0 release review (crew, 2026-11-25). On that day `steward coordinator status`
  listed five entries that needed nothing more: the failed reviews of luplows/pinpoint #77
  (`cannot-review`, 2026-11-09) and luplows/tower-workshop-paths #297 (`head-moved`), both since
  merged; H-1 and H-2, stopped with `coder-link-conflict`, whose work was opened and landed by hand
  (tower-workshop-paths #288 and #290); and H-3, completed. No command removes any of them: the
  README says no command releases a stopped or interrupted handoff, and `withdraw` takes only a
  pending or held one.
- The failed-review list is built by `failedHeads` in `scripts/dispatch/coordinator.mjs`, from
  `reviews.json`; the coding lists by `codingWork`, from `handoffs.json`, with `codingState` in
  `scripts/dispatch/handoff.mjs`.
- Amended after the review of its first implementation, #193 (crew, 2026-11-26). That
  implementation recorded a review's dismissal on its entry in `reviews.json`, as AC-5 then said,
  which made `dismiss` a second, unlocked writer of the coordinator's file: a review ending between
  dismiss's read and its write would be put back to `running`, and both wrote through the same
  `reviews.json.tmp`. The crew's aim is that `status` lists what needs it, and that a dismissal is
  its note that it has dealt with an entry its own way. So a dismissal is kept in the crew's own
  file, may name one head, and is dropped once `status` would not list its entry anyway, and a
  failed head that a later head has superseded needs no dismissal. `handoffs.json` already takes a
  lock for every writer, so a handoff's dismissal stays on its record.

## Open questions

*(none)*
