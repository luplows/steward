---
id: ST-42
title: Run the gate's logic as steward commands, and ship thin workflow files that start steward at a pinned tag
tier: next
kind: workflow
depends_on: [ST-16, ST-17, ST-24, ST-45]
model: null
blocked: null
---

## Intent

As a member of the crew of a project that installs steward, I want the review gate's and the
runway's workflows to run steward's own commands, from steward installed at a pinned tag, so that
my project carries only thin workflow files, needs no copy of steward's scripts, and installs
nothing of its own to run the gate.

## Acceptance criteria

- [x] **AC-1** — Everything `review-gate.yml` and `land-approved.yml` do beyond triggers,
      permissions, concurrency and environment is a steward command in `cli.mjs`'s `COMMANDS`: one
      for each script they run today (`scripts/land/apply-review-blocked.mjs`,
      `select-candidates.mjs`, `check-author.mjs` and `delete-merged-heads.mjs`), and one for each
      piece of inline shell they run today (the `pending` job's status post, the `verdict` job's
      marker reading and status post, and the `land` job's circuit breaker, candidate loop and
      merge), or one command taking over several of these. Each command keeps what its part does
      when this story is built: the honoured associations, the marker pattern, the circuit breaker's
      limit of five and its two exemptions, the landing rule as ST-24 leaves it (the checks
      `landWhen` names, in place of `mergeable_state` `clean`), the direct re-check of
      `review/agent`, `--squash` and `--match-head-commit`, and deleting merged heads without
      failing the run. `cli.test.mjs` shows each new command is in `COMMANDS`.
- [x] **AC-2** — Each test that reads `review-gate.yml` or `land-approved.yml` to check that
      logic (in `ci.test.mjs`, `github.test.mjs`, `review.test.mjs`,
      `scripts/land/*.test.mjs` and `scripts/report/review-verdicts.test.mjs`) checks the same
      property where the logic now lives, with the same expectations, or checks the workflow
      file for the command that runs it.
- [x] **AC-3** — Steward's own `.github/workflows/review-gate.yml` and `land-approved.yml` run
      these commands from steward's checkout (`node scripts/dispatch/cli.mjs <command>`), and hold
      no other logic. Their file names and their `name:`s ("Review gate", "Land approved PRs") are
      unchanged, since `land.mjs` dispatches `land-approved.yml` by file name (`WORKFLOW`) and
      `ci.yml`'s `workflow_run` names "Land approved PRs". The `pending` job, which runs on the
      pull request's own event with a token that can post statuses, checks out the pull request's
      base, not its merge tree, so that it runs no code the pull request changes. Its step running
      `mark-pending` runs only when the base holds that command's module (`if: hashFiles(…) != ''`
      on the module's path), and is otherwise skipped, so that the job succeeds. The base holds it
      only once this story has landed, so this story's own pull request gets no pending post and no
      failed check, and every later one gets the post (owner, 2026-10-22; Context). A test shows
      the `pending` job checks out the base and carries that condition, and AC-5's comparison
      ignores both as part of how steward is started.
