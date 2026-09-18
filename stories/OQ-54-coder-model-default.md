---
id: OQ-54
title: Resolve the coder model from a single declared default
tier: next
kind: workflow
depends_on: [OQ-61]
model: sonnet
blocked: null
---

## Intent

As the person maintaining the story queue, I want `model: null` to mean "use the
declared default", so that a story that made no deliberate model choice is
distinguishable from one that did, and so that changing the project's default coder
model is a one-line edit rather than an edit to every story file.

## Acceptance criteria

- [ ] **AC-1** — One committed file declares the default coder model and the set of
      permitted model names. No model name is hardcoded anywhere else under
      `scripts/`. A test changes the declared default and asserts the resolver
      follows it, proving the value is read rather than duplicated as a literal.
- [ ] **AC-2** — `resolveModel(story)` returns the story's `model` when it is a
      permitted name, and the declared default when it is `null`. Any other value
      — an unpermitted name, an empty string, a non-string — throws, naming the
      offending value. It is never passed through to the CLI unchecked.
- [ ] **AC-3** — The story schema lint reads the permitted set from the same file
      as the resolver, not a second copy, and rejects a `model` that is neither
      `null` nor a member of that set. This replaces the presence-only check the
      lint ships with today.
- [ ] **AC-4** — `stories/_TEMPLATE.md` carries `model: null`, and the story
      schema in `docs/agent-workflow-design.md` is updated to match. A story written
      from the template with no edits resolves to the default and passes the lint.

## Out of scope

- **Spawn-time wiring.** This story ships `resolveModel` and its tests; the call
  site lands with `spawn.mjs` in Phase 1 step 3, which must call the resolver
  rather than reading the frontmatter field directly. Sequenced this way on
  purpose: the resolver exists before any story can legally hold `model: null`,
  so there is no window where the lint accepts a value the dispatcher cannot
  resolve.
- **The reviewer's model.** It stays fixed at opus and is not read from story
  frontmatter — see Constraints.
- A per-tier default. One default for all coder spawns; a story that needs
  something else names it explicitly.
- Retroactively rewriting existing stories to `model: null`. They resolve
  correctly as they are; convert on next touch.
- `--effort` and `--max-budget-usd`. Same shape of problem, separate story.

## Constraints

- The declared default and permitted set live in `scripts/dispatch/models.mjs` as
  data, not as branches in code. AC-1 is checkable only if the file is named.
- Node, ESM, no new runtime dependencies.
- **The reviewer model must not become per-story configurable.** The design
  requires the reviewer to run on a model that is never the coder's, and a story
  that could name the reviewer's model could defeat that. `resolveModel` covers
  coder spawns only.

## Context

- `stories/OQ-61-story-schema-lint.md` — the lint AC-3 tightens. Its AC-2
  constrains `id`, `tier`, `depends_on` and `blocked` by value but requires only
  that `model` be present, which is the hole this closes.
- `docs/agent-workflow-design.md` — the model allocation table (sonnet baseline,
  per-story override) and the invocation sketch's `--model "$STORY_MODEL"`.
- `docs/migration-plan.md`, Phase 1 step 3 — `spawn.mjs`, the future caller.

## Open questions

*(none)*
