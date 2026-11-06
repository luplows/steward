---
id: ST-15
title: Run the coder through the Codex CLI, with the dispatcher committing its work
tier: normal
kind: workflow
depends_on: []
model: sonnet
blocked: null
---

## Intent

As the owner, I want a coder choice in the machine's settings to run the coder
through the Codex CLI, so that the work is not all done by similar models, and
so that the workflow does not depend on any one company staying in business or
affordable (`docs/agent-workflow-design.md`, "Purpose", "Goals", 2 and 3). The
design is Part 3, "Decided so far", "A Codex coder's work is committed by the
dispatcher", from the trial under "Trials and measurements", "Codex as coder".

The threat model is one member of the crew running `coder.mjs` on their own
Windows machine, with a model that is honest and may make mistakes. The
criteria below protect that run against a session's mistakes, not against a
session trying to get its work or a credential past them.

## Acceptance criteria

- [x] **AC-1** — `readUserConfig` accepts a choice in `roles.coder.available`
      whose `tool` is `"codex"`, with its `strength`. `tools.codex` gains the
      key `windowsSandbox`, `"elevated"` or `"unelevated"`. It is required when
      a coder choice's tool is `"codex"`, and the error names
      `tools.codex.windowsSandbox`. Any other value is refused. A file giving
      Codex to the reviewer alone, with `tools.codex` holding only `executable`,
      stays valid. A coder choice whose tool is `"codex"` is refused on a
      platform other than Windows, the error saying the coder has been tried
      only on Windows. The platform is injectable for tests.
- [x] **AC-2** — `codexCoderArgs` (`scripts/dispatch/codex.mjs`) returns exactly,
      in this order: `exec`, `-s`, `workspace-write`, `-C`, the worktree, `-m`,
      the model, `-c`, `model_reasoning_effort="<effort>"`, `-c`,
      `approval_policy="never"`, `-c`, `windows.sandbox="<windowsSandbox>"`,
      `-c`, `sandbox_workspace_write.exclude_tmpdir_env_var=true`, `-c`,
      `sandbox_workspace_write.exclude_slash_tmp=true`, `--add-dir`, the session
      temp folder, `--ignore-user-config`, `--json`, `-o`, the output file,
      `--ephemeral`, `-`. A test pins the list.
- [x] **AC-3** — `spawnCodexCoder` (`scripts/dispatch/codex.mjs`) runs the session
      through `runSession` (`spawn.mjs`), with the prompt on stdin, and with
      `coderEnv`'s environment plus `TMP`, `TEMP` and `TMPDIR` set to the session
      temp folder. That folder and the output file are new, in the dispatch's
      scratch directory, outside the worktree. It resolves
      `{ classification, output, record }`. `classification.outcome` is as
      `spawnCodexReviewer` gives it, and `classification.prText` is `parsePrBlock`
      of the last message, so `coder.mjs` handles the result as it handles
      `spawnSession`'s. `output.result` is the last message.
- [x] **AC-4** — `dispatchCoder` and `retryStory` run a choice whose tool is
      `"codex"` through `spawnCodexCoder`, with `tools.codex.executable`, the
      choice's model and effort, `timeoutMs` and `stallMs` from `sessionOptions`
      when given, and the prompt `buildInvocation` renders, which on a retry
      includes `retrySection`. A choice whose tool is `"claude"` still runs
      through `spawnSession`, with the same arguments as before this story.
- [x] **AC-5** — After a Codex session whose outcome is `completed`, and before
      `pushBranch`, the dispatcher commits what the session left in the worktree,
      in `dispatchCoder` and in `retryStory`. The commit includes new, changed,
      deleted and moved files. Untracked files under `e2e/__screenshots__/`, which
      `classifyStatus` already leaves out, stay uncommitted. Its identity is the
      claim commit's. Its subject is the title of the session's PR block, or
      `<story id>: the coder's work` when the block did not parse. So a pushed
      branch with no pull request (`pr-block-invalid`) still holds the work, as
      it does for a Claude session. With nothing to commit it makes no commit, and
      `pushBranch` reports `nothing-committed` as today. After a session of any
      other outcome, or of a `"claude"` choice, it commits nothing.
- [x] **AC-6** — The commit of AC-5, and the push `pushBranch` then makes for a
      Codex session, run with git's hooks off: `core.hooksPath` set to the null
      device for that command, and `--no-verify` on the commit. A test against
      real git, in a repository whose `core.hooksPath` names a folder in the
      worktree holding `pre-commit`, `commit-msg`, `post-commit` and `pre-push`
      hooks that write a marker file, finds no marker after the commit and the
      push.
- [x] **AC-7** — For any tool, `pushBranch` pushes nothing when the branch's
      commits beyond its base add, change, delete or rename a path under
      `.claude/prompts/`. It returns the new status `prompt-change-refused`, with
      those paths under `paths` and a `reason` naming them.
      `dispatchCoder` and `retryStory` return that status and open or replace no
      pull request, and the CLI exits 1. The commits stay on the local branch, as
      `cleanUp` already keeps unpushed commits. Commits already at the base do not
      count, so a retry on a branch where someone applied a proposed prompt edit by
      hand still pushes.
