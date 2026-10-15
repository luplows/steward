---
id: ST-30
title: Let a spike's own pull request add the stories it recommends, as drafts
tier: next
kind: workflow
depends_on: []
model: sonnet
blocked: null
---

## Intent

As a member of the crew, I want a spike's own pull request to add the stories its findings
recommend, as drafts, so that the stories are written from the findings in the pull request that
reports them, and not in a planning-session pull request that has to land first. A story marks
itself a spike with `kind: spike`. The drafts it adds cannot be taken by a coder until the
planning session and the crew refine them.

## Acceptance criteria

- [ ] **AC-1** — `KINDS` in `scripts/lint-stories.mjs` gains `spike`. A story with `kind: spike`
      lints with no violation, and a `kind` outside `product`, `workflow` and `spike` is still a
      blocking violation.
- [ ] **AC-2** — In `scripts/dispatch/story-containment.mjs`, when the pull request moves its own
      story into `stories/done/` (`resolveStory`'s `moved`), and that story's frontmatter has
      `kind: spike` as its file reads at the merge base, a file the pull request adds directly
      under `stories/` is not a violation when all of these hold at the head:
      - its name matches the story filename pattern built from `storyPrefix`;
      - it parses as a story (`buildStory`, `scripts/dispatch/queue.mjs`), and `deriveStatus`
        gives it `draft`;
      - its id is not used by any file in `stories/`, `stories/done/` or `stories/retired/` at the
        merge base, nor by another file the pull request adds.

      An added file that fails one of these is a violation, and its message says which.
- [ ] **AC-3** — Nothing else changes. A spike's own story file may still change only by its move,
      its ticks and its `blocked:` line. Any change to a story that exists at the merge base, a
      deletion, and a file added in `stories/done/` or `stories/retired/` (other than the spike's
      own move) are still violations. A pull request whose own story is not `kind: spike` at the
      merge base still may not add a story, a draft included.
- [ ] **AC-4** — Tests in `scripts/dispatch/story-containment.test.mjs`, each named after the AC it
      covers (`ST-30/AC-<n>`), with the pull request moving its own story to `stories/done/`:
      - a `kind: spike` story's pull request adding two drafts passes;
      - the same adding a story whose Open questions holds only a placeholder fails;
      - the same adding a story with `blocked:` set fails;
      - the same adding a story whose id is in `stories/done/` at the merge base fails;
      - the same adding two files with one id fails;
      - the same changing a story that exists at the merge base fails;
      - a `kind: workflow` story's pull request adding a draft fails.

      A test in `scripts/lint-stories.test.mjs` covers AC-1. The existing `OQ-82/AC-<n>` tests
      pass unchanged.
- [ ] **AC-5** — `REVIEW.md`, "Conformance to the unit", item 3, says that a spike's own pull
      request may also add new stories as drafts, pointing at `story-containment.mjs` for the
      conditions rather than restating them. "Changes to stories" applies to the stories a
      spike's pull request adds: its `Applies when:` line says so.
- [ ] **AC-6** — `docs/agent-workflow-design.md` describes what was built: "What CI runs", where it
      says what story containment fails, and "Kind is for people, not ATC", which says the
      ordering never reads `kind`, this repository's story tooling may, and `kind: spike` marks a
      spike. The format block's `kind:` comment lists `spike`. Every **Planned (ST-30)** marker
      loses `ST-30`, and each passage is corrected wherever what was built differs.

## Out of scope

- `stories/README.md` and `stories/_TEMPLATE.md`. Containment refuses any change a story's own
  pull request makes to a file under `stories/` that is not its own story, these two included. The
  planning session changes them in its next pull request once this story has landed, the one that
  gives ST-6 `kind: spike`.
- Changing any existing story's `kind`, ST-6's included. That is the planning session's.
- Letting the queue's ordering, or anything in ATC other than `story-containment.mjs`, read
  `kind`.
- Moving `resolveStory` out of `review.mjs`. That is ST-22's.
- Spikes in other projects. Steward does not parse or lint a project's units (`docs/outline.md`,
  "Review"), and story containment is this repository's own convention
  (`docs/agent-workflow-design.md`, Part 3, the revision of 2026-10-10).
- Checking the added stories' numbers against branches on `origin`. That stays the reviewer's
  (`REVIEW.md`, "Changes to stories", item 1).

## Constraints

- Node, ESM, no new runtime dependencies.

## Context

- **Decided on 2026-10-15 by the owner, with the planning session** (design doc, Part 3, "Decided
  so far"). The problem came up on #28, which rewrites ST-6 as a spike. Its second `block` was
  for ST-6's AC-1 and AC-5 having the spike's own pull request add the recommended stories and
  edit ST-13 and ST-27, which `story-containment.mjs` refuses for a pull request that moves its
  own story into `stories/done/`.
- `scripts/dispatch/story-containment.mjs`: `checkStoryContainment`, and `checkOtherFile`, which
  today refuses every file under `stories/` other than the pull request's own story, whether it
  is added, changed or deleted.
- `scripts/dispatch/queue.mjs`: `buildStory` and `deriveStatus`. A story is `draft` when its
  `blocked:` is null and its Open questions holds more than a placeholder.
- `scripts/lint-stories.mjs`: `KINDS`, and the check that reports a `kind` outside it.
- `docs/agent-workflow-design.md`, "Kind is for people, not ATC", says nothing in ATC reads
  `kind`. The rule's reason is the ordering, and it is narrowed to that.
- The lint reports a **Planned** marker in `docs/*.md` naming a story in `stories/done/`, and
  accepts one naming a draft. A spike's own pull request may already change the design doc, so it
  re-points its markers onto the drafts it adds without any change here.
- ST-22 also changes `story-containment.mjs`: it moves `resolveStory` there from `review.mjs`.
  Whichever lands second merges the other.

## Open questions

*(none)*
