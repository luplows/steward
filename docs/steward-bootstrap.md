# Steward bootstrap checklist

The hand-run procedure for "The move, in order", step 2, in
[`agent-workflow-design.md`](agent-workflow-design.md), "Portability": creating `luplows/steward`
from this repository. It is run by the owner with Session A. It is not a story, and nothing
dispatches from it.

**Status: agreed by the owner on 2026-10-08, with the six decisions in section 9.** Nothing below
has been run except the dry run in section 3. It runs once P1 to P6 hold. The decisions
themselves live in the design doc's Portability section; this file is the procedure, and where it
restates a decision it names the one it must not drift from.

Every count and line number here was taken on `main` at `7169d85`, or at `d86080c` for the dry
run, and **must be re-derived at the time of the run**: OQ-117, OQ-121, OQ-122 and OQ-123 change
these files before then.

## 1. Before starting

- [ ] **P1.** OQ-116, OQ-117, OQ-118, OQ-121, OQ-122 and OQ-123 are in `stories/done/` on `main`.
      Of those, the move needs OQ-118, OQ-117, OQ-122 and OQ-123 (design doc, "The move, in
      order", step 1). The other two are first in the queue.
- [ ] **P2.** No open pull request changes a moving path, except #209 (OQ-73), which stays parked.
- [ ] **P3.** `git ls-remote --heads origin` shows no `story/` branch for a moving story, except
      `story/OQ-73-coder-machine-credentials`.
- [ ] **P4.** The loop is not running, and the dispatcher session has nothing in flight, so `main`
      does not move during the extraction. Record the `main` SHA extracted from.
- [ ] **P5.** `git filter-repo --version` runs. It is installed with `pip install --user`, in the
      Python user `Scripts` directory, which is not on `PATH`.
- [ ] **P6.** `gh repo view luplows/steward` still reports no such repository.

## 2. What is extracted

The design doc's R1 table, with the gaps the dry run found. Re-derive the moving stories with the
rule in R4: every unbuilt `kind: workflow` story, except OQ-72, OQ-94, OQ-115, OQ-117 and OQ-118.

**Paths (27, with `steward.config.json`):**

| Path | Why |
|---|---|
| `scripts/dispatch/`, `scripts/land/`, `scripts/report/`, `scripts/lint-stories.mjs`, `scripts/lint-stories.test.mjs` | R1 |
| `.claude/prompts/` | R1 |
| `REVIEW.md`, `CLAUDE.md` | R1 (trimmed in section 4) |
| `docs/agent-workflow-design.md`, `docs/harness-outline.md`, `docs/session-a.md`, `docs/migration-plan.md`, `docs/gap-analysis.md` | R1 |
| `stories/README.md`, `stories/_TEMPLATE.md` | R1 |
| `.github/workflows/ci.yml`, `review-gate.yml`, `land-approved.yml` | R1 (`ci.yml` is rewritten in section 4) |
| `steward.config.json` | Added by OQ-122 (rewritten in section 4) |
| `test/fixtures/` | Not in R1: `lint-stories.test.mjs` reads two files there |
| `stories/done/OQ-51-story-injection-boundary.md`, `OQ-68-github-operations.md`, `OQ-69-reviewer-dispatch.md`, `OQ-70-coder-dispatch.md` | Not in R1: tests read them as fixtures (`queue.test.mjs`, `render.test.mjs`, `lint-stories.test.mjs`) |
| `.github/pull_request_template.md`, `.oxlintrc.json`, `.gitignore` | Not in R1: steward's lint, PRs and ignores |

**The 21 moving stories**, as of `7169d85`, assuming OQ-116, OQ-121, OQ-122 and OQ-123 are built
by then: OQ-46, 54, 59, 62, 64, 66, 71, 73, 88, 89, 98, 99, 100, 101, 102, 103, 105, 108, 114, 119
and 120. Each is extracted at its path under `stories/`, so its history moves with it.

**Commit messages** (R1, "Commit messages name this repository's pull requests in plain text";
must not drift from it). The rule file, written with a heredoc, not `printf`, which mangles `\1`:

```text
regex:\(#([0-9]+)\)==>(tower-workshop-paths PR \1)
regex:(?m)(^|[^A-Za-z0-9/&])#([0-9]+)==>\1tower-workshop-paths PR \2
```

## 3. The dry run (done 2026-10-08)

On a fresh clone of `main` at `d86080c`, in Session A's scratch folder, with the paths above
less `steward.config.json`, which did not exist yet (26 paths and the 21 stories, 47 in all), and
both rules. Nothing was pushed.

- `git filter-repo` ran in about a second, and its own fresh-clone check passed.
- 127 of 216 commits kept, and 94 files, every one on the list.
- Per-file commit counts matched the original for the 9 files checked, including this repository's
  design doc, `CLAUDE.md`, `REVIEW.md`, `coder.md`, `coder.mjs` and two moving stories. The
  history starts at this repository's first commit (2026-09-10).
- Commit subjects ending `(#N)`: 124 of 127 rewritten. Bare `#N` in bodies: 106 lines before the
  second rule, 0 after. Every one was this repository's pull request.
- **The clone's other branches become local branches** (for example `story/OQ-118-…`). Only `main`
  is pushed (section 6).

## 4. The bootstrap commits

On top of the extracted history, in a fresh clone at `E:\Source\steward-extract`, never a working
checkout. Each is its own commit, so the direct push in section 6 is reviewable commit by commit.

- [ ] **B1. Renumber the stories.** `git mv` each moving story to `ST-<n>`, numbered in ascending
      order of OQ id (R4, R9), and set its `id:`. Add a line to its Context: "Formerly
      tower-workshop-paths OQ-<n>." References to OQ stories that stay here keep their numbers.
      The mapping, as of `7169d85`:

      | ST | OQ | `depends_on` in steward | `blocked:` in steward |
      |---|---|---|---|
      | ST-1 | OQ-46 | `[]` | `null` |
      | ST-2 | OQ-54 | `[]` (OQ-61 is built here) | cleared (R4) |
      | ST-3 | OQ-59 | `[]` (OQ-49 is built here) | cleared (R4) |
      | ST-4 | OQ-62 | `[]` | cleared (R4) |
      | ST-5 | OQ-64 | `[]` | `null` |
      | ST-6 | OQ-66 | `[]` | `null` |
      | ST-7 | OQ-71 | `[]` | `null` |
      | ST-8 | OQ-73 | `[]` (OQ-84 is built here) | **set**: see decision D-4 |
      | ST-9 | OQ-88 | `[]` | cleared (R4) |
      | ST-10 | OQ-89 | `[]` | cleared (R4) |
      | ST-11 | OQ-98 | `[]` | cleared (R4) |
      | ST-12 | OQ-99 | `[]` | cleared (R4) |
      | ST-13 | OQ-100 | `[]` | cleared (R4) |
      | ST-14 | OQ-101 | `[ST-8]` (the other nine are built here) | `null` |
      | ST-15 | OQ-102 | `[ST-14]` (OQ-83 and OQ-86 are built here) | `null` |
      | ST-16 | OQ-103 | `[]` | cleared (R4) |
      | ST-17 | OQ-105 | `[]` | cleared (R4) |
      | ST-18 | OQ-108 | `[]` (OQ-107 is built here) | kept: parked by the owner |
      | ST-19 | OQ-114 | `[]` (R4: `OQ-115` dropped) | `null` |
      | ST-20 | OQ-119 | `[]` | cleared (R4) |
      | ST-21 | OQ-120 | `[]` | cleared (R4) |

      A dropped dependency is recorded in that story's Context, naming the built OQ story.
- [ ] **B2. Move the fixtures.** `git mv` the four built stories to `test/fixtures/stories/`, and
      point the tests that read them there.
- [ ] **B3. `steward.config.json`:** `{ "repo": "luplows/steward", "storyPrefix": "ST" }`.
- [ ] **B4. `package.json`.** Name `steward`, `"type": "module"`, `"private": true`, and a `bin`
      entry `steward` pointing at `scripts/dispatch/cli.mjs` (OQ-123), which needs a
      `#!/usr/bin/env node` line. Scripts `lint` (`oxlint`) and `test` (`vitest run`).
      `devDependencies`: `vitest` and `oxlint` only, at this repository's ranges (`^5.0.0` and
      `^1.79.0` at `7169d85`). `package-lock.json` from `npm install`.
