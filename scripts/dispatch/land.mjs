#!/usr/bin/env node
/**
 * Triggers the landing sweep once a pull request is landable, and waits for it
 * to merge (OQ-50). The sweep, `.github/workflows/land-approved.yml`, is the
 * only thing that merges; this module never does. Its one write is a
 * `workflow_dispatch` of that workflow on `main`. Unattended, its one input names this pull
 * request. Manual (ST-54), its inputs are `mode: manual`, this pull request and the full head SHA
 * the request authorizes. The runway checks each against GitHub and against the project's `main`.
 *
 * Landable means: not a draft, no `review-blocked` label, `review/agent` = `success` on the head
 * SHA, the checks the settings' `landWhen` names green on the head (read with `checksGreen`,
 * `scripts/land/checks-green.mjs`), and a `mergeable_state` GitHub would merge in
 * (`MERGEABLE_STATES` there). A `dirty` one is a conflict; a `blocked` one with those checks
 * green is `github-blocked`, and `unknown` (or any state not named) is waited for. The sweep
 * re-checks the same itself with the same function; this only decides when to ask it to.
 *
 * Every reason a pull request cannot become landable is a distinct `status` on
 * the result rather than an indefinite wait. `unknown` is the exception: GitHub
 * recomputes `mergeable_state` after a merge, and the sweep skips `unknown`, so
 * it is waited through, and the sweep is re-triggered while the pull request is
 * still open after a triggered run (#123/#125, 2026-09-24).
 *
 * A rotation waits only for an event that finishes on its own within a known bound: the gate's
 * status after a verdict (`GATE_LAG_BOUND_MS`) and the runway's merge after a trigger
 * (`SWEEP_RUN_BOUND_MS`). It waits for nothing else, leaving anything of unknown length, such as
 * checks still running, to a later rotation. Called with `once` (ST-23, ST-51) it waits for those
 * two and no other: see `landPullRequest`. Unattended, with the settings' `land` false, it sends
 * nothing at all. The standalone `land` command below is a manual request (ST-54): one gated
 * landing of one pull request at one head, valid whether `land` is true or false. It changes no
 * setting, label or standing permission, and no other caller requests it.
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
import { readSettings } from './settings.mjs'
import { assertLandWhen, checksGreen, mergeableOutcome } from '../land/checks-green.mjs'

const API = 'https://api.github.com'
const CHECK_RUNS_PAGE = 100
const WORKFLOW = 'land-approved.yml'
const SHA_PATTERN = /^[0-9a-f]{40}$/
export const MANUAL = 'manual'
export const UNATTENDED = 'unattended'
const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_LATENCY_LOG = path.join(HERE, '..', '..', 'logs', 'land-latency.jsonl')

// ------------------------------------------------------------------ bounds

export const POLL_INTERVAL_MS = 15_000
// One sweep run is given this long to merge the pull request before another is triggered.
export const SWEEP_RUN_BOUND_MS = 3 * 60_000
// `review/agent` still pending after this long: the review is not coming.
export const REVIEW_PENDING_BOUND_MS = 30 * 60_000
// `mergeable_state` `blocked` with review passed and the checks `landWhen` names green: GitHub
// requires something `landWhen` does not name (ST-24). A later call may find it cleared.
export const BLOCKED_BOUND_MS = 10 * 60_000
// A check `landWhen` names still unfinished, or absent, with review passed (ST-24).
export const CHECKS_PENDING_BOUND_MS = 30 * 60_000
// `mergeable_state` `unknown` (or any state that is not one `mergeableOutcome` names).
export const UNKNOWN_BOUND_MS = 5 * 60_000
// `review/agent` reads `failure`/`error` on the same head the caller holds a passing verdict for
// (`passedAt`): the gate has not yet turned the fresh pass into a `success` status (OQ-104).
export const GATE_LAG_BOUND_MS = 2 * 60_000
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

/**
 * The head's check runs (ST-24), the allowlist's one added read. One request for up to 100; a head
 * with more is refused by `readChecks`, since the rest could hold a failure.
 */
