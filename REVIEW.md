# Review Checklist

The criteria a pull request is reviewed against. Written to be enumerated and
auditable rather than a general instruction to "check the code is good" — when
a review misses something, it should be possible to tell whether the rule was
wrong or the reading was. See OQ-42 in `Completed-Questions.md` for why this
exists and how the gating around it is meant to work.

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
4. If the PR resolves an entry from `Open-Questions.md`, that entry is moved
   to `Completed-Questions.md` in completion order, with its `**Resolved in:**
   [#N]` link. A PR implementing a story from `stories/` uses item 19 instead
   — the two queues have different completion moves, and a story is not also
   copied into the archive.
5. Any new open question or story uses the next unused OQ number — checked
   against `stories/`, `Open-Questions.md` and `Completed-Questions.md`, which
   share one number space. Numbers are never reused or renumbered.
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

## Conformance to the story

These apply to a PR implementing a story from `stories/`. A PR that implements
no story — a bootstrap, or a workflow-only change — has no story to conform
to; say which of these you treated as not applicable rather than passing them
silently.

Items 7 and 15 check the PR against *its own account of itself*, and the same
worker wrote both sides. These four check it against **the story**, which is the
standard it was supposed to meet.

16. **Completeness** — every acceptance criterion in the story is delivered.
    Name any that are not.
17. **Fidelity** — each AC is genuinely satisfied, not merely named in a test.
    A test named `OQ-49/AC-3` that does not exercise AC-3 fails this item.
18. **Containment** — nothing in the diff falls under the story's
    **Out of scope**, and nothing implements a decision the story left open.
19. The story file is moved to `stories/done/` in this PR.

## For the reviewer: reporting a verdict

The prompt a reviewer session is spawned with lives in
[`.claude/prompts/reviewer.md`](.claude/prompts/reviewer.md). It must be spawned
as its own session, never as a continuation of the one that wrote the PR: the
independence this gate provides comes from context isolation, and a reviewer
told what the change was *meant* to do cannot see that the diff does something
else.

**The reviewer is given the story**, and that is not a contradiction of the
paragraph above. What is withheld is the author's *account* of the change — its
session, its summary, its reasoning. The *authored story* is a different thing:
it is the standard the diff has to meet, and a reviewer that never sees it
cannot check items 16–18 at all. It can only compare the diff to the PR body,
which the same worker wrote.

Review is enforced by `.github/workflows/review-gate.yml`, which sets a
`review/agent` commit status. Opening a PR, or pushing to one, sets that status
to pending; it clears only when a verdict marker is posted. A PR with no marker
stays pending and cannot merge — forgetting to review fails safe.

### Recording a verdict

The reviewer decides the verdict. **Whoever ran the reviewer records it**, as
one ordinary PR comment naming the `REVIEW.md` item number each finding comes
from, ending with exactly one marker line:

```
<!-- agent-review head=<full-40-char-sha> verdict=pass -->
<!-- agent-review head=<full-40-char-sha> verdict=pass-with-observations -->
<!-- agent-review head=<full-40-char-sha> verdict=block -->
```

That split is deliberate: the reviewer holds no GitHub write access and posts
nothing. It returns its verdict and findings, and the runner — a person today,
the dispatcher once it exists — records them. A reviewer that had to post its
own verdict needed credentials, and hunting for them is what turned the old
reviewer prompt into something a reviewer session correctly refused as an
injection attack.

### The three verdicts

| Verdict | Means | Commit status |
|---|---|---|
| `pass` | No applicable item fails, and nothing was found worth recording. | `success` |
| `pass-with-observations` | No applicable item fails, but real findings were surfaced and deliberately not blocked on. They go in the comment. | `success` |
| `block` | At least one applicable item fails. | `failure` |

The middle state exists because reviewers here kept producing findings that fit
nowhere in a binary — a tool named as the primary method that did not exist in
the container; an undescribed rider in a diff. Both were right to surface and
arguably right not to block. Without a state for them, the verdict record
understates what review catches, and any measurement built on it (OQ-47) is
meaningless.

`verdict=fail` is still accepted as a deprecated spelling of `block`. It is kept
only because an unrecognised marker is *ignored* — which leaves the PR pending
forever with a valid-looking verdict sitting on it, a worse failure than
honouring an old name. Write `block` in new reviews.

### When the reviewer returns no verdict

A reviewer that is not in a position to review at all — the head moved under it,
the diff will not resolve, the story is missing when there should be one —
returns `"verdict": null` rather than guessing. **Record nothing.** Post no
marker. The PR stays pending and cannot merge.

That is the intended outcome, not a gap to paper over. A PR stuck pending is a
visible problem someone picks up; a `pass` recorded by a reviewer that was not
in a position to give one is an invisible one. Where the cause is fixable —
usually a new head to review against — run the reviewer again and record
whatever verdict it returns then.

### What the workflow enforces

Getting these wrong means the marker is silently ignored rather than obeyed.

1. **`head` must be the full 40-character SHA of the commit reviewed**, not an
   abbreviation. Where you get it depends on where you are running — every
   command in this project is qualified by that, because it has twice shipped
   documentation instructing agents to do impossible things:

   | Where | Command |
   |---|---|
   | Locally, or on a GitHub Actions runner — `gh` present | `gh pr view <N> --repo <owner/repo> --json headRefOid --jq .headRefOid` |
   | In a spawned cloud session — **no `gh`** | `git fetch origin <head-branch> && git rev-parse origin/<head-branch>` |

   The second works everywhere, so prefer it when unsure.
2. **That SHA must still be the PR's head.** A verdict about an earlier commit
   says nothing about the current one, so a stale marker is ignored and the
   status stays pending. Re-review after any new push.
3. **There is no partial credit and no dismissal mechanism.** The only way past
   a `block` is a commit that addresses it, which resets the gate to pending
   and requires a fresh review.
4. **The comment must come from an account with write access.** Anyone can
   comment on a public repository; a marker from anyone else is ignored.

If a comment contains more than one well-formed marker, the last one wins, so a
correction later in the same comment supersedes an earlier line.

A `block` verdict also fails the `Review gate` workflow run itself. The commit
status is what blocks the merge; failing the run is what makes the block
*noticeable*, since GitHub's built-in Actions failure notifications only fire on
a failed run. A job reporting success while recording a blocking review would be
silent exactly when someone needs to hear about it.