- [ ] **B5. A Vitest config** with `environment: 'node'` and no setup file. Six of the moved test
      files have no `@vitest-environment node` line and rely on this repository's jsdom default
      and `src/test/setup.js`, neither of which moves.
- [ ] **B6. `ci.yml`, rewritten.** One job named `test`, so it matches the required check: checkout
      with `fetch-depth: 0`, Node 22, `npm ci`, lint, Vitest, and the story containment step. No
      build and no Playwright. Its setup steps keep the `Setup: ` name prefix, because
      `ci.test.mjs` ("OQ-118/AC-3") reads steward's own `ci.yml` and fails otherwise. OQ-117's time
      limits are kept. OQ-124's `workflow_run` trigger on `Land approved PRs`, and its job
      condition, are kept, so steward's `main` is checked after each landing (design doc,
      "Portability", "Decided so far").
- [ ] **B7. `review-gate.yml` and `land-approved.yml`, unchanged.** Neither names this repository:
      they take `github.repository`, and run `node scripts/land/…` without `npm ci`.
- [ ] **B8. The prompts, stripped by hand** (R1, "steward starts clean"): in `coder.md` this
      repository's name, Vitest and Playwright, the screenshot-baseline rules, `mytower.app`, and
      the pointer to `Completed-Questions.md`; in `reviewer.md` this repository's name. The name
      becomes `luplows/steward`.
- [ ] **B9. `REVIEW.md`**: items 8 and 10 removed, leaving the gaps (R1).
- [ ] **B10. `CLAUDE.md`**: the workflow rules stay. This repository's "Testing" rules (Playwright,
      screenshot baselines, the buy-order algorithm) go, and the documents table loses the files
      that stay here. See D-2.
