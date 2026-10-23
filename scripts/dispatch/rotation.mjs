#!/usr/bin/env node
/**
 * A rotation of the review side, started as one command (ST-25): it decides which open pull
 * requests get a reviewer, starts reviewers up to a cap, has the pilot request landing for each
 * pull request that has passed, runs inspection, and exits, carrying nothing forward. Each run
 * uses steward as it is on `main`.
 *
 * It composes the modules that exist and reimplements none of them: `loop.mjs`'s
 * `requireOwnWorktree` and `updateCheckout`, `review.mjs`'s `reviewPullRequest`, `land.mjs`'s
 * `landPullRequest` (always with `once: true`, ST-23) and `inspect.mjs`'s `main`. It never pushes,
 * never starts a coder, and starts the runway only through the pilot.
 *
 *   1. Refuses to run from a checkout with a branch checked out, brings its worktree to
 *      `origin/main`, detached, and stops, doing nothing more, when the worktree has anything
 *      uncommitted. The settings are read after the update.
 *   2. Lists the open pull requests against `main` or a release branch (`isLandingBase`), once.
 *   3. Oldest first (lowest number), reviews each that is not a draft, whose author the gate
 *      honours (`HONOURED_ASSOCIATIONS`), that is not labelled `review-blocked`, and that has no
 *      honoured verdict at its current head, until `--max-reviews` reviews have been started.
 *   4. When the settings' `land` is true, reads the list again and, one at a time, has the pilot
 *      request landing for each pull request whose current head has an honoured `pass` or
 *      `pass-with-observations` verdict, whoever opened it and whenever it passed.
 *   4a. Runs inspection once. What it prints is printed, and its exit code, or an error in it, is
 *      printed and changes neither what the rotation has done nor its own exit code.
 *   5. Prints one line per pull request considered, and exits 0.
 *
 * It exits non-zero only when the rotation itself could not run or go on: a checkout with a
 * branch (`branch-checked-out`), a worktree that cannot be brought to `origin/main`
 * (`update-failed`) or has anything uncommitted (`dirty`), settings that do not read
 * (`settings-unreadable`), a listing that fails (`listing-failed`), a script that throws
 * (`script-error`), a worktree a review changed (`worktree-changed`), or a reviewer that could not
 * review (`cannot-review`, ST-37). It stores nothing.
 *
 * `rules-unreadable` and `choice-unavailable` from `reviewPullRequest` refuse every pull request
 * alike, so they end the reviewing and not the rotation: step 4 and step 4a go on. Any other
 * status a script returns is that pull request's outcome, and the rotation goes on.
 *
 * Usage:
 *   node scripts/dispatch/rotation.mjs [--max-reviews N] [--repo owner/name]
 *   node scripts/dispatch/cli.mjs rotation [--max-reviews N] [--repo owner/name]
 */
import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { isLandingBase } from '../land/release-branch.mjs'
import {
  createContext, getPullRequestLabels, listOpenPullRequests, listPullRequestComments,
} from './github.mjs'
import { createInspectContext, listReleaseBranches, main as inspectMain } from './inspect.mjs'
import { createLandContext, landPullRequest } from './land.mjs'
import { requireOwnWorktree, updateCheckout } from './loop.mjs'
import { HONOURED_ASSOCIATIONS, reviewPullRequest } from './review.mjs'
import { readSettings } from './settings.mjs'

const execFileAsync = promisify(execFile)

export const DEFAULT_MAX_REVIEWS = 5
const PASSING = ['pass', 'pass-with-observations']
const REVIEW_BLOCKED = 'review-blocked'
// The refusals that hold for every pull request alike: they end the reviewing, not the rotation.
const ENDS_REVIEWING = ['rules-unreadable', 'choice-unavailable']
const USAGE = 'usage: node scripts/dispatch/rotation.mjs [--max-reviews N] [--repo owner/name]'

// ---------------------------------------------------------------- arguments

/** Parses argv into `{ maxReviews, repo }`; `repo` is `undefined` when not given. Throws on misuse. */
export function parseArgs(argv) {
  const args = [...argv]
  const take = (flag) => {
    const at = args.indexOf(flag)
    if (at === -1) return undefined
    const value = args[at + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(USAGE)
    args.splice(at, 2)
    return value
  }
  const repo = take('--repo')
  const raw = take('--max-reviews')
  if (args.length > 0) throw new Error(USAGE)
  let maxReviews = DEFAULT_MAX_REVIEWS
  if (raw !== undefined) {
    maxReviews = /^[1-9][0-9]*$/.test(raw) ? Number(raw) : NaN
    if (!Number.isSafeInteger(maxReviews)) throw new Error(`--max-reviews must be a positive integer, got: ${raw}`)
  }
  return { maxReviews, repo }
}

// ------------------------------------------------------------------- reading

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd, maxBuffer: 64 * 1024 * 1024,
  })
  return stdout
}

