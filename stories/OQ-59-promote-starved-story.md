---
id: OQ-59
title: Promote a starved story ahead of its tier
tier: normal
kind: workflow
depends_on: [OQ-49]
model: sonnet
blocked: null
mechanisms:
  - story age derived from git history
  - the tier-override promotion rule and its selection record
---

## Intent

As the person keeping the queue, I want a story that has sat untouched for too
long to be picked up regardless of its tier, so that a deliberately deferred
story is deferred rather than abandoned. Tier-then-id ordering starves every
tier below the top one for as long as work keeps arriving above it, and the
stories most likely to be starved are the ones nobody is advocating for.

## Acceptance criteria

- [ ] **AC-1** — A story's age is derived from the last commit that touched its
      file. It is never read from frontmatter and never from filesystem mtime. A
      story with no commit history is treated as age zero, so a story added in
      the working tree is not immediately promoted.
- [ ] **AC-2** — When the longest-untouched **ready** story has been untouched
      for longer than the configured interval, it is selected next regardless of
      tier. Otherwise selection is unchanged: tier, then lowest id. A draft or
      blocked story is never a promotion candidate, because it is not ready.
- [ ] **AC-3** — A ready `fix` story always outranks a promotion. When any ready
      story carries `tier: fix`, the valve does not fire at all.
- [ ] **AC-4** — The valve is self-limiting. A test that promotes a story, moves
      it to `stories/done/`, and selects again gets ordinary tier order back,
      with no promotion state persisted anywhere.
- [ ] **AC-5** — Every selection reports which rule chose the story — ordinary
      ordering or promotion — and a promotion also reports the age that triggered
      it. Returned in the selection result and printed when the queue is run as a
      script.
- [ ] **AC-6** — The interval is configuration, not a literal in the ordering
      code. A test sets it and asserts both sides of the boundary: a story just
      under the interval is not promoted, one just over it is.

## Out of scope

- Spawning anything, worktrees, or any dispatch step beyond selecting the next
  story. Same boundary as OQ-49.
- Changing tier semantics, adding a tier, or making `kind` affect ordering.
- Promoting more than one story, or reordering the whole queue. Selection returns
  one story; the valve changes which one.
- Any promotion that considers `depends_on` or `blocked` reasons beyond the
  readiness test AC-2 already applies.

## Constraints

- Extends the queue module from OQ-49. No new script and no new CI job.
- **Age comes from git history only.** Filesystem mtime is reset by a fresh
  clone, which would make every story look newly touched and silently disable the
  valve on exactly the machine the dispatcher runs on.
- Tests pin the clock. Ordering is deterministic for a given clock and git
  history, but it is **not time-invariant** — which is the one way this differs
  from OQ-49's AC-4, and the reason that AC's wording needs amending rather than
  merely extending.
- Node, ESM, no new runtime dependencies.

## Context

- OQ-49 — `queue.mjs`, the module this extends. Its AC-4 currently states
  ordering as "by tier, then lowest id first; stable across runs" and needs
  amending when this lands. **It is still only prose in `docs/migration-plan.md` and
  has to exist as a story file before this one can dispatch.**
- `docs/agent-workflow-design.md`, *The starvation valve* — the rule this implements
  and the four properties that justify its shape.
- The retry bound in the same document is the precedent for deriving a count from
  durable evidence rather than storing it; age from `git log` is the same move.

## Open questions

*(none)*