- [ ] **B11. The design doc and the other moved documents.**
      - One note at the top of each: an `OQ-<n>` means a tower-workshop-paths story, found in its
        `stories/done/` or `Completed-Questions.md`.
      - Its **Planned** markers that name a moved story take that story's `ST-<n>`. At `7169d85`
        those are OQ-73 (3), OQ-101 (2), OQ-102, OQ-105, OQ-108, OQ-114 and OQ-119. The marker
        naming OQ-115 is reworded without a marker, since that work is this repository's.
      - This repository's passages, listed in R1 under "This document", and the example story:
        removed or replaced (D-1).
- [ ] **B12. Links to files that stay here**, made into plain text or links to this repository.
      Five at `d86080c`: `CLAUDE.md` lines 62 and 90, `stories/README.md` lines 14 and 18, and
      ST-7's (OQ-71's) line 69.
- [ ] **B13. `.github/pull_request_template.md`**: its Docs check names `README.md`,
      `Open-Questions.md` and `Project-Outline.md`, which steward does not have.
- [ ] **B14. A short `README.md`**: what steward is, with a pointer to `docs/harness-outline.md`.
- [ ] **B15. Local checks**, with their real output kept for the record: `npm ci`, `npm run lint`,
      `npm test`, `node scripts/dispatch/cli.mjs lint`, and `node scripts/dispatch/cli.mjs queue`.
      The queue should list only `ST-` stories, with the statuses in B1.

## 5. Create the repository

- [ ] **A1. The owner authorises creating `luplows/steward`, public**, with no initial commit.
- [ ] Settings, mirroring this repository's as read on 2026-10-08: squash, merge-commit and rebase
      merging allowed (the sweep squashes); issues on; default workflow permissions `read`;
      Actions may not approve pull requests.
- [ ] Labels: `review-blocked` and `loop-stuck`, which this repository has. `breaker-override` is
      read by `land-approved.yml` but this repository has no such label either.

## 6. The one direct push

- [ ] **A2. The owner authorises the push explicitly, at that moment.** It is made before any
      protection exists (design doc, "The move, in order", step 2).
- [ ] Push `main` only: `git push origin main`. No other branch, no tags.
- [ ] The `ci.yml` run triggered by the push is green.

## 7. Protect `main`

- [ ] Mirror this repository's protection, as read on 2026-10-08: required checks `test` and
      `review/agent`, not strict; `enforce_admins: true`; pull requests required, with 0
      approvals; no force pushes, no deletions.
- [ ] Read the protection back with `gh api repos/luplows/steward/branches/main/protection` and
      check each setting.

## 8. Steward's own loop, and the first pull request

- [ ] A checkout of steward at `E:\Source\steward`, and the loop's own worktree made from it with
      `node scripts/dispatch/cli.mjs loop --init <path>`. `TW_MACHINE_LABEL` exported.
- [ ] Steward's own first stories written at tier `next`, on `write-story/` branches in steward,
      before its loop first runs (D-5).
- [ ] A first, small pull request on steward (for example, its first story), reviewed and landed
      through steward's own gate, which shows `test`, `review/agent` and the sweep working.
- [ ] Record the outcome: in steward's design doc, through a steward pull request; and here, in R4,
      the OQ-to-ST mapping, through a `write-story/` pull request, since OQ-115 needs it.

## 9. Decisions

All six were made by the owner on 2026-10-08, and are recorded in the design doc's Portability
section (R1 and R4) and its "Decided so far".

- **D-1. This repository's passages in steward's copy of the design doc** (Pages as the alpha
  channel, the buy-order examples, scraped-data validation, the production target, `mytower.app`,
  and the example story): **stripped at the bootstrap**, as the prompts are (B11).
- **D-2. `CLAUDE.md`'s "Testing" section in steward:** **keeps** the rules that hold for steward
  (CI is required, tests alongside new logic in Vitest, no coverage tooling, green CI is not
  sufficient) and **drops** Playwright, screenshot baselines and the buy-order algorithm (B10).
- **D-3. The additions to R1's list in section 2** (`test/fixtures/`, the four fixture stories, the
  PR template, `.oxlintrc.json`, `.gitignore`): **added** to R1's table.
- **D-4. ST-8 (OQ-73):** **`blocked:` is set** in steward, saying it is to be rewritten as
  containers (R5). Its file reads `ready` on this repository's `main`, so copied as it is,
  steward's loop would dispatch the Windows-account version at once (B1).
- **D-5. The order of steward's first stories:** steward's own first stories (the prompts'
  `{{REPO}}` slot and project section, closing `REVIEW.md`'s gaps, and `init` with the thin
  workflow files) are **written at tier `next` before its loop first runs**, so they come before
  the moved stories. Writing them is Session A's, in steward (section 8).
- **D-6. The checkouts:** `E:\Source\steward-extract` for the extraction, and `E:\Source\steward`
  with the loop's worktree beside it.