/**
 * Every open pull request against `main` or a release branch (`isLandingBase`), in one list: the
 * release branches are read the way inspection reads them (`listReleaseBranches`), then the open
 * pull requests against each base (`listOpenPullRequests`).
 */
export async function listLandingPullRequests({ ctx, inspectCtx }) {
  const bases = ['main', ...(await listReleaseBranches(inspectCtx))].filter((base) => isLandingBase(base))
  const all = []
  for (const base of bases) all.push(...(await listOpenPullRequests(ctx, { base })))
  return all
}

const defaultDeps = {
  requireOwnWorktree, updateCheckout, readSettings, git,
  createContext, createLandContext, createInspectContext,
  listPullRequests: listLandingPullRequests, getPullRequestLabels, listPullRequestComments,
  reviewPullRequest, landPullRequest,
  inspection: ({ repo, cwd, out }) => inspectMain(['--repo', repo], { cwd, out, err: out }),
}

/** The latest comment with an honoured marker at `headSha`, or `undefined`. */
function verdictAtHead(comments, headSha) {
  return comments.findLast((c) =>
    c.marker.kind === 'marker' && c.marker.headSha === headSha && HONOURED_ASSOCIATIONS.includes(c.authorAssociation))
}

const byNumber = (a, b) => a.number - b.number

function describeLanding(result) {
  const details = []
  if (result.reason !== undefined) details.push(`reason: ${result.reason}`)
  if (result.waiting !== undefined) details.push(`waiting: ${[result.waiting].flat().join(', ')}`)
  if (result.failing !== undefined) details.push(`failing: ${[result.failing].flat().join(', ')}`)
  if (result.newHeadSha !== undefined) details.push(`new head: ${result.newHeadSha}`)
  return details.length === 0 ? result.status : `${result.status} (${details.join('; ')})`
}

function describeReview(result) {
  const parts = [result.status]
  if (result.verdict !== undefined) parts.push(result.verdict)
  const text = result.reason ?? result.summary
  if (typeof text === 'string' && text !== '') parts.push(text)
  return parts.length === 1 ? parts[0] : `${parts[0]} (${parts.slice(1).join('; ')})`
}

// ------------------------------------------------------------------ rotation

/**
 * Runs one rotation and resolves `{ status, exitCode, lines }`: `status` is `finished`, or the
 * reason the rotation stopped (see the header); `lines` is what step 5 printed (and the stop, last).
 * Everything printed goes through `out`.
 *
 *   repoDir      the rotation's own worktree
 *   maxReviews   the cap on reviews started
 *   repo         `owner/name`; defaults to the settings' `repo`
 *   deps         replaceable by a test: `requireOwnWorktree`, `updateCheckout`, `readSettings`,
 *                `git(cwd, args)` (resolving stdout), `createContext`, `createLandContext`,
 *                `createInspectContext`, `listPullRequests({ ctx, inspectCtx })`,
 *                `getPullRequestLabels`, `listPullRequestComments`, `reviewPullRequest`,
 *                `landPullRequest` and `inspection({ repo, cwd, out })` (resolving an exit code)
 */
