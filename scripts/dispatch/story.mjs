#!/usr/bin/env node
/**
 * Runs one story from dispatch to merged (OQ-48): dispatch the coder (OQ-70),
 * wait for CI on the head (OQ-79), review the pull request (OQ-69), land it
 * (OQ-50). A red CI or a blocking review sends the coder back through
 * `retryStory` (OQ-85), under bounds derived from GitHub on every call.
 *
 * It composes those modules and reimplements none of them. It builds no
 * request of its own: every GitHub call goes through a function of
 * `github.mjs`, `ci.mjs` or `land.mjs`, each with its own allowlist, so no
 * merge, workflow dispatch or label write is constructible from here (AC-3,
 * AC-7). It lands only by calling `landPullRequest`.
 *
 * `decide*` below is the whole table of what each result leads to (AC-2).
 * A result the table does not name stops the story.
 *
 * Nothing is stored. The review count is the number of blocking verdict markers
 * from an honoured author on the pull request, the red CI count is
 * `countRedCiRounds`, and where a resumed story stands is read from its pull
 * request (AC-9). Nothing here spans stories, so parallel dispatch can follow.
 *
 * Usage:
 *   node scripts/dispatch/story.mjs OQ-<n> [--pr <number>] [--repo owner/name]
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { countRedCiRounds, createCiContext, waitForCi } from './ci.mjs'
import { dispatchCoder, pushBranch, retryStory } from './coder.mjs'
import {
  buildGetPullRequestState,
  convertPullRequestToDraft,
  createContext,
  getPullRequestLabels,
  listPullRequestComments,
  parsePullRequestState,
} from './github.mjs'
import { createLandContext, landPullRequest } from './land.mjs'
import { parseFrontmatter } from './queue.mjs'
import { HONOURED_ASSOCIATIONS, reviewPullRequest } from './review.mjs'
import { readSettings } from './settings.mjs'

const execFileAsync = promisify(execFile)

const DISPATCHER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const REMOTE = 'origin'

// The bound on each kind of round (AC-3, AC-4). The round a retry is given is
// the count so far plus one, and the rounds remaining after it are this minus that.
export const MAX_ROUNDS = 3
const FINDINGS_IN_REASON = 600
// The label OQ-80's `review-gate.yml` applies; this module only reads it.
const REVIEW_BLOCKED_LABEL = 'review-blocked'
const PASSING = ['pass', 'pass-with-observations']

// ------------------------------------------------------------------- results

/** A story that stops: `status` names why, `reason` says it in words. */
function stopped(status, reason, extra = {}) {
  return { status, stopped: true, reason, ...extra }
}

// ------------------------------------------------------------ decision tables

/** What a coder dispatch leads to (AC-2). */
export function decideDispatch(result) {
  if (result.status !== 'opened') {
    return { next: 'stop', status: result.status, reason: result.reason ?? `the coder dispatch ended ${result.status}` }
  }
  if (result.draft) {
    const why = result.blocked ? `the coder set blocked: ${result.blocked}` : 'the coder opened the pull request as a draft'
    return { next: 'stop', status: 'coder-draft', reason: why }
  }
  return { next: 'ci' }
}

/** What a CI wait leads to (AC-2, AC-5). `redCount` is `countRedCiRounds`, read only for a `failure`. */
export function decideCi(result, redCount = 0) {
  if (result.result === 'green') return { next: 'review' }
  if (result.result === 'timed-out') {
    return { next: 'stop', status: 'ci-wait-timed-out', reason: 'CI did not finish within the wait; a coder cannot fix that' }
  }
  if (result.result === 'red' && result.conclusion === 'failure') {
    if (result.setupFailure) {
      const steps = (result.setupSteps ?? []).join(', ') || 'no step reported'
      return {
        next: 'stop',
        status: 'ci-setup-failed',
        reason: `CI failed in setup step(s) ${steps}, outside the repository; a coder retry cannot fix it`,
      }
    }
    if (redCount >= MAX_ROUNDS) {
      const jobs = (result.jobNames ?? []).join(', ') || 'no job reported'
      return { next: 'stop', status: 'ci-round-bound', reason: `CI has failed on ${redCount} commits, the bound; failing jobs: ${jobs}` }
    }
    return { next: 'retry', source: 'ci', round: redCount + 1 }
  }
  if (result.result === 'red') {
    return {
      next: 'stop',
      status: `ci-concluded-${result.conclusion}`,
      reason: `the CI run concluded ${result.conclusion}, which a coder retry cannot fix`,
    }
  }
  return { next: 'stop', status: 'ci-unrecognised', reason: `unrecognised CI result ${JSON.stringify(result.result)}` }
}

