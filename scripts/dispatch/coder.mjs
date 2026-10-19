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
 * Each of `dispatchCoder` and `retryStory` reads the plan's usage before it
 * starts a session (`usage.mjs`, ST-31), and starts none when either window is
 * at or over the coder's limit in the settings (`over-usage`), or when the usage
 * cannot be read (`usage-unknown`). Unless the crew named a choice (`--choice`), they then try the
 * other choices at least as strong as the story's, and start the first whose tool's usage is
 * readable and under the limit (ST-35, `choices.mjs`). A coder session already running is never
 * stopped.
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
 * did not write. The pull request's body ends with a `Coder:` line ATC writes, naming the choices
 * that ran on it (ST-35/AC-7).
 *
 * Usage:
 *   node scripts/dispatch/coder.mjs [OQ-<n>] [--repo owner/name] [--choice <name>]
 *   node scripts/dispatch/coder.mjs retry OQ-<n> --pr <number> --findings-file <path> --source review|ci --round <n> --remaining <n> [--repo owner/name] [--choice <name>]
 *
 * `--choice <name>` runs the coder on that key of `roles.coder.available` for this run (ST-35/AC-1).
 * It is final: it runs instead of the story's choice and the default, whatever its `strength`, and
 * when its tool's usage is over the limit or unreadable the run stops, with no other choice taken.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { coderLineNames, firstWithUsage, withCoderLine } from './choices.mjs'
import { readCodexUsage } from './codex.mjs'
import { coderEnv } from './coder-env.mjs'
import { buildGetPullRequestState, createContext, createPullRequest, parsePullRequestState, replacePullRequest } from './github.mjs'
import { installDependencies } from './install.mjs'
import { RETRY_SOURCES } from './invocation.mjs'
import { coderChoice, readMachineSettings } from './machine-settings.mjs'
import { buildStory, deriveStatus, dispatchable, isStoryFilename, orderStories, parseFrontmatter } from './queue.mjs'
import { readSettings } from './settings.mjs'
import { spawnSession } from './spawn.mjs'
import { readUsage } from './usage.mjs'

const execFileAsync = promisify(execFile)

const DISPATCH_DIR = path.dirname(fileURLToPath(import.meta.url))
// The engine root: where this module and its prompt live, found from its own
// location (OQ-123). Not the project -- see `repoDir` below.
const ENGINE_ROOT = path.resolve(DISPATCH_DIR, '..', '..')
const CODER_PROMPT = path.join(ENGINE_ROOT, '.claude', 'prompts', 'coder.md')

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
 * `prefix` is the project's story-id prefix (OQ-126).
 */
async function loadQueueAt(repoDir, ref, prefix) {
  const listing = await git(repoDir, ['ls-tree', ref, 'stories/', 'stories/done/'])
  const built = []
  for (const line of listing.split(/\r?\n/)) {
    const m = line.match(/^(\d+) blob [0-9a-f]+\t(stories\/(?:done\/)?([^/]+))$/)
    if (!m || !m[1].startsWith('100') || !isStoryFilename(m[3], prefix)) continue
    built.push(buildStory(m[2], await git(repoDir, ['show', `${ref}:${m[2]}`]), m[2].startsWith('stories/done/'), prefix))
  }
  const doneIds = new Set(built.filter((story) => story.isDone).map((story) => story.id))
  return orderStories(built.map((story) => ({ ...story, ...deriveStatus(story, doneIds) })))
}

/** The branch a story is worked on: `story/` plus its filename without `.md`. */
export function branchFor(storyFilename) {
  return `story/${storyFilename.replace(/\.md$/, '')}`
}

