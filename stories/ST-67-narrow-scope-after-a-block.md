---
id: ST-67
title: Stop blocking on a case a story excludes, and let its pull request record one after a block
tier: next
kind: workflow
depends_on: []
model: null
blocked: null
---

## Intent

As a member of the crew, I want a review not to block on a case its story excludes, and a story's
own pull request able to record that a case a review found is excluded, with a draft story for it
when it should be done later, so that the reviewer can see its finding was not ignored, without a
separate pull request to `main` and a merge first.

## Acceptance criteria

- [ ] **AC-1** — **Containment allows an added exclusion.** `checkStoryContainment`
      (`scripts/dispatch/story-containment.mjs`) accepts a story's own pull request adding lines to
      that story's `## Out of scope` section, in the form AC-2 gives. It still fails a line added in
      any other section, and a change to or removal of any line already there. Tests cover each, for
      a story moved into `stories/done/` and for one not moved.
- [ ] **AC-2** — **Each added line says whose decision it is and what follows.** The form is
      `- **After review:** <the case> (crew, YYYY-MM-DD). Follow-up: <story id, or none>.`
      Containment fails an added line in any other form, and one naming a story id that is neither
      at the merge base nor added by the pull request. Tests cover each.
- [ ] **AC-3** — **Any story's pull request may add drafts.** A pull request that moves its own
      story may add stories directly under `stories/` on the conditions `checkAddedDraft` already
      defines, whatever that story's `kind`. A test shows a `kind: workflow` story's pull request
      adding a draft, and existing `checkAddedDraft` tests keep their expectations.
- [ ] **AC-4** — **A case the unit excludes does not block.** `.claude/prompts/reviewer.md` says that
      a finding about how the diff behaves in a case the unit's **Out of scope** names is an
      `observation`, whatever item it would otherwise fail, unless the diff exposes a credential,
      which is a `block`. Building something the unit excluded still blocks.
- [ ] **AC-4a** — **The reviewer honours an added line and reports it.** The same prompt says that a
      line in AC-2's form, added by the pull request's diff, counts as part of the unit's **Out of
      scope**, and that each such line is itself reported with severity `observation`, so that the
      crew sees it in the verdict. It also says that a line excluding everything an acceptance
      criterion asks for, rather than a case of it, is a `block`. The unit is still read from `main`.
- [ ] **AC-5** — **It is the crew's decision.** `.claude/prompts/coder.md` says a coder does not add
      such a line, and reports the case instead. `docs/planning-session.md` says the planning session
      adds one only once the crew has decided, with the draft follow-up when the crew wants the case
      done later.
- [ ] **AC-5a** — **A coder stops at a promise it cannot keep.** `.claude/prompts/coder.md`, "When you
      cannot proceed", says that the section's route applies when an acceptance criterion's promise
      cannot be kept as written: the coder does not build something close to it and tick it, does not
      reword it, and says what the promise needs and why it cannot be met.
- [ ] **AC-6** — The implementing pull request resolves this story's **Planned (ST-67)** marker, and
      corrects `REVIEW.md`, "Conformance to the unit", item 3, and the design record's statements of
      what containment allows. It changes nothing else under `stories/`: `stories/README.md` already
      leaves what a story's own pull request may add to `checkStoryContainment`.

## Out of scope

The threat model is an honest crew and honest sessions, one pull request at a time. Outside it, and
not to be guarded against, for now:

- Proving mechanically that the crew made the decision a line names. A line written against AC-5
  would pass containment, and the verdict's observation is how the crew sees it.
- Rewording or removing an acceptance criterion, or any other edit to a story from its own pull
  request.
- Reading the unit from anywhere but `main`.
- Two pull requests open at once adding drafts with the same new id.
- A pull request that implements no story, which containment does not restrict, and a pull request
  into a release branch, which changes nothing under `stories/`.

## Constraints

- **Threat model:** as under Out of scope.
- Node 24, ESM, no new runtime dependencies. No test writes to GitHub, starts a model, or touches the
  real `~/.steward/`.

## Context

- Crew decision, 2026-11-03, after #111's reviews: `docs/agent-workflow-design.md`, Part 3, "Decided
  so far", "A case a story excludes does not block". On #111, narrowing the story would have taken a
  separate story pull request and a merge of `main`, which is why a fix was chosen instead.
- `checkOwnFile` and `isAllowedEdit` in `scripts/dispatch/story-containment.mjs` reject added lines
  today. `checkAddedDraft` is the conditions AC-3 reuses, gated today on `kind: spike` (ST-30).
- `.claude/prompts/reviewer.md`, under "The unit, as it stands on `main`:": why the unit is not read
  from the branch, and that a change to it is in the diff for the reviewer to judge.
- `.claude/prompts/coder.md`: a coder spawned by ATC cannot write under `.claude/prompts/`, and puts
  a prompt edit in its pull request's body as that file says.
- Suggested size: small.

## Open questions

*(none)*
