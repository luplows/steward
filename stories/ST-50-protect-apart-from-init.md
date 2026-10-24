---
id: ST-50
title: "steward protect: set branch protection as a command of its own, and take it out of init"
tier: fix
kind: workflow
depends_on: []
model: null
blocked: null
---

## Intent

As a member of the crew of a project that uses steward, I want branch protection to be an optional
step I take after the gate is installed and merged, not a question in the run that installs it, so
that the pull request that installs the gate can merge, and a project, or a group within a larger
one, can use steward without protection and add it later.

## Acceptance criteria

- [ ] **AC-1** — **`init` no longer touches branch protection.** Its `protectMain` question and
      its `--protect-main` flag are gone from `QUESTIONS`, so that `init --protect-main yes` is
      refused as an unknown flag, as any other is (`parseFlags`): exit 2, nothing written. A run
      makes no request to any `/branches/main/protection` URL: its request allowlist
      (`assertAllowedRequest`) refuses one, and `grep -n -i protect scripts/dispatch/init.mjs`
      finds only its closing message (AC-2). Tests with GitHub injected: a run with every question
      answered, and a `--yes` run, record no protection request; a run where GitHub answers every
      protection request `404 Branch not found` (a repository with no `main`) exits 0 after
      writing its files and creating its labels.
- [ ] **AC-2** — **`init`'s closing message** says, in its last lines: that the crew commits what
      it wrote and opens a pull request; that the pull request is merged as the project normally
      merges, since the gate cannot review the pull request that installs it; and that the crew
      may then, optionally, run `steward protect`. It presents this as a complete set-up with one
      optional step, not as a trial or an unfinished one. A test finds each of the three
      statements in the output of a run, and finds `steward protect` named as optional. ST-44's
      requirement that its last lines say the crew commits what it wrote still holds.
- [ ] **AC-3** — **`steward protect` is a command.** `cli.mjs`'s `COMMANDS` gains `protect`,
      which runs `scripts/dispatch/protect.mjs`, and `cli.test.mjs`'s list of commands gains it.
      It takes the repository as the other commands do: the settings' `repo` read from the working
      directory's `steward.config.json`, or `--repo owner/name`, which wins (`review.mjs`,
      `land.mjs` and `inspect.mjs` do the same). It reads and writes GitHub with the crew member's
      own credential (`ghAuthToken`), through a context that checks each request against an
      allowlist before any network call, as `init`'s does. It asks no question and takes no flag
      but `--repo`: any other is refused, as `init` refuses one. Running it is the crew's yes.
      A test shows it runs with no terminal and nothing else but `--repo` given.
- [ ] **AC-4** — **It reads `main` before it sets anything.** From GitHub, not from the working
      directory, it reads whether `main` exists and holds `steward.config.json`, the checklist
      that file's `rulesFile` names, `.github/workflows/review-gate.yml` and
      `.github/workflows/land-approved.yml`. It refuses, setting nothing (it sends no request but
      reads), when any is missing: its message names each one missing, and, when
      `steward.config.json` is missing or its `rulesFile` is not a path (`isRulesFilePath`), says
      that the checklist cannot be named. With no `main` it refuses, saying that it found no
      `main` on the repository. A read that fails any other way (not a 404 for a missing file or
      branch) stops it with a non-zero exit, setting nothing. It does not read the files'
      contents beyond the `rulesFile` value. Tests with GitHub injected: all four present, and
      protection is set; each of the four missing alone, and all missing, and no `main`: refused,
      naming exactly what is missing, with no write request; a 500 on a read: stops, no write
      request.
- [ ] **AC-5** — **What it sets, once those are on `main`, is what `init`'s protection set.**
      Protection requiring `review/agent` with `enforce_admins` on (`PROTECTION_BODY`). Where
      `main` already has protection, it keeps the project's own and adds only those two: it adds
      `review/agent` to the required status checks unless it is there and turns `enforce_admins`
      on unless it is on; where the protection requires no status checks, it rebuilds it with one
      PUT of every setting it had plus those two (`rebuildProtectionBody`), turning required
      signatures on again when they were on. It says which it did, and that the project's own CI
      checks are the crew's to add. Where GitHub offers none (the plan) or the account cannot set
      it (admin access), it reports so plainly, says that nothing on GitHub then enforces the
      gate, and exits 0 as `init` did; any other failed request exits non-zero. A run with no
      terminal and nothing wrong exits 0.
