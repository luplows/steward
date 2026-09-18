# Stories

The refined, dispatchable queue. One file per story; a story is any file
matching `stories/OQ-<n>-<slug>.md` and nothing else in this directory is one,
which is what keeps this README and `_TEMPLATE.md` out of the queue without
needing an exclusion list.

Copy [`_TEMPLATE.md`](_TEMPLATE.md) to start one.

## Three places work lives, and what dispatches from which

| | What it holds | Dispatches? |
|---|---|---|
| [`../Open-Questions.md`](../Open-Questions.md) | The **idea backlog** — unrefined. Prose stories, open questions still open, no acceptance criteria. | **No.** |
| `stories/` | **Refined** stories with enumerated acceptance criteria, ready to hand to a coder. | Yes. |
| `stories/done/` | Completed stories, moved here by the PR that completed them. | — |
| [`../Completed-Questions.md`](../Completed-Questions.md) | The **historical archive**, going back to OQ-1. Grepped by number (`grep -n 'OQ-37' ../Completed-Questions.md`), never read whole. | — |

**Nothing dispatches from `Open-Questions.md`.** It is input to a planning
session, not to the loop. Refining an entry means moving it into a file here
and attaching acceptance criteria to it — which happens when the story is next
picked up, not in a bulk migration. The two queues coexist while it drains, and
`Open-Questions.md` keeps its name because `Completed-Questions.md` and several
workflow comments reference it by that name.

`Completed-Questions.md` is **not** migrated. It stays exactly as it is. Only
stories completed from `stories/` land in `stories/done/`; everything resolved
before this directory existed stays in the archive where its references point.

## Numbering

Unchanged from `Open-Questions.md`: every story has a permanent `OQ-<n>`.
**Numbers are never reused and never renumbered**, so a number always points at
the same story, whether it lives here, in the backlog, or in the archive. A new
story takes the next unused number — check all three places before picking one.

## Frontmatter

```yaml
id: OQ-49                  # matches the filename
title: Read and rank the story queue
tier: workflow             # foundational | dependent | anytime | workflow
depends_on: []             # [OQ-45] — not dispatched until those are in done/
model: sonnet              # per-story escalation; the reviewer is never this model
blocked: null              # null | "reason text"
```

`blocked` is **the only stored state**, because it is the only thing that
cannot be derived. Everything else about where a story stands is read from the
filesystem, git, and GitHub — by two different things, at two different layers.

**From the story files alone.** These are what the queue reader derives. The
first match wins, so the order of the rows is part of the definition:

| Status | Derived from |
|---|---|
| `done` | the file lives in `stories/done/` |
| `blocked` | `blocked` is non-null |
| `draft` | **Open questions** section is non-empty |
| `waiting` | a `depends_on` entry is not yet in `stories/done/` |
| `ready` | none of the above |

**From git and GitHub.** These refine `ready` once work has started, and need
refs and PRs rather than files, so they belong to the dispatcher rather than to
the queue reader:

| Status | Derived from |
|---|---|
| `in-progress` | a `story/OQ-49-*` branch exists |
| `in-review` | a PR is open for that branch |

The split is load-bearing. A story is dispatchable when it reads `ready` from
the files *and* has no branch — but keeping the file-only derivation free of
git is what lets the queue be read, tested and printed without a repository in
any particular state.

No status field, no status commits, nothing to sweep, nothing to drift.

**The review round count is deliberately not a field here.** It is derived by
counting blocking verdicts recorded on the PR. Storing it would mean a commit
per round, on a file that lives on `main` while the work lives on a branch.

**Ordering** is by `tier`, then lowest id first. Deterministic, needs no
ordering file, and cannot starve an old story. Re-prioritising is a one-field
edit.

## The readiness test

Review is drift detection — *does this diff do what the story said, all of what
it said, and nothing it didn't?* So the reviewer can only catch drift from what
was **written down**. Anything left unspecified is not drift; it is
unspecified, and the coder's choice on it stands unreviewed permanently.

The consequence is easy to miss: **a vague story does not produce a weak
review, it produces a review that cannot fail.** The gate silently stops
working and the pipeline still shows green.

> **Could a reviewer, seeing only this story and the diff, tell whether the
> diff conforms?**

If no, the story is not ready. That question is checkable while writing, which
"is this story good?" is not.

## Acceptance criteria and tests

AC ids appear in test names directly, so that what was asked for and what was
verified can be matched mechanically:

```js
test('OQ-49/AC-4: ordering is by tier, then lowest id first', ...)
```

Naming a test after an AC does not satisfy it — `REVIEW.md` item 17 exists
precisely to catch a test named `OQ-49/AC-3` that does not exercise AC-3.

## Lifecycle

1. A planning session writes the story here, or refines a backlog entry into
   one. **Open questions** must be empty before it can be dispatched.
2. A coder branches `story/OQ-49-<slug>`, implements, and opens a PR.
3. The PR **moves the story file to `stories/done/`** — `REVIEW.md` item 19.
   Completion is a `git mv` inside the story's own PR, visible in the diff and
   checkable by the reviewer, rather than a cut-and-paste into an 82 KB
   archive.
4. If the story turns out to be wrong rather than the code, `blocked:` is set
   with the reason and it goes back to a planning session.

`git log stories/OQ-49-*.md` is that story's refinement trail.
