#!/usr/bin/env node
/**
 * Triggers the landing sweep once a pull request is landable, and waits for it
 * to merge (OQ-50). The sweep, `.github/workflows/land-approved.yml`, is the
 * only thing that merges; this module never does. Its one write is a
 * `workflow_dispatch` of that workflow on `main` with no inputs.
 *
 * Landable means: not a draft, no `review-blocked` label, `mergeable_state`
 * `clean`, and `review/agent` = `success` on the head SHA. The sweep re-checks
 * every one of those itself; this only decides when to ask it to.
 *
 * Every reason a pull request cannot become landable is a distinct `status` on
 * the result rather than an indefinite wait. `unknown` is the exception: GitHub
 * recomputes `mergeable_state` after a merge, and the sweep skips `unknown`, so
 * it is waited through, and the sweep is re-triggered while the pull request is
 * still open after a triggered run (#123/#125, 2026-09-24).
 *
 * Latency bound (AC-5): a pull request is polled every `POLL_INTERVAL_MS`, and
 * the first trigger is sent in the same iteration that first sees it landable.
 * So the time from becoming landable to the first trigger is
 * at most `POLL_INTERVAL_MS` plus the time of the requests in one iteration. A re-trigger
 * waits `SWEEP_RUN_BOUND_MS` after the previous one, so the sweep is not
 * dispatched on top of a run that may still be working.
 *
 * Latency is observable after the fact (AC-7): every call appends one JSON line
 * to `logs/land-latency.jsonl` (gitignored) with when the pull request was first
 * seen landable, when the sweep was first triggered, and when it was seen merged.
 * `node scripts/dispatch/land.mjs --latency [N]` prints the last N.
 *
 * Neither `coder.mjs` nor `review.mjs` imports this module, so no session that
 * runs a model can reach the landing trigger. `github.mjs`'s allowlist is not
 * touched: this module has its own, checked before any network call.
 *
 * Usage:
 *   node scripts/dispatch/land.mjs <pr-number> [--repo owner/name]
 *   node scripts/dispatch/land.mjs --latency [N]
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ghAuthToken } from './github.mjs'

const API = 'https://api.github.com'
const DEFAULT_REPO = 'luplows/tower-workshop-paths'
const WORKFLOW = 'land-approved.yml'
const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_LATENCY_LOG = path.join(HERE, '..', '..', 'logs', 'land-latency.jsonl')

// ------------------------------------------------------------------ bounds

export const POLL_INTERVAL_MS = 15_000
// One sweep run is given this long to merge the pull request before another is triggered.
export const SWEEP_RUN_BOUND_MS = 3 * 60_000
// `review/agent` still pending after this long: the review is not coming.
export const REVIEW_PENDING_BOUND_MS = 30 * 60_000
// `mergeable_state` `blocked` (a required check not green) with review passed.
export const BLOCKED_BOUND_MS = 10 * 60_000
// `mergeable_state` `unknown` (or any state that is not `clean`, `blocked` or `dirty`).
export const UNKNOWN_BOUND_MS = 5 * 60_000
// Sweep triggers sent for one pull request that is still open afterwards.
export const MAX_TRIGGERS = 5
// Total time in one call, whatever the reason.
export const MAX_TOTAL_WAIT_MS = 60 * 60_000

// ------------------------------------------------------------ requests / allowlist

function repoPath(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error(`repo must be "owner/name", got: ${repo}`)
  return `${API}/repos/${repo}`
}

function requirePrNumber(number) {
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`pull request number must be a positive integer, got: ${number}`)
  }
  return number
}

export function buildGetPullRequest(repo, number) {
  return { method: 'GET', url: `${repoPath(repo)}/pulls/${requirePrNumber(number)}` }
}

export function buildGetCommitStatus(repo, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error(`sha must be a full 40-character SHA, got: ${sha}`)
  return { method: 'GET', url: `${repoPath(repo)}/commits/${sha}/status` }
}

/** The one write: dispatch the sweep on `main`, with no inputs. */
export function buildDispatchSweep(repo) {
  return {
    method: 'POST',
    url: `${repoPath(repo)}/actions/workflows/${WORKFLOW}/dispatches`,
    body: { ref: 'main' },
  }
}

