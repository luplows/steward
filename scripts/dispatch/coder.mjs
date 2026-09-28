#!/usr/bin/env node
/**
 * Takes the next ready story from the queue to an open pull request (OQ-70):
 * pick it, create its branch and a dedicated worktree from the current
 * `origin/main`, spawn the coder there, push the branch it committed, and open
 * the pull request from the block the coder emitted.
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
 * The coder commits and the dispatcher pushes (OQ-84): `pushBranch` runs after a
 * session that ended `completed`, so the session needs no write access to the
 * remote. Every result returned after a session has run carries that session's
 * output under `session`.
 *
 * Every way this can stop short is a distinct `status` on the result, and each
 * leaves a state someone can see: a pushed branch with no pull request, a local
 * branch holding the coder's commits, or nothing at all. It never opens a pull request with a description the coder
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
import { coderEnv } from './coder-env.mjs'
import { buildGetPullRequestState, createContext, createPullRequest, parsePullRequestState, replacePullRequest } from './github.mjs'
import { installDependencies } from './install.mjs'
import { RETRY_SOURCES } from './invocation.mjs'
import { buildStory, deriveStatus, dispatchable, isStoryFilename, orderStories, parseFrontmatter } from './queue.mjs'
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

/**
 * The queue as it stands at `ref`, built with `queue.mjs`'s own parsing,
 * status derivation and ordering. Only regular files count (`loadQueue` skips
 * anything else, so a symlink named like a story is not one here either).
 */
