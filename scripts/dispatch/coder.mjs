#!/usr/bin/env node
/**
 * Takes the next ready story from the queue to an open pull request (OQ-70):
 * pick it, create its branch and a dedicated worktree from the current
 * `origin/main`, spawn the coder there, check the branch really reached the
 * remote, and open the pull request from the block the coder emitted.
 *
 * It joins existing modules and reimplements none of them: `queue.mjs` decides
 * which story, `spawn.mjs` runs the session (building the prompt, environment
 * and allowlist through `invocation.mjs`, so `coderEnv` and `coderAllowedTools`
 * are never restated here), `github.mjs` opens the pull request.
 *
 * It sets no commit status and triggers no workflow: `review-gate.yml` sets
 * `review/agent` pending when the pull request opens, and opening it is
 * therefore sufficient.
 *
 * A change to `.claude/prompts/` that the coder emitted as a diff is reported,
 * never applied (AC-7b). This module reads the prompt template from the
 * dispatcher's own checkout and writes nothing outside its scratch directory
 * and the git worktree machinery.
 *
 * Every way this can stop short is a distinct `status` on the result, and each
 * leaves a state someone can see: a pushed branch with no pull request, or
 * nothing at all. It never opens a pull request with a description the coder
 * did not write.
 *
 * Usage:
 *   node scripts/dispatch/coder.mjs [OQ-<n>] [--repo owner/name]
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createContext, createPullRequest } from './github.mjs'
import { dispatchable, loadQueue, parseFrontmatter } from './queue.mjs'
import { spawnSession } from './spawn.mjs'

const execFileAsync = promisify(execFile)

const DISPATCH_DIR = path.dirname(fileURLToPath(import.meta.url))
const DISPATCHER_ROOT = path.resolve(DISPATCH_DIR, '..', '..')
const CODER_PROMPT = path.join(DISPATCHER_ROOT, '.claude', 'prompts', 'coder.md')

const DEFAULT_REPO = 'luplows/tower-workshop-paths'
const REMOTE = 'origin'
const BASE = 'main'

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout
}

/** Like `git`, but a non-zero exit is `null` rather than a throw. */
async function gitOrNull(cwd, args) {
  try {
    return await git(cwd, args)
  } catch {
    return null
  }
}

/** The branch a story is worked on: `story/` plus its filename without `.md`. */
export function branchFor(storyFilename) {
  return `story/${storyFilename.replace(/\.md$/, '')}`
}

/** The tip of `branch` on the remote, or `null` when it is not there. */
async function remoteTip(repoDir, branch) {
  const out = await git(repoDir, ['ls-remote', '--heads', REMOTE, `refs/heads/${branch}`])
  const line = out.split(/\r?\n/).find((l) => l.trim() !== '')
  return line ? line.split(/\s+/)[0] : null
}

/**
 * Finds a prompt change the coder emitted in its PR body (coder.md's
 * `### Proposed prompt edit` heading) and names the `.claude/prompts/` files
 * its diff touches. Reads text only; the paths come from the coder's own
 * output and are reported, never used.
 */
export function findPromptChange(body) {
  const lines = body.split(/\r?\n/)
  const at = lines.findIndex((line) => /^#{2,4}\s+Proposed prompt edit\s*$/i.test(line))
  if (at === -1) return null
  const files = new Set()
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,3}\s/.test(line)) break
    const m = line.match(/^(?:diff --git a\/|\+\+\+ b\/|--- a\/)(\.claude\/prompts\/\S+)/)
    if (m) files.add(m[1])
  }
  return { pending: true, files: [...files] }
}

/** Removes the worktree, then the local branch when doing so loses nothing. */
async function cleanUp({ repoDir, tree, branch, baseSha, worktreeAdded }) {
  if (worktreeAdded) await git(repoDir, ['worktree', 'remove', '--force', tree]).catch(() => {})
  const tip = (await gitOrNull(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]))?.trim()
  if (!tip) return
  const pushed = await remoteTip(repoDir, branch).catch(() => null)
  // Unpushed commits are the only copy of the coder's work; keep them.
  if (tip === baseSha || tip === pushed) await git(repoDir, ['branch', '-D', branch]).catch(() => {})
}

/**
 * Runs the coder half for the next ready story.
 *
 *   ctx            a `github.mjs` context (`createContext`)
 *   repoDir        the dispatcher's own checkout: the queue is read from it,
 *                  and the worktree is made from its object store. Its `stories/`
 *                  should be current; the story text the coder receives is read
 *                  from the worktree, i.e. from `origin/main`. Defaults to this
 *                  file's repo
 *   storyId        run this story instead of the head of the queue. It must
 *                  still be `ready`; this is not a second ordering
 *   promptTemplate coder.md's text; defaults to the copy beside this file
 *   baseEnv        the environment to derive the session's from; defaults to
 *                  `process.env`. `coderEnv` strips the credentials
 *   sessionOptions extra `spawnSession` options (executable, run, timeouts,
 *                  budget)
 *
 * Resolves `{ status, ... }`. `opened` carries the pull request. Every other
 * status means none was opened, and `reason` says why. `nothing-ready` is not
 * a failure.
 */
