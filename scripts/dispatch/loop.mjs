#!/usr/bin/env node
/**
 * Runs the story queue unattended, one story at a time, from the latest
 * `origin/main` (OQ-86). It picks a story itself (AC-4), fast-forwards its
 * own checkout before dispatching it (AC-1), and runs it as its own child
 * process of `story.mjs` (AC-2), so every story loads the dispatch modules
 * and prompts as they are on `origin/main` at that moment.
 *
 * It reimplements none of `story.mjs`: the child process is OQ-48's entry
 * point, started fresh for each story. This module only chooses which story,
 * keeps its own checkout current between stories, and decides whether a
 * story's result lets the loop continue (AC-3).
 *
 * Nothing here spans stories beyond the checkout itself, which AC-1 updates
 * only between stories: whether a story is `in-progress` is derived fresh
 * from its branch on every pick (AC-4), never stored, so running several
 * stories at once later changes only how many are started.
 *
 * Usage:
 *   node scripts/dispatch/loop.mjs [--repo owner/name] [--max-stories N]
 */
import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { branchFor, remoteTip } from './coder.mjs'
import { dispatchable, loadQueue } from './queue.mjs'

const execFileAsync = promisify(execFile)

const DISPATCH_DIR = path.dirname(fileURLToPath(import.meta.url))
const DISPATCHER_ROOT = path.resolve(DISPATCH_DIR, '..', '..')
const STORY_MJS = path.join(DISPATCH_DIR, 'story.mjs')

const DEFAULT_REPO = 'luplows/tower-workshop-paths'
const REMOTE = 'origin'
const BASE = 'main'

const MAX_STORIES_RE = /^[1-9][0-9]*$/

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=off', ...args], { cwd, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

/**
 * AC-1: fetches `origin/main` and fast-forwards the checkout at `repoDir` to
 * it (`git merge --ff-only`). Resolves `{ status: 'updated', headSha }`, or
 * `{ status: 'not-fast-forward', reason }` when the merge refuses -- a local
 * commit or edit the fast-forward would discard. Never called while a story
 * is running, and indifferent to whether any story's branch exists on
 * `origin`: that is a different ref from the one being fast-forwarded.
 */
export async function updateCheckout(repoDir) {
  await git(repoDir, ['fetch', REMOTE, BASE])
  try {
    await git(repoDir, ['merge', '--ff-only', `${REMOTE}/${BASE}`])
  } catch (error) {
    const reason = String(error.stderr ?? '').trim() || error.message
    return { status: 'not-fast-forward', reason }
  }
  const headSha = (await git(repoDir, ['rev-parse', 'HEAD'])).trim()
  return { status: 'updated', headSha }
}

/**
 * AC-4: the first `ready` story (`dispatchable()`, `stories/README.md`'s
 * ordering) whose `story/OQ-<n>-*` branch does not exist on `origin` --
 * `in-progress` is this, derived fresh and never stored. Reads the queue
 * from `repoDir`'s working tree, which `updateCheckout` is expected to have
 * just brought to `origin/main`.
 *
 * Resolves `{ story: { id, branch } | null, skipped: [{ id, branch }] }`:
 * `skipped` is every `in-progress` story passed over before the pick (or
 * before concluding none is ready), in order.
 */
export async function pickStory(repoDir) {
  const queue = await loadQueue(repoDir)
  const skipped = []
  for (const story of dispatchable(queue)) {
    const filename = path.basename(story.filePath)
    const branch = branchFor(filename)
    if (await remoteTip(repoDir, branch)) {
      skipped.push({ id: story.id, branch })
      continue
    }
    return { story: { id: story.id, branch }, skipped }
  }
  return { story: null, skipped }
}

/**
 * AC-2: runs `storyId` as its own child process of `story.mjs`, in `repoDir`,
 * so it loads the dispatch modules and prompts as they are on disk at that
 * moment -- never this process's already-loaded copies.
 *
 * `story.mjs` prints its JSON result and exits non-zero for any status but
 * `merged`, which is the ordinary outcome of a stop, not a process failure;
 * its stdout is parsed regardless of exit code. Resolves `{ status: 'ran',
 * result }`, or `{ status: 'process-error', reason }` when the process exited
 * without printing a parseable result (AC-3).
 *
 * `scriptPath` defaults to `story.mjs` and exists only so a test can point it
 * at a stand-in script; production never passes it.
 */
export async function runStoryProcess({ repoDir, repo, storyId, scriptPath = STORY_MJS }) {
  let stdout = ''
  let stderr = ''
  try {
    const out = await execFileAsync('node', [scriptPath, storyId, '--repo', repo], { cwd: repoDir, maxBuffer: 64 * 1024 * 1024 })
    stdout = out.stdout
  } catch (error) {
    stdout = error.stdout ?? ''
    stderr = error.stderr ?? ''
  }
  let result
  try {
    result = JSON.parse(stdout)
  } catch {
    const detail = stderr.trim()
    return { status: 'process-error', reason: `the story process for ${storyId} produced no parseable result${detail ? `: ${detail}` : ''}` }
  }
  return { status: 'ran', result }
}