/** The tip of `branch` on the remote, or `null` when it is not there. */
export async function remoteTip(repoDir, branch) {
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

/** Throws unless `branch` is a plain name: no refspec, no option, and never `main`. */
function assertPlainBranch(branch, fnName) {
  if (typeof branch !== 'string' || !BRANCH_NAME.test(branch) || branch.includes('..')) {
    throw new Error(`${fnName} requires a plain branch name, got ${JSON.stringify(branch)}`)
  }
  if (branch === BASE || branch === `refs/heads/${BASE}`) throw new Error(`${fnName} refuses ${BASE}`)
}

/**
 * The arguments of the one push the dispatcher makes for a finished branch:
 * `git push origin <branch>`. The branch must be a plain name, which is what
 * keeps a forced form (a `+` refspec or an option), a refspec (`a:b`) or
 * `main` from being constructible.
 */
export function pushArgs(branch) {
  assertPlainBranch(branch, 'pushArgs')
  return ['push', REMOTE, branch]
}

/**
 * The arguments of the claim push (AC-1): `git push
 * --force-with-lease=refs/heads/<branch>: origin <branch>`. The empty
 * expected value after the colon means "must not already exist" (git's
 * `git-push` documentation, `--force-with-lease`), so this can only create a
 * branch, never overwrite one -- a second claim of the same name is refused.
 * Takes the same plain-name-only branch as `pushArgs`.
 */
export function claimPushArgs(branch) {
  assertPlainBranch(branch, 'claimPushArgs')
  return ['push', `--force-with-lease=refs/heads/${branch}:`, REMOTE, branch]
}

/** OQ-112's AC-2: a claim older than this is stuck rather than a dispatch still running. */
export const STUCK_AFTER_MS = 2 * 60 * 60 * 1000

// The subject the claim commit above is made with: `Claim <OQ-n> on <label> at <ISO time>`.
const CLAIM_SUBJECT_GREP = '^Claim [A-Za-z0-9-]+ on '

/**
 * The age, in milliseconds, of `branch`'s claim commit on `origin` (OQ-112's
 * AC-2): the commit on the branch, not on `origin/main`, with a subject
 * beginning `Claim <OQ-n> on ` -- the commit `dispatchCoder` makes above.
 * Fetches `branch` and `main` fresh from `origin` first, so a stale local
 * tracking ref cannot report a wrong age. `null` when the branch has no such
 * commit (an unclaimed branch, or one made before OQ-110). `now` is
 * overridable so a test can check the boundary deterministically.
 */
export async function claimAgeMs(repoDir, branch, now = Date.now()) {
  await git(repoDir, ['fetch', REMOTE, `+refs/heads/${BASE}:refs/remotes/${REMOTE}/${BASE}`, `+refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`])
  const out = await git(repoDir, [
    'log', `refs/remotes/${REMOTE}/${branch}`, '--not', `refs/remotes/${REMOTE}/${BASE}`,
    '-E', `--grep=${CLAIM_SUBJECT_GREP}`, '--format=%ct',
  ])
  const lines = out.split(/\r?\n/).filter((line) => line !== '')
  if (lines.length === 0) return null
  // Oldest match (git log lists newest first) is the claim itself.
  return now - Number(lines[lines.length - 1]) * 1000
}

const MACHINE_LABEL_RE = /^[A-Za-z0-9._-]{1,32}$/

/**
 * The machine's label for a claim commit (AC-8): never the hostname, since
 * the repository is public. Reads `TW_MACHINE_LABEL` from `env`: unset or
 * empty is `'unlabelled'`, a value matching `MACHINE_LABEL_RE` is used as is,
 * and anything else is refused by returning `null` -- the caller turns that
 * into `bad-machine-label` before anything is claimed, installed or spawned.
 */
export function machineLabel(env) {
  const raw = env.TW_MACHINE_LABEL
  if (raw === undefined || raw === '') return 'unlabelled'
  return MACHINE_LABEL_RE.test(raw) ? raw : null
}

/**
 * What `git status --porcelain -z` reports, split into changes that block a
 * push and untracked screenshot baselines that do not (tower-workshop-paths'
 * `CLAUDE.md` forbids committing one generated locally, so a coder that
 * follows it leaves them).
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
 *   repoDir        the project root: its object store supplies the queue and
 *                  the worktree, both taken from the freshly fetched
 *                  `origin/main`, never from its working tree. Also where
 *                  `steward.config.json` is read from. Defaults to the
 *                  current working directory
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
 * Straight after creating the branch, it makes an empty claim commit naming
 * the machine (`machineLabel`, AC-8) and pushes it to `origin` with
 * `claimPushArgs`, which only ever creates the branch there (AC-1); from then
 * on that commit, not `origin/main`, is the base the dispatch measures
 * "committed beyond" from. A failed claim push spends nothing further
 * (AC-2): `bad-machine-label` is refused before the branch is even created,
 * and `claim-failed` or `branch-exists` before the install or the session.
 *
 *   choice         the name of a key of `roles.coder.available` to run instead of the story's
 *                  choice (ST-35/AC-1); `choice-unavailable` when it is none, before the usage
 *                  is read. Final: no other choice is taken, whatever its `strength`
 *   usage          `({ cwd })`, resolving `readUsage`'s result; defaults to
 *                  `readUsage`. Called at most once, in `repoDir`, after the story is
 *                  chosen and before the branch is claimed (ST-31)
 *   codexUsage     `({ executable, cwd })`, resolving `readCodexUsage`'s result, for a choice whose
 *                  tool is `codex` (ST-35/AC-6; none can be configured until ST-15)
 *   machineSettings  `()`, resolving the machine's settings; defaults to `readMachineSettings`
 *                  on the real environment and home directory. Called once, before the
 *                  usage check (ST-34)
 *
 * Resolves `{ status, ... }`. `opened` carries the pull request. Every other
 * status means none was opened, and `reason` says why. `nothing-ready` is not
 * a failure. `over-usage` (with `window`, `percent`, `limit` and `resetsAt`)
 * and `usage-unknown` carry the story's id and leave nothing behind; they are
 * failures, and the CLI exits 1 for them: a run that was asked for did not
 * happen (`NON_FAILURES` does not list them). So is `choice-unavailable` (ST-34/AC-4), with
 * `storyId` and `choice`: the story's `model:` names no choice in `roles.coder.available`, or the
 * name given as `choice` is none.
 *
 * Without `choice`, the story's choice is tried first, then every other choice in
 * `roles.coder.available`, in the file's order, whose `strength` is at least its own, each tool's
 * usage read at most once (ST-35/AC-6). Every result returned after a session started carries
 * `choice` (`name`, `tool`, `model`, `effort` and `why`: `crew`, `unit`, `default` or `usage`) and,
 * when ATC moved off the story's choice, `skipped`: one entry per choice not started, with its
 * `name` and `status` (`over-usage` with `window`, `percent` and `limit`; `usage-unknown` with
 * `reason`). A refusal after every choice was tried carries `skipped` too (ST-35/AC-3). The pull
 * request is opened with the `Coder:` line (ST-35/AC-7).
 */
export async function dispatchCoder({
  ctx, repoDir = process.cwd(), storyId, promptTemplate, baseEnv = process.env, sessionOptions = {},
  install = installDependencies, usage = readUsage, choice: named, codexUsage = readCodexUsage,
  machineSettings = () => readMachineSettings({ env: process.env, homedir: homedir() }),
}) {
  const template = promptTemplate ?? readFileSync(CODER_PROMPT, 'utf8')

  // The queue is read from the tip just fetched, and the worktree is made from
  // that same commit, so the story chosen is the story the coder is handed.
  const { storyPrefix } = await readSettings(repoDir)
  const machine = await machineSettings()
  await git(repoDir, ['fetch', REMOTE, BASE])
  const mainSha = (await git(repoDir, ['rev-parse', `${REMOTE}/${BASE}`])).trim()
  const queue = await loadQueueAt(repoDir, mainSha, storyPrefix)
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

  // AC-8: a bad label is refused before anything is claimed, installed or spawned.
  const label = machineLabel(baseEnv)
  if (label === null) {
    return {
      status: 'bad-machine-label', storyId: chosen.id, branch,
      reason: `TW_MACHINE_LABEL ${JSON.stringify(baseEnv.TW_MACHINE_LABEL)} does not match ${MACHINE_LABEL_RE}`,
    }
  }

  // ST-34/AC-4: the story's choice, before the usage is read or anything is claimed.
  const first = await storyChoiceAt({ repoDir, ref: mainSha, filename, storyId: chosen.id, machine, named })
  if (first.refusal) return first.refusal

  // ST-31/AC-4, ST-35/AC-6: before the branch is claimed, worktree-made or anything installed.
  const picked = await pickCoderChoice({
    machine, first, named, usage, codexUsage, cwd: repoDir, storyId: chosen.id,
  })
  if (picked.refusal) return picked.refusal
  const { choice, ran } = picked

  const scratch = await mkdtemp(path.join(tmpdir(), 'tw-coder-'))
  const tree = path.join(scratch, 'tree')
  let worktreeAdded = false
  // Reassigned to the claim commit's sha once it is made (AC-3): from then on
  // it is the base `pushBranch` and `cleanUp` measure "committed beyond" from,
  // not `origin/main`.
  let baseSha = mainSha
  try {
    // `--no-track`: a branch made from `origin/main` otherwise tracks it, and a
    // bare `git push` on it would aim at `main` (AC-2).
    await git(repoDir, ['worktree', 'add', '--no-track', '-b', branch, tree, mainSha])
    worktreeAdded = true

    // AC-1: the claim commit and its push, before the install or the coder
    // session spend anything. A failed push means either a race (someone else's
    // claim beat us to `origin`) or a genuine push failure (AC-2); either way
    // nothing below this is installed or spawned, and `cleanUp` below removes
    // the local branch and worktree since their tip is still this claim.
    // `-c user.name`/`-c user.email`: the claim commit is the dispatcher's own
    // action, not an authored change, so it must not depend on whichever git
    // identity happens to be configured on the machine running it (CI's
    // runners have none at all).
    await git(tree, [
      '-c', 'user.name=tw-dispatch', '-c', 'user.email=dispatch@tower-workshop-paths.invalid',
      'commit', '--allow-empty', '-m', `Claim ${chosen.id} on ${label} at ${new Date().toISOString()}`,
    ])
    baseSha = (await git(tree, ['rev-parse', 'HEAD'])).trim()
    try {
      await git(tree, claimPushArgs(branch))
    } catch (error) {
      if (await remoteTip(repoDir, branch)) {
        return { status: 'branch-exists', storyId: chosen.id, branch, reason: `${branch} already exists on ${REMOTE}` }
      }
      const reason = String(error.stderr ?? '').trim() || error.message
      return { status: 'claim-failed', storyId: chosen.id, branch, reason }
    }

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
      model: choice.model,
      effort: choice.effort,
      branch,
      baseEnv,
      emptyGhConfigDir: ghConfigDir,
      cwd: tree,
    })

    const session = sessionSummary(classification, output)
    const context = { storyId: chosen.id, branch, headSha: null, session, ...ran }

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
    // ST-35/AC-7: the `Coder:` line is ATC's; the coder's own is dropped.
    const pr = await createPullRequest(ctx, {
      title: block.title, body: withCoderLine(block.body, [choice.name]), head: branch, base: BASE, draft,
    })

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
 * The coder's first choice for the story `filename` as it stands at `ref`, under stories/ or
 * stories/done/ (ST-34/AC-4): the `choice-unavailable` result when its `model:` names no available
 * choice, else `{ choice, why }`, `why` being `unit` (its `model:` names it) or `default` (it names
 * none). Read from the object store, so nothing is made or installed first. A choice `named` by the
 * crew (ST-35/AC-1) is the choice instead, `why` being `crew`, and the story's `model:` is not
 * looked at; a name that is none is `choice-unavailable` too.
 */
async function storyChoiceAt({ repoDir, ref, filename, storyId, machine, named }) {
  if (named !== undefined) {
    const choice = typeof named === 'string' ? coderChoice(machine, named) : null
    return choice === null ? { refusal: { status: 'choice-unavailable', storyId, choice: named } } : { choice, why: 'crew' }
  }
  let model = null
  for (const candidate of [`stories/${filename}`, `stories/done/${filename}`]) {
    const source = await gitOrNull(repoDir, ['show', `${ref}:${candidate}`])
    if (source === null) continue
    model = parseFrontmatter(source, candidate).data.model ?? null
    break
  }
  const choice = coderChoice(machine, model)
  return choice === null
    ? { refusal: { status: 'choice-unavailable', storyId, choice: model } }
    : { choice, why: model === null ? 'default' : 'unit' }
}

/**
 * Which choice the coder runs, once the story's `first` is known (ST-35/AC-6): the first of
 * `first` and then every other choice in `roles.coder.available`, in the file's order, whose
 * `strength` is at least `first`'s, whose tool's usage is readable and under the coder's limits. A
 * story never runs on a weaker choice than its own. A choice `named` by the crew is the only one
 * tried, and its refusal carries no `skipped`. Resolves `{ choice, ran }`, `ran` being what the
 * call's results carry (`choice`, and `skipped` when ATC moved), or `{ refusal }`.
 */
async function pickCoderChoice({ machine, first, named, usage, codexUsage, cwd, storyId }) {
  const { available } = machine.roles.coder
  const candidates = named !== undefined
    ? [first.choice]
    : [first.choice, ...Object.entries(available)
      .filter(([name, other]) => name !== first.choice.name && other.strength >= first.choice.strength)
      .map(([name, other]) => ({ name, ...other }))]
  const readers = {
    claude: usage,
    codex: ({ cwd: dir }) => codexUsage({ executable: machine.tools?.codex?.executable, cwd: dir }),
  }
  const picked = await firstWithUsage({
    candidates, readers, cwd, limits: machine.usageLimits.coder, extra: { storyId },
  })
  if (picked.refusal) {
    const { skipped: _tried, ...refusal } = picked.refusal
    return { refusal: named !== undefined ? refusal : picked.refusal }
  }
  const { choice, skipped } = picked
  const why = skipped.length > 0 ? 'usage' : first.why
  return {
    choice,
    ran: {
      choice: { name: choice.name, tool: choice.tool, model: choice.model, effort: choice.effort, why },
      ...(skipped.length > 0 && { skipped }),
    },
  }
}

/** Whether `filename` is a story file with id `storyId` under stories/ or stories/done/ at `ref`. */
async function hasStoryFile(repoDir, ref, filename, storyId) {
  for (const candidate of [`stories/${filename}`, `stories/done/${filename}`]) {
    const source = await gitOrNull(repoDir, ['show', `${ref}:${candidate}`])
    if (source === null) continue
    try {
      return parseFrontmatter(source, candidate).data.id === storyId
    } catch {
      return false
    }
  }
  return false
}

/**
 * Sends a story's coder back to its own open pull request with the findings
 * that stopped it (OQ-85). The coder runs in a fresh worktree of the story's
 * existing branch at its tip on `origin`; the commits it makes are pushed with
 * `pushBranch`, and the pull request's title and body are replaced with the
 * ones it emitted. It opens no pull request and leaves the draft state alone.
 *
 *   ctx, repoDir, promptTemplate, baseEnv, sessionOptions, install, usage, codexUsage, choice,
 *   machineSettings
 *                    as for `dispatchCoder`; `usage` is called before the
 *                    worktree is made, so `over-usage` and `usage-unknown`
 *                    (ST-31) come before anything is installed. The body it replaces ends with
 *                    the `Coder:` line (ST-35/AC-7): the names on the pull request's current one,
 *                    then the choice that ran, each once
 *   storyId          the story
 *   prNumber         its open pull request, whose head must be the story's branch
 *   findings         the text to address (untrusted; injected as a bounded block)
 *   source           'review' | 'ci'
 *   round, roundsRemaining   passed in by the caller (OQ-48), never counted here
 *
 * Resolves `{ status, ... }`. Only `retried` (a commit was pushed and the body
 * replaced) and `body-replaced` (no commit and nothing uncommitted, body
 * replaced) mean the retry completed. Every other status means it did not:
 * `pr-not-open`, `choice-unavailable` (ST-34/AC-4), `wrong-branch` (the head is not `branchFor` of a story file
 * with this id at its tip on `origin`), `branch-missing`, `local-branch-exists`
 * (refusals, before anything is spawned), `install-failed`, `session-failed`,
 * `nothing-committed`, `uncommitted-changes` (with `paths`), `push-failed`,
 * `pr-block-invalid`, `story-unreadable`, `replace-failed`. Every result after a
 * session carries `session`, and every one where the session completed carries
 * `draft` (the coder's choice, or null with no valid block) and `blocked`.
 */
export async function retryStory({
  ctx, repoDir = process.cwd(), storyId, prNumber, findings, source, round, roundsRemaining,
  promptTemplate, baseEnv = process.env, sessionOptions = {}, install = installDependencies,
  usage = readUsage, choice: named, codexUsage = readCodexUsage,
  machineSettings = () => readMachineSettings({ env: process.env, homedir: homedir() }),
}) {
  const { storyPrefix } = await readSettings(repoDir)
  const machine = await machineSettings()
  if (!new RegExp(`^${storyPrefix}-\\d+$`).test(storyId ?? '')) {
    throw new Error(`retryStory requires a story id of the form ${storyPrefix}-<n>, got ${JSON.stringify(storyId)}`)
  }
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

  // The head is the story's only if `branchFor` would name it: its story file
  // carries this id and is on the branch, whichever of the two directories.
  if (!(await hasStoryFile(repoDir, baseSha, filename, storyId))) {
    return { status: 'wrong-branch', storyId, branch, prNumber, reason: `${branch} has no ${filename} with id ${storyId} in stories/ or stories/done/ at its tip on ${REMOTE}, so it is not the branch ${storyId} is worked on` }
  }

  // ST-34/AC-4: the story's choice, before the usage is read or anything is made.
  const first = await storyChoiceAt({ repoDir, ref: baseSha, filename, storyId, machine, named })
  if (first.refusal) return first.refusal

  // ST-31/AC-4, ST-35/AC-6: before the worktree is made and dependencies are installed.
  const picked = await pickCoderChoice({ machine, first, named, usage, codexUsage, cwd: repoDir, storyId })
  if (picked.refusal) return picked.refusal
  const { choice, ran } = picked

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
      model: choice.model,
      effort: choice.effort,
      branch,
      baseEnv,
      emptyGhConfigDir: ghConfigDir,
      cwd: tree,
      retry: { round, roundsRemaining, findings, source, storyMoved: moved },
    })

    const session = sessionSummary(classification, output)
    const context = { storyId, branch, prNumber, headSha: null, session, ...ran }
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
      // ST-35/AC-7: the choices on the body's `Coder:` line before this run, then the one that ran.
      const ranBefore = coderLineNames(pr.body) ?? []
      await replacePullRequest(ctx, prNumber, {
        title: block.title, body: withCoderLine(block.body, [...new Set([...ranBefore, choice.name])]),
      })
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