/** What a recorded verdict leads to (AC-2, AC-3). `blocks` is the honoured block count; `labels` the pull request's. */
export function decideVerdict(verdict, { blocks, labels, findings = '' }) {
  if (PASSING.includes(verdict)) return { next: 'land' }
  if (verdict !== 'block') return { next: 'stop', status: 'review-unrecognised', reason: `unrecognised verdict ${JSON.stringify(verdict)}` }
  if (labels.includes(REVIEW_BLOCKED_LABEL)) {
    return { next: 'stop', status: 'review-blocked-label', reason: `the pull request carries ${REVIEW_BLOCKED_LABEL}; not retrying it` }
  }
  if (blocks >= MAX_ROUNDS) {
    // One line, bounded: the reason is written into the story file's frontmatter.
    const named = findings.replace(/\s+/g, ' ').trim()
    const shown = named.length > FINDINGS_IN_REASON ? `${named.slice(0, FINDINGS_IN_REASON)}…` : named
    return {
      next: 'stop',
      status: 'review-round-bound',
      reason: `${blocks} blocking verdicts, the bound; the unresolved findings of the latest: ${shown || 'none recorded'}`,
    }
  }
  return { next: 'retry', source: 'review', round: blocks + 1 }
}

/** What a review result leads to (AC-2); a recorded verdict is `decideVerdict`'s. */
export function decideReview(result) {
  if (result.status === 'recorded') return { next: 'verdict', verdict: result.verdict }
  return { next: 'stop', status: `review-${result.status}`, reason: result.reason ?? `the review ended ${result.status}` }
}

/** What a retry leads to (AC-2). `source` is what the retry was for. */
export function decideRetry(result, source) {
  const asked = result.blocked != null ? `set blocked: ${result.blocked}` : result.draft === true ? 'asked for a draft' : null
  if (asked) return { next: 'stop', status: result.blocked != null ? 'retry-blocked' : 'retry-draft', reason: `the retried coder ${asked}` }
  if (result.status === 'retried') return { next: 'ci', headSha: result.headSha }
  if (result.status === 'body-replaced') {
    if (source === 'review') return { next: 'review', rereview: true }
    return {
      next: 'stop',
      status: 'ci-retry-no-commit',
      reason: 'the retry pushed no commit, so the head is unchanged and its CI is still red',
    }
  }
  return { next: 'stop', status: `retry-${result.status}`, reason: result.reason ?? `the retry ended ${result.status}` }
}

/** What landing leads to (AC-2). */
export function decideLand(result) {
  if (result.status === 'merged') return { next: 'done' }
  return { next: 'stop', status: `land-${result.status}`, reason: `landing ended ${result.status}` }
}

// ---------------------------------------------------------------------- git

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=off', ...args], { cwd, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

async function gitOrNull(cwd, args) {
  try {
    return await git(cwd, args)
  } catch {
    return null
  }
}

const storyPaths = (branch) => {
  const filename = `${branch.replace(/^story\//, '')}.md`
  return [`stories/done/${filename}`, `stories/${filename}`]
}

/**
 * The `blocked:` value of the story file at `ref` on `branch`, wherever the
 * file is, or `{ unreadable }` when it cannot be read there.
 */
export async function readBlockedAt({ repoDir = DISPATCHER_ROOT, branch, ref }) {
  await git(repoDir, ['fetch', REMOTE, `+refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`])
  for (const candidate of storyPaths(branch)) {
    const source = await gitOrNull(repoDir, ['show', `${ref ?? `${REMOTE}/${branch}`}:${candidate}`])
    if (source === null) continue
    try {
      return { blocked: parseFrontmatter(source, candidate).data.blocked ?? null, path: candidate }
    } catch (error) {
      return { unreadable: error.message }
    }
  }
  return { unreadable: `the story file is on neither ${storyPaths(branch).join(' nor ')} at ${ref}` }
}

const oneLine = (text) => String(text).replace(/\p{Cc}+/gu, ' ').replace(/ {2,}/g, ' ').trim()

