#!/usr/bin/env node
/**
 * Reports the verdict mix recorded on gated pull requests (OQ-47): the
 * `<!-- agent-review head=... verdict=... -->` marker comments
 * `.github/workflows/review-gate.yml` already reads. Adds no instrumentation
 * and stores nothing -- the record already exists twice, as this comment and
 * as the `review/agent` commit status (REVIEW.md, "Recording a verdict");
 * this only reads the comment.
 *
 * Reuses `buildListComments`, `parseComments` and `parseMarkerComment` from
 * `../dispatch/github.mjs` unchanged, so a verdict this counts is, by
 * construction, a verdict `review-gate.yml`'s own marker pattern matches
 * (AC-4) -- there is only the one transcription of that pattern, in
 * `github.mjs`, and this module never re-derives it.
 *
 * A marker also counts only from an account the gate itself would honour
 * (`OWNER`, `MEMBER`, `COLLABORATOR` -- see review-gate.yml's `ASSOC` check).
 * It does *not* filter by the pull request's current head sha. review-gate.yml
 * compares a marker's `head=` against the head *at the moment that comment's
 * event fires* (`head="$(gh pr view ...headRefOid)"`, run inside the
 * `issue_comment` job) -- not against wherever the pull request ends up. A
 * reviewer only ever posts a marker naming the commit it just reviewed, which
 * is the head at that moment, so the gate acts on it and sets `review/agent`
 * from it there and then. A later commit resets the gate to pending and
 * leaves that status on the record; it does not retroactively make the gate's
 * earlier action not have happened. Filtering by the pull request's *current*
 * head would silently drop every verdict from an earlier round once the pull
 * request moves on -- exactly the multi-round blocking verdicts (#117's three
 * rounds, this story's own round 1 and round 2) that AC-3's per-pull-request
 * count exists to distinguish from a single blocking verdict.
 *
 * Read-only. This module's own allowlist (`assertAllowedRequest`) admits two
 * GET shapes -- list pull requests, list a pull request's comments -- and
 * nothing else, so it cannot be made to write even by mistake. It never
 * imports `github.mjs`'s `postComment` or any other write.
 *
 * Unauthenticated GitHub reads work for this repository (public), at a lower
 * rate limit, so a token is optional (`--limit` exists mainly to stay inside
 * that limit; see the PR body for the run this shipped with).
 *
 * Usage:
 *   node scripts/report/review-verdicts.mjs [--repo owner/name] [--limit N]
 */
import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildListComments, parseComments } from '../dispatch/github.mjs'
import { readSettings } from '../dispatch/settings.mjs'

const API = 'https://api.github.com'
export const DEFAULT_LIMIT = 60

// The associations review-gate.yml honours a marker from (its `ASSOC` case).
export const PRIVILEGED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR']

function repoPath(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error(`repo must be "owner/name", got: ${repo}`)
  return `${API}/repos/${repo}`
}

// ------------------------------------------------------------ requests

export function buildListPullRequests(repo, { page = 1 } = {}) {
  return {
    method: 'GET',
    url: `${repoPath(repo)}/pulls?state=all&sort=created&direction=desc&per_page=100&page=${page}`,
  }
}

export function parsePullRequests(json) {
  return json.map((pr) => ({ number: pr.number, headSha: pr.head.sha, createdAt: pr.created_at }))
}

const ALLOWED = [
  ['GET', /^\/pulls\?state=all&sort=created&direction=desc&per_page=100&page=[1-9][0-9]*$/],
  ['GET', /^\/issues\/[1-9][0-9]*\/comments\?per_page=100&page=[1-9][0-9]*$/],
]

/** Throws unless `request` is one of the two listings this module reads. Runs before any network call. */
export function assertAllowedRequest(repo, request) {
  const prefix = repoPath(repo)
  const url = typeof request?.url === 'string' ? request.url : ''
  const rest = url.startsWith(`${prefix}/`) ? url.slice(prefix.length) : null
  if (!rest || !ALLOWED.some(([method, re]) => method === request.method && re.test(rest))) {
    throw new Error(`refusing a request outside the two listings this module reads: ${request?.method} ${url}`)
  }
}

// --------------------------------------------------------------------- I/O

/**
 * `fetch` is injectable; `token` is optional (see module header). Adds no
 * `Authorization` header when `token` is falsy, rather than sending one that
 * is empty.
 */
export function createContext({ repo, fetch = globalThis.fetch, token = null }) {
  repoPath(repo)
  return {
    repo,
    async send(request) {
      assertAllowedRequest(repo, request)
      const response = await fetch(request.url, {
        method: request.method,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      })
      if (!response.ok) {
        throw new Error(`${request.method} ${request.url} failed: ${response.status} ${await response.text()}`)
      }
      return response.json()
    },
  }
}

/** The `limit` most-recently-created pull requests, newest first. */
export async function listRecentPullRequests(ctx, limit) {
  const all = []
  for (let page = 1; all.length < limit; page++) {
    const json = await ctx.send(buildListPullRequests(ctx.repo, { page }))
    all.push(...parsePullRequests(json))
    if (json.length < 100) break
  }
  return all.slice(0, limit)
}

async function listAllComments(ctx, number) {
  const all = []
  for (let page = 1; ; page++) {
    const json = await ctx.send(buildListComments(ctx.repo, number, page))
    all.push(...parseComments(json))
    if (json.length < 100) return all
  }
}

/**
 * The verdicts `review-gate.yml` actually acted on among one pull request's
 * comments (AC-4): every well-formed marker (`comment.marker.kind ===
 * 'marker'`, from `parseMarkerComment` in `github.mjs`) from a privileged
 * account. There is deliberately no filter against the pull request's
 * *current* head sha -- see the module header for why that would discard
 * exactly the multi-round blocking verdicts AC-3 exists to count. A marker's
 * own `head=` is read (`c.marker.headSha`) but not compared against anything
 * here, because the head it should be compared against is the one that was
 * current when that comment's event fired, which this module -- reading only
 * the two listings in `ALLOWED` -- has no way to recover.
 */
