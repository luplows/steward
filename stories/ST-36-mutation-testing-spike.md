---
id: ST-36
title: "Spike: find out how a periodic agent could check that the tests test something useful, by mutating the code"
tier: normal
kind: spike
depends_on: []
model: sonnet
blocked: null
---

## Intent

As a member of the crew, I want to know how a periodic agent, not one that runs on every pull
request, could check that the tests would catch a change in what the code does: by making small
changes to the code (mutants), running the tests, and reporting each change no test notices.
Since the reviewer no longer runs tests (ST-33), CI shows only that the tests pass, not that they
test anything useful. A spike's output is findings, and the stories they recommend, added as
drafts in its own pull request.

**This is a draft.** Its acceptance criteria are a first sketch, to be settled with the Open
questions below.

## Acceptance criteria

- [ ] **AC-1** — Sketch: the spike tries at least one way of making mutants of steward's own
      `scripts/` (a mutation-testing tool, or an agent writing the changes), runs the tests against
      them, and records, for one module or more, how many mutants the tests caught and how many
      survived, with the time and cost of the run.
- [ ] **AC-2** — Sketch: the findings say how often such a run should happen, what starts it, what
      it covers each time, and what it reports (an issue per surviving mutant, or one report), and
      compare it with what CI and the reviewer already check.
- [ ] **AC-3** — Sketch: the spike's pull request adds the stories it recommends as drafts, and
      points this story's **Planned** markers at them.

## Out of scope

- Running mutation tests on every pull request (owner, 2026-10-15: not an every-pull-request ask).
- Coverage-percentage tooling, whose absence is deliberate (`AGENTS.md`, "Testing").
- Building the periodic agent: the stories the spike recommends.

## Constraints

- Node, ESM, no new runtime dependencies in steward itself.

## Context

- **Decided on 2026-10-15 by the owner** (design doc, Part 3, "Decided so far", "The reviewer
  runs no checks"): with the tests out of the review, the owner wants to explore a periodic
  mutation-testing agent, to make sure the tests test useful things.
- `REVIEW.md`, "Conformance to the unit", item 2 (fidelity) has the reviewer judge whether a test
  named after an AC exercises it, by reading. A surviving mutant is the same failure, found by
  running.

## Open questions

1. **Tool or agent.** A mutation-testing tool for JavaScript would be a new development
   dependency, which `AGENTS.md`'s testing rules do not forbid but the coverage rule's reasoning
   may bear on. An agent writing mutants needs no dependency but costs model usage. Which does the
   spike try first?
2. **How often, and on what.** On a schedule, after a number of landings, or by hand; on the whole
   of `scripts/`, or on what changed since the last run?
3. **Where its findings go.** As issues, as stories, or as a report the crew reads.
4. **Whose usage it spends**, and under which limit (ST-31, ST-34).