/** `source` with its `blocked:` line set to `reason`, as a double-quoted one-line scalar. */
export function withBlocked(source, reason) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) throw new Error('the story has no frontmatter block')
  const block = match[1]
  const line = `blocked: ${JSON.stringify(oneLine(reason))}`
  if (!/^blocked:.*$/m.test(block)) throw new Error('the story has no blocked: line in its frontmatter')
  const replaced = block.replace(/^blocked:.*$/m, () => line)
  return source.slice(0, match.index) + match[0].replace(block, () => replaced) + source.slice(match.index + match[0].length)
}

/**
 * AC-8 step 2: one commit on top of `branch`'s tip on `origin` that sets
 * `blocked:` to `reason`, pushed with `pushBranch`. Skipped when `blocked:` is
 * already set there. Resolves `{ status }`: `recorded` (with `headSha`),
 * `already-blocked`, or a failure (`local-branch-exists`, `story-unreadable`,
 * or `pushBranch`'s `push-failed` and the like), with `reason`.
 */
export async function recordBlocked({ repoDir = DISPATCHER_ROOT, branch, reason }) {
  if (await gitOrNull(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) {
    return { status: 'local-branch-exists', reason: `${branch} already exists locally, and this checkout's copy is not the one to commit on` }
  }
  await git(repoDir, ['fetch', REMOTE, `+refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`])
  const baseSha = (await git(repoDir, ['rev-parse', `${REMOTE}/${branch}`])).trim()

  const scratch = await mkdtemp(path.join(tmpdir(), 'tw-stop-'))
  const tree = path.join(scratch, 'tree')
  let worktreeAdded = false
  try {
    await git(repoDir, ['worktree', 'add', '--no-track', '-b', branch, tree, baseSha])
    worktreeAdded = true
    const file = storyPaths(branch).find((candidate) => existsSync(path.join(tree, candidate)))
    if (!file) return { status: 'story-unreadable', reason: `the story file is on neither ${storyPaths(branch).join(' nor ')}` }
    const source = readFileSync(path.join(tree, file), 'utf8')
    let existing
    try {
      existing = parseFrontmatter(source, file).data.blocked
    } catch (error) {
      return { status: 'story-unreadable', reason: error.message }
    }
    if (existing != null) return { status: 'already-blocked', blocked: existing }
    writeFileSync(path.join(tree, file), withBlocked(source, reason))
    await git(tree, ['add', '--', file])
    await git(tree, ['commit', '-m', `Record blocked: on ${branch.replace(/^story\//, '')}, the story's run stopped`])
    const push = await pushBranch({ cwd: tree, branch, baseSha })
    if (push.status !== 'pushed') return { status: push.status, reason: push.reason ?? push.status }
    return { status: 'recorded', headSha: push.headSha }
  } finally {
    if (worktreeAdded) await git(repoDir, ['worktree', 'remove', '--force', tree]).catch(() => {})
    await gitOrNull(repoDir, ['branch', '-D', branch])
    await rm(scratch, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------------ GitHub

const isHonoured = (comment) => HONOURED_ASSOCIATIONS.includes(comment.authorAssociation)

/** AC-3: the blocking verdict markers from honoured authors, on any head. Derived on every call. */
export function countBlockingVerdicts(comments) {
  return comments.filter((c) => c.marker.kind === 'marker' && c.marker.verdict === 'block' && isHonoured(c)).length
}

/** The latest honoured verdict marker at `headSha`, as the gate reads it, or `undefined`. */
export function verdictAtHead(comments, headSha) {
  return comments.findLast((c) => c.marker.kind === 'marker' && c.marker.headSha === headSha && isHonoured(c))
}

// The reviewer's findings without the marker line: the coder is handed the
// findings as data, and the marker is the gate's, not the coder's.
function findingsOf(comment) {
  const text = (comment?.body ?? '').replace(/<!--[^>]*-->/g, '').trim()
  return text === '' ? 'The review blocked this head and recorded no findings text.' : text
}

// ---------------------------------------------------------------- the run

/**
 * Runs `storyId` to merged.
 *
 *   ctx            a `github.mjs` context; `ciCtx` a `ci.mjs` context; `landCtx`
 *                  a `land.mjs` context
 *   prNumber       resume the story's open pull request instead of dispatching (AC-9)
 *   repoDir        the dispatcher's checkout, for the coder, the review and the stop commit
 *   options        `{ coder, reviewer }`: extra options for `dispatchCoder` and `retryStory`,
 *                  and for `reviewPullRequest` (`promptTemplate`, `baseEnv`,
 *                  `sessionOptions`, `install`). The two roles have different prompts
 *   deps           the modules' functions, replaceable by a test
 *
 * Resolves `{ status: 'merged', pr }`, or a stop: `{ status, stopped: true, reason, ... }`,
 * with `pr` and `record` (AC-8) when the story had a pull request. Exceptions from
 * the modules are not caught: a run that dies resumes from the pull request (AC-9).
 */
export async function runStory({
  storyId, prNumber, ctx, ciCtx, landCtx, repoDir = DISPATCHER_ROOT, options = {}, deps = {},
}) {
  const { storyPrefix } = await readSettings(repoDir)
  if (!new RegExp(`^${storyPrefix}-\\d+$`).test(storyId ?? '')) {
    throw new Error(`runStory requires a story id of the form ${storyPrefix}-<n>, got ${JSON.stringify(storyId)}`)
  }
  const d = {
    dispatchCoder, retryStory, waitForCi, countRedCiRounds, reviewPullRequest, landPullRequest,
    convertPullRequestToDraft, listPullRequestComments, getPullRequestLabels, readBlockedAt, recordBlocked,
    ...deps,
  }
  const run = { pr: null, branch: null, headSha: null }

  // AC-8. Only for a story with a pull request; each step's failure is reported, not thrown.
  async function stop(status, reason, extra = {}) {
    const record = { draft: false, blocked: null, recorded: false, failed: [] }
    try {
      const converted = await d.convertPullRequestToDraft(ctx, run.pr)
      if (converted?.draft !== true) throw new Error('GitHub reports the pull request is still not a draft')
      record.draft = true
    } catch (error) {
      record.failed.push({ step: 'draft', reason: error.message })
    }
    // Committing on a pull request that is still ready would break the rule that a
    // `blocked:` story is a draft, so a failed conversion leaves the commit undone.
    if (record.draft) {
      try {
        const done = await d.recordBlocked({ repoDir, branch: run.branch, reason: `${status}: ${reason}` })
        record.blocked = done.status
        if (done.status !== 'recorded' && done.status !== 'already-blocked') {
          record.failed.push({ step: 'blocked', reason: done.reason ?? done.status })
        }
      } catch (error) {
        record.failed.push({ step: 'blocked', reason: error.message })
      }
    }
    record.recorded = record.failed.length === 0
    return stopped(status, reason, { pr: run.pr, headSha: run.headSha, record, ...extra })
  }

  let phase = null // { next: 'ci' | 'review' | 'verdict' | 'land', ... }

  if (prNumber === undefined) {
    const dispatched = await d.dispatchCoder({ ctx, repoDir, storyId, ...options.coder })
    const decision = decideDispatch(dispatched)
    if (dispatched.status !== 'opened') {
      // Nothing to record on: there is no pull request (AC-8).
      return stopped(decision.status, decision.reason, { dispatch: dispatched })
    }
    run.pr = dispatched.pr.number
    run.branch = dispatched.branch
    run.headSha = dispatched.pr.headSha ?? dispatched.headSha
    if (decision.next === 'stop') return stop(decision.status, decision.reason, { dispatch: dispatched })
    phase = { next: 'ci' }
  } else {
    const json = await ctx.send(buildGetPullRequestState(ctx.repo, prNumber))
    const pr = parsePullRequestState(json)
    if (json.state !== 'open') return stopped('pr-not-open', `pull request ${prNumber} is ${json.state}, not open`, { pr: prNumber })
    if (typeof pr.headRef !== 'string' || !new RegExp(`^story/${storyId}-[A-Za-z0-9._-]+$`).test(pr.headRef)) {
      return stopped('wrong-branch', `pull request ${prNumber} has head ${JSON.stringify(pr.headRef)}, not a ${storyId} story branch`, { pr: prNumber })
    }
    run.pr = prNumber
    run.branch = pr.headRef
    run.headSha = pr.headSha
    if (pr.draft) return { status: 'already-stopped', stopped: true, reason: 'the pull request is a draft', pr: prNumber }
    const at = await d.readBlockedAt({ repoDir, branch: run.branch, ref: run.headSha })
    if (at.unreadable) return stop('story-unreadable', at.unreadable)
    if (at.blocked !== null) {
      return { status: 'already-stopped', stopped: true, reason: `the story file at the head has blocked: ${at.blocked}`, pr: prNumber }
    }
    const marker = verdictAtHead(await d.listPullRequestComments(ctx, prNumber), run.headSha)
    phase = marker ? { next: 'verdict', verdict: marker.marker.verdict, comment: marker } : { next: 'ci' }
  }

  // Every loop pass is a step of the run; each ends in a stop, a landing, or another pass.
  for (;;) {
    if (phase.next === 'ci') {
      const ci = await d.waitForCi(ciCtx, run.headSha)
      const redCount =
        ci.result === 'red' && ci.conclusion === 'failure' && !ci.setupFailure ? await d.countRedCiRounds(ciCtx, run.pr) : 0
      const decision = decideCi(ci, redCount)
      if (decision.next === 'stop') return stop(decision.status, decision.reason, { ci })
      phase = decision.next === 'review' ? { next: 'review' } : await retry(decision, ci.findings)
    } else if (phase.next === 'review') {
      const result = await d.reviewPullRequest({ number: run.pr, ctx, repoDir, rereview: phase.rereview === true, ...options.reviewer })
      const decision = decideReview(result)
      if (decision.next === 'stop') return stop(decision.status, decision.reason, { review: result })
      const comments = await d.listPullRequestComments(ctx, run.pr)
      phase = { next: 'verdict', verdict: decision.verdict, comment: comments.find((c) => c.id === result.commentId) }
    } else if (phase.next === 'verdict') {
      const comments = await d.listPullRequestComments(ctx, run.pr)
      const decision = decideVerdict(phase.verdict, {
        blocks: countBlockingVerdicts(comments),
        labels: await d.getPullRequestLabels(ctx, run.pr),
        findings: findingsOf(phase.comment),
      })
      if (decision.next === 'stop') return stop(decision.status, decision.reason)
      phase = decision.next === 'land' ? { next: 'land' } : await retry(decision, findingsOf(phase.comment))
    } else if (phase.next === 'land') {
      const landed = await d.landPullRequest({ number: run.pr, ctx: landCtx, passedAt: run.headSha })
      const decision = decideLand(landed)
      if (decision.next === 'stop') return stop(decision.status, decision.reason, { land: landed })
      return { status: 'merged', pr: run.pr, headSha: run.headSha, land: landed }
    } else {
      return stop(`unhandled-${phase.next}`, `the run reached a phase it does not know: ${phase.next}`)
    }
    if (phase.stop) return phase.stop
  }

  // AC-6: the round is the count so far plus one; the rounds remaining are the bound less that.
  async function retry(decision, findings) {
    const result = await d.retryStory({
      ctx, repoDir, storyId, prNumber: run.pr, findings, source: decision.source,
      round: decision.round, roundsRemaining: MAX_ROUNDS - decision.round, ...options.coder,
    })
    const next = decideRetry(result, decision.source)
    if (next.next === 'stop') return { stop: await stop(next.status, next.reason, { retry: result }) }
    if (next.next === 'ci') run.headSha = next.headSha
    return next
  }
}

// --------------------------------------------------------------------- CLI

async function main(argv) {
  const args = [...argv]
  const take = (name) => {
    const at = args.indexOf(name)
    return at === -1 ? undefined : args.splice(at, 2)[1]
  }
  const { repo: settingsRepo, storyPrefix } = await readSettings(DISPATCHER_ROOT)
  const repoFlag = take('--repo')
  const repo = repoFlag ?? settingsRepo
  const pr = take('--pr')
  const storyId = args.shift()
  const usage = `usage: node scripts/dispatch/story.mjs ${storyPrefix}-<n> [--pr <number>] [--repo owner/name]`
  if (args.length > 0 || !new RegExp(`^${storyPrefix}-\\d+$`).test(storyId ?? '') || (pr !== undefined && !/^[1-9]\d*$/.test(pr))) {
    throw new Error(usage)
  }
  const result = await runStory({
    storyId,
    prNumber: pr === undefined ? undefined : Number(pr),
    ctx: createContext({ repo }),
    ciCtx: createCiContext({ repo }),
    landCtx: createLandContext({ repo }),
  })
  console.log(JSON.stringify(result, null, 2))
  if (result.status !== 'merged') process.exitCode = 1
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
