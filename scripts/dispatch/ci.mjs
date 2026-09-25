#!/usr/bin/env node
/**
 * Reads a pull request's CI result (OQ-79), and nothing else: whether the CI
 * workflow's run on a head commit passed, and if not, what failed, in words a
 * retried coder can act on.
 *
 * CI is the runs of `.github/workflows/ci.yml`, identified by the workflow file
 * (`CI_WORKFLOW_PATH`), never by job or check name: a head's check runs also
 * include `review-gate.yml`'s `pending` and `verdict` jobs, which are not CI.
 *
 * This module only reads. `createCiContext` has its own allowlist
 * (`assertAllowedCiRequest`), checked before any network call, that permits
 * four GET shapes: a commit's workflow runs, a run's jobs, a job's log, and a
 * pull request's commits. It reports and counts; whether a red run is retried,
 * and the bound on retries, belong to OQ-48's loop. A red run counts as a round
 * even if a re-run would have passed.
 *
 * A job's log is untrusted text (the pull request's code wrote it). It is
 * handed on as data in `findings`; bounding it in a prompt is
 * `wrapInjectedBlock`'s job, which `retrySection` applies to findings.
 */
import { ghAuthToken } from './github.mjs'

const API = 'https://api.github.com'

export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml'
// How long `waitForCi` waits for the run to finish before returning `timed-out`.
// ci.yml takes minutes on a runner; this leaves room for a queue.
export const CI_WAIT_TIMEOUT_MS = 30 * 60 * 1000
export const CI_POLL_INTERVAL_MS = 15 * 1000
// The most characters of one failed job's log carried into the findings, taken
// from the end of the log once it is cut at its last error line (`excerptLog`).
export const CI_LOG_EXCERPT_MAX_CHARS = 4000

// ---------------------------------------------------------------- requests

function repoPath(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) {
    throw new Error(`repo must be "owner/name", got: ${repo}`)
  }
  return `${API}/repos/${repo}`
}

function requireSha(sha) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) {
    throw new Error(`head SHA must be the full 40-character lowercase hex SHA, got: ${sha}`)
  }
  return sha
}