- [x] **AC-8** — `.claude/prompts/coder.md` stays one prompt, and gains one
      section, headed `## If you are running under the Codex CLI`, that says the
      rules are the same and these things differ: the coder runs no `git add`,
      `git mv` or `git commit`, because the sandbox refuses them, and leaves its
      changes in the worktree, moving the story file with an ordinary file move,
      for ATC to commit; so its report gives no head SHA, and uncommitted work is
      not a reason to say `draft`. There is no network, whatever "Environment"
      says. Commands run in Windows PowerShell 5.1, where `&&` does not parse, and
      npm is run as `npm.cmd`, because PowerShell's policy blocks `npm.ps1`. It
      waits for every command to finish before ending its report. A test that
      fails only under the sandbox is reported in **Verification** with its output,
      not changed. Writes under `.claude/prompts/` are not refused by the sandbox
      but the rule is the same, and ATC refuses to push them. The text above the
      file's `---`, which says how the session is started, covers both tools.
- [x] **AC-9** — `docs/user-config.md` describes `tools.codex.windowsSandbox` and
      a coder choice whose tool is `"codex"`: what the session may do, that ATC
      commits for it, that the flags were tried on codex-cli 0.163.0 on Windows
      and nowhere else, and that such a session can read files outside its worktree, such as
      `~/.codex/auth.json` and `~/.claude/.credentials.json`, so that what it
      copies into the worktree would be committed and pushed. Its "Until a Codex
      coder is built (ST-15)" sentence goes. `README.md`'s requirements say Codex
      may run the coder too, and say the same about reading credentials. The
      comments at `scripts/dispatch/user-config.mjs` (`ROLE_TOOLS`) and
      `scripts/dispatch/coder.mjs` (`codexUsage`) that say a Codex coder is yet to
      come are corrected, and so is the sentence "Never commits on the coder's
      behalf" on `pushBranch`, which stays true of `pushBranch` and now says who
      does.
- [x] **AC-10** — `story.mjs`, `loop.mjs` and `land.mjs` are not in the diff.
      Replacing a coder's tool stays a change to the settings plus the tool's
      adapter (`docs/agent-workflow-design.md`, "Other companies' models (OQ-114)",
      M6).
- [x] **AC-11** — Every `**Planned (…)**` marker in
      `docs/agent-workflow-design.md` that names ST-15 loses `ST-15`, as that
      document's "Reading this document" note says. The sentence in the entry
      "A choice named by hand is final, and ATC moves off a spent tool" that begins
      "Until ST-15 is built" is corrected.

## Out of scope

- Keeping a session from reading credentials, or checking what the dispatcher's
  commit holds for one. Isolation is ST-6, planned for 0.4 (`docs/outline.md`).
  AC-9 states the limit instead.
- A Codex coder on another platform. It has not been tried. A later trial lifts
  AC-1's refusal.
- A cost bound for a Codex session. `codex exec` has none here; the time limit and
  stall interval apply.
- `steward init` offering a Codex coder. The crew writes the choice into the file.
- Running the coder on steward itself, the coder loop (`loop.mjs`, `story.mjs`),
  and resuming a session that left work uncommitted (ST-14, parked).
- The crew's first real run of `coder.mjs` on a Codex choice, on
  `luplows/playground`. It is the crew's to run after this lands, and goes in
  "Trials and measurements". The trial did not run `coder.mjs` or its retry path.
- Changing what the gate decides: verdicts, the round bound, landing.

## Constraints

- A coder session stays under `-s workspace-write`. The flags are AC-2's, because
  the trial showed what each one changes.

## Context

- `docs/agent-workflow-design.md`: "Trials and measurements", "Codex as coder", for
  what each flag does and what the sandbox refused and allowed; Part 3, "Decided so
  far", for the decision and what was not chosen; "Other companies' models
  (OQ-114)", M3, M5 and M6.
- `scripts/dispatch/codex.mjs`: `codexReviewerArgs` and `spawnCodexReviewer` are
  the pattern. M3's guarantees are shown here as the reviewer's were, by tests of
  the arguments and the environment, since CI has no Codex.
- `scripts/dispatch/coder.mjs`: `dispatchCoder` and `retryStory` each call
  `spawnSession` once; `pushBranch`, `classifyStatus`, `cleanUp`; the claim commit's
  identity; `pickCoderChoice` already reads a Codex choice's usage.
- `scripts/dispatch/review.mjs` around `codexSession`: how a Codex choice is told
  from a Claude one, and `chooseReviewer`, which keeps the reviewer on another
  model through the `Coder:` line.
- `.claude/prompts/reviewer.md`, "If you are running under the Codex CLI", is the
  pattern for AC-8. `.claude/prompts/coder.md` says a spawned session cannot edit
  its own prompt: a coder gives AC-8 as a `### Proposed prompt edit`, as that file
  describes.
- `docs/outline.md`'s 0.2.0 runs a bounded coder, which may rework `coder.mjs`.
  Keeping the tool's specifics in `codex.mjs` is what lets them carry over.

## Open questions

*(none)*
