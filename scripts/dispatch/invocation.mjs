/**
 * Builds a coder or reviewer `claude -p` invocation without running anything
 * (OQ-74): the argument list, the environment, the allowlists and the
 * rendered prompt. Pure -- it starts no process, reads no session output and
 * performs no GitHub operation. Starting and supervising the process is
 * OQ-65's; classifying how it ended is OQ-75's (`outcome.mjs`); deciding that
 * a retry happens is OQ-48's.
 *
 * The prompt is returned as its own value and never appears in an argument:
 * it is far too large for a command line, and OQ-65 delivers it on stdin.
 *
 * Every allowlist the session needs is built here and passed on the command
 * line. `permissions.allow` in `.claude/settings.json` is ignored without
 * warning when the workspace is not trusted, so a role that relied on it would
 * lose those tools silently; each role's list is complete on its own.
 */

import { coderAllowedTools, coderEnv, CODER_DISALLOWED_TOOLS, READ_ONLY_SHELL_UTILS } from './coder-env.mjs'
import { render, wrapInjectedBlock } from './render.mjs'

export const ROLES = ['coder', 'reviewer']

// The per-role defaults are the values in docs/agent-workflow-design.md,
// "Invocation shape". Each can be overridden by the caller.
export const ROLE_DEFAULTS = {
  coder: { effort: 'medium', maxBudgetUsd: 6 },
  reviewer: { model: 'opus', effort: 'high', maxBudgetUsd: 3 },
}

const REVIEWER_GIT_TOOLS = [
  'Bash(git fetch:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git rev-parse:*)',
  'Bash(git merge-base:*)',
  'Bash(git grep:*)',
  'Bash(git cat-file:*)',
  'Bash(git ls-files:*)',
  'Bash(git status:*)',
  'Bash(git branch:*)',
  'Bash(git ls-remote:*)',
  'Bash(git ls-tree:*)',
]

// The one reviewer `git` verb that writes, kept apart so the list above stays
// honestly read-only. `git merge-tree --write-tree` adds tree and blob objects
// to the shared object store. It moves no ref and touches no index or working
// tree, and nothing references what it writes, so `git gc` eventually prunes
// it. It is granted so the reviewer can check a claim that two branches merge
// cleanly instead of leaving that to whoever ran it.
const REVIEWER_GIT_OBJECT_WRITERS = [
  'Bash(git merge-tree:*)',
]

/**
 * The reviewer's `--allowedTools` list. `git` verbs are enumerated rather than
 * granting `Bash(git:*)`, so `git push` is absent from the list before
 * `REVIEWER_DISALLOWED_TOOLS` also removes it. All are read-only except
 * `git merge-tree`, which writes unreferenced objects (see above). `npm`, `npx` and `node`
 * are granted because verifying the author's claims means running the suite;
 * that is arbitrary execution, so this is defence in depth, not containment
 * (see reviewer.md). The read-only shell utilities are `coder-env.mjs`'s
 * `READ_ONLY_SHELL_UTILS`, imported so the two roles cannot drift apart on
 * which utilities are safe. No `gh`, no `git push`.
 */
export function reviewerAllowedTools() {
  return [
    'Read', 'Glob', 'Grep', 'TodoWrite',
    ...REVIEWER_GIT_TOOLS,
    ...REVIEWER_GIT_OBJECT_WRITERS,
    'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)',
    ...READ_ONLY_SHELL_UTILS,
  ]
}

export const REVIEWER_DISALLOWED_TOOLS = [
  'Edit', 'Write', 'NotebookEdit', 'Bash(git push:*)', 'Bash(gh:*)',
]

/**
 * The `claude -p` argument list for `role`. The prompt is not part of it.
 * `allowedTools` and `disallowedTools` come last because both flags are
 * variadic.
 */
export function buildArgs({ role, model, effort, maxBudgetUsd, branch }) {
  if (!ROLES.includes(role)) throw new Error(`unknown role: ${JSON.stringify(role)}`)
  if (!model) throw new Error('buildArgs requires a model')
  if (!effort) throw new Error('buildArgs requires an effort level')
  if (!(typeof maxBudgetUsd === 'number' && maxBudgetUsd > 0)) {
    throw new Error('buildArgs requires a positive maxBudgetUsd')
  }

  const common = [
    '-p',
    '--permission-prompts', 'none',
    '--max-budget-usd', String(maxBudgetUsd),
    '--output-format', 'json',
    '--model', model,
    '--effort', effort,
  ]

  if (role === 'coder') {
    return [
      ...common,
      '--permission-mode', 'acceptEdits',
      '--allowedTools', ...coderAllowedTools(branch),
      '--disallowedTools', ...CODER_DISALLOWED_TOOLS,
    ]
  }
  return [
    ...common,
    '--allowedTools', ...reviewerAllowedTools(),
    '--disallowedTools', ...REVIEWER_DISALLOWED_TOOLS,
  ]
}

// Placeholders whose values are substituted inline into a sentence and cannot
// be bounded as a block. Each is validated against a pattern that cannot carry
// a newline, a marker or a heading. Every placeholder NOT named here is
// wrapped with `wrapInjectedBlock`: the default fails closed, so a new
// placeholder (a `{{FINDINGS}}`) is bounded unless someone declares it
// trusted, rather than unbounded unless someone remembers to wrap it.
const TRUSTED_INLINE = {
  STORY_ID: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  STORY_PATH: /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
  BRANCH: /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
  HEAD_BRANCH: /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
  HEAD_SHA: /^[0-9a-f]{40}$/,
  PR_NUMBER: /^[0-9]+$/,
}