/** Parses `--max-stories`'s raw value (AC-6); `undefined` passes through uncapped. */
export function parseMaxStories(raw) {
  if (raw === undefined) return undefined
  if (!MAX_STORIES_RE.test(raw)) {
    throw new Error(`--max-stories must match ${MAX_STORIES_RE}, got ${JSON.stringify(raw)}`)
  }
  return Number(raw)
}

/**
 * Runs the queue to `nothing-ready`, `max-stories`, or a stop (AC-1--AC-4,
 * AC-6).
 *
 *   repoDir      the dispatcher's own checkout, fast-forwarded between
 *                stories and handed to each story's process
 *   repo         `owner/name`, passed to each story's process
 *   maxStories   caps the number of stories *started*; a skipped story does
 *                not count. Uncapped when omitted
 *   deps         `{ updateCheckout, pickStory, runStoryProcess }`, replaceable
 *                by a test
 *
 * Resolves `{ status, report, ... }`. `report` is every story the run
 * touched, in order: `{ id, branch, outcome: 'skipped' }` for one AC-4 passed
 * over, and `{ id, outcome }` for one it ran -- `'merged'`,
 * `'stopped-recorded'` (AC-3's fully-recorded stop, the loop goes on), or
 * `'stopped'` / `'process-error'` (the loop stops, named on the result too).
 * `status` is `'nothing-ready'`, `'max-stories'`, `'update-failed'`,
 * `'process-error'`, or `'story-stopped'`.
 */
export async function runLoop({ repoDir = DISPATCHER_ROOT, repo = DEFAULT_REPO, maxStories, deps = {} } = {}) {
  const d = { updateCheckout, pickStory, runStoryProcess, ...deps }
  const report = []
  let started = 0

  for (;;) {
    if (maxStories !== undefined && started >= maxStories) {
      return { status: 'max-stories', report }
    }

    const update = await d.updateCheckout(repoDir)
    if (update.status !== 'updated') {
      return { status: 'update-failed', reason: update.reason, report }
    }

    const picked = await d.pickStory(repoDir)
    for (const s of picked.skipped) report.push({ id: s.id, branch: s.branch, outcome: 'skipped' })
    if (!picked.story) {
      return { status: 'nothing-ready', report }
    }

    started++
    const ran = await d.runStoryProcess({ repoDir, repo, storyId: picked.story.id })
    if (ran.status !== 'ran') {
      report.push({ id: picked.story.id, outcome: 'process-error', reason: ran.reason })
      return { status: 'process-error', storyId: picked.story.id, reason: ran.reason, report }
    }

    const r = ran.result
    if (r?.status === 'merged') {
      report.push({ id: picked.story.id, outcome: 'merged' })
      continue
    }
    if (r?.stopped === true && r.record?.recorded === true) {
      report.push({ id: picked.story.id, outcome: 'stopped-recorded', status: r.status })
      continue
    }
    report.push({ id: picked.story.id, outcome: 'stopped', status: r?.status, reason: r?.reason })
    return { status: 'story-stopped', storyId: picked.story.id, storyStatus: r?.status, reason: r?.reason, report }
  }
}

// --------------------------------------------------------------------- CLI

/**
 * Parses the CLI's argv into `{ repo, maxStories }`, or throws -- for a
 * missing value (a trailing `--max-stories`, or one followed only by another
 * flag whose own value has already been taken), an unrecognised flag, or a
 * `--max-stories` value `parseMaxStories` rejects. Throws before `main` ever
 * touches `repoDir` or the network, so a bad invocation starts nothing (AC-6).
 */
export function parseArgs(argv) {
  const args = [...argv]
  const take = (name) => {
    const at = args.indexOf(name)
    if (at === -1) return undefined
    if (at === args.length - 1) throw new Error(`${name} requires a value`)
    return args.splice(at, 2)[1]
  }
  const repo = take('--repo') ?? DEFAULT_REPO
  const maxStoriesRaw = take('--max-stories')
  const usage = 'usage: node scripts/dispatch/loop.mjs [--repo owner/name] [--max-stories N]'
  if (args.length > 0) throw new Error(usage)
  const maxStories = parseMaxStories(maxStoriesRaw)
  return { repo, maxStories }
}

async function main(argv) {
  const { repo, maxStories } = parseArgs(argv)

  const result = await runLoop({ repo, maxStories })
  console.log(JSON.stringify(result, null, 2))
  if (result.status !== 'nothing-ready' && result.status !== 'max-stories') process.exitCode = 1
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