export async function dispatchCoder({
  ctx, repoDir = DISPATCHER_ROOT, storyId, promptTemplate, baseEnv = process.env, sessionOptions = {},
}) {
  const template = promptTemplate ?? readFileSync(CODER_PROMPT, 'utf8')

  const queue = await loadQueue(repoDir)
  let chosen
  if (storyId) {
    chosen = queue.find((s) => s.id === storyId)
    if (!chosen) throw new Error(`${storyId} is not in the queue`)
    if (chosen.status !== 'ready') {
      return { status: 'not-ready', storyId, reason: `${storyId} is ${chosen.status}, not ready` }
    }
  } else {
    chosen = dispatchable(queue)[0]
    if (!chosen) return { status: 'nothing-ready', reason: 'no story in the queue is ready' }
  }

  const filename = path.basename(chosen.filePath)
  const storyPath = `stories/${filename}`
  const branch = branchFor(filename)

  if (await gitOrNull(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) {
    return { status: 'branch-exists', branch, reason: `${branch} already exists locally` }
  }
  await git(repoDir, ['fetch', REMOTE, BASE])
  // An existing remote branch would make "it is on the remote" (AC-4) no evidence.
  if (await remoteTip(repoDir, branch)) {
    return { status: 'branch-exists', branch, reason: `${branch} already exists on ${REMOTE}` }
  }
  const baseSha = (await git(repoDir, ['rev-parse', `${REMOTE}/${BASE}`])).trim()

  const scratch = await mkdtemp(path.join(tmpdir(), 'tw-coder-'))
  const tree = path.join(scratch, 'tree')
  let worktreeAdded = false
  try {
    // `--no-track`: a branch made from `origin/main` otherwise tracks it, and a
    // bare `git push` on it would aim at `main` (AC-2).
    await git(repoDir, ['worktree', 'add', '--no-track', '-b', branch, tree, `${REMOTE}/${BASE}`])
    worktreeAdded = true

    const text = readFileSync(path.join(tree, storyPath), 'utf8')
    const { data } = parseFrontmatter(text, storyPath)
    const story = { id: chosen.id, path: storyPath, text, model: data.model ?? null }

    const ghConfigDir = path.join(scratch, 'gh-config')
    await mkdir(ghConfigDir)
    const { classification } = await spawnSession({
      ...sessionOptions,
      role: 'coder',
      promptTemplate: template,
      story,
      branch,
      baseEnv,
      emptyGhConfigDir: ghConfigDir,
      cwd: tree,
    })

    // What the session says and what the remote holds are separate questions.
    const pushedSha = await remoteTip(repoDir, branch)
    const pushed = pushedSha !== null && pushedSha !== baseSha
    const context = { storyId: chosen.id, branch, headSha: pushedSha }

    if (classification.outcome !== 'completed') {
      return { status: 'session-failed', ...context, outcome: classification.outcome, reason: classification.reason, pushed }
    }
    if (!pushed) {
      return { status: 'nothing-pushed', ...context, reason: `${branch} is not on ${REMOTE} with any commit of its own` }
    }

    const block = classification.prText
    if (block.status !== 'parsed') {
      return { status: 'pr-block-invalid', ...context, reason: block.reason }
    }

    // The coder may have set `blocked:` (coder.md); it does so in the story file
    // on the branch, wherever the file then is, so read the pushed tip.
    await git(repoDir, ['fetch', REMOTE, `+refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`])
    let blocked = null
    let readable = false
    for (const candidate of [storyPath, `stories/done/${filename}`]) {
      const source = await gitOrNull(repoDir, ['show', `${pushedSha}:${candidate}`])
      if (source === null) continue
      try {
        blocked = parseFrontmatter(source, candidate).data.blocked
        readable = true
      } catch (error) {
        return { status: 'story-unreadable', ...context, reason: error.message }
      }
      break
    }
    if (!readable) {
      return { status: 'story-unreadable', ...context, reason: `${filename} is on neither stories/ nor stories/done/ at ${pushedSha}` }
    }
    const isBlocked = blocked !== null

    // The coder's flag is honoured exactly, except that a `blocked:` story is
    // always a draft, which is what keeps the sweep off it (AC-8).
    const draft = isBlocked || block.draft
    const pr = await createPullRequest(ctx, { title: block.title, body: block.body, head: branch, base: BASE, draft })

    const result = { status: 'opened', ...context, pr, draft, blocked: isBlocked ? blocked : null }
    const promptChange = findPromptChange(block.body)
    if (promptChange) result.promptChange = promptChange
    return result
  } finally {
    await cleanUp({ repoDir, tree, branch, baseSha, worktreeAdded })
    await rm(scratch, { recursive: true, force: true })
  }
}

// --------------------------------------------------------------------- CLI

const NON_FAILURES = ['opened', 'nothing-ready']

async function main(argv) {
  const args = [...argv]
  const repoAt = args.indexOf('--repo')
  const repo = repoAt === -1 ? DEFAULT_REPO : args.splice(repoAt, 2)[1]
  const storyId = args.shift()
  if (args.length > 0 || (storyId !== undefined && !/^OQ-\d+$/.test(storyId))) {
    throw new Error('usage: node scripts/dispatch/coder.mjs [OQ-<n>] [--repo owner/name]')
  }
  const result = await dispatchCoder({ ctx: createContext({ repo }), storyId })
  console.log(JSON.stringify(result, null, 2))
  if (result.promptChange) {
    const named = result.promptChange.files.length > 0 ? result.promptChange.files.join(', ') : 'files not named in the diff'
    console.log(`\nA prompt change is pending manual application (${named}); it is in the pull request body under "Proposed prompt edit".`)
  }
  if (!NON_FAILURES.includes(result.status)) process.exitCode = 1
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