export function buildGetCheckRuns(repo, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error(`sha must be a full 40-character SHA, got: ${sha}`)
  return { method: 'GET', url: `${repoPath(repo)}/commits/${sha}/check-runs?per_page=${CHECK_RUNS_PAGE}` }
}

export function buildGetCommitStatus(repo, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error(`sha must be a full 40-character SHA, got: ${sha}`)
  return { method: 'GET', url: `${repoPath(repo)}/commits/${sha}/status` }
}

/**
 * The one write, in its unattended form: dispatch the sweep on `main`, naming the one pull request
 * it may land. It carries no `mode`, so the runway reads it as unattended and lands only where the
 * project's `land` on `main` is true.
 */
export function buildDispatchSweep(repo, number) {
  return {
    method: 'POST',
    url: `${repoPath(repo)}/actions/workflows/${WORKFLOW}/dispatches`,
    body: { ref: 'main', inputs: { pr: String(requirePrNumber(number)) } },
  }
}

/**
 * The one write, in its manual form (ST-54): the same dispatch, with `mode: manual`, the pull
 * request and the full head SHA the request authorizes, and nothing else.
 */
export function buildDispatchManualLanding(repo, number, head) {
  if (!SHA_PATTERN.test(head ?? '')) throw new Error(`head must be a full 40-character SHA, got: ${head}`)
  return {
    method: 'POST',
    url: `${repoPath(repo)}/actions/workflows/${WORKFLOW}/dispatches`,
    body: { ref: 'main', inputs: { mode: MANUAL, pr: String(requirePrNumber(number)), head } },
  }
}

const ALLOWED = [
  ['GET', /^\/pulls\/[1-9][0-9]*$/],
  ['GET', /^\/commits\/[0-9a-f]{40}\/status$/],
  ['GET', new RegExp(`^/commits/[0-9a-f]{40}/check-runs\\?per_page=${CHECK_RUNS_PAGE}$`)],
  ['POST', new RegExp(`^/actions/workflows/${WORKFLOW.replace('.', '\\.')}/dispatches$`)],
]

/**
 * Throws unless `request` is one of the four this module builds, a dispatch in either form. Runs
 * before any network call.
 */
export function assertAllowedRequest(repo, request) {
  const prefix = repoPath(repo)
  const url = typeof request?.url === 'string' ? request.url : ''
  const rest = url.startsWith(`${prefix}/`) ? url.slice(prefix.length) : null
  if (!rest || !ALLOWED.some(([method, re]) => method === request.method && re.test(rest))) {
    throw new Error(`refusing a request outside the operations land.mjs performs: ${request?.method} ${url}`)
  }
  const body = request.body
  const keys = body === undefined ? [] : Object.keys(body)
  const inputKeys = body?.inputs && typeof body.inputs === 'object' ? Object.keys(body.inputs) : []
  const isDispatch = request.method === 'POST'
  const hasPr = typeof body?.inputs?.pr === 'string' && /^[1-9][0-9]*$/.test(body.inputs.pr)
  // Two bodies only: `{ pr }` (unattended) and `{ mode: 'manual', pr, head }` (ST-54).
  const unattended = inputKeys.length === 1 && inputKeys[0] === 'pr'
  const manual =
    inputKeys.length === 3 && ['mode', 'pr', 'head'].every((key) => inputKeys.includes(key)) &&
    body.inputs.mode === MANUAL && SHA_PATTERN.test(typeof body.inputs.head === 'string' ? body.inputs.head : '')
  const ok = isDispatch
    ? keys.length === 2 && keys.includes('ref') && keys.includes('inputs') && body.ref === 'main' && hasPr && (unattended || manual)
    : keys.length === 0
  if (!ok) throw new Error(`refusing a request with an unexpected body: ${request.method} ${url}`)
}

// --------------------------------------------------------------------- I/O

/**
 * `landing` is the settings' `land` value, required with no default: `false` makes
 * `landPullRequest` return `landing-off` without sending any request (ST-23). `landWhen` is the
 * settings' value of that name, likewise required (ST-24).
 * `fetch` and `getToken` are injectable; the token is read once, on first use.
 */
