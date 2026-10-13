# Review Checklist

The checklist a pull request is reviewed against. A section applies when its
`Applies when:` line says so, and a section without one always applies. How a
review is run and reported is in `.claude/prompts/reviewer.md`.

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
3. **Docs check** records a real outcome for `README.md` — what changed, or
   why nothing needed to.

<!-- Item 4 is not used. -->

5. A new story takes the next unused `ST-<n>`, checked as `stories/README.md`,
   "Numbering", says: against `stories/` (`done/` and `retired/` included) and
   every branch on `origin`. Numbers are never reused or renumbered.
6. Commit granularity: one commit is right for most changes.
7. The diff matches the **What changed** description. No unrelated changes
   riding along.

## PRs that change app code

Applies when: the diff changes code or tests.

<!-- Item 8 is not used. -->

9. No test was skipped, disabled, quarantined, weakened, or deleted in order to
   make something pass.

<!-- Item 10 is not used. -->

11. No coverage-percentage tooling is added. Its absence is deliberate; see
    `AGENTS.md`.

## Integrity

12. The **Verification** section reports real results — actual numbers, taken
    the same way across a before/after comparison — rather than an assertion
    that checks passed.
13. A check that could not be run is stated as such, with the reason, rather
    than quietly omitted from the list.
14. No local workaround is left in the diff. A path, config, or flag patched
    in order to get a check running locally must be reverted before pushing.
15. Scope was not widened beyond the task the PR set out to do.

## Conformance to the story

Applies when: the pull request implements a story from `stories/`.

16. **Completeness** — every acceptance criterion in the story is delivered.
    Name any that are not. The PR ticks each AC it delivered in the story file
    (`stories/README.md`, "Acceptance criteria and tests"). An AC left unticked
    must be explained in the PR body, and an AC delivered but left unticked is
    a finding here.
17. **Fidelity** — each AC is genuinely satisfied, not merely named in a test.
    A test named `ST-49/AC-3` that does not exercise AC-3 fails this item. So
    does a ticked AC: a tick is the author's claim, and one that is not
    genuinely delivered fails this item as surely as a misnamed test.
18. **Containment** — nothing in the diff falls under the story's
    **Out of scope**, and nothing implements a decision the story left open.
    CI enforces the `stories/` part of this mechanically
    (`scripts/dispatch/story-containment.mjs`): the only changes a
    story's own pull request may make under `stories/` are that story's move
    into `stories/done/`, its acceptance-criterion lines ticking, and its
    `blocked:` edit. The reviewer's judgement is still needed for the rest —
    whether the diff outside `stories/` strays into the story's Out of scope,
    or implements a decision it left open.
19. The story file is moved to `stories/done/` in this PR.

## PRs that add or change a story

Applies when: the pull request adds or changes a file under `stories/` without
implementing a story.

20. **Schema** — each added or changed story matches `stories/_TEMPLATE.md`:
    the frontmatter keys, the six sections, and AC ids of the form `AC-N`
    (or `AC-Nx`).
21. **Readiness** — a story whose Open questions section is empty passes the
    readiness test in `stories/README.md`: each AC can be checked by someone
    holding only the story and a diff. An AC that could not fail is a finding.
    A story that is not ready must say so, with its questions under Open
    questions, which keeps it `draft`.
22. **Claims** — every statement the story makes about the repository is true
    at the PR's head: files, functions, line numbers, counts, behaviour, and
    what another story says. Check each one (`AGENTS.md`, "Claims about this
    repository").
23. **Stable ids** — a story that is already in flight (a `story/ST-<n>-*`
    branch exists on `origin`; check with `git ls-remote`) does not have its
    AC ids renumbered. A new AC goes in with a letter suffix.
24. **Consistency** — the story does not contradict or duplicate another
    story's ACs. Where it takes over part of another story, that story is
    edited in the same PR, and every reference to the moved part is updated.
25. **Decisions recorded** — a design decision the story makes is written into
    `docs/agent-workflow-design.md` in this PR, marked as that document's
    "Reading this document" note says, and the story has an AC to resolve the
    marker. A decision that exists only in a story is a finding.
