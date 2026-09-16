# Review Checklist

The criteria a pull request is reviewed against. Written to be enumerated and
auditable rather than a general instruction to "check the code is good" — when
a review misses something, it should be possible to tell whether the rule was
wrong or the reading was. See `Open-Questions.md` OQ-42 for why this exists and
how the gating around it is meant to work.

## Reading the PR body

Every PR uses [`.github/pull_request_template.md`](.github/pull_request_template.md),
which has three required sections: **What changed**, **Verification**, and
**Docs check**.

**Check the content of each section, not that the heading exists.** A template
auto-populates, so an unfilled one is structurally identical to a filled one.
These do not satisfy the requirement:

- A section left as its HTML comment placeholder, or emptied to a blank.
- `Verification: N/A`, `tests pass`, `all green`, or any claim without the
  command and its actual result.
- `Docs check: none needed` with no statement of what was considered.

A section that restates the PR title in other words is also unfilled.

## Every PR, including docs-only

1. The work is on a feature branch with a pull request; nothing was pushed
   directly to `main`.
2. All three template sections are present and substantively filled, per above.
3. **Docs check** records a real outcome for `README.md`, `Open-Questions.md`
   and `Project-Outline.md` — what changed, or why nothing needed to.
4. If the PR resolves an open question, the story is moved to
   `Completed-Questions.md` in completion order, with its `**Resolved in:**
   [#N]` link.
5. Any new open question uses the next unused OQ number. Numbers are never
   reused or renumbered.
6. Commit granularity: one commit is right for most changes; a PR that both
   regenerates data files and changes logic splits those into separate commits.
7. The diff matches the **What changed** description. No unrelated changes
   riding along.

## PRs that change app code

8. New logic is accompanied by tests — Vitest for unit and component behavior,
   Playwright for real user flows. The buy-order scoring algorithm especially.
9. No test was skipped, disabled, quarantined, weakened, or deleted in order to
   make something pass.
10. If screenshot baselines are added or modified, the change is stated and
    justified in the PR body. Regenerating a baseline is never an acceptable
    silent side-effect of getting CI green — it is the visual form of item 9.
11. No coverage-percentage tooling is added. Its absence is deliberate; see
    `CLAUDE.md`.

## Integrity

These exist because an unsupervised author optimizes for the success criterion,
and the cheapest path to "green" is not always the intended one.

12. The **Verification** section reports real results — actual numbers, taken
    the same way across a before/after comparison — rather than an assertion
    that checks passed.
13. A check that could not be run is stated as such, with the reason, rather
    than quietly omitted from the list.
14. No local workaround is left in the diff. A path, config, or flag patched
    in order to get a check running locally must be reverted before pushing.
15. Scope was not widened beyond the task the PR set out to do.

## For the reviewer: reporting a verdict

The prompt a reviewer session is spawned with lives in
[`.claude/reviewer-prompt.md`](.claude/reviewer-prompt.md). It must be spawned
as its own session, never as a continuation of the one that wrote the PR: the
independence this gate provides comes from context isolation, and a reviewer
told what the change was *meant* to do cannot see that the diff does something
else.


Review is enforced by `.github/workflows/review-gate.yml`, which sets a
`review/agent` commit status. Opening a PR, or pushing to one, sets that status
to pending; it clears only when a reviewer posts a verdict marker. A PR with no
marker stays pending and cannot merge — forgetting to review fails safe.

Post the findings as an ordinary PR comment, naming the `REVIEW.md` item number
each one comes from, and end the comment with exactly one marker line:

```
<!-- agent-review head=<full-40-char-sha> verdict=pass -->
<!-- agent-review head=<full-40-char-sha> verdict=fail -->
```

Four things the workflow enforces, so getting them wrong means the marker is
silently ignored rather than obeyed:

1. **`head` must be the full 40-character SHA of the commit reviewed**, not an
   abbreviation. Get it with
   `gh pr view <N> --repo <owner/repo> --json headRefOid --jq .headRefOid`.
2. **That SHA must still be the PR's head.** A verdict about an earlier commit
   says nothing about the current one, so a stale marker is ignored and the
   status stays pending. Re-review after any new push.
3. **`verdict=pass` only when no applicable item fails.** Anything else is
   `fail`. There is no partial credit and no dismissal mechanism: the only way
   past a `fail` is a commit that addresses it, which resets the gate to pending
   and requires a fresh review.
4. **The comment must come from an account with write access.** Anyone can
   comment on a public repository; a marker from anyone else is ignored.

If a comment contains more than one well-formed marker, the last one wins, so a
correction later in the same comment supersedes an earlier line.

A `fail` verdict also fails the `Review gate` workflow run itself. The commit
status is what blocks the merge; failing the run is what makes the block
*noticeable*, since GitHub's built-in Actions failure notifications only fire on
a failed run. A job reporting success while recording a blocking review would be
silent exactly when someone needs to hear about it.
