---
id: ST-22
title: Review against the unit the pull request links, and verify with narrower commands
tier: next
kind: workflow
depends_on: [ST-19, ST-21, ST-26]
model: sonnet
blocked: "Built by hand: changes .claude/prompts/reviewer.md, which a spawned coder session cannot edit (docs/agent-workflow-design.md, A spawned session cannot edit .claude/prompts/)"
---

## Intent

As a member of the crew, I want the reviewer to be given the unit a pull request links, read from
`main`, with a plain statement of what steward found when the link is missing or unreadable, so that
a pull request is judged against the unit as approved, in whatever form the project keeps its units.
I also want the reviewer to check claims with narrower commands rather than rerunning the project's
whole check, which CI already runs as a peer check.

## Acceptance criteria

- [ ] **AC-1** — `review.mjs` finds the unit with ST-19's `findUnitLink`, from the pull request's
      body and the settings' `unitLinks`, and reads it with `readUnit`. `resolveStory` is
      removed, and so are the results `review.mjs` returned for it: `story-not-moved`,
      `story-ambiguous` and its `story-unreadable` (`coder.mjs` and `story.mjs` keep their own
      `story-unreadable`). A
      missing, unreadable, `Unit: none` or several-link case does not stop the review: it is
      reviewed, with ST-19's `describeUnit` note.
- [ ] **AC-2** — `reviewer.md` replaces `{{STORY_ID}}`, `{{STORY_PATH}}` and `{{STORY}}` with
      `{{UNIT_NOTE}}`, the note, and `{{UNIT}}`, the unit's text when one was read and otherwise
      a fixed line saying none was. Both are bounded as injected values are. The prompt tells the
      reviewer that whether a missing or unreadable unit fails the review is the rules' to say,
      and that a pull request with no readable unit is still reviewed against the rules.
- [ ] **AC-3** — `reviewer.md`'s "Verify rather than accept" no longer tells the reviewer to
      rerun the whole suite (today: "If the PR says 240 tests pass, run `npm test`"). It tells it
      to run only the narrower commands that settle a particular claim, such as one test file, a
      search or a diff of one path, and that CI's checks are a peer check the reviewer neither
      reads nor reruns.
- [ ] **AC-3a** — `REVIEW.md`'s "Every pull request" section gains an item, numbered after its
      last: a change to code links the unit it implements, and `Unit: none` is accepted only where
      no unit could exist, such as a pull request that writes the unit itself. The reviewer is
      told the four cases by the note (AC-1); this item is how the rules judge them.
- [ ] **AC-4** — The reviewer's model is `ROLE_DEFAULTS.reviewer.model` when the unit gives no
      model. When the unit is a file with frontmatter naming a `model:`, `chooseReviewerModel`
      still picks a different one, as today.
- [ ] **AC-5** — Tests in `review.test.mjs`: a pull request with each of ST-19's four cases is
      reviewed, and the rendered prompt carries the matching note; a file unit is read from
      `main`, not the head (a file changed on the branch is given as it is on `main`); and the
      removed results are no longer returned.
- [ ] **AC-6** — `docs/agent-workflow-design.md`'s "Reviewer" section, which says the reviewer
      receives the "story file", says it receives the unit the pull request links, read from
      `main`. The `**Planned (ST-22)**` marker loses `ST-22`, and the passage is corrected
      wherever what was built differs.

## Out of scope

- Whether a `Unit:` line is required, and how: left open by the owner.
- The coder's side: `coder.mjs`, `story.mjs` and `loop.mjs` keep their story files, and
  `storyPrefix` stays in the settings. The dispatcher writing the `Unit:` line on a pull request
  it opens for a coder comes with the coder's stories; steward runs no coder until then.
- Removing `npm`, `npx` or `node` from the reviewer's allowlist, or a setting for allowed
  commands (later, by the owner's decision).
- Reading CI results into the prompt: not chosen (`docs/harness-outline.md`, "Land").

## Constraints

- Node, ESM, no new runtime dependencies.

## Context

- `docs/harness-outline.md`, "Defining steward": "Review" (the unit link, read from `main`; the
  reviewer decides on a missing link) and "Land" (the review and CI are peer checks; the reviewer
  runs narrower commands).
- `scripts/dispatch/review.mjs`: `resolveStory`, `chooseReviewerModel` (which reads the story's
  `model:`), and the `story-not-moved`, `story-ambiguous` and `story-unreadable` results.
  `story.mjs` reviews its own pull requests through `reviewPullRequest`, so the results it
  handles from a review need checking too.
- `.claude/prompts/reviewer.md`: the `{{STORY…}}` placeholders, and "Verify rather than accept"
  (line 219 on 2026-10-11).
- ST-26 adds the `Unit:` line to the pull request template, so steward's own pull requests carry
  one before this story makes the review depend on it.
- A spawned coder session cannot edit `.claude/prompts/`; this story is built by hand.

## Open questions

*(none)*
