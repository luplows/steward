---
id: ST-13
title: Let the reviewer's helper run a repository script with node, and still refuse node's flags
tier: normal
kind: workflow
depends_on: []
model: sonnet
blocked: "Built by hand: changes .claude/prompts/reviewer.md, which a spawned coder session cannot edit (docs/agent-workflow-design.md, A spawned session cannot edit .claude/prompts/)"
---

## Intent

As a member of the crew, I want a reviewer to be able to capture the exit
code of a repository script, such as `node scripts/lint-stories.mjs`, so that
a review can confirm a check passed rather than inferring it from what the
check printed. `scripts/dispatch/review-tools.mjs` refuses every `node`
command, to keep `node -e` out of it. That also refuses the repository's own
scripts, and a shell's `$?` is refused too. So today no reviewer can capture
such an exit code.

## Acceptance criteria

- [ ] **AC-1** — `review-tools.mjs` accepts a command of the form
      `node <script> [args…]`, where `<script>`:
      - is the first argument after `node`, and does not start with `-`;
      - ends in `.mjs` or `.js`;
      - resolves, with `path.resolve` against the working directory, to an
        existing file inside the working directory, and not above it.

      It starts such a command as `process.execPath` with the script and the
      remaining arguments, with `execFile` and no shell, as it starts every
      other command. `repeat`, `exit` and `sorted` all accept it. A test
      asserts the program and arguments started for
      `node scripts/lint-stories.mjs` and for
      `node scripts/dispatch/queue.mjs --x`.
- [ ] **AC-2** — Every other `node` command is still refused before anything
      starts. Tests assert refusal, with no process started, for:
      - `node` alone;
      - a flag in the script position: `node -e 1`, `node --eval 1`,
        `node -p 1`, `node -v`, `node --require x scripts/lint-stories.mjs`;
      - a script path that leaves the working directory:
        `node ../x.mjs`, and an absolute path outside it;
      - a script that does not exist;
      - a script without a `.mjs` or `.js` extension.

      OQ-92's existing refusal tests (`node -e`, and `node -v` on `win32`)
      still pass unchanged.
- [ ] **AC-3** — The module header's description of what the helper runs is
      updated to say that a repository script may be run with `node`, and
      that `node`'s flags may not. `allowedPrefixes()` still leaves `node`
      out, so a `node` command is admitted only by AC-1's rule.
- [ ] **AC-4** — `.claude/prompts/reviewer.md`, "Verify rather than accept",
      which says the helper refuses every `node` command, says instead that
      it runs a repository script with `node`, and refuses `node`'s flags.

## Out of scope

- **Changing any allowlist.** `reviewerAllowedTools()` is unchanged.
- **Narrowing the reviewer's direct `node` access.** That is ST-3's
  (formerly tower-workshop-paths OQ-62), as OQ-92 said.

## Constraints

- Node, ESM, no new runtime dependencies.
- The helper can still do nothing the reviewer's allowlist cannot. A reviewer
  can already run `node <script>` directly under `Bash(node:*)`, so AC-1
  widens nothing.

## Context

Formerly tower-workshop-paths OQ-103.

- `scripts/dispatch/review-tools.mjs` (OQ-92):
  - `allowedPrefixes()` takes the `Bash(<prefix>:*)` entries of
    `reviewerAllowedTools()` and drops `node`
    (`if (m && m[1] !== 'node')`).
  - `resolveCommand` refuses anything whose line does not start with an
    allowed prefix, with the message `"<program>" is not an allowed reviewer
    command`.
  - `startProcess` starts commands with `execFile`, no shell.
- Tower-workshop-paths' `stories/done/OQ-92-reviewer-refused-commands.md`,
  AC-2: the helper runs a command only if it matches a `Bash(<prefix>:*)`
  entry "and is not `node` itself", and its tests refuse `node -e`. This
  story keeps that intent, keeping arbitrary code out of the helper, and
  admits only a file in the repository.
- `scripts/dispatch/review-tools.test.mjs`: the `OQ-92/AC-2` refusal table
  includes `['node -e', ['node', '-e', '1']]`, and "still refuses node on
  win32" refuses `node -v`.
- Seen in reviews of tower-workshop-paths' #172, #173 and #174 on
  2026-09-28: each reviewer had
  `review-tools.mjs exit -- node scripts/lint-stories.mjs` refused. The
  reviewers of #172 and #174 also had `$?` refused. Each fell back to running
  the lint directly and reading its output, or to `node -e` calling `lintAll`
  or `spawnSync`.
- Raised by tower-workshop-paths' dispatcher session; the owner asked for
  this follow-up.

## Open questions

*(none)*