export async function runRotation({ repoDir, maxReviews = DEFAULT_MAX_REVIEWS, repo, deps = {}, out = console.log }) {
  const d = { ...defaultDeps, ...deps }
  const records = new Map() // number -> { number, review, landing }
  const record = (number) => {
    if (!records.has(number)) records.set(number, { number, review: null, landing: null })
    return records.get(number)
  }
  const printed = []
  const print = (line) => {
    printed.push(line)
    out(line)
  }
  let stopped = null // { status, text }
  const stop = (status, text) => {
    stopped ??= { status, text }
  }
  const finish = () => {
    if (stopped === null) return { status: 'finished', exitCode: 0, lines: printed }
    print(`rotation stopped (${stopped.status}): ${stopped.text}`)
    return { status: stopped.status, exitCode: 1, lines: printed }
  }
  const printRecords = () => {
    for (const r of [...records.values()].sort(byNumber)) {
      print(`#${r.number} ${[r.review, r.landing].filter((part) => part !== null).join('; ')}`)
    }
  }

  // Step 1.
  try {
    await d.requireOwnWorktree(repoDir)
  } catch (error) {
    stop('branch-checked-out', error.message)
    return finish()
  }
  let checkout
  try {
    checkout = await d.updateCheckout(repoDir)
  } catch (error) {
    stop('update-failed', `${repoDir} could not be brought to origin/main: ${error.message}`)
    return finish()
  }
  if (checkout.status === 'dirty') {
    stop('dirty', `${repoDir} has uncommitted changes (${checkout.paths.join(', ')}); nothing was done`)
    return finish()
  }
  const checkedOut = checkout.headSha
  let settings
  try {
    settings = await d.readSettings(repoDir)
  } catch (error) {
    stop('settings-unreadable', error.message)
    return finish()
  }
  const slug = repo ?? settings.repo
  const ctx = d.createContext({ repo: slug })
  const landCtx = d.createLandContext({ repo: slug, landing: settings.land, landWhen: settings.landWhen })
  const inspectCtx = d.createInspectContext({ repo: slug })

  // Step 2.
  let prs
  try {
    prs = (await d.listPullRequests({ ctx, inspectCtx })).sort(byNumber)
  } catch (error) {
    stop('listing-failed', `step 2, listing the open pull requests: ${error.message}`)
    return finish()
  }

  // Step 3.
  let reviews = 0
  let reviewing = true
  let reviewingEnded = null
  for (const pr of prs) {
    const rec = record(pr.number)
    if (!reviewing) {
      rec.review = reviewingEnded
      continue
    }
    if (pr.draft) {
      rec.review = 'skipped: a draft'
      continue
    }
    if (!HONOURED_ASSOCIATIONS.includes(pr.authorAssociation)) {
      rec.review = `skipped: outsider (${pr.authorAssociation})`
      continue
    }
    if (reviews >= maxReviews) {
      rec.review = `not reviewed: the cap of ${maxReviews} reviews was reached`
      continue
    }
    try {
      if ((await d.getPullRequestLabels(ctx, pr.number)).includes(REVIEW_BLOCKED)) {
        rec.review = 'skipped: labelled review-blocked'
        continue
      }
      if (verdictAtHead(await d.listPullRequestComments(ctx, pr.number), pr.headSha)) {
        rec.review = 'skipped: a verdict is already at its head'
        continue
      }
    } catch (error) {
      stop('listing-failed', `step 3, reading #${pr.number}: ${error.message}`)
      break
    }

    reviews += 1
    let result
    try {
      result = await d.reviewPullRequest({ number: pr.number, ctx, repoDir })
    } catch (error) {
      rec.review = `review threw: ${error.message}`
      stop('script-error', `step 3, the review of #${pr.number} threw: ${error.message}`)
      break
    }
    rec.review = `reviewed: ${describeReview(result)}`

    // The review must not have changed the files the pilot runs from.
    let head
    let porcelain
    try {
      head = (await d.git(repoDir, ['rev-parse', 'HEAD'])).trim()
      porcelain = (await d.git(repoDir, ['status', '--porcelain'])).trim()
    } catch (error) {
      stop('script-error', `step 3, reading ${repoDir} after the review of #${pr.number}: ${error.message}`)
      break
    }
    if (head !== checkedOut || porcelain !== '') {
      stop('worktree-changed',
        `the review of #${pr.number} came before a change to ${repoDir} (HEAD ${head}, checked out ${checkedOut}` +
        `${porcelain === '' ? '' : `; git status prints ${JSON.stringify(porcelain)}`})`)
      break
    }

    if (result.status === 'cannot-review') {
      stop('cannot-review', `the reviewer could not review #${pr.number}: ${result.summary}`)
      break
    }
    if (ENDS_REVIEWING.includes(result.status)) {
      reviewing = false
      reviewingEnded = `not reviewed: reviewing ended at #${pr.number} (${result.status})`
    }
  }
  if (stopped !== null) {
    printRecords()
    return finish()
  }

  // Step 4.
  if (!settings.land) {
    for (const rec of records.values()) rec.landing = 'not landed: landing is off in the settings'
  } else {
    let again
    try {
      again = (await d.listPullRequests({ ctx, inspectCtx })).sort(byNumber)
    } catch (error) {
      stop('listing-failed', `step 4, listing the open pull requests: ${error.message}`)
      printRecords()
      return finish()
    }
    for (const pr of again) {
      const rec = record(pr.number)
      let passing
      try {
        const found = verdictAtHead(await d.listPullRequestComments(ctx, pr.number), pr.headSha)
        passing = found !== undefined && PASSING.includes(found.marker.verdict)
      } catch (error) {
        stop('listing-failed', `step 4, reading #${pr.number}: ${error.message}`)
        break
      }
      if (!passing) {
        rec.landing = 'not landed: no passing verdict at its head'
        continue
      }
      try {
        const result = await d.landPullRequest({ number: pr.number, ctx: landCtx, passedAt: pr.headSha, once: true })
        rec.landing = `landing: ${describeLanding(result)}`
      } catch (error) {
        rec.landing = `landing threw: ${error.message}`
        stop('script-error', `step 4, landing #${pr.number} threw: ${error.message}`)
        break
      }
    }
    if (stopped !== null) {
      printRecords()
      return finish()
    }
  }

  // Step 4a.
  print('inspection:')
  try {
    const code = await d.inspection({ repo: slug, cwd: repoDir, out: print })
    print(`inspection exit code: ${code}`)
  } catch (error) {
    print(`inspection error: ${error.message}`)
  }

  // Step 5.
  printRecords()
  return finish()
}

// --------------------------------------------------------------------- CLI

async function main(argv) {
  const { maxReviews, repo } = parseArgs(argv)
  const result = await runRotation({ repoDir: process.cwd(), maxReviews, repo })
  process.exitCode = result.exitCode
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
