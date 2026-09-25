---
id: OQ-68
title: Wrap the GitHub operations the loop needs in one tested module
tier: next
kind: workflow
depends_on: []
model: sonnet
blocked: null
---

## Intent

As the dispatcher, I need one tested place that performs every GitHub operation
the loop depends on, so that posting a verdict or opening a pull request is a
function with a known contract rather than a command line retyped per round.

## Acceptance criteria

- [x] **AC-1** — `scripts/dispatch/github.mjs` exposes the operations the loop
      actually performs, and no others: create a pull request from a title, body
      and draft flag; replace an existing pull request's title and body; post a
      comment; read a pull request's state (head SHA, draft, labels,
      mergeability); read a pull request's labels; and list a pull request's
      comments. Each is an exported function. **It posts no commit status** —
      see AC-3.
- [x] **AC-2** — Every function's request construction is a pure exported
      function, tested without network access. Requests go over `fetch` with the
      token read once from `gh auth token`, so the single place that performs I/O
      is injectable and tests assert what *would* be sent rather than mocking a
      subprocess. `gh` solves authentication and is used for that alone;
      reimplementing token resolution is its own risk, and shelling out per call
      would put the request construction back outside the tests. This is the
      property the migration plan's "why node, not bash" rationale rests on, so
      it is an acceptance criterion rather than a style note.
- [x] **AC-3** — **Nothing in this module writes the `review/agent` commit
      status, and a test asserts no such request is constructible.**
      `.github/workflows/review-gate.yml` already owns that: it sets `pending` on
      `pull_request` open/synchronize/reopen, and on an `issue_comment` it reads
      the `<!-- agent-review … -->` marker and derives `success` or `failure`
      from the verdict. This module's output is the **marker comment**; the
      status follows from it. A second writer on the same status context would
      race the workflow for no benefit.
- [x] **AC-3b** — Composing a marker comment produces exactly one
      `<!-- agent-review head=<full-40-char-sha> verdict=<v> -->` line, with the
      full 40-character SHA and one of `pass`, `pass-with-observations` or
      `block`. A `null` verdict composes **no** comment and is not an error:
      `REVIEW.md` is explicit that a reviewer not in a position to review leaves
      the PR pending, and the workflow leaves the status alone when it finds no
      marker. A test covers `null`, and one asserts a composed comment is
      accepted by the same pattern `review-gate.yml` matches.
- [x] **AC-4** — `verdict=fail` is accepted when *reading* a marker comment, as
      the deprecated spelling of `block`, and is never produced when writing
      one. `REVIEW.md` keeps it only because an unrecognised marker is ignored,
      which would leave a PR pending forever behind a valid-looking verdict.
- [x] **AC-5** — Reading a pull request's comments returns the parsed
      `<!-- agent-review head=<sha> verdict=<v> -->` markers, each with its head
      SHA and verdict, in order. The module parses them and does not count,
      compare or interpret them: the round count belongs to the loop (OQ-48),
      and keeping the parse here is what lets the count be tested against
      fixtures.
- [x] **AC-6** — A comment's verdict is read by the gate's own rule, so the
      module never reports a verdict the gate did not apply or withholds one it
      did. A marker counts only if it is **well-formed** by the pattern
      `review-gate.yml` greps for, line by line: on one line, a full
      40-character hex head, and a verdict of `pass`, `pass-with-observations`,
      `block` or `fail`. When a comment carries more than one well-formed
      marker, **the last one wins**, as `REVIEW.md` states. Marker-like text
      that is not well-formed is reported alongside, never skipped silently,
      but it neither prevents nor replaces the verdict of a well-formed marker.
      A comment with no well-formed marker has no verdict. It is reported as
      malformed if it holds marker-like text, and as absent otherwise. A test
      covers a comment that quotes a malformed marker before a real one, and
      asserts the real one's verdict.
      *(Revised 2026-09-24 by the owner, during #133's review. It previously
      read: "A comment with two markers, or a marker whose verdict is
      unrecognised, is a classified result and not silently the last one."
      Round 2's parser followed that literally, and reported no verdict for a
      real review comment on #133 that the gate had passed. Unticked by the
      runner until delivered.)*
- [x] **AC-7** — No function in this module spawns a session, renders a prompt,
      reads a story, or decides anything about the loop's progress, and a test
      asserts the module surface. `spawn.mjs`, `invocation.mjs` and
      `dispatch.mjs` own those.

## Out of scope

