---
id: ST-40
title: Make the reviewer's prompt work in any project, and name the project's repository in both prompts
tier: next
kind: workflow
depends_on: []
model: null
blocked: "Built by hand: changes .claude/prompts/reviewer.md and coder.md, which a spawned coder session cannot edit (docs/agent-workflow-design.md, A spawned session cannot edit .claude/prompts/)"
---

## Intent

As a member of the crew of a project that installs steward, I want the reviewer's prompt to hold
nothing particular to steward's own repository, and both prompts to name my project's repository,
so that a reviewer started for my project is told the right repository, given paths that exist
where it runs, and reviewed against my checklist alone.

## Acceptance criteria

- [ ] **AC-1** — Both prompts take the repository from a placeholder, `{{REPO}}`, in place of
      `luplows/steward`: `.claude/prompts/reviewer.md` in "You are reviewing pull request
      **#{{PR_NUMBER}}** in …" and `.claude/prompts/coder.md` in "You are implementing
      **{{STORY_ID}}** in …". Neither file spells `luplows/steward` anywhere. Each prompt's
      placeholder table gains a `{{REPO}}` row saying what it is substituted with.
- [ ] **AC-2** — `buildInvocation` and `renderReviewerPrompt` (`scripts/dispatch/invocation.mjs`)
      substitute `{{REPO}}` with the repository the run works on, `ctx.repo`, which the command
      line takes from the settings' `repo` unless `--repo` names another. `reviewPullRequest`
      (`review.mjs`), `dispatchCoder` and `retryStory` (`coder.mjs`) pass it, for a Claude and a
      Codex reviewer alike. `REPO` is a `TRUSTED_INLINE` placeholder whose pattern admits only
      `owner/name`, with no newline, and an invocation without a repository is refused.
- [ ] **AC-3** — `reviewer.md` takes the path of `review-tools.mjs` from a placeholder,
      `{{REVIEW_TOOLS}}`, substituted with the absolute path of the `review-tools.mjs` beside the
      running `review.mjs`, which is where steward is installed, not the project's checkout.
      Every command line the prompt gives for it uses the placeholder, quoted so that a path with
      spaces runs. The placeholder is trusted inline, with a pattern that admits no newline and
      no backtick.
- [ ] **AC-4** — `reviewer.md` names the checklist by the settings' `rulesFile`, through a
      placeholder, `{{RULES_FILE}}`, in place of `REVIEW.md` in "If the pull request changes
      `REVIEW.md`, its copy is in the diff". It is trusted inline, with the form `readSettings`
      allows for `rulesFile`.
- [ ] **AC-5** — After this story the rendered reviewer prompt holds none of the following, each
      of which is in `reviewer.md` today (line numbers at `950137c`):
      1. lines 77 to 82: the rule that a story unit's file is moved into `stories/done/`, and that
         "Changes to stories" applies to a pull request that changes `stories/`;
      2. lines 122 to 126: the paragraph on ticking acceptance criteria in a story file;
      3. lines 111 to 112: "Three sub-checks, which are items 1 to 3 of the checklist's
         'Conformance to the unit'", stated as a fact about every project's checklist. The prompt
         says instead that they are the items of that section in the example checklist steward
         ships (ST-43), and are checked as the checklist's items where the project's checklist
         has them;
      4. line 117: "A test named after AC-3", or any other acceptance-criterion id form;
      5. line 215: the `src/` example of a narrow diff;
      6. lines 231 to 232: `reviewerAllowedTools()` and `scripts/dispatch/invocation.mjs`, a path
         in steward's code that is not in a project's checkout;
      7. line 313: "the design of record (`docs/agent-workflow-design.md`)", and line 314's "or
         another story", which become the project's recorded design and another unit, named
         without a path;
      8. line 325: the citation of `docs/agent-workflow-design.md`, "What the gate enforces";
      9. lines 349 to 350: the example findings' `AC-3` and `orderStories in queue.mjs`, and the
         citation of "Every pull request", item 3, a claims item the example checklist does not
         have (ST-43);
      10. line 354: the example verdict's "Changes to stories" entry and its `stories/` reason.

      Each example finding and section the prompt keeps cites a section and item the example
      checklist has (ST-43).
- [ ] **AC-6** — `invocation.test.mjs` renders the reviewer prompt with `owner/other`, a
      `rulesFile` of `docs/checklist.md` and a `review-tools.mjs` path containing a space, and
      shows: `owner/other`, `docs/checklist.md` and the quoted path where the placeholders were;
      none of `luplows/steward`, `REVIEW.md`, `stories/`, `docs/agent-workflow-design.md`,
      `scripts/dispatch/`, `queue.mjs` or `AC-3`; and a refusal for a `{{REPO}}` value with a
      newline or no `/`. A coder prompt rendered with `owner/other` says `owner/other`.
- [ ] **AC-7** — Every **Planned** marker naming ST-40 in `docs/agent-workflow-design.md` is
      resolved, as its "Reading this document" note says.

## Out of scope

- **The rest of `coder.md`**: it gets only `{{REPO}}`. Its other lines are the coding side's.
- **The prompts' project section** (`docs/agent-workflow-design.md`, R1): tower-workshop-paths
  needs it only once its coder runs (owner, 2026-10-19).
- The prompt's header, above its `---`, which `render` does not send.
- The "If you are running under the Codex CLI" section, including its line that commands run in
  Windows PowerShell 5.1: that is about the machine, not the project.
- `REVIEW.md`, which this story does not change, and the example checklist (ST-43).
- The reviewer's allowlist (`reviewerAllowedTools()`).

## Constraints

- Every new placeholder is substituted inline, validated against its pattern, as `{{PR_NUMBER}}`
  is (`renderBounded`, `invocation.mjs`), and listed in the prompt's placeholder table, which
  `checkPlaceholderContract` (`render.mjs`) enforces.

## Context

- **Decided on 2026-10-19 by the owner**, with the planning session (design doc, Part 3, "Decided
  so far", "Steward installs in another project as a review gate, through `init`"): the prompts
  work as delivered, in any project.
- `grep -n "luplows" .claude/prompts/*.md`: `coder.md`, line 59, and `reviewer.md`, line 53, only.
- `render.mjs`, `FILE_SEPARATOR_RE`: only the text after a prompt file's `---` is rendered.
- `REVIEW.md` already holds the story rules of AC-5's items 1 and 2: "Conformance to the unit",
  items 1, 2 and 4, and the `Applies when:` line of "Changes to stories".
- `review.mjs`, lines 87 to 88: `ENGINE_ROOT`, from which the reviewer's prompt is read.
  `review-tools.mjs`'s own usage text names `node scripts/dispatch/review-tools.mjs`.
- `scripts/dispatch/settings.mjs`: `REPO_RE`, and the validation of `rulesFile`.
- Design doc, Part 3, R1: the prompts' project-specific lines "become a `{{REPO}}` slot and a
  project section the project supplies".

## Open questions

*(none)*