async function loadQueueAt(repoDir, ref) {
  const listing = await git(repoDir, ['ls-tree', ref, 'stories/', 'stories/done/'])
  const built = []
  for (const line of listing.split(/\r?\n/)) {
    const m = line.match(/^(\d+) blob [0-9a-f]+\t(stories\/(?:done\/)?([^/]+))$/)
    if (!m || !m[1].startsWith('100') || !isStoryFilename(m[3])) continue
    built.push(buildStory(m[2], await git(repoDir, ['show', `${ref}:${m[2]}`]), m[2].startsWith('stories/done/')))
  }
  const doneIds = new Set(built.filter((story) => story.isDone).map((story) => story.id))
  return orderStories(built.map((story) => ({ ...story, ...deriveStatus(story, doneIds) })))
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

const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const SCREENSHOT_DIR = 'e2e/__screenshots__/'

/**
 * The arguments of the one push the dispatcher makes: `git push origin <branch>`.
 * The branch must be a plain name, which is what keeps a forced form (a `+`
 * refspec or an option), a refspec (`a:b`) or `main` from being constructible.
 */
export function pushArgs(branch) {
  if (typeof branch !== 'string' || !BRANCH_NAME.test(branch) || branch.includes('..')) {
    throw new Error(`pushArgs requires a plain branch name, got ${JSON.stringify(branch)}`)
  }
  if (branch === BASE || branch === `refs/heads/${BASE}`) throw new Error(`pushArgs refuses ${BASE}`)
  return ['push', REMOTE, branch]
}

/**
 * What `git status --porcelain -z` reports, split into changes that block a
 * push and untracked screenshot baselines that do not (`CLAUDE.md` forbids
 * committing one generated locally, so a coder that follows it leaves them).
 */
function classifyStatus(porcelainZ) {
  const entries = porcelainZ.split('\0').filter((e) => e !== '')
  const changes = []
  const screenshots = []
  for (let i = 0; i < entries.length; i++) {
    const code = entries[i].slice(0, 2)
    const file = entries[i].slice(3)
    if (/[RC]/.test(code)) i++ // the next entry is the original path, not a change
    if (code === '??' && file.startsWith(SCREENSHOT_DIR)) screenshots.push(file)
    else changes.push(file)
  }
  return { changes, screenshots }
}

/**
 * Pushes `branch` from the worktree `cwd`, and only when it holds a commit
 * beyond `baseSha` and nothing else was left uncommitted. Never commits on the
 * coder's behalf and never forces. `dispatchCoder` and the retry path share it.
 *
 * Resolves `{ status: 'pushed', headSha, screenshots }`, or a status that means
 * nothing was pushed: `nothing-committed` and `uncommitted-changes` (each with
 * `paths`, the uncommitted changes, empty when there are none),
 * `push-failed` (with git's error as `reason`).
 */
export async function pushBranch({ cwd, branch, baseSha }) {
  const args = pushArgs(branch)
  const ahead = Number((await git(cwd, ['rev-list', '--count', `${baseSha}..refs/heads/${branch}`])).trim())
  const { changes, screenshots } = classifyStatus(await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']))
  if (ahead === 0) {
    // No commit wins over uncommitted changes, but the paths are still named:
    // the worktree is removed after this, so the result is their only record.
    const left = changes.length > 0 ? `; uncommitted changes: ${changes.join(', ')}` : ''
    return { status: 'nothing-committed', paths: changes, screenshots, reason: `${branch} has no commit beyond ${BASE}${left}` }
  }
  if (changes.length > 0) {
    return {
      status: 'uncommitted-changes',
      paths: changes,
      screenshots,
      reason: `the worktree has uncommitted changes: ${changes.join(', ')}`,
    }
  }
  try {
    await git(cwd, args)
  } catch (error) {
    const reason = String(error.stderr ?? '').trim() || error.message
    return { status: 'push-failed', reason, screenshots }
  }
  const headSha = (await git(cwd, ['rev-parse', `refs/heads/${branch}`])).trim()
  return { status: 'pushed', headSha, screenshots }
}

/** The parts of a session's JSON envelope the dispatcher keeps in its result. */
function sessionSummary(classification, output) {
  return {
    outcome: classification.outcome,
    report: typeof output?.result === 'string' ? output.result : null,
    costUsd: output?.total_cost_usd ?? null,
    turns: output?.num_turns ?? null,
    refused: (output?.permission_denials ?? []).map((d) => ({
      tool: d.tool_name,
      command: typeof d.tool_input?.command === 'string' ? d.tool_input.command : JSON.stringify(d.tool_input ?? null),
    })),
  }
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
 *   repoDir        the dispatcher's own checkout: its object store supplies the
 *                  queue and the worktree, both taken from the freshly fetched
 *                  `origin/main`, never from its working tree. Defaults to this
 *                  file's repo
 *   install        `({ cwd, env })`, the dependency install run in the worktree
 *                  before the coder starts; defaults to `npm ci`. It gets the
 *                  coder's own credential-free environment
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
  install = installDependencies,
}) {
  const template = promptTemplate ?? readFileSync(CODER_PROMPT, 'utf8')

  // The queue is read from the tip just fetched, and the worktree is made from
  // that same commit, so the story chosen is the story the coder is handed.
  await git(repoDir, ['fetch', REMOTE, BASE])
  const baseSha = (await git(repoDir, ['rev-parse', `${REMOTE}/${BASE}`])).trim()
  const queue = await loadQueueAt(repoDir, baseSha)
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
  // An existing remote branch would make "it is on the remote" (AC-4) no evidence.
  if (await remoteTip(repoDir, branch)) {
    return { status: 'branch-exists', branch, reason: `${branch} already exists on ${REMOTE}` }
  }

  const scratch = await mkdtemp(path.join(tmpdir(), 'tw-coder-'))
  const tree = path.join(scratch, 'tree')
  let worktreeAdded = false
  try {
    // `--no-track`: a branch made from `origin/main` otherwise tracks it, and a
    // bare `git push` on it would aim at `main` (AC-2).
    await git(repoDir, ['worktree', 'add', '--no-track', '-b', branch, tree, baseSha])
    worktreeAdded = true

    const text = readFileSync(path.join(tree, storyPath), 'utf8')
    const { data } = parseFrontmatter(text, storyPath)
    const story = { id: chosen.id, path: storyPath, text, model: data.model ?? null }

    const ghConfigDir = path.join(scratch, 'gh-config')
    await mkdir(ghConfigDir)

    // The install runs `package.json` scripts, so it gets the environment the
    // coder session gets (what `spawnSession` derives from `baseEnv` and
    // `emptyGhConfigDir`), never the dispatcher's own.
    try {
      await install({ cwd: tree, env: coderEnv(baseEnv, ghConfigDir) })
    } catch (error) {
      return { status: 'install-failed', storyId: chosen.id, branch, reason: error.message }
    }
    const { classification, output } = await spawnSession({
      ...sessionOptions,
      role: 'coder',
      promptTemplate: template,
      story,
      branch,
      baseEnv,
      emptyGhConfigDir: ghConfigDir,
      cwd: tree,
    })

    const session = sessionSummary(classification, output)
    const context = { storyId: chosen.id, branch, headSha: null, session }

    if (classification.outcome !== 'completed') {
      // No push: a session that did not finish is not the dispatcher's to publish.
      return { status: 'session-failed', ...context, outcome: classification.outcome, reason: classification.reason, pushed: false }
    }
    const push = await pushBranch({ cwd: tree, branch, baseSha })
    if (push.status !== 'pushed') {
      const { status, ...rest } = push
      return { status, ...context, ...rest }
    }
    const pushedSha = push.headSha
    context.headSha = pushedSha
    if (push.screenshots.length > 0) context.untrackedScreenshots = push.screenshots

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

/**
 * What the coder decided, read from the branch's committed tip in `cwd` (the
 * pushed tip, when there was a push): the `blocked:` value of its story file,
 * wherever the file then is. Changes nothing.
 */
async function readBlocked(cwd, branch, filename) {
  for (const candidate of [`stories/done/${filename}`, `stories/${filename}`]) {
    const source = await gitOrNull(cwd, ['show', `refs/heads/${branch}:${candidate}`])
    if (source === null) continue
    try {
      return { blocked: parseFrontmatter(source, candidate).data.blocked ?? null }
    } catch (error) {
      return { blocked: null, unreadable: error.message }
    }
  }
  return { blocked: null, unreadable: `${filename} is on neither stories/ nor stories/done/ at the tip of ${branch}` }
}

/**
 * Sends a story's coder back to its own open pull request with the findings
 * that stopped it (OQ-85). The coder runs in a fresh worktree of the story's
 * existing branch at its tip on `origin`; the commits it makes are pushed with
 * `pushBranch`, and the pull request's title and body are replaced with the
 * ones it emitted. It opens no pull request and leaves the draft state alone.
 *
 *   ctx, repoDir, promptTemplate, baseEnv, sessionOptions, install
 *                    as for `dispatchCoder`
 *   storyId          the story
 *   prNumber         its open pull request, whose head must be the story's branch
 *   findings         the text to address (untrusted; injected as a bounded block)
 *   source           'review' | 'ci'
 *   round, roundsRemaining   passed in by the caller (OQ-48), never counted here
 *
 * Resolves `{ status, ... }`. Only `retried` (a commit was pushed and the body
 * replaced) and `body-replaced` (no commit and nothing uncommitted, body
 * replaced) mean the retry completed. Every other status means it did not:
 * `pr-not-open`, `wrong-branch`, `branch-missing`, `local-branch-exists`
 * (refusals, before anything is spawned), `install-failed`, `session-failed`,
 * `nothing-committed`, `uncommitted-changes` (with `paths`), `push-failed`,
 * `pr-block-invalid`, `story-unreadable`, `replace-failed`. Every result after a
 * session carries `session`, and every one where the session completed carries
 * `draft` (the coder's choice, or null with no valid block) and `blocked`.
 */
export async function retryStory({
  ctx, repoDir = DISPATCHER_ROOT, storyId, prNumber, findings, source, round, roundsRemaining,
  promptTemplate, baseEnv = process.env, sessionOptions = {}, install = installDependencies,
}) {
  if (!/^OQ-\d+$/.test(storyId ?? '')) throw new Error(`retryStory requires a story id, got ${JSON.stringify(storyId)}`)
  if (!RETRY_SOURCES.includes(source)) throw new Error(`retryStory source must be one of ${RETRY_SOURCES.join(', ')}`)
  const template = promptTemplate ?? readFileSync(CODER_PROMPT, 'utf8')

  const json = await ctx.send(buildGetPullRequestState(ctx.repo, prNumber))
  const pr = parsePullRequestState(json)
  if (json.state !== 'open') {
    return { status: 'pr-not-open', storyId, prNumber, reason: `pull request ${prNumber} is ${json.state}, not open` }
  }
  const branch = pr.headRef
  if (typeof branch !== 'string' || !new RegExp(`^story/${storyId}-[A-Za-z0-9._-]+$`).test(branch)) {
    return { status: 'wrong-branch', storyId, prNumber, reason: `pull request ${prNumber} has head ${JSON.stringify(branch)}, not a ${storyId} story branch` }
  }
  const filename = `${branch.slice('story/'.length)}.md`
  const storyPath = `stories/${filename}`

  if (await gitOrNull(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) {
    return { status: 'local-branch-exists', storyId, branch, prNumber, reason: `${branch} already exists locally, and this checkout's copy is not the one to retry` }
  }
  if (!(await remoteTip(repoDir, branch))) {
    return { status: 'branch-missing', storyId, branch, prNumber, reason: `${branch} is not on ${REMOTE}` }
  }
  await git(repoDir, ['fetch', REMOTE, `+refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`])
  const baseSha = (await git(repoDir, ['rev-parse', `${REMOTE}/${branch}`])).trim()

  const scratch = await mkdtemp(path.join(tmpdir(), 'tw-coder-'))
  const tree = path.join(scratch, 'tree')
  let worktreeAdded = false
  try {
    await git(repoDir, ['worktree', 'add', '--no-track', '-b', branch, tree, baseSha])
    worktreeAdded = true

    let moved = true
    let storyFile = `stories/done/${filename}`
    if (!existsSync(path.join(tree, storyFile))) {
      moved = false
      storyFile = storyPath
    }
    const text = readFileSync(path.join(tree, storyFile), 'utf8')
    const { data } = parseFrontmatter(text, storyFile)
    const story = { id: storyId, path: storyPath, text, model: data.model ?? null }

    const ghConfigDir = path.join(scratch, 'gh-config')
    await mkdir(ghConfigDir)
    try {
      await install({ cwd: tree, env: coderEnv(baseEnv, ghConfigDir) })
    } catch (error) {
      return { status: 'install-failed', storyId, branch, prNumber, reason: error.message }
    }
    const { classification, output } = await spawnSession({
      ...sessionOptions,
      role: 'coder',
      promptTemplate: template,
      story,
      branch,
      baseEnv,
      emptyGhConfigDir: ghConfigDir,
      cwd: tree,
      retry: { round, roundsRemaining, findings, source, storyMoved: moved },
    })

    const session = sessionSummary(classification, output)
    const context = { storyId, branch, prNumber, headSha: null, session }
    if (classification.outcome !== 'completed') {
      return { status: 'session-failed', ...context, outcome: classification.outcome, reason: classification.reason, pushed: false }
    }
    const block = classification.prText
    context.draft = block.status === 'parsed' ? block.draft : null

    const push = await pushBranch({ cwd: tree, branch, baseSha })
    const decided = await readBlocked(tree, branch, filename)
    context.blocked = decided.blocked
    if (push.screenshots?.length > 0) context.untrackedScreenshots = push.screenshots

    // Nothing to push is only "nothing" when nothing was left uncommitted, too.
    const nothingToPush = push.status === 'nothing-committed' && push.paths.length === 0
    if (push.status === 'nothing-committed' && !nothingToPush) {
      return { status: 'uncommitted-changes', ...context, paths: push.paths, reason: push.reason }
    }
    if (push.status !== 'pushed' && !nothingToPush) {
      const { status, screenshots: _screenshots, ...rest } = push
      return { status, ...context, ...rest }
    }
    if (push.status === 'pushed') context.headSha = push.headSha

    if (block.status !== 'parsed') {
      return { status: nothingToPush ? 'nothing-committed' : 'pr-block-invalid', ...context, reason: block.reason }
    }
    if (decided.unreadable) return { status: 'story-unreadable', ...context, reason: decided.unreadable }
    try {
      await replacePullRequest(ctx, prNumber, { title: block.title, body: block.body })
    } catch (error) {
      return { status: 'replace-failed', ...context, reason: error.message }
    }
    const result = { status: nothingToPush ? 'body-replaced' : 'retried', ...context }
    const promptChange = findPromptChange(block.body)
    if (promptChange) result.promptChange = promptChange
    return result
  } finally {
    await cleanUp({ repoDir, tree, branch, baseSha, worktreeAdded })
    await rm(scratch, { recursive: true, force: true })
  }
}

// --------------------------------------------------------------------- CLI

// `install-failed` is deliberately absent: it is a failure.
const NON_FAILURES = ['opened', 'nothing-ready', 'retried', 'body-replaced']

const USAGE = 'usage: node scripts/dispatch/coder.mjs [OQ-<n>] [--repo owner/name]\n' +
  '       node scripts/dispatch/coder.mjs retry OQ-<n> --pr <number> --findings-file <path> --source review|ci --round <n> --remaining <n> [--repo owner/name]'

function takeOption(args, name) {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args.splice(at, 2)[1]
}

async function mainRetry(args, repo) {
  const pr = takeOption(args, '--pr')
  const file = takeOption(args, '--findings-file')
  const source = takeOption(args, '--source')
  const round = takeOption(args, '--round')
  const remaining = takeOption(args, '--remaining')
  const storyId = args.shift()
  const number = (v) => (/^\d+$/.test(v ?? '') ? Number(v) : NaN)
  if (args.length > 0 || !/^OQ-\d+$/.test(storyId ?? '') || !file || !RETRY_SOURCES.includes(source) ||
      !Number.isInteger(number(pr)) || !Number.isInteger(number(round)) || !Number.isInteger(number(remaining))) {
    throw new Error(USAGE)
  }
  const result = await retryStory({
    ctx: createContext({ repo }),
    storyId,
    prNumber: number(pr),
    findings: readFileSync(file, 'utf8'),
    source,
    round: number(round),
    roundsRemaining: number(remaining),
  })
  console.log(JSON.stringify(result, null, 2))
  if (!NON_FAILURES.includes(result.status)) process.exitCode = 1
}

async function main(argv) {
  const args = [...argv]
  if (args[0] === 'retry') {
    args.shift()
    const repoAt = args.indexOf('--repo')
    return mainRetry(args, repoAt === -1 ? DEFAULT_REPO : args.splice(repoAt, 2)[1])
  }
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