- [ ] **AC-6** — **The code and tests move; they are not rewritten.** From `init.mjs` to
      `protect.mjs`: `PROTECTION_BODY`, the protection request builders, `isProtectionPut`,
      `rebuildProtectionBody`, `protectionRefusal`, `protectMain` (named for what it does) with
      `keepProtection` and `refused`, and the protection operations in the allowlist. From
      `init.test.mjs` to `protect.test.mjs`, with GitHub injected: every case of the describe block
      "ST-44/AC-10: branch protection" (a set, a refusal for the plan, a refusal for admin access,
      protection kept with one or both additions, a rebuild with required signatures on again,
      and the cases there named ST-44/AC-12: a rate limit's 403, a 403 or 404 that says neither
      plan nor admin, a refusal in the middle of additions), the protection assertions of the test
      "ST-44/AC-7: init asks GitHub for nothing outside the labels and main's protection", and the
      `protection: 'broken'` case of "ST-44/AC-12: exit codes". Their expectations are unchanged
      except where AC-1, AC-3 and AC-5 change them, and each name carries the `ST-50/AC-<n>` it
      tests in place of `ST-44/AC-10`, `AC-7` or `AC-12`. The `init` tests that counted or
      indexed its questions are updated for one fewer.
- [ ] **AC-7** — **`README.md`.** "Setting up another project" describes the set-up as complete
      without protection, then `steward protect` as an optional later step: the order is `init`,
      commit and open a pull request, merge it as the project normally merges (the gate cannot
      review the pull request that installs it), and optionally `steward protect`. Its list of what
      `init` writes no longer has the branch-protection item; a new passage says what `protect`
      reads from `main` before it sets anything, what it sets, how it keeps protection already
      there, and what it reports where GitHub offers none. The administrator access it needs is
      said of `protect`, in place of `init`'s opening sentence ("with `gh` signed in as an account
      that can administer the repository (for branch protection)"). `grep -n -i protect README.md`
      shows nothing else that says `init` sets protection.
- [ ] **AC-8** — **`docs/release-review.md`.** In "The walkthrough", the step that runs `init
      --ref <commit>` on a scratch repository and then opens a test pull request gains, between
      them: merging the pull request `init` leaves by hand, as nothing has reviewed it, and running
      `steward protect` from steward installed at the same `<commit>`. The test pull request is
      then reviewed and landed with protection set. The report of each command and its result
      covers `protect` too.
- [ ] **AC-9** — **`docs/outline.md`.** Its statements in "What installing steward sets up" that
      installing offers or asks about branch protection (found with
      `grep -n -i protection docs/outline.md`; lines 302, 304 and 309 today) say instead that
      installing sets none, and that a separate, optional command, `steward protect`, sets it
      once the gate is on `main`, asks nothing, and says plainly where GitHub offers none that
      nothing on GitHub then enforces the gate. Each revised statement says it was revised on
      2026-10-23 by the owner, as the outline's other revisions do.
- [ ] **AC-10** — Every **Planned** marker naming ST-50 in `docs/agent-workflow-design.md` is
      resolved, as its "Reading this document" note says: the id taken out of each marker (three
      today: in the `init` entry of "Decided so far", in the entry added with this story, and in
      "The release review", "The walkthrough"), the new entry's passage made a plain statement and
      corrected wherever what was built differs, the walkthrough's passage made a plain
      statement, and the passage in the `init` entry about protection kept as a dated record, its
      words unchanged and a plain pointer to the new entry left in place of the marker.
      `docs/glossary.md`, `docs/settings.md` and `AGENTS.md` say nothing about what `init` does
      about protection (`grep -n -i protect` on each finds only `AGENTS.md`'s "It is protected"
      about `main`), so they need no change.

