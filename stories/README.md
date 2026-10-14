# Stories

Steward's own units of work, one file per story. A story is any file matching
`stories/ST-<n>-<slug>.md`, and nothing else in this directory is one, which is
what keeps this README and `_TEMPLATE.md` out of the queue without needing an
exclusion list. The prefix is `steward.config.json`'s `storyPrefix`, which the
queue reader builds its filename pattern from (`scripts/dispatch/queue.mjs`).

Copy [`_TEMPLATE.md`](_TEMPLATE.md) to start one.

## Where stories live

| | What it holds | Can a coder take it? |
|---|---|---|
| `stories/` | Every story not yet built: refined ones with enumerated acceptance criteria, and drafts, whose Open questions still hold something. | A ready one, yes. |
| `stories/done/` | Completed stories, moved here by the pull request that completed them. | — |
| `stories/retired/` | Stories dropped without being built, moved here by a planning-session pull request with the date and reason in their Context. | **No.** |

**A draft story is the backlog.** An idea not yet refined is written as a story
with its questions under Open questions, which keeps it `draft` until they are
answered. There is no separate backlog file. Open questions about steward's
design, rather than about one story, are in `docs/agent-workflow-design.md`.

## Numbering

Every story has a permanent `ST-<n>`. **Numbers are never reused and never
renumbered**, so a number always points at the same story, wherever it lives. A
new story takes the next unused number: check `stories/`, `stories/done/`,
`stories/retired/` and every branch on `origin` (`git ls-remote --heads
origin`), since a story still being written is on its branch and not yet on
`main`.

An `OQ-<n>` is a tower-workshop-paths story, which steward came from. Some of
steward's stories began there, and each says so in its Context.

## Frontmatter

```yaml
id: ST-49                  # matches the filename
title: Read and rank the story queue
tier: next                 # fix | next | normal | later — priority, nothing else
kind: workflow             # product | workflow — for reading; never read by ATC
depends_on: []             # [ST-45] — not taken until those are in done/
model: sonnet              # per-story escalation; the reviewer is never this model
blocked: null              # null | "reason text"
```

**`tier` is priority and nothing else**, highest first:

| Tier | Means |
|---|---|
| `fix` | A defect or regression. Absolute priority. |
| `next` | Deliberately prioritised ahead of the default. |
| `normal` | The default. Most stories. |
| `later` | Refined and ready to take, but deliberately deferred. |

**Dependencies are not a tier.** `depends_on` handles them mechanically and at the
right granularity. An earlier vocabulary — `foundational | dependent | anytime |
workflow` — mixed three axes: position in the dependency graph, absence of a
dependency, and subject matter. A story can be both workflow and foundational, so
forcing one value made the sort order arbitrary, and two of the four duplicated
`depends_on` while being able to contradict it.

**`kind` is for people, not ATC.** It groups stories for reading —
release-review assembly, or answering "how much of this batch was tooling."
**Nothing in ATC reads it, and nothing in the ordering may.** That is
stated as a rule because a field that exists eventually attracts a sort: ordering
by `kind` should be a visible violation of something written down rather than a
natural-looking extension. Adding a value is cheap for the same reason.

## Status

`blocked` is **the only stored state**, because it is the only thing that
cannot be derived. A story with `blocked:` set is **grounded**: the field keeps
the name `blocked`, and the queue prints the status as `blocked`. Everything
else about where a story stands is read from the filesystem, git, and GitHub —
by two different things, at two different layers.

A story only the crew can carry out, by hand, keeps `blocked:` set with a reason
saying so, so that no coder takes it. A member of the crew starts a session for
it, and that session's pull request moves the story to `stories/done/` like any
other.

**From the story files alone.** These are what the queue reader derives. The
first match wins, so the order of the rows is part of the definition:

| Status | Derived from |
|---|---|
| `done` | the file lives in `stories/done/` |
| `blocked` (grounded) | `blocked` is non-null |
| `draft` | **Open questions** holds content beyond the empty marker — see below |
| `waiting` | a `depends_on` entry is not yet in `stories/done/` |
| `ready` | none of the above |

**What "empty" means**, because two readings of that word give opposite answers
for the same file. A section is empty when its content — ignoring HTML comments
and whitespace — is a single italic parenthetical placeholder alone on its
line: `*(none)*`, `*(must be empty to dispatch)*`, or any other `*(...)*`.
Which placeholder text was used carries no meaning beyond "considered, nothing
outstanding"; both forms are treated identically (OQ-61/AC-6).