const usage = (prefix) => `usage: node scripts/dispatch/coder.mjs [${prefix}-<n>] [--repo owner/name] [--choice <name>]\n` +
  `       node scripts/dispatch/coder.mjs retry ${prefix}-<n> --pr <number> --findings-file <path> --source review|ci --round <n> --remaining <n> [--repo owner/name] [--choice <name>]`

/** Removes `--choice <name>` from `args` and returns the name, or `undefined` when it is not there. */
function takeChoice(args, storyPrefix) {
  const name = takeOption(args, '--choice')
  if (args.includes('--choice') || name === '') throw new Error(usage(storyPrefix))
  return name
}

function takeOption(args, name) {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args.splice(at, 2)[1]
}

async function mainRetry(args, repo, storyPrefix) {
  const choice = takeChoice(args, storyPrefix)
  const pr = takeOption(args, '--pr')
  const file = takeOption(args, '--findings-file')
  const source = takeOption(args, '--source')
  const round = takeOption(args, '--round')
  const remaining = takeOption(args, '--remaining')
  const storyId = args.shift()
  const number = (v) => (/^\d+$/.test(v ?? '') ? Number(v) : NaN)
  if (args.length > 0 || !new RegExp(`^${storyPrefix}-\\d+$`).test(storyId ?? '') || !file || !RETRY_SOURCES.includes(source) ||
      !Number.isInteger(number(pr)) || !Number.isInteger(number(round)) || !Number.isInteger(number(remaining))) {
    throw new Error(usage(storyPrefix))
  }
  const result = await retryStory({
    ctx: createContext({ repo }),
    storyId,
    prNumber: number(pr),
    findings: readFileSync(file, 'utf8'),
    source,
    round: number(round),
    roundsRemaining: number(remaining),
    choice,
  })
  console.log(JSON.stringify(result, null, 2))
  if (!NON_FAILURES.includes(result.status)) process.exitCode = 1
}

async function main(argv) {
  const args = [...argv]
  const { repo: settingsRepo, storyPrefix } = await readSettings(process.cwd())
  if (args[0] === 'retry') {
    args.shift()
    const repoAt = args.indexOf('--repo')
    return mainRetry(args, repoAt === -1 ? settingsRepo : args.splice(repoAt, 2)[1], storyPrefix)
  }
  const choice = takeChoice(args, storyPrefix)
  const repoAt = args.indexOf('--repo')
  const repo = repoAt === -1 ? settingsRepo : args.splice(repoAt, 2)[1]
  const storyId = args.shift()
  if (args.length > 0 || (storyId !== undefined && !new RegExp(`^${storyPrefix}-\\d+$`).test(storyId))) {
    throw new Error(usage(storyPrefix))
  }
  const result = await dispatchCoder({ ctx: createContext({ repo }), storyId, choice })
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
