---
id: ST-108
title: Stop restricting the coder by path
tier: normal
kind: product
depends_on: [ST-106]
model: null
blocked: null
---

## Intent

As a member of the crew, I want a coder to change whatever its unit needs, `.claude/prompts/`
included, and have the change reviewed and landed by hand, so that a unit touching the prompts is
not stopped by a rule the coder works around, while ST-106, shipped in the same release, keeps
such a change from landing unattended.

## Acceptance criteria

- [ ] **AC-1** — Steward no longer refuses to push a coder's branch whose commits touch
      `.claude/prompts/`, for every coder tool: `pushBranch` (`scripts/dispatch/coder.mjs`) loses
      the `prompt-change-refused` result, `promptPathsTouched` and `PROMPTS_DIR`, and pushes such a
      branch as any other. `dispatchCoder`, `retryStory` and `executeHandoff`
      (`scripts/dispatch/handoff-coder.mjs`) push it and go on as for any other branch.
      `git grep prompt-change-refused` finds nothing outside `stories/done/` and dated records.
- [ ] **AC-2** — Both coder prompts, `.claude/prompts/coder.md` and
      `.claude/prompts/coder-handoff.md`, no longer say that the coder cannot edit anything under
      `.claude/prompts/`, nor that writes there are not refused by its sandbox but the rule is the
      same. In their place each says: when the coder's tool refuses an edit it needs, it puts that
      change in its PR body under a `### Proposed edit` heading, as a unified diff against the file
      as it is on its branch, in a `diff` code block that `git apply` accepts; it commits the rest;
      and it leaves the acceptance criterion that depends on the change unticked and says so. Each
      says that a pending proposed edit is not work left undone. Neither prompt names a path the
      coder may not change.
- [ ] **AC-3** — `findPromptChange` (`coder.mjs`) is generalized, not removed, and renamed
      `findProposedEdit`: it finds the `### Proposed edit` heading (at heading levels 2 to 4, as
      now) and names every file the diff's `diff --git a/`, `--- a/` and `+++ b/` lines name,
      whatever its path. `dispatchCoder` and `retryStory` report it as `proposedEdit`
      (`{ pending: true, files }`) where they report `promptChange` now, and the `coder` command
      prints that a proposed edit is pending manual application, naming the files and the heading.
      It stays text only: nothing applies the diff. Kept rather than removed because it is the
      only notice steward gives whoever ran the coder that a person has a diff to apply, and the
      route it reports stays.
- [ ] **AC-4** — The docs no longer describe the refusal: `README.md`'s list of `executeHandoff`'s
      statuses, `docs/user-config.md`'s bullet on the Codex coder editing `.claude/prompts/`, and
      the comments of `coder.mjs` and `handoff-coder.mjs` that name `prompt-change-refused` or the
      `.claude/prompts/` rule.
- [ ] **AC-5** — This story's **Planned** marker in `docs/agent-workflow-design.md`, "A spawned
      session cannot edit `.claude/prompts/`", is removed, and that section is corrected to match:
      its heading, its paragraph scoping the observation to `.claude/prompts/coder.md`, its
      consequence that no coder can deliver a story that changes the prompts, and its account of
      what `coder.md` tells the coder. Every other copy of those claims in the document is
      corrected or marked as dated.
- [ ] **AC-6** — Tests, in `scripts/dispatch/coder.test.mjs` and
      `scripts/dispatch/handoff-coder.test.mjs`:
      - the tests of the refusal (`describe('ST-15/AC-7: …')` in `coder.test.mjs`, and
        "ST-91/AC-6: a coder that changes .claude/prompts is refused, and its commit is kept" in
        `handoff-coder.test.mjs`) are replaced by tests that a branch adding, changing, deleting or
        moving a file under `.claude/prompts/` is pushed, through `pushBranch`, `dispatchCoder` for
        a Claude and a Codex session, and `executeHandoff`;
      - the tests of `findPromptChange` ("OQ-70/AC-7b") test `findProposedEdit` with the new
        heading, a diff of a file outside `.claude/`, and a body with no proposed edit;
      - the test that no code path in `coder.mjs` writes to `.claude/` or invokes `git apply`
        stays.

## Out of scope

- Making the Claude coder able to write under `.claude/`. No supported setting does: an explicit
  allow rule does not lift the refusal (2026-11-25, `docs/agent-workflow-design.md`).
- Applying a proposed edit automatically. A person applies it by hand, in a separate commit (OQ-70).
- Reporting a proposed edit from a handoff's coding in `steward coordinator status`.
- Restricting the coder by path in any other way. ST-106's landing restriction is the safeguard.

## Constraints

*(none)*

## Context

- `pushBranch` refuses a branch whose commits beyond its base touch `.claude/prompts/`
  (`promptPathsTouched`, status `prompt-change-refused`, ST-15/AC-7); `executeHandoff` uses the same
  `pushBranch`, and its header lists the status.
- `findPromptChange` reads the `### Proposed prompt edit` heading and names only `.claude/prompts/`
  files; `dispatchCoder` and `retryStory` put its result on `promptChange`, and the CLI prints a
  line for it. `executeHandoff` does not call it.
- `stories/ST-14-resume-uncommitted-coder.md` names `findPromptChange` in its AC-1, noting the
  rename this story makes.
- Tested 2026-11-25 in a scratch repository: a `claude -p` session run with steward's coder flags
  (`--permission-mode acceptEdits`) is refused `Edit` anywhere under `.claude/` (`prompts/`,
  `skills/`, `agents/`, `settings.json`), an explicit `Edit(.claude/**)` allow rule does not lift
  it, and `CLAUDE.md` at the root is editable. Handoff H-8 (ST-104) stopped with nothing
  committed, its changes kept uncommitted in every file the story names except the two prompts.
  No log of its session was kept, so that the refusal stopped it is likely, not shown.
- Depends on ST-106 so that the two ship in the same release, never this story without ST-106.
  Steward's own runway is pinned to v0.3.0 (`.github/workflows/land-approved.yml`) and its
  coordinator runs v0.3.0, so on steward ST-106's restriction and this story's removal of the push
  refusal take effect together, when steward upgrades to the release that holds both. A project
  gets both together too, in one release. A coder run by hand from a checkout of steward's `main`
  (`node scripts/dispatch/cli.mjs coder`) uses this story's code as soon as it lands there. This
  story's own pull request changes `.claude/prompts/`, but on steward it lands by hand only once
  steward's runway runs a release with ST-106.
- The decision is the crew's, 2026-11-25, recorded in `docs/agent-workflow-design.md`, "A spawned
  session cannot edit `.claude/prompts/`".

## Open questions

*(none)*