- **Triggering `land-approved.yml`.** Dispatching that workflow is the owner's,
  not any agent session's or script's — `CLAUDE.md` says so in as many words,
  and the reason is that a dispatcher which can trigger the sweep can merge the
  PR it just produced. This module must not expose a workflow-dispatch call at
  all, so that no later story can reach for one casually.
- **Posting the `review/agent` commit status.** `review-gate.yml` derives it from
  the marker comment and has done since OQ-42. AC-3 makes that a tested
  prohibition rather than an omission.
- **Deciding what a verdict means**, counting rounds, or applying the retry
  bound. That is OQ-48. This module does not apply the `review-blocked` label
  either — OQ-48 settles that in `review-gate.yml` — though it does read labels,
  because the loop needs to see one.
- **Branch and worktree creation.** Local git is OQ-70's.
- **Deleting the head branch after a merge.** That belongs to the sweep, which
  does not currently do it. OQ-52 makes it do so.

## Constraints

- Node, ESM, no new runtime dependencies.
- The `review/agent` context string must stay exactly that. It is named in
  `land-approved.yml`, `REVIEW.md`, both prompts and the branch protection
  configuration; a rename here silently stops the gate mattering.

## Context

**The posted status is already known to satisfy branch protection**, which the
migration plan lists as a thing to verify before anything depends on it. During
OQ-51's hand-run, `review/agent` was posted to
[#117](https://github.com/luplows/tower-workshop-paths/pull/117) at four head
SHAs; the pull request moved from `mergeStateStatus: BLOCKED` to `CLEAN` when it
was set to `success`, and back to blocked on `failure`. That step of the plan is
done, and this story inherits the result rather than re-establishing it.

**AC-3 exists because that hand-run posted every status twice without noticing.**
The status history on #117's final head reads:

```
23:35:34  success  creator=github-actions[bot]  Agent review passed with observations
23:35:24  success  creator=luplows              pass-with-observations (4 observations…)
23:28:14  pending  creator=luplows              Agent review in progress (round 4)
23:26:38  pending  creator=github-actions[bot]  Awaiting agent review
```

Every manual post was followed ten seconds later by `review-gate.yml` setting the
same context off the same marker comment, and the `pending` posts duplicated what
the workflow had already done on PR open. The hand-run's habits are not the
contract — the workflow's header states the intended split plainly: *"The reviewer
agent supplies judgement and posts a marker comment; this workflow supplies
enforcement by setting a commit status that branch protection can require."*
Writing statuses from here would be a dispatcher reimplementing a gate that
already works, and would put the dispatcher on both sides of it.

**The operation list above is what the hand-run actually performed**, four times
each, rather than a guess at what a dispatcher might want. Two of them are easy
to overlook and are in AC-1 because of it:

- **Replacing a PR body, not appending to it.** Each retry round emits a fresh
  `## PR body` describing the whole change, so the body is overwritten. A
  dispatcher that appends produces a description that reads as a changelog of
  its own rounds.
- **Posting comments the reviewer and coder cannot post themselves.** The
  verdict, and the coder's `## Response to review`, both reach the PR only
  because the runner relays them. `REVIEW.md` calls this out: the party with the
  judgement is not the party with the credential.

- `REVIEW.md`, "Recording a verdict" and "The three verdicts" — the marker
  format AC-5 parses and the mapping AC-3 implements
- `.github/workflows/land-approved.yml` — what reads the `review/agent`
  status that `review-gate.yml` derives from this module's marker comment,
  and the `review-blocked` label that AC-1's label functions read
- `scripts/dispatch/queue.mjs` and its tests — the house style, and the
  fail-loudly-on-malformed stance AC-6 follows
- `scripts/dispatch/coder-env.mjs` — the pure-functions-behind-a-thin-caller
  shape AC-2 requires
- `docs/migration-plan.md`, "Order within Phase 1" step 2 — this story's scope

## Open questions

*(none)*

<!--
Two were resolved on 2026-09-19 before dispatch, and are recorded above rather
than here:

- **Which credential.** There is one credential in this project — the owner's
  `repo`-scoped token — and the dispatcher is a trusted user of it. The design
  doc and `coder.md` both claimed a third, separately-scoped credential with
  "pull-request write but neither commit-status nor workflow-dispatch"; that was
  never true and could not be, since a dispatcher has to record verdicts. Both
  are corrected in this PR. What keeps the dispatcher off both sides of the gate
  is that it does not decide the verdict, and that `review-gate.yml` derives the
  status from its comment — which is AC-3, not a token scope.
- **`gh` or `fetch`.** `fetch`, with the token read once from `gh auth token`:
  AC-2. Keeps `gh`'s auth, keeps request construction inside the tests.
-->

