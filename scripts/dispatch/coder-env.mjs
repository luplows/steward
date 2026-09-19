#!/usr/bin/env node
/**
 * The coder's capability contract (OQ-63): what a coder invocation is
 * allowed to touch, and what its process environment carries.
 *
 * A coder must push its own branch, so it cannot simply be handed no GitHub
 * access the way the reviewer is (OQ-62). Instead its *credential* is
 * narrowed rather than its command surface: `coderEnv` strips anything that
 * would let `gh`, a `curl` invocation, or any other process reach GitHub's
 * write API (commit statuses, workflow dispatch, pull request writes), while
 * leaving git's own push authentication (SSH key / credential helper)
 * untouched. That is what makes the guarantee survive `node -e`, `npm`, and
 * `npx` reaching past the Bash tool's allowlist entirely (AC-4) -- it has
 * nothing to do with which command was used, only with whether a usable
 * credential exists in the environment that command inherits.
 *
 * `coderAllowedTools` is the separate, complementary layer: it scopes `git
 * push` to the one branch a given invocation was spawned for, which is a
 * property `coderEnv` alone can't provide (a credential valid for the repo is
 * valid for any branch in it).
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
 * Deliberately does not touch anything push authentication needs (SSH agent
 * socket, `GIT_SSH_COMMAND`, a credential helper's own storage): those are
 * how AC-5 keeps working once this runs.
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
 * The coder's `--allowedTools` list for one invocation. `branch` is the exact
 * branch that invocation was spawned to work on (the dispatcher already knows
 * it -- it created the worktree). Push is scoped to literal patterns naming
 * that branch, not `Bash(git push:*)`, so pushing to `main` or to any other
 * branch is refused at the tool-permission layer (AC-5) even though the
 * underlying credential, being repo-wide, does not itself enforce that.
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
    throw new Error('coderAllowedTools requires the branch, so push can be scoped to it')
  }

  return [
    'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite',
    ...READ_ONLY_GIT_TOOLS,
    'Bash(git add:*)',
    'Bash(git commit:*)',
    `Bash(git push origin HEAD:${branch})`,
    `Bash(git push origin ${branch}:${branch})`,
    'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)',
  ]
}

/**
 * Denied outright, on top of `gh` simply having nothing to authenticate with
 * (`coderEnv`). Raises the floor against the ordinary, non-bypassing path the
 * same way OQ-62 denies it to the reviewer -- see `coderEnv`'s doc comment
 * for why this alone would not satisfy AC-4.
 *
 * Deliberately does *not* include `Bash(git push:*)`, unlike the reviewer's
 * equivalent list. Deny rules take precedence over allow rules, and that
 * pattern prefix-matches the scoped `Bash(git push origin HEAD:<branch>)` /
 * `Bash(git push origin <branch>:<branch>)` entries `coderAllowedTools`
 * grants -- applied together, the coder could not push at all, defeating
 * AC-5. The reviewer can carry the blanket deny because its allowlist never
 * grants push in the first place, so there is nothing for it to shadow; the
 * coder's allowlist does, so the deny has to stop short of it. Scoping push
 * to one branch is `coderAllowedTools`'s job, not this list's.
 */
export const CODER_DISALLOWED_TOOLS = ['Bash(gh:*)']
