---
id: ST-29
title: Inspect main and the open pull requests, and raise a merge without a passing verdict or a stalled pull request
tier: next
kind: workflow
depends_on: []
model: sonnet
blocked: null
---

## Intent

As a member of the crew, I want a check that notices when the gate has been gone around, or when the
review side has stopped moving, and raises each case as a GitHub issue, so that a broken gate does
not look exactly like a working one. It runs after each rotation, at no cost in Actions minutes,
and from a scheduled workflow a project may keep or drop, which runs while the crew's machine is
off. On a repository with no branch protection it is the only thing that would notice a merge
around the gate.

## Acceptance criteria

- [ ] **AC-1** — `node scripts/dispatch/cli.mjs inspect [--repo owner/name] [--since-days N]` runs
      a new module, `scripts/dispatch/inspect.mjs`, and `cli.mjs`'s table of commands gains
      `inspect`. `--repo` defaults to the settings' `repo`. `--since-days` takes a positive
      integer and defaults to 7. The token is `GH_TOKEN` when it is set and not empty, and
      otherwise `gh auth token`, as `github.mjs`'s `ghAuthToken` reads it.
- [ ] **AC-2** — **Merges.** For each commit on `main` committed within the last `--since-days`
      days, it asks GitHub for the pull requests associated with that commit
      (`GET /repos/{repo}/commits/{sha}/pulls`), and keeps those that are merged and whose base is
      `main`. A commit with none is a finding: a commit on `main` without a pull request. For each
      pull request kept, its merge is passing when the latest `review/agent` status on its head
      SHA created at or before its `merged_at` has the state `success` and was created by
      `github-actions[bot]`, the account `review-gate.yml` posts as. Any other merge is a finding:
      a merge without a passing verdict. A pull request is judged once, however many of its
      commits are on `main`.
- [ ] **AC-3** — **Stalls.** For each open pull request against `main` that is not a draft and
      whose author the gate honours (`HONOURED_ASSOCIATIONS`, `scripts/land/check-author.mjs`), it
      reads the latest `review/agent` status on its head:
      - `pending`, created more than the settings' `inspectAfterHours` ago: a finding, the pull
        request pending at that head;
      - `success`, created by `github-actions[bot]` more than `inspectAfterHours` ago: a finding,
        the pull request holding at that head;
      - anything else, or no `review/agent` status at all, is not a stall finding.
- [ ] **AC-4** — **Raising.** Each finding is raised as one issue labelled `inspection`, whose
      title names the finding and nothing that changes between runs:
      - `Inspection: #<n> merged without a passing verdict`;
      - `Inspection: <short sha> on main without a pull request`;
      - `Inspection: #<n> pending at <short sha>`;
      - `Inspection: #<n> holding at <short sha>`.

      The body says what was found and links the pull request or commit. Before opening one, it
      lists every issue labelled `inspection`, open or closed, and opens none whose title is
      already there, so closing an issue is how the crew says it has seen it. It creates the
      `inspection` label when the repository does not have it.
- [ ] **AC-5** — It prints one line per finding, saying whether it opened an issue or one was
      already there, and a last line with the counts. It exits 0 when it opened no issue, 1 when it
      opened at least one, and 2, opening nothing more, when a request fails or the settings do
      not read.
- [ ] **AC-6** — `inspect.mjs` has its own request allowlist, checked before any network call, as
      `land.mjs` and `review-verdicts.mjs` have theirs. It admits only: listing `main`'s commits,
      a commit's pull requests, a commit's statuses, the open pull requests, and the issues
      labelled `inspection`; creating an issue; and creating the `inspection` label. A test shows
      that any other request is refused with nothing sent.
- [ ] **AC-7** — A new required settings key, `inspectAfterHours`, a positive integer: how long a
      pull request may stay pending or holding before inspection raises it. `readSettings` refuses
      a file without it, or with a value that is not a positive integer, as it refuses any other
      key, and its tests say so. `docs/settings.md` gains its row, with `init`'s value "Not
      decided". `steward.config.json`, the page's copy of it, and `FIXTURE_SETTINGS`
      (`scripts/dispatch/settings-fixture.mjs`) gain `"inspectAfterHours": 24`.
- [ ] **AC-8** — A new workflow, `.github/workflows/inspection.yml` ("Inspection"), runs
      `node scripts/dispatch/cli.mjs inspect`, after checking out the repository so that it can
      read the settings, on `workflow_dispatch` and on a schedule of once a day, with `GH_TOKEN`
      set to `github.token`. Its `permissions:` are `contents: read`, `pull-requests: read`,
      `statuses: read` and `issues: write`, with a comment saying what each is for. A comment at
      the top says that a project sets how often it runs by editing the schedule, or drops the
      file, and that on a private repository each run costs Actions minutes.