export function actedOnVerdicts(comments) {
  return comments
    .filter((c) => c.marker.kind === 'marker' && PRIVILEGED_ASSOCIATIONS.includes(c.authorAssociation))
    .map((c) => ({ verdict: c.marker.verdict, deprecatedSpelling: c.marker.deprecatedSpelling }))
}

/** Fetches the acted-on verdicts for the `limit` most recent pull requests. */
export async function gatherVerdicts(ctx, { limit = DEFAULT_LIMIT } = {}) {
  const prs = await listRecentPullRequests(ctx, limit)
  const perPullRequest = []
  for (const pr of prs) {
    const comments = await listAllComments(ctx, pr.number)
    perPullRequest.push({ number: pr.number, verdicts: actedOnVerdicts(comments) })
  }
  return perPullRequest
}

// ------------------------------------------------------------------ tally

/**
 * Tallies verdicts across pull requests (AC-2, AC-3). `perPullRequest` is
 * `[{ number, verdicts: [{ verdict, deprecatedSpelling }] }]`, as
 * `gatherVerdicts` returns -- `verdict` already normalised by
 * `parseMarkerComment` (`fail` read as `block`), `deprecatedSpelling` telling
 * the two apart again so AC-2's distinction survives that normalisation.
 *
 * Every well-formed, privileged marker counts once toward `verdictsRecorded`
 * and the matching entry in `counts`; a pull request counts once toward
 * `gatedPullRequests` if it carries at least one, and once toward
 * `pullRequestsWithBlockingVerdict` if at least one of its verdicts is
 * blocking -- so three blocking verdicts on one pull request move
 * `verdictsRecorded` by three but `pullRequestsWithBlockingVerdict` by one.
 */
export function tallyVerdicts(perPullRequest) {
  const counts = { pass: 0, 'pass-with-observations': 0, block: 0, fail: 0 }
  const blockingPullRequests = []
  let gatedPullRequests = 0
  let verdictsRecorded = 0

  for (const { number, verdicts } of perPullRequest) {
    if (verdicts.length === 0) continue
    gatedPullRequests += 1
    let blocking = 0
    for (const { verdict, deprecatedSpelling } of verdicts) {
      verdictsRecorded += 1
      if (verdict === 'block') {
        counts[deprecatedSpelling ? 'fail' : 'block'] += 1
        blocking += 1
      } else {
        counts[verdict] += 1
      }
    }
    if (blocking > 0) blockingPullRequests.push({ number, blocking })
  }

  const blockingVerdicts = counts.block + counts.fail
  return {
    pullRequestsScanned: perPullRequest.length,
    gatedPullRequests,
    verdictsRecorded,
    counts,
    blockingVerdicts,
    blockingRate: verdictsRecorded === 0 ? null : blockingVerdicts / verdictsRecorded,
    pullRequestsWithBlockingVerdict: blockingPullRequests.length,
    blockingPullRequests,
  }
}

// ------------------------------------------------------------- reporting

export function formatReport(tally) {
  const pct = (n, d) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`)
  const lines = [
    `Pull requests scanned: ${tally.pullRequestsScanned}`,
    `Gated pull requests (carrying at least one counted marker): ${tally.gatedPullRequests}`,
    `Verdicts recorded: ${tally.verdictsRecorded}`,
    `  pass: ${tally.counts.pass}`,
    `  pass-with-observations: ${tally.counts['pass-with-observations']}`,
    `  block: ${tally.counts.block}`,
    `  fail (deprecated spelling of block): ${tally.counts.fail}`,
    `Blocking verdicts (block + fail): ${tally.blockingVerdicts} of ${tally.verdictsRecorded} -- ${pct(tally.blockingVerdicts, tally.verdictsRecorded)}`,
    `Pull requests with at least one blocking verdict: ${tally.pullRequestsWithBlockingVerdict} of ${tally.gatedPullRequests}`,
  ]
  if (tally.blockingPullRequests.length > 0) {
    lines.push(`  ${tally.blockingPullRequests.map((p) => `#${p.number} (${p.blocking})`).join(', ')}`)
  }
  return lines.join('\n')
}

// --------------------------------------------------------------------- CLI

/**
 * Parses the CLI's argv into `{ repo, limit }`, or throws on a non-positive
 * or non-integer `--limit`. `repo` defaults to the `repo` named in
 * `<projectRoot>/steward.config.json` (OQ-122) -- `projectRoot` defaults to
 * the working directory, where `queue.mjs` and `lint-stories.mjs` already
 * find their project, and a test overrides it to point at a fixture.
 */
export async function parseArgs(argv, { projectRoot = process.cwd() } = {}) {
  const args = [...argv]
  const repoAt = args.indexOf('--repo')
  const repoFlag = repoAt === -1 ? undefined : args.splice(repoAt, 2)[1]
  const limitAt = args.indexOf('--limit')
  const limit = limitAt === -1 ? DEFAULT_LIMIT : Number(args.splice(limitAt, 2)[1])
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('--limit must be a positive integer')
  const repo = repoFlag ?? (await readSettings(projectRoot)).repo
  return { repo, limit }
}

async function main(argv) {
  const { repo, limit } = await parseArgs(argv)
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null
  const ctx = createContext({ repo, token })
  const perPullRequest = await gatherVerdicts(ctx, { limit })
  const tally = tallyVerdicts(perPullRequest)
  console.log(formatReport(tally))
  console.log()
  console.log(JSON.stringify(tally, null, 2))
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
