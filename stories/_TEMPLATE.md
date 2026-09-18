---
id: OQ-NN
title: One line, in the imperative or as the capability delivered
tier: anytime              # foundational | dependent | anytime | workflow
depends_on: []             # [OQ-45] — not dispatched until those are in done/
model: sonnet              # per-story escalation; the reviewer is never this model
blocked: null              # null | "reason text" — set by a kickback, cleared by Session A
---

<!--
Copy this file to stories/OQ-NN-short-slug.md and fill it in. The leading
underscore is what keeps this file out of the queue: a story is any file
matching stories/OQ-<n>-<slug>.md, and nothing else in this directory is one.

Before you consider it ready, apply the readiness test from stories/README.md:

  Could a reviewer, seeing only this story and the diff, tell whether the
  diff conforms?

If no, the story is not ready. A vague story does not produce a weak review —
it produces a review that cannot fail, which means the gate silently stops
working while the pipeline still shows green.
-->

## Intent

As a <who>, I want <what>, so that <why>.

One paragraph at most. This is the thing the story is for, not how to build it.

## Acceptance criteria

Each one is independently checkable by someone holding only this file and the
diff. AC ids are referenced in test names — `test('OQ-NN/AC-2: ...')` — so
they must be stable once the story is dispatched.

- [ ] **AC-1** — <observable behaviour, stated so that "is this true?" has a
      yes/no answer>
- [ ] **AC-2** — <...>

## Out of scope

Named exclusions, not an empty gesture. Anything a reasonable implementer might
fold in but should not. Say where it goes instead if it matters.

- <thing> — file separately if it matters.

## Constraints

*(rare — binding implementation decisions that are not negotiable. Empty is
the normal case: if everything here is obvious from the codebase, leave it
empty rather than restating house style.)*

## Context

Pointers, not instructions. Where the relevant code lives, which prior story
decided a thing, which file is the house style to match.

- `path/to/thing` — what it is
- OQ-NN — prior decision, in `Completed-Questions.md`

## Open questions

*(must be empty to dispatch. A non-empty section makes the story `draft`, and
the dispatcher skips it. Anything here is Session A's to resolve — writing it
down and dispatching anyway is how the coder's guess becomes a permanent,
unreviewed decision.)*