/**
 * `render` with the injection boundary applied by name (OQ-51's guarantee,
 * which `render` deliberately leaves to its caller). `values` maps placeholder
 * name to string; names in `TRUSTED_INLINE` are validated and passed through,
 * all others are wrapped as injected blocks.
 */
export function renderBounded(fileText, values) {
  const bounded = {}
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== 'string') throw new Error(`value for ${name} must be a string`)
    const pattern = TRUSTED_INLINE[name]
    if (pattern) {
      if (!pattern.test(value)) throw new Error(`value for trusted placeholder ${name} is not a plain token`)
      bounded[name] = value
    } else {
      bounded[name] = wrapInjectedBlock(name, value)
    }
  }
  return render(fileText, bounded)
}

function checkCount(name, n) {
  if (!Number.isInteger(n) || n < 0) throw new Error(`retry.${name} must be a non-negative integer`)
}

// A retry has already moved its story file, so its path is under done/.
function donePath(storyPath) {
  return storyPath.startsWith('stories/done/') ? storyPath : storyPath.replace(/^stories\//, 'stories/done/')
}

/**
 * The section appended to a retry's prompt. It carries the contract a retry
 * previously depended on a person writing by hand: which round this is, what
 * already exists, and that the emitted PR body replaces rather than appends.
 * It lives here rather than in coder.md because a coder cannot edit
 * `.claude/prompts/`. The findings are an injected block like any other.
 *
 * It names the exact push command, because the coder's allowlist permits only
 * scoped forms (`coderAllowedTools`) and "push to the same branch" invited a
 * bare `git push`, which is denied. That happened in #133's round 2.
 */
export function retrySection({ round, roundsRemaining, findings, branch }) {
  checkCount('round', round)
  checkCount('roundsRemaining', roundsRemaining)
  if (typeof findings !== 'string' || findings.trim() === '') {
    throw new Error('retry.findings must be a non-empty string')
  }
  if (typeof branch !== 'string' || branch === '') {
    throw new Error('retrySection requires the branch, to name the push command')
  }
  return [
    '## This is a retry',
    '',
    `This is round ${round}. ${roundsRemaining} round(s) remain after this one.`,
    '',
    'Your earlier work is not lost, and you are not starting over:',
    '',
    '- Your branch already exists and already carries your earlier commits. Continue on it.',
    '- A pull request for that branch already exists. Do not try to open another; you cannot open one in any case. Push to the same branch and it updates.',
    `- Push with exactly \`git push origin ${branch}\`. A bare \`git push\`, or \`git -C <path> push\`, is not on your allowlist and will be denied.`,
    '- The story file has already been moved to `stories/done/` on that branch. Do not move it again.',
    '- The `## PR body` you emit will **replace** the existing description, not be appended to it. Write it complete, covering the whole change so far, not only what this round changed. Keep all three sections of `.github/pull_request_template.md` (What changed, Verification, Docs check): a replacement that drops one is a missing section, and review blocks on it.',
    '',
    'The review findings to address are below. Fix the genuine ones with a new commit. If you believe one is wrong, say so under a `## Response to review` heading in your final report.',
    '',
    wrapInjectedBlock('FINDINGS', findings),
  ].join('\n')
}

/**
 * Builds everything needed to start one session, and starts nothing.
 *
 *   role            'coder' | 'reviewer'
 *   promptTemplate  the text of the role's prompt file (the caller reads it)
 *   story           { id, path, text, model }
 *   branch          coder: the branch it works on. reviewer: the PR's head branch
 *   pr              reviewer only: { number, headSha, body }
 *   retry           coder only, optional: { round, roundsRemaining, findings }
 *   baseEnv         the environment to derive the process environment from
 *   emptyGhConfigDir  coder only: see `coderEnv`
 *   model, effort, maxBudgetUsd  optional overrides of `ROLE_DEFAULTS`
 *
 * Returns `{ args, env, prompt }`. `prompt` is for stdin (OQ-65) and appears
 * in no element of `args`. The coder's `env` is `coderEnv`'s, so no GitHub
 * credential survives into it. The reviewer's is a copy of `baseEnv`:
 * removing the reviewer's credentials is OQ-62's, not this story's.
 */
export function buildInvocation(options) {
  const { role, promptTemplate, story, branch, pr, retry, baseEnv, emptyGhConfigDir } = options
  if (!ROLES.includes(role)) throw new Error(`unknown role: ${JSON.stringify(role)}`)
  if (!story) throw new Error('buildInvocation requires a story')

  const defaults = ROLE_DEFAULTS[role]
  const args = buildArgs({
    role,
    branch,
    model: options.model ?? defaults.model ?? story.model,
    effort: options.effort ?? defaults.effort,
    maxBudgetUsd: options.maxBudgetUsd ?? defaults.maxBudgetUsd,
  })

  let values
  let env
  if (role === 'coder') {
    if (pr) throw new Error('a coder invocation takes no pr')
    values = {
      STORY_ID: story.id,
      STORY_PATH: retry ? donePath(story.path) : story.path,
      STORY: story.text,
      BRANCH: branch,
    }
    env = coderEnv(baseEnv ?? {}, emptyGhConfigDir)
  } else {
    if (retry) throw new Error('a reviewer invocation takes no retry')
    if (!pr) throw new Error('a reviewer invocation requires pr')
    values = {
      PR_NUMBER: String(pr.number),
      HEAD_BRANCH: branch,
      HEAD_SHA: pr.headSha,
      STORY_ID: story.id,
      STORY_PATH: story.path,
      STORY: story.text,
      PR_BODY: pr.body,
    }
    env = { ...(baseEnv ?? {}) }
  }

  let { text: prompt } = renderBounded(promptTemplate, values)
  if (retry) prompt = `${prompt}\n\n${retrySection({ ...retry, branch })}\n`

  return { args, env, prompt }
}
