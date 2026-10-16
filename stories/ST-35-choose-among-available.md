---
id: ST-35
title: Let the crew override a role's choice for a run, and let ATC take another choice when one is out of usage
tier: normal
kind: workflow
depends_on: [ST-34]
model: sonnet
blocked: null
---

## Intent

As a member of the crew, I want to be able to run a role on another of the machine's available
choices when I start a run by hand, and I want ATC to start a session on another available choice
when the one it would use is over its usage limit and another is not, so that work goes on while
one company's or one model's allowance is spent.

**This is a draft.** Its acceptance criteria are a first sketch, to be settled with the Open
questions below.

## Acceptance criteria

- [ ] **AC-1** — Sketch: `review.mjs` and `coder.mjs`'s command lines take an option naming a
      choice in the machine's settings for that run (ST-34), which overrides the unit's and the
      default. A name that is not available is refused before anything starts.
- [ ] **AC-2** — Sketch: before starting a session, ATC reads the usage of the tool its choice
      runs on. When that is over the role's limit, it takes the next available choice, in the
      file's order, whose tool's usage is under the limit, and starts that one; when none is, it
      returns `over-usage` as today (ST-31). A reviewer's choice still differs from the coder's
      model (ST-34's AC-5).
- [ ] **AC-3** — Sketch: the result of a run says which choice ran, and why it was not the
      default.
- [ ] **AC-4** — Every `**Planned (…)**` marker naming ST-35 in `docs/agent-workflow-design.md`
      loses `ST-35`, and each passage is corrected wherever what was built differs.

## Out of scope

- The machine's settings themselves: ST-34.
- A tool other than Claude Code and Codex.

## Constraints

- Node, ESM, no new runtime dependencies.

## Context

- **Decided on 2026-10-15 by the owner** (design doc, Part 3, "Decided so far", "The machine
  steward runs on has settings of its own"): three tiers choose among a role's available choices:
  the unit, the crew for a run it starts by hand, and ATC when one choice is out of usage and
  another is not.
- ST-31 reads Claude Code's usage (`scripts/dispatch/usage.mjs`). Codex's can be read with no
  model call through `codex app-server`'s `account/rateLimits/read` (design doc, "Trials and
  measurements", "Codex as reviewer", 2026-10-15), which ST-32 builds for the reviewer.

## Open questions

1. **Order.** When the crew's override, the unit's choice and the default disagree, is the
   override always final, or does ATC still move off it when its usage is over the limit?
2. **Which choices ATC may move to.** Any available choice, or only those on another tool, or
   only those the unit allows? Does a unit's `model:` mean "this one or none", or "this one if it
   can"?
3. **The coder's escalation.** A story's `model:` today escalates the coder to a stronger model.
   May ATC move a story to a weaker choice when the stronger one is out of usage?
4. **Usage per model.** Claude Code reports per-model weekly rows (`weekly_scoped`), which ST-31
   ignores for now. Does moving between Claude models need them?