const ALLOWED = [
  ['GET', /^\/pulls\/[1-9][0-9]*$/],
  ['GET', /^\/commits\/[0-9a-f]{40}\/status$/],
  ['POST', new RegExp(`^/actions/workflows/${WORKFLOW.replace('.', '\\.')}/dispatches$`)],
]

/** Throws unless `request` is one of the three this module builds. Runs before any network call. */
export function assertAllowedRequest(repo, request) {
  const prefix = repoPath(repo)
  const url = typeof request?.url === 'string' ? request.url : ''
  const rest = url.startsWith(`${prefix}/`) ? url.slice(prefix.length) : null
  if (!rest || !ALLOWED.some(([method, re]) => method === request.method && re.test(rest))) {
    throw new Error(`refusing a request outside the operations land.mjs performs: ${request?.method} ${url}`)
  }
  const keys = request.body === undefined ? [] : Object.keys(request.body)
  const isDispatch = request.method === 'POST'
  const ok = isDispatch ? keys.length === 1 && request.body.ref === 'main' : keys.length === 0
  if (!ok) throw new Error(`refusing a request with an unexpected body: ${request.method} ${url}`)
}

// --------------------------------------------------------------------- I/O

/** `fetch` and `getToken` are injectable; the token is read once, on first use. */
export function createLandContext({ repo, fetch = globalThis.fetch, getToken = ghAuthToken }) {
  repoPath(repo)
  let token
  return {
    repo,
    async send(request) {
      assertAllowedRequest(repo, request)
      token ??= await getToken()
      const response = await fetch(request.url, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      })
      if (!response.ok) {
        throw new Error(`${request.method} ${request.url} failed: ${response.status} ${await response.text()}`)
      }
      // A workflow dispatch answers 204 with no body.
      return response.status === 204 ? null : response.json()
    },
  }
}

// ------------------------------------------------------------------- reading

function readPullRequest(json) {
  return {
    headSha: json.head.sha,
    state: json.state,
    merged: json.merged === true || (json.merged_at ?? null) !== null,
    draft: json.draft === true,
    labels: (json.labels ?? []).map((label) => label.name),
    mergeableState: json.mergeable_state ?? 'unknown',
  }
}

function reviewState(json) {
  return (json.statuses ?? []).find((s) => s.context === 'review/agent')?.state ?? 'absent'
}

/**
 * Why the pull request cannot be landed yet, or `null` if it can. `wait` is
 * `{ reason, bound }` for a condition that may clear; `final` is a terminal status.
 */
function assess(pr, review) {
  if (pr.draft) return { final: 'draft' }
  if (pr.labels.includes('review-blocked')) return { final: 'review-blocked' }
  if (review === 'failure' || review === 'error') return { final: 'review-failed' }
  if (review !== 'success') return { wait: 'review-pending', bound: REVIEW_PENDING_BOUND_MS }
  if (pr.mergeableState === 'dirty') return { final: 'conflict' }
  if (pr.mergeableState === 'clean') return null
  if (pr.mergeableState === 'blocked') return { wait: 'blocked', bound: BLOCKED_BOUND_MS }
  // `unknown`, and anything else GitHub reports that is not yet `clean`.
  return { wait: 'unknown', bound: UNKNOWN_BOUND_MS }
}

// --------------------------------------------------------------- the entry point

/**
 * Waits until pull request `number` is landable, triggers the sweep, and waits
 * until it is merged. Returns `{ status, ... }`; `status` is `merged` on success.
 * `sleep` and `now` are injectable so the bounds can be tested without waiting.
 */