A section holding nothing at all is **malformed**, not empty. It cannot be told
apart from one nobody has filled in, and a story is never silently defaulted —
the same stance the schema takes on missing frontmatter. Writing a placeholder
is the act of saying *"considered, nothing outstanding"*, and that act is what
the status is derived from. Anything else in the section, including a single
line alongside the placeholder, makes the story `draft`.

**From git and GitHub.** These refine `ready` once work has started, and need
refs and pull requests rather than files, so they belong to ATC rather than to
the queue reader:

| Status | Derived from |
|---|---|
| `in-progress` | a `story/ST-49-*` branch exists |
| `in-review` | a pull request is open for that branch |

The split is load-bearing. A coder may take a story when it reads `ready` from
the files *and* has no branch — but keeping the file-only derivation free of
git is what lets the queue be read, tested and printed without a repository in
any particular state.

No status field, no status commits, nothing to tidy, nothing to drift.

**The review round count is deliberately not a field here.** It is derived by
counting blocking verdicts recorded on the pull request. Storing it would mean a
commit per round, on a file that lives on `main` while the work lives on a
branch.

**Ordering** is by `tier`, then lowest id first. Deterministic, needs no ordering
file, and re-prioritising is a one-field edit.

That does not starve a story *within* a tier, but a lower tier starves
indefinitely while higher-tier work keeps arriving. The design calls for a
starvation valve; until one exists, a story that has waited too long is promoted
by editing its `tier`.

## The readiness test

Review is drift detection — *does this diff do what the story said, all of what
it said, and nothing it didn't?* So the reviewer can only catch drift from what
was **written down**. Anything left unspecified is not drift; it is
unspecified, and the coder's choice on it stands unreviewed permanently.

The consequence is easy to miss: **a vague story does not produce a weak
review, it produces a review that cannot fail.** Review silently stops working
and the checks still show green.

> **Could a reviewer, seeing only this story and the diff, tell whether the
> diff conforms?**

If no, the story is not ready. That question is checkable while writing, which
"is this story good?" is not.

## Acceptance criteria and tests

AC ids appear in test names directly, so that what was asked for and what was
verified can be matched mechanically:

```js
test('ST-49/AC-4: ordering is by tier, then lowest id first', ...)
```

Naming a test after an AC does not satisfy it — `REVIEW.md`, "Conformance to the
unit", exists precisely to catch a test named `ST-49/AC-3` that does not
exercise AC-3.

**The pull request that implements a story ticks each AC it delivered**, in the
story file, as part of that pull request — `- [ ]` becomes `- [x]`. A story is
written with every box unticked, and nothing else ticks them. An AC left
unticked is one the pull request says it did not deliver, and its body says
why.

A tick is the author's claim, not evidence. It shows in the diff, and the
reviewer checks it against `REVIEW.md`, "Conformance to the unit": an AC
delivered but left unticked, or ticked but not genuinely delivered, is a
finding. When a review finds a ticked AC undelivered, the fix commit either
delivers it or unticks it.

**A story whose decision is recorded in the design doc** carries an AC to
resolve its `**Planned (ST-n)**` markers there. The design doc's "Reading this
document" note defines the markers, and the pull request that writes the story
records the decision, marked, so that the goal state reaches `main` when it is
decided.

## Lifecycle

1. The planning session writes the story here, with the crew. **Open
   questions** must be empty before a coder can take it.
2. A coder takes it: ATC claims the branch `story/ST-49-<slug>`, the coder
   implements and commits, and ATC pushes the work and opens the pull request.
3. The pull request **ticks each AC it delivered** — see above — and **moves the
   story file to `stories/done/`** (`REVIEW.md`, "Conformance to the unit").
   Completion is a `git mv` inside the story's own pull request, visible in the
   diff and checkable by the reviewer.
4. If the story turns out to be wrong rather than the code, `blocked:` is set
   with the reason and it goes back to the planning session.
5. A story the crew decides not to build is **retired**: a planning-session pull
   request moves it to `stories/retired/` with a `git mv`, adds the date and
   reason to its Context, and corrects whatever else cites it. Neither the queue
   reader nor the story lint reads that directory, so a retired story is never
   taken, and a `**Planned**` marker naming one is reported as naming no story
   file. A `depends_on` naming one would leave that story `waiting` for good, so
   the retiring pull request removes it. Reviving one is a `git mv` back into
   `stories/`.

`git log stories/ST-49-*.md` is that story's refinement trail.