export function createLandContext({ repo, landing, landWhen, fetch = globalThis.fetch, getToken = ghAuthToken }) {
  repoPath(repo)
  if (typeof landing !== 'boolean') throw new Error(`landing must be true or false, got: ${JSON.stringify(landing)}`)
  assertLandWhen(landWhen)
  let token
  return {
    repo,
    landing,
    landWhen,
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
 * The checks `landWhen` names, read from the head's commit statuses and check runs (ST-24). A
 * response with fewer statuses or check runs than it counts is refused rather than read as green:
 * the rest could hold a failure, which the sweep, reading every page, would see.
 */
function readChecks(statusJson, checkRunsJson, landWhen) {
  const statuses = statusJson.statuses ?? []
  if (statusJson.total_count > statuses.length) {
    throw new Error(`the head has ${statusJson.total_count} statuses and only ${statuses.length} were returned`)
  }
  const checkRuns = checkRunsJson.check_runs ?? []
  if (checkRunsJson.total_count > checkRuns.length) {
    throw new Error(`the head has ${checkRunsJson.total_count} check runs and only ${checkRuns.length} were returned`)
  }
  return checksGreen({ checkRuns, statuses, landWhen })
}

/**
 * Why the pull request cannot be landed yet, or `null` if it can. `wait` is
 * `{ reason, bound }` for a condition that may clear; `final` is a terminal status.
 *
 * `gateLag` is true when the caller holds an honoured pass at this exact head
 * (`passedAt`): a `failure`/`error` status is then the gate not having caught up
 * yet rather than a real block, so it is waited through instead of being final
 * (OQ-104).
 */
function assess(pr, review, gateLag) {
  if (pr.draft) return { final: 'draft' }
  if (pr.labels.includes('review-blocked')) return { final: 'review-blocked' }
  if (review === 'failure' || review === 'error') {
    if (gateLag) return { wait: 'gate-lag', bound: GATE_LAG_BOUND_MS }
    return { final: 'review-failed' }
  }
  if (review !== 'success') return { wait: 'review-pending', bound: REVIEW_PENDING_BOUND_MS }
  if (mergeableOutcome(pr.mergeableState) === 'conflict') return { final: 'conflict' }
  return null
}

/**
 * The second half of `assess`, once the review and a conflict are settled and the head's checks
 * have been read: the named checks, then what GitHub says of the merge (ST-24).
 */
function assessChecks(pr, checks) {
  if (!checks.green) {
    if (checks.failing.length > 0) return { final: 'checks-failed', failing: checks.failing }
    return { wait: 'checks-pending', bound: CHECKS_PENDING_BOUND_MS, waiting: checks.waiting }
  }
  const outcome = mergeableOutcome(pr.mergeableState)
  if (outcome === 'landable') return null
  if (outcome === 'github-blocked') return { wait: 'github-blocked', bound: BLOCKED_BOUND_MS }
  // `unknown`, and anything else GitHub reports that is not one it would merge.
  return { wait: 'unknown', bound: UNKNOWN_BOUND_MS }
}

// --------------------------------------------------------------- the entry point

/**
 * Waits until pull request `number` is landable, triggers the sweep, and waits
 * until it is merged. Returns `{ status, ... }`; `status` is `merged` on success.
 * `sleep` and `now` are injectable so the bounds can be tested without waiting.
 *
 * `passedAt`, optional: a head SHA at which the caller holds an honoured `pass`
 * or `pass-with-observations` verdict. While the pull request's head is still
 * `passedAt`, a `review/agent` of `failure`/`error` is waited through for up to
 * `GATE_LAG_BOUND_MS` (returning `gate-lag` if it has not cleared by then)
 * instead of ending the call at once with `review-failed` (OQ-104).
 *
 * `once`, optional (ST-23): wait only for the two events that finish on their own within a known
 * bound, and for nothing else. A pull request that is not landable yet is returned at once as
 * `not-landable`, with its `reason` (the wait that `assess` names), and nothing is triggered; one
 * GitHub reports `blocked` though the checks `landWhen` names are green is returned as
 * `github-blocked` instead (ST-24). The one case that is not returned at once (ST-51): `passedAt`
 * is the head and `review/agent` is not `success`, which is the gate's status not having caught up
 * with the verdict, so it is read again every `POLL_INTERVAL_MS` for up to `GATE_LAG_BOUND_MS`;
 * once it reads `success` the look goes on, and if it has not by the bound the result is
 * `not-landable` with the reason `gate-lag`. A landable one has the sweep triggered once and is
 * polled for its merge for at most `SWEEP_RUN_BOUND_MS`: `merged`, or `sweep-pending` if it has
 * not merged by then. It is never triggered a second time.
 *
 * `mode`, optional (ST-54): `unattended` (the default) or `manual`. Unattended is standing
 * permission and needs `ctx.landing` true: with it false, either `once` setting returns
 * `landing-off` before any request is sent. Manual is one explicit request, valid with either value
 * of `ctx.landing`, which it neither reads nor changes. It binds to the first head it reads and
 * sends that head in its dispatch; if the head changes, while waiting or after the dispatch, or
 * the pull request is merged or closed at another head, it returns `head-changed` with the
 * `newHeadSha` and sends nothing further. Only the standalone `land` command passes it.
 * `onBound`, optional, is called once with `{ mode, pr, headSha }` when a manual request has read
 * the head it is bound to.
 */
export async function landPullRequest({
  number,
  ctx,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  latencyLog = DEFAULT_LATENCY_LOG,
  passedAt,
  once = false,
  mode = UNATTENDED,
  onBound,
}) {
  requirePrNumber(number)
  if (mode !== UNATTENDED && mode !== MANUAL) throw new Error(`mode must be "${UNATTENDED}" or "${MANUAL}", got: ${JSON.stringify(mode)}`)
  const manual = mode === MANUAL
  const startedAt = now()
  const times = { landableAt: null, triggeredAt: null, mergedAt: null }
  let triggers = 0
  let lastTriggerAt = null
  let headSha = null
  let waiting = null // { reason, since }
  let gateLagSince = null // `once` only: when the gate's status was first read as not `success`

  const finish = async (status, extra = {}) => {
    const result = { status, pr: number, headSha, mode, triggers, ...extra }
    await recordLatency(latencyLog, { ...result, ...toIso(times), startedAt: new Date(startedAt).toISOString(), endedAt: new Date(now()).toISOString() })
    return result
  }

  // A manual request sends the head it is bound to; an unattended one names the pull request only.
  const dispatch = () => (manual ? buildDispatchManualLanding(ctx.repo, number, headSha) : buildDispatchSweep(ctx.repo, number))
  // A head that is not the one first read: a manual request ends and needs a new invocation.
  const headChanged = (pr) => finish(manual ? 'head-changed' : 'head-moved', { newHeadSha: pr.headSha })

  // `once`: the one trigger, then the merge polled for at most one sweep run's bound.
  const triggerOnce = async () => {
    times.landableAt = now()
    await ctx.send(dispatch())
    triggers += 1
    times.triggeredAt = now()
    for (;;) {
      if (now() - times.triggeredAt >= SWEEP_RUN_BOUND_MS) return finish('sweep-pending')
      await sleep(POLL_INTERVAL_MS)
      const pr = readPullRequest(await ctx.send(buildGetPullRequest(ctx.repo, number)))
      // A manual request checks the head first: a merge at another head is not its request.
      if (manual && pr.headSha !== headSha) return headChanged(pr)
      if (pr.merged) {
        times.mergedAt = now()
        return finish('merged')
      }
      if (pr.state !== 'open') return finish('closed')
      if (pr.headSha !== headSha) return headChanged(pr)
    }
  }

  // Anything but an explicit `true` is off, so a context built by hand fails closed. A manual
  // request is its own authorization and does not read `ctx.landing`.
  if (!manual && ctx.landing !== true) return finish('landing-off')

  for (;;) {
    const pr = readPullRequest(await ctx.send(buildGetPullRequest(ctx.repo, number)))
    if (manual && headSha !== null && pr.headSha !== headSha) return headChanged(pr)
    if (pr.merged) {
      times.mergedAt = now()
      return finish('merged')
    }
    if (pr.state !== 'open') return finish('closed')
    if (headSha !== null && pr.headSha !== headSha) return headChanged(pr)
    if (headSha === null && manual) onBound?.({ mode, pr: number, headSha: pr.headSha })
    headSha = pr.headSha

    // Not asked for at all when the pull request is a draft or blocked: the answer changes nothing.
    const early = assess(pr, 'success', false)
    const statusJson = early?.final ? null : await ctx.send(buildGetCommitStatus(ctx.repo, headSha))
    const review = statusJson === null ? 'success' : reviewState(statusJson)
    const gateLag = passedAt != null && headSha === passedAt
    let verdict = early?.final ? early : assess(pr, review, gateLag)
    // The head's checks are read only once the review and a conflict are settled.
    if (verdict === null) {
      verdict = assessChecks(pr, readChecks(statusJson, await ctx.send(buildGetCheckRuns(ctx.repo, headSha)), ctx.landWhen))
    }

    if (verdict?.final) return finish(verdict.final, verdict.failing ? { failing: verdict.failing } : {})

    if (once) {
      // The gate's status after a verdict is the one wait `once` makes before the look goes on
      // (ST-51): bounded by `GATE_LAG_BOUND_MS`, and only when `passedAt` is the head.
      if (gateLag && review !== 'success') {
        gateLagSince ??= now()
        if (now() - gateLagSince >= GATE_LAG_BOUND_MS) return finish('not-landable', { reason: 'gate-lag' })
        await sleep(POLL_INTERVAL_MS)
        continue
      }
      // `github-blocked` is its own result rather than a wait that may clear: see `assessChecks`.
      if (verdict?.wait === 'github-blocked') return finish('github-blocked')
      if (verdict !== null) return finish('not-landable', { reason: verdict.wait, ...(verdict.waiting ? { waiting: verdict.waiting } : {}) })
      return triggerOnce()
    }

    if (verdict === null) {
      waiting = null
      times.landableAt ??= now()
      if (lastTriggerAt === null || now() - lastTriggerAt >= SWEEP_RUN_BOUND_MS) {
        if (triggers >= MAX_TRIGGERS) return finish('trigger-limit')
        await ctx.send(dispatch())
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

/**
 * The `land` command. `deps` are for tests: `readSettings`, `fetch` and `getToken` (for the
 * context), `sleep`, `now`, `latencyLog`, `cwd` and `out`, a function printing a line. Returns the
 * pilot's result for a landing request, which the command line turns into its exit code.
 */
export async function main(argv, deps = {}) {
  const out = deps.out ?? ((line) => console.log(line))
  const settingsOf = deps.readSettings ?? readSettings
  const cwd = deps.cwd ?? process.cwd()
  const args = [...argv]
  const latencyAt = args.indexOf('--latency')
  if (latencyAt !== -1) {
    const n = args[latencyAt + 1] === undefined ? 10 : Number(args[latencyAt + 1])
    if (!Number.isInteger(n) || n <= 0) throw new Error('usage: node scripts/dispatch/land.mjs --latency [N]')
    out(JSON.stringify(await recentLandingLatencies(n, deps.latencyLog), null, 2))
    return
  }
  const repoAt = args.indexOf('--repo')
  const repo = repoAt === -1 ? (await settingsOf(cwd)).repo : args.splice(repoAt, 2)[1]
  const number = Number(args[0])
  if (args.length !== 1 || !Number.isInteger(number) || number <= 0) {
    throw new Error('usage: node scripts/dispatch/land.mjs <pr-number> [--repo owner/name]')
  }
  const { land: landing, landWhen } = await settingsOf(cwd)
  const ctx = createLandContext({ repo, landing, landWhen, fetch: deps.fetch, getToken: deps.getToken })
  // The one place that asks for a manual landing (ST-54).
  const result = await landPullRequest({
    number,
    ctx,
    mode: MANUAL,
    onBound: ({ mode, pr, headSha }) => out(`${mode} landing requested: project ${repo}, PR #${pr}, head ${headSha}`),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.latencyLog ? { latencyLog: deps.latencyLog } : {}),
  })
  out(JSON.stringify({ project: repo, ...result }, null, 2))
  return result
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (result) => {
      if (result !== undefined && result.status !== 'merged') process.exitCode = 1
    },
    (error) => {
      console.error(error.message)
      process.exitCode = 1
    },
  )
}
