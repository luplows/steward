#!/usr/bin/env node
/**
 * The coder's capability contract (OQ-63): what a coder invocation is
 * allowed to touch, and what its process environment carries.
 *
 * The coder's *credential* is narrowed rather than its command surface:
 * `coderEnv` strips anything that would let `gh`, a `curl` invocation, or any
 * other process reach GitHub's write API (commit statuses, workflow dispatch,
 * pull request writes). That is what makes the guarantee survive `node -e`,
 * `npm`, and `npx` reaching past the Bash tool's allowlist entirely (AC-4) --
 * it has nothing to do with which command was used, only with whether a usable
 * credential exists in the environment that command inherits. Git's own
 * authentication (SSH key / credential helper) is left in place here; the
 * coder no longer needs it, and removing it is OQ-73's.
 *
 * `coderAllowedTools` is the separate, complementary layer. The coder commits
 * and the dispatcher pushes (OQ-84, `pushBranch` in `coder.mjs`), so no `git
 * push` pattern is granted and `CODER_DISALLOWED_TOOLS` denies it outright.
 */

// Environment variables that could hand a process a GitHub API credential.
// `GH_TOKEN` and `GITHUB_TOKEN` are what `gh` and most GitHub API clients
// read; `GH_ENTERPRISE_TOKEN` is `gh`'s equivalent for a GitHub Enterprise
// host. Cleared unconditionally -- not merely left unset -- because a coder
// invocation may inherit a shell where one of these is already exported.
const CREDENTIAL_ENV_VARS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN']

/**
 * Builds the environment a coder process runs in from `baseEnv`. Strips any
 * GitHub API credential regardless of whether `baseEnv` carries one, and
 * points `gh`'s own config (where a prior `gh auth login` would otherwise be
 * found) at `emptyGhConfigDir` -- a directory the caller has verified is
 * empty of any host/token configuration, e.g. a fresh temp directory.
 *
 * Deliberately does not touch git's own authentication (SSH agent socket,
 * `GIT_SSH_COMMAND`, a credential helper's own storage); that is OQ-73's.
 */
export function coderEnv(baseEnv, emptyGhConfigDir) {
  if (!emptyGhConfigDir) {
    throw new Error('coderEnv requires emptyGhConfigDir, so gh has nowhere to find a prior login')
  }

  const env = { ...baseEnv }
  for (const key of CREDENTIAL_ENV_VARS) delete env[key]
  env.GH_CONFIG_DIR = emptyGhConfigDir
  return env
}

const READ_ONLY_GIT_TOOLS = [
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git branch:*)',
  'Bash(git fetch:*)',
]

/**
 * The shell utilities a coder uses to inspect the repository (OQ-67 AC-4).
 * Defined here rather than by each caller, because every hand-run of the loop
 * invented its own set.
 *
 * Every entry must be unable to write in *any* mode, not merely in the way it
 * is usually called (AC-5). That rules out utilities that are read-only by
 * habit: `sed` (`-i`, and its `w` command), `sort` (`-o`), `uniq` (a second
 * operand is an output file), `find` (`-delete`, `-exec`), `awk`, `tee`,
 * `xargs` (runs its operands), `dd` (`of=`), and any interpreter (`perl`).
 * The test asserts the property by probing each entry with write-shaped
 * arguments rather than by comparing the list to a fixed one. Those probes
 * are themselves a fixed set, so a new entry is only as safe as the probes
 * are complete: check its write modes against them when adding it.
 *
 * Shell redirection (`cat f > g`) is out of this list's reach: it is a
 * property of the shell, not of the utility, and applies equally to
 * `git log > g`. The coder holds `Write` anyway; the point of "read-only"
 * here is that the list does what its name says.
 */
export const READ_ONLY_SHELL_UTILS = [
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
  'Bash(grep:*)',
  'Bash(diff:*)',
  'Bash(cut:*)',
  'Bash(pwd:*)',
]

/**
 * The coder's `--allowedTools` list for one invocation, read-only shell
 * utilities included. `branch` is the exact branch that invocation was
 * spawned to work on (the dispatcher already knows it -- it created the
 * worktree). No `git push` is granted (OQ-84): the coder commits, and the
 * dispatcher pushes the branch itself. Two coders were refused a push spelling
 * and stopped on that alone (#140, #145). `branch` may still not be `main`.
 *
 * `git mv` is granted because `coder.md` requires the story file to be moved
 * with it (`REVIEW.md` item 19). It rewrites the working tree and index only,
 * the same reach `Write` and `git add` already have.
 *
 * `gh` is not included, in either form -- there is no longer a legitimate use
 * for it here (AC-6 moves PR creation to whatever spawned the coder), so
 * there is nothing to allowlist. See `coderEnv` for why that omission is
 * defence in depth rather than the guarantee itself: `Bash(gh:*)` being
 * absent from this list does not stop `node -e` from invoking the `gh`
 * binary directly.
 */
export function coderAllowedTools(branch) {
  if (!branch) {
    throw new Error('coderAllowedTools requires the branch the coder is assigned')
  }
  if (branch === 'main' || branch === 'refs/heads/main') {
    throw new Error('coderAllowedTools refuses main: a coder is never assigned main')
  }

  return [
    'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite',
    ...READ_ONLY_GIT_TOOLS,
    'Bash(git add:*)',
    'Bash(git mv:*)',
    'Bash(git commit:*)',
    'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)',
    ...READ_ONLY_SHELL_UTILS,
  ]
}

/**
 * Denied outright, on top of `gh` simply having nothing to authenticate with
 * (`coderEnv`). Raises the floor against the ordinary, non-bypassing path the
 * same way OQ-62 denies it to the reviewer -- see `coderEnv`'s doc comment
 * for why this alone would not satisfy AC-4.
 *
 * `Bash(git push:*)` is denied as a second barrier, as the reviewer's list does
 * (OQ-84): `coderAllowedTools` grants no push, so the deny shadows nothing.
 */
export const CODER_DISALLOWED_TOOLS = ['Bash(gh:*)', 'Bash(git push:*)']