- [ ] **AC-9** — Tests in `inspect.test.mjs`, named `ST-29/AC-<n>`, with the requests and the time
      injected:
      - a squash merge with a gate-posted `success` before `merged_at`: no finding;
      - a merge whose latest `review/agent` before `merged_at` is `failure` or `pending`, one
        whose `success` was created by another account, and one whose only `success` was created
        after `merged_at`: each a finding;
      - a commit on `main` with no pull request: a finding;
      - a pull request with several commits on `main`: judged once;
      - pending and holding just over and just under `inspectAfterHours`; a draft; a pull request
        from an author the gate does not honour; and a `failure` head: only the two over the age
        are findings;
      - a finding whose title is already on an open issue, and one on a closed issue: no issue
        opened; a new finding: one issue opened, with the label;
      - the exit codes of AC-5.
- [ ] **AC-10** — `docs/controller.md`, "A rotation", tells the controller to run
      `node scripts/dispatch/cli.mjs inspect` once after the rotation's landings, and to report what
      it prints. Its exit code is reported, and does not stop the rotation. "What you are" names
      `inspect` beside `review.mjs` and `land.mjs` among the scripts the controller runs on steward.
- [ ] **AC-11** — The `**Planned (ST-29)**` markers in `docs/agent-workflow-design.md` lose
      `ST-29`, and each passage is corrected wherever what was built differs. The glossary's
      `inspection` entry drops its "(planned: ST-29)", and `docs/outline.md`, "Land", no longer
      says the design doc's "Watchdog" describes something not built.

## Out of scope

- **A rotation running inspection itself.** That is ST-25's (its AC-4a), which depends on this
  story. Until then the controller runs it (AC-10).
- **The coder's stuck stories**: a story branch on `origin` with no open pull request. That is
  the coder side's, and `loop.mjs` already raises `loop-stuck` issues for its own loop.
- **Pull requests from outside the crew.** They are not reviewed today, so they would always read
  pending. ST-27 decides how a scheduled one is reviewed and landed.
- **When a draft was marked ready.** The gate sets `review/agent` to `pending` when a head is
  pushed, not when a draft is marked ready (`review-gate.yml`, the `pending` job), so a pull
  request kept as a draft for a long time reads as pending since its push.
- **Reading branch protection.** It needs admin scope; the merges themselves show its effect
  (`docs/agent-workflow-design.md`, "Watchdog").
- **What `init` writes** for `inspectAfterHours`, and how it offers the workflow.
- **History from before the gate.** A run raises every commit in its window that reached `main`
  without a pull request, including those from before steward was installed. On steward the last
  is B14, `e77fc29`, committed at 2026-10-11T01:27:00Z, so a run with the default window after
  2026-10-18T01:27Z raises none of them. How a project adopting steward avoids raising its own
  recent history is `init`'s.
- **Closing an issue** when its finding clears. The crew closes it.
- **The ground stop** (`docs/agent-workflow-design.md`, "Open questions", D1): findings are
  raised, and nothing stops because of them.

## Constraints

- Node, ESM, no new runtime dependencies.
- Inspection writes nothing but issues and the `inspection` label. It never comments on, labels or
  changes a pull request, and never starts a workflow.

## Context

- `docs/outline.md`, "Land": installing steward "offers inspection, never forces it … a check that
  opens an issue for any merge to `main` without a passing verdict".
- `docs/agent-workflow-design.md`, "Watchdog": the two checks, and why a schedule's cadence is
  "sometime" rather than its cron expression. Part 3, "Decided so far", 2026-10-15: what this
  story decides.
- `.github/workflows/review-gate.yml`: the `pending` job posts `review/agent` `pending` on every
  head of a pull request; the `verdict` job posts the status from an honoured marker. Both post
  with `github.token`, so the status's creator is `github-actions[bot]`. Checked on #26's head,
  `1cb5155`: a `pending` at 05:11:08Z and a `success` at 05:21:01Z, both created by
  `github-actions[bot]`, and the pull request merged at 05:21:14Z.
- `GET /repos/{repo}/commits/7faa2fb…/pulls` returns #26, with head `1cb5155`: a squash merge's
  commit on `main` leads back to its pull request.
- `scripts/dispatch/land.mjs` and `scripts/report/review-verdicts.mjs`: modules with their own
  request allowlists. `scripts/dispatch/cli.mjs`: `COMMANDS`. `scripts/dispatch/settings.mjs`:
  `ALLOWED_KEYS` and the validation of each key.
- GitHub Free includes 2,000 Actions minutes a month for private repositories, billed time is
  rounded up to the next minute, and standard runners are free on public repositories (GitHub
  Docs, "GitHub Actions billing" and "Viewing job execution time", read 2026-10-15). A daily run
  of one short job costs about 30 minutes a month.

## Open questions

*(none)*
