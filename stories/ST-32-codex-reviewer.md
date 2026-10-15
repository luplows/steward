---
id: ST-32
title: Run the reviewer through the Codex CLI, chosen in the settings
tier: normal
kind: workflow
depends_on: [ST-22, ST-31]
model: sonnet
blocked: null
---

## Intent

As a member of the crew, I want the reviewer to be able to run through OpenAI's Codex CLI instead
of Claude Code, chosen in the settings, so that a pull request is judged by a model from another
company than the one that wrote it, and so that steward does not depend on one company (design
doc, "Goals", 2 and 3). The reviewer keeps the guarantees it has under Claude Code, shown by tests
before it is used (M3).

**This is a draft.** Its acceptance criteria are a first sketch from the trial of 2026-10-15, to be
settled with the Open questions below.

## Acceptance criteria

- [ ] **AC-1** — Sketch: a settings key names the tool each role runs through, `claude` or
      `codex`, and `review.mjs` starts the reviewer through the one named, with no change to
      `land.mjs`. Claude Code stays the default for steward's own file.
- [ ] **AC-2** — Sketch: a Codex reviewer runs as
      `codex exec -s read-only -C <checkout> --json -o <file> --ephemeral -` with the rendered
      prompt on stdin and no GitHub credential in its environment (`coderEnv`), and its last
      message is parsed by `parseReviewerVerdict` exactly as a Claude reviewer's is.
- [ ] **AC-3** — Sketch: `reviewer.md` keeps one set of rules, with a short section for Codex
      (M5), such as: the head is already fetched and checked out, so confirm it with
      `git rev-parse HEAD`; the base for the three-dot diff; the shell it runs in.
- [ ] **AC-4** — Sketch: tests show the reviewer's guarantees hold under Codex (M3): no `gh`
      token, no SSH push, no `git credential fill` password, no write outside its checkout, and
      the checkout unchanged after the review, as `review.mjs` checks today.
- [ ] **AC-5** — Every `**Planned (…)**` marker naming ST-32 in `docs/agent-workflow-design.md`
      loses `ST-32`, and each passage is corrected wherever what was built differs.

## Out of scope

- A Codex coder. That waits for steward's coder stories (owner, 2026-10-15), and stays in ST-15.
- A tool other than Claude Code and Codex.
- Changing what the gate decides: verdicts, sections, landing.

## Constraints

- Node, ESM, no new runtime dependencies.

## Context

- **The trial** (design doc, "Trials and measurements", "Codex as reviewer", 2026-10-15): three
  runs of `codex exec -s read-only` (codex-cli 0.162.0-alpha.17.2) on #34 at `da6e5c5`, with the
  prompt `buildInvocation` renders:
  - checkout under `%LOCALAPPDATA%\Temp\claude`: unreadable to the sandbox, so it worked in
    `C:\`, and returned a well-formed `null` verdict;
  - checkout in `steward.worktrees\codex-trial`: `git fetch`, which the prompt asks for, failed (no
    network, and `FETCH_HEAD` is outside the checkout), and it returned a `null` verdict;
  - the same, with a four-line Codex section: it reviewed in 32 seconds, and
    `parseReviewerVerdict` accepted its `pass-with-observations` with all six sections. It could
    not run `npm test`, which PowerShell's execution policy refused (`npm.ps1`).
- Inside `codex sandbox`, a probe found no `gh` token, no SSH to GitHub (port 22 refused), no
  `git credential fill` password, no network, and no write outside its working directory. On the
  host, `gh auth token` returned a token and SSH authenticated.
- `docs/agent-workflow-design.md`, "Other companies' models (OQ-114)": M1 to M6, the owner's
  decisions of 2026-10-08. ST-15 is the placeholder this story takes the reviewer's half of.
- ST-22 rewrites `reviewer.md` and the unit the reviewer is given, and its narrower commands bear
  on Open question 3. ST-31's usage check reads only Claude Code's usage.

## Open questions

1. **Reading Codex's usage** (left open by the owner on 2026-10-15, who is on a free ChatGPT plan
   for now and expects to move to Pro). Codex's session logs record `rate_limits.primary`, a single
   30-day window at the trial (`window_minutes` 43200); `codex exec --json` does not report it,
   and `--ephemeral` writes no log. Without a reading, ST-31 starts nothing.
2. **Where the checkout lives.** The sandbox could not read the scratch directory under
   `%LOCALAPPDATA%\Temp\claude`. `review.mjs` makes its checkout under `tmpdir()`. Is that
   readable to the sandbox, or does the checkout move?
3. **Running the project's checks.** `npm` as `npm.ps1` was refused by the execution policy;
   `npm.cmd` may not be. The tests also write temporary repositories, which a read-only sandbox may
   refuse. Does the reviewer run checks at all under Codex, or only the narrower commands ST-22
   asks for?
4. **Windows Credential Manager.** The probe did not read it directly, which is how
   tower-workshop-paths' #209 reached the `gh` credential. Is that tried here or left to ST-6?
5. **The model and its settings key** (M4): which Codex model, and whether the key names a tool
   and a model per role.