function requireId(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${value}`)
  }
  return value
}

export function buildListRunsForCommit(repo, headSha) {
  return { method: 'GET', url: `${repoPath(repo)}/actions/runs?head_sha=${requireSha(headSha)}&per_page=100` }
}

export function buildListRunJobs(repo, runId) {
  return { method: 'GET', url: `${repoPath(repo)}/actions/runs/${requireId('run id', runId)}/jobs?per_page=100` }
}

export function buildGetJobLog(repo, jobId) {
  return { method: 'GET', url: `${repoPath(repo)}/actions/jobs/${requireId('job id', jobId)}/logs` }
}

export function buildListPullRequestCommits(repo, number, page = 1) {
  return {
    method: 'GET',
    url: `${repoPath(repo)}/pulls/${requireId('pull request number', number)}/commits?per_page=100&page=${requireId('page', page)}`,
  }
}

const ID = '[1-9][0-9]*'
// [method, path after the repo]: the shapes of the four `build*` functions above.
const ALLOWED = [
  ['GET', new RegExp('^/actions/runs\\?head_sha=[0-9a-f]{40}&per_page=100$')],
  ['GET', new RegExp(`^/actions/runs/${ID}/jobs\\?per_page=100$`)],
  ['GET', new RegExp(`^/actions/jobs/${ID}/logs$`)],
  ['GET', new RegExp(`^/pulls/${ID}/commits\\?per_page=100&page=${ID}$`)],
]

/**
 * Throws unless `request` is one of the four GET shapes above for `repo`, and
 * carries no body. `send` calls this before any network call.
 */
export function assertAllowedCiRequest(repo, request) {
  const prefix = repoPath(repo)
  const url = typeof request?.url === 'string' ? request.url : ''
  const rest = url.startsWith(`${prefix}/`) ? url.slice(prefix.length) : null
  const allowed = rest && ALLOWED.some(([method, re]) => method === request.method && re.test(rest))
  if (!allowed || request.body !== undefined) {
    throw new Error(`refusing a request outside the reads this module performs: ${request?.method} ${url}`)
  }
}

// --------------------------------------------------------------------- I/O

/**
 * `fetch`, `getToken`, `sleep` and `now` are injectable. `send` returns the
 * parsed JSON, or the text for a job log.
 */
export function createCiContext({
  repo,
  fetch = globalThis.fetch,
  getToken = ghAuthToken,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
}) {
  repoPath(repo)
  let token
  return {
    repo,
    sleep,
    now,
    async send(request) {
      assertAllowedCiRequest(repo, request)
      token ??= await getToken()
      const response = await fetch(request.url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      })
      if (!response.ok) {
        throw new Error(`GET ${request.url} failed: ${response.status} ${await response.text()}`)
      }
      return request.url.endsWith('/logs') ? response.text() : response.json()
    },
  }
}

// ------------------------------------------------------------------- logic

function isCiRun(run) {
  // A run's `path` can carry an `@ref` suffix; the workflow file is what precedes it.
  return typeof run.path === 'string' && run.path.split('@')[0] === CI_WORKFLOW_PATH
}

/** The latest ci.yml run in a listing: highest run number, then highest attempt. */
export function latestCiRun(runs) {
  const ci = runs.filter(isCiRun)
  if (ci.length === 0) return null
  return ci.reduce((best, run) => {
    const a = [best.run_number ?? 0, best.run_attempt ?? 1]
    const b = [run.run_number ?? 0, run.run_attempt ?? 1]
    return b[0] > a[0] || (b[0] === a[0] && b[1] > a[1]) ? run : best
  })
}

async function latestCiRunFor(ctx, headSha) {
  const json = await ctx.send(buildListRunsForCommit(ctx.repo, headSha))
  return latestCiRun((json.workflow_runs ?? []).filter((run) => run.head_sha === headSha))
}

// The runner's annotation for an error. The last one in a failed job's log is
// `##[error]Process completed with exit code N.`, ending the failed step.
const ERROR_ANNOTATION = '##[error]'
// eslint-disable-next-line no-control-regex -- matching the escape character is the point
const ANSI_SGR = /\u001b\[[0-9;]*m/g

/**
 * The last `CI_LOG_EXCERPT_MAX_CHARS` characters of `log` up to the end of its
 * last `##[error]` line, or of the whole log when it has none, with colour
 * codes removed. A failed job's log does not end at its failure: `ci.yml`'s
 * `if: failure()` artifact upload and the post-job cleanup follow it. On every
 * failed `ci.yml` job in this repository when this was written, that tail was
 * over 3,000 characters, so the log's own end held none of the failure and the
 * end of the failed step held all of it.
 */
export function excerptLog(log) {
  // Colour codes (Vitest and Playwright colour their output) cost characters and say nothing.
  let text = String(log).replace(ANSI_SGR, '')
  const error = text.lastIndexOf(ERROR_ANNOTATION)
  if (error !== -1) {
    const lineEnd = text.indexOf('\n', error)
    if (lineEnd !== -1) text = text.slice(0, lineEnd)
  }
  text = text.trimEnd()
  return text.length <= CI_LOG_EXCERPT_MAX_CHARS ? text : text.slice(text.length - CI_LOG_EXCERPT_MAX_CHARS)
}

/** Findings text for a red run: says CI failed, names each failed job and step, excerpts each log. */
export function composeCiFindings(headSha, run, failedJobs) {
  const lines = [
    `CI failed on ${headSha}: the "${run.name ?? CI_WORKFLOW_PATH}" workflow concluded ${run.conclusion}. This is a CI failure, not a review finding.`,
    '',
  ]
  if (failedJobs.length === 0) lines.push('No individual failed job was reported.', '')
  for (const job of failedJobs) {
    const steps = job.steps.length === 0 ? 'none reported' : job.steps.map((s) => `"${s}"`).join(', ')
    lines.push(
      `Failed job: ${job.name}`,
      `Failed step(s): ${steps}`,
      `The job's log, up to its last error line (last ${CI_LOG_EXCERPT_MAX_CHARS} characters at most):`,
      '',
      job.logExcerpt,
      '',
    )
  }
  return lines.join('\n').trimEnd()
}

async function failedJobsOf(ctx, run) {
  const json = await ctx.send(buildListRunJobs(ctx.repo, run.id))
  const failed = (json.jobs ?? []).filter((job) => job.conclusion !== 'success' && job.conclusion !== 'skipped')
  const out = []
  for (const job of failed) {
    let logExcerpt
    try {
      logExcerpt = excerptLog(await ctx.send(buildGetJobLog(ctx.repo, job.id)))
    } catch (error) {
      logExcerpt = `(the job's log could not be read: ${error.message})`
    }
    out.push({
      name: job.name,
      steps: (job.steps ?? []).filter((s) => s.conclusion === 'failure').map((s) => s.name),
      logExcerpt,
    })
  }
  return out
}

/**
 * Waits for the ci.yml run on `headSha` to finish, then returns
 *   { result: 'green' }
 *   { result: 'red', failedJobs: [{ name, steps, logExcerpt }], jobNames, findings }
 *   { result: 'timed-out' }
 * The wait is bounded by `CI_WAIT_TIMEOUT_MS`. Anything but a `success`
 * conclusion is red.
 */
export async function waitForCi(ctx, headSha, { timeoutMs = CI_WAIT_TIMEOUT_MS, pollMs = CI_POLL_INTERVAL_MS } = {}) {
  requireSha(headSha)
  const deadline = ctx.now() + timeoutMs
  for (;;) {
    const run = await latestCiRunFor(ctx, headSha)
    if (run && run.status === 'completed') {
      if (run.conclusion === 'success') return { result: 'green' }
      const failedJobs = await failedJobsOf(ctx, run)
      return {
        result: 'red',
        failedJobs,
        jobNames: failedJobs.map((job) => job.name),
        findings: composeCiFindings(headSha, run, failedJobs),
      }
    }
    if (ctx.now() + pollMs > deadline) return { result: 'timed-out' }
    await ctx.sleep(pollMs)
  }
}

/**
 * The number of red CI rounds on a pull request: the distinct commits on it
 * whose latest ci.yml run concluded `failure`. Derived from GitHub on every
 * call; nothing is stored.
 */
export async function countRedCiRounds(ctx, number) {
  const shas = new Set()
  for (let page = 1; ; page++) {
    const json = await ctx.send(buildListPullRequestCommits(ctx.repo, number, page))
    for (const commit of json) shas.add(commit.sha)
    if (json.length < 100) break
  }
  let red = 0
  for (const sha of shas) {
    const run = await latestCiRunFor(ctx, sha)
    if (run?.status === 'completed' && run.conclusion === 'failure') red++
  }
  return red
}