export async function landPullRequest({
  number,
  ctx,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  latencyLog = DEFAULT_LATENCY_LOG,
}) {
  requirePrNumber(number)
  const startedAt = now()
  const times = { landableAt: null, triggeredAt: null, mergedAt: null }
  let triggers = 0
  let lastTriggerAt = null
  let headSha = null
  let waiting = null // { reason, since }

  const finish = async (status, extra = {}) => {
    const result = { status, pr: number, headSha, triggers, ...extra }
    await recordLatency(latencyLog, { ...result, ...toIso(times), startedAt: new Date(startedAt).toISOString(), endedAt: new Date(now()).toISOString() })
    return result
  }

  for (;;) {
    const pr = readPullRequest(await ctx.send(buildGetPullRequest(ctx.repo, number)))
    if (pr.merged) {
      times.mergedAt = now()
      return finish('merged')
    }
    if (pr.state !== 'open') return finish('closed')
    if (headSha !== null && pr.headSha !== headSha) return finish('head-moved', { newHeadSha: pr.headSha })
    headSha = pr.headSha

    // Not asked for at all when the pull request is a draft or blocked: the answer changes nothing.
    const early = assess(pr, 'success')
    const review = early?.final ? 'success' : reviewState(await ctx.send(buildGetCommitStatus(ctx.repo, headSha)))
    const verdict = early?.final ? early : assess(pr, review)

    if (verdict?.final) return finish(verdict.final)

    if (verdict === null) {
      waiting = null
      times.landableAt ??= now()
      if (lastTriggerAt === null || now() - lastTriggerAt >= SWEEP_RUN_BOUND_MS) {
        if (triggers >= MAX_TRIGGERS) return finish('trigger-limit')
        await ctx.send(buildDispatchSweep(ctx.repo))
        triggers += 1
        lastTriggerAt = now()
        times.triggeredAt ??= lastTriggerAt
      }
    } else {
      if (waiting?.reason !== verdict.wait) waiting = { reason: verdict.wait, since: now() }
      if (now() - waiting.since >= verdict.bound) return finish(verdict.wait === 'unknown' ? 'unknown' : verdict.wait)
    }

    if (now() - startedAt >= MAX_TOTAL_WAIT_MS) return finish('timeout')
    await sleep(POLL_INTERVAL_MS)
  }
}

// ------------------------------------------------------------------ latency log

function toIso(times) {
  return Object.fromEntries(Object.entries(times).map(([k, v]) => [k, v === null ? null : new Date(v).toISOString()]))
}

async function recordLatency(file, record) {
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify(record)}\n`)
}

/**
 * The last `n` calls, oldest first, each with `waitSeconds`: how long the pull
 * request waited between becoming landable and the sweep being triggered
 * (`null` if it never became landable), and `mergeSeconds`: landable to merged.
 */
export async function recentLandingLatencies(n = 10, file = DEFAULT_LATENCY_LOG) {
  const text = await readFile(file, 'utf8').catch((error) => (error.code === 'ENOENT' ? '' : Promise.reject(error)))
  const seconds = (from, to) => (from && to ? (Date.parse(to) - Date.parse(from)) / 1000 : null)
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
    .slice(-n)
    .map((r) => ({
      pr: r.pr,
      status: r.status,
      landableAt: r.landableAt,
      triggeredAt: r.triggeredAt,
      mergedAt: r.mergedAt,
      waitSeconds: seconds(r.landableAt, r.triggeredAt),
      mergeSeconds: seconds(r.landableAt, r.mergedAt),
    }))
}

// --------------------------------------------------------------------- CLI

async function main(argv) {
  const args = [...argv]
  const latencyAt = args.indexOf('--latency')
  if (latencyAt !== -1) {
    const n = args[latencyAt + 1] === undefined ? 10 : Number(args[latencyAt + 1])
    if (!Number.isInteger(n) || n <= 0) throw new Error('usage: node scripts/dispatch/land.mjs --latency [N]')
    console.log(JSON.stringify(await recentLandingLatencies(n), null, 2))
    return
  }
  const repoAt = args.indexOf('--repo')
  const repo = repoAt === -1 ? DEFAULT_REPO : args.splice(repoAt, 2)[1]
  const number = Number(args[0])
  if (args.length !== 1 || !Number.isInteger(number) || number <= 0) {
    throw new Error('usage: node scripts/dispatch/land.mjs <pr-number> [--repo owner/name]')
  }
  const result = await landPullRequest({ number, ctx: createLandContext({ repo }) })
  console.log(JSON.stringify(result, null, 2))
  if (result.status !== 'merged') process.exitCode = 1
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