- [x] **AC-4** — The package carries the thin workflow files a project uses: a `review-gate.yml` and
      a `land-approved.yml`, in one directory of the package, which ST-44's `init` copies from. Each
      has the same triggers, permissions, concurrency, jobs and environment as steward's own, and
      runs the same commands, starting steward from the package installed alone at a pinned tag
      (`npx --yes --package=github:luplows/steward#v<version> steward <command>`, or an equivalent
      that installs steward and nothing of the project's). The tag is a placeholder in the file,
      which `init` fills (ST-44). Neither file checks out the project to install its dependencies or
      runs the project's `npm ci`.
- [x] **AC-5** — A test fails when steward's own workflow files and the thin files differ in
      anything but how steward is started: the steps or lines that start it from the checkout in
      one and from the pinned package in the other. It reads the four files from the repository,
      and a case shows it failing on a thin file with a changed permission or trigger.
- [x] **AC-6** — No comment in the four files makes a statement particular to steward's own
      repository that is false for another project: in particular, `review-gate.yml`'s reference
      to `Open-Questions.md` and `land-approved.yml`'s to `Completed-Questions.md`, files this
      repository does not have, and `land-approved.yml`'s "The repository is public and forking
      is allowed".
- [x] **AC-7** — `docs/agent-workflow-design.md`, Part 3, "What ties the workflow to this
      repository today", says what the gate's workflows run after this story, and every
      **Planned** marker naming ST-42 there is resolved, as its "Reading this document" note
      says. `README.md`'s description of the three workflows is corrected wherever this story
      makes it untrue.

## Out of scope

- `ci.yml`, steward's own and a project's: its story containment step, its after-sweep trigger
  (`workflow_run` on "Land approved PRs") and its checks. A project's CI is its own.
- Writing the thin files into a project, and filling in their tag: `init` (ST-44).
- Changing what the gate or the runway decides: every rule in AC-1 is kept as it is.
- The base branch, `main`, which stays a constant (design doc, R3).
- Cutting a release or a tag: the release review's.
- ST-16's and ST-17's changes to `review-gate.yml` and `apply-review-blocked.mjs`.

## Constraints

- Node, ESM, no new runtime dependencies.

## Context

- **Decided on 2026-10-19 by the owner**, with the planning session (design doc, Part 3, "Decided so
  far", "Steward installs in another project as a review gate, through `init`"). Steward alone at a
  pinned tag was chosen over running the project's `npm ci`, for fewer Actions minutes on a private
  repository and because it works for a project that is not Node. A project's `package.json` does
  not pin steward: the crew runs it locally with the same `npx --yes
  --package=github:luplows/steward#v<version> steward <command>` form, so the version is pinned only
  in the workflow files and the commands the crew types. Whether that hurts adoption is to be
  revisited later (owner). A tag in steward's repository is never moved once cut (owner), so a
  pinned tag names one version for good. Considered and not chosen: pinning the commit the tag
  points at, which is safer against a moved tag but harder to read.
- Design doc, Part 3, R1 (the logic of `review-gate.yml` and `land-approved.yml` moves to steward;
  thin workflow files call it) and R2 ("the triggers and permissions, then one step running the
  package's command").
- `.github/workflows/review-gate.yml`: the `pending` job posts `review/agent` pending with
  `gh api`; the `verdict` job checks out the repository, reads the marker in shell, with its own
  `OWNER|MEMBER|COLLABORATOR` `case`, posts the status, and runs
  `node scripts/land/apply-review-blocked.mjs` (line 192). Line 3 names `Open-Questions.md`.
- `.github/workflows/land-approved.yml`: one job that checks out the repository, runs the circuit
  breaker in shell (`-ge 5`, line 82), `node scripts/land/select-candidates.mjs` (line 91), and
  for each candidate `node scripts/land/check-author.mjs` (line 112), the label and
  `mergeable_state` checks, the `review/agent` re-check, and `gh pr merge … --squash
  --match-head-commit` (line 178); then `node scripts/land/delete-merged-heads.mjs` (line 198)
  with `continue-on-error`. Line 78 names `Completed-Questions.md`, and line 103 says the
  repository is public.
- Neither workflow runs `actions/setup-node`; `ci.yml` does, with Node 22.
- `scripts/dispatch/cli.mjs`: `COMMANDS`, each run as its own process. `package.json`: `bin`
  `steward` is `scripts/dispatch/cli.mjs`, `version` `0.0.0`. `origin` has no tags
  (`git ls-remote --tags origin`, 2026-10-19).
- `scripts/dispatch/land.mjs`, line 54: `const WORKFLOW = 'land-approved.yml'`.
- ST-24 replaces the runway's and the pilot's `mergeable_state` `clean` rule with the checks
  `landWhen` names, in `land-approved.yml` and `land.mjs`. This story depends on it, so the rule
  it moves into a command is ST-24's.
- ST-16 (AC-4, AC-5) and ST-17 change `review-gate.yml` and `apply-review-blocked.mjs`, citing line
  numbers this story will move. This story depends on both, as on ST-24, so the logic it moves
  includes their changes. It also depends on ST-45, which changes `select-candidates.mjs` to take
  pull requests into a release branch.
- **Revised on 2026-10-22 by the owner**, after #74's second and third reviews (comments 6334578130
  and 6334852619). The `pending` job runs on the pull request's own event with `statuses: write`;
  given the default checkout, the merge tree, it would run the pull request's own `cli.mjs`, which
  could post `review/agent` success with no review. Today's step runs no checked-out code: it
  posts a literal pending status with `gh api`. So steward's own `pending` job checks out the
  base. The base has no `mark-pending` until this story lands, and a step that runs it there would
  fail, leaving a failed check on this story's own head, which `landWhen`'s `"all-checks"`
  (`steward.config.json`, `scripts/land/checks-green.mjs`) would never let land (#77's first
  review, comment 6343032828). So the step runs only when the base holds the command's module,
  and is skipped otherwise: this story's own pull request gets no pending post and no failed check.
  A missing pending post costs nothing, since landing waits for `review/agent` success, which the
  `verdict` job posts from `main`. Considered and not chosen then: keeping today's `gh api` step in
  this story's pull request and switching it in a follow-up, which is one more pull request and an
  exception to AC-3 in the meantime. Considered and not chosen before: the merge tree, arguing
  that on a pull request's event GitHub also takes the workflow file from the pull request, so a
  pull request could already rewrite the job, which makes forging the status easier to miss in review;
  and falling back to `gh api` when the command is missing, which AC-3 forbids as logic in the
  workflow file. The thin files check out nothing and start steward at a pinned tag (AC-4).

## Open questions

*(none)*