## Out of scope

- **The plain 404.** A 404 "Not Found" answered to an account without admin access may be
  treated as a failure and not as an admin refusal (`protectionRefusal` reads a 403 or 404's
  message). The owner wants it seen on GitHub before it is decided. `protect` keeps today's
  handling of it.
- Carrying this fix into `release/v0.1.0`: the release review's, as a cherry-pick pull request
  (`docs/release-review.md`, "A blocker is fixed or deferred").
- GitHub rulesets (design doc, D11).
- Reading the contents of the files on `main`, or checking that they are the thin files at a
  version: `protect` reads that they are there.
- Protecting a release branch: the release review gives one the same protection by hand
  (`docs/release-review.md`, "The batch and its branch").
- The project's own CI checks in protection: the crew's to add.
- A trial mode, with `review/agent` required and `enforce_admins` off.

## Constraints

- Node, ESM, no new runtime dependencies.
- It changes the repository's settings only when the crew runs it, and it reads GitHub with the
  crew member's own credential (`gh auth token`), as the other commands do.

## Context

- **Decided on 2026-10-23 by the owner**, with the planning session, from the release review of
  `v0.1.0` (design doc, Part 3, "Decided so far", the entry added with this story). The owner's
  framing: a project set up by `init`, without protection, is a complete way to use steward, which
  a person or a group on a larger project may use alone; protection is an optional step taken
  later, not the end of a trial.
- **The finding.** The release review's walkthrough ran `init --ref <commit>` on a scratch
  repository, `luplows/playground`. With `review/agent` required and `enforce_admins` on, as
  `init` set them, the pull request that installs the gate can never get `review/agent`:
  the gate's `verdict` job (on `issue_comment`) and the runway (on `workflow_dispatch`) run from
  the default branch, where the gate is not yet installed, and the checklist is read from `main`.
  The owner: the gate not running on the pull request that installs it is right, "a feature
  rather than a bug", since a pull request must not install the rules it is judged by; what is
  wrong is offering protection in the same run. What worked: `init` without protection, merging
  its pull request by hand, then `init` again with protection, whose second run left every file
  and label as it was and only set protection. Also seen: `init` on a repository with no `main`
  stops with `GET …/branches/main/protection failed with 404: Branch not found`, after writing its
  files and labels.
- ST-44 (`stories/done/ST-44-init.md`), AC-10, built `init`'s protection question and its
  behaviour, with its tests in `scripts/dispatch/init.test.mjs`. ST-42
  (`stories/done/ST-42-gate-runs-installed-steward.md`) built the thin files whose `verdict` job
  and runway the finding concerns.
- `scripts/dispatch/init.mjs`: `PROTECTION_BODY`, the `protectMain` question (`QUESTIONS`),
  `buildGetProtection` and its siblings, `isProtectionPut`, `rebuildProtectionBody`,
  `assertAllowedRequest`, `protectionRefusal`, `protectMain`, `keepProtection`, `refused`, and the
  closing `out(...)` line of `run`.
- Considered and not chosen: only documenting the order that works today, in `README.md` and
  `init`'s closing message, with the release accepting `init` with a follow-up; `init` itself
  offering protection only once it finds the gate on `main`, run a second time, which is one
  command, but "run it again" is less clear and `init` keeps both jobs; a trial mode with
  protection required but `enforce_admins` off.
- ST-48 (`stories/ST-48-validate-review-installation.md`) describes the branch-protection outcome
  as `init`'s. It is edited to name `protect` in the pull request that writes this story, keeping
  its AC ids, so this story's pull request does not change it.
- ST-49, written with this story, edits `README.md`'s "Setting up another project" opening
  sentence too, which names Node 22. Whichever lands second keeps both changes.
- The route to the release branch is the release review's: this fix lands on `main` first, then
  comes to `release/v0.1.0` as a cherry-pick pull request that changes nothing under `stories/`
  (`docs/release-review.md`, "The walkthrough").

## Open questions

*(none)*
