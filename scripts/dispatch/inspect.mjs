#!/usr/bin/env node
/**
 * Inspection (ST-29): looks for a merge that went around the gate and for a review that has stopped
 * moving, and raises each case as a GitHub issue labelled `inspection`. The glossary's word is
 * inspection; `docs/agent-workflow-design.md`, "Watchdog" and Part 3, "Decided so far", 2026-10-15,
 * say why. It exists so that a broken gate does not look exactly like a working one: on a
 * repository with no branch protection it is the only thing that would notice a merge around the
 * gate.
 *
 * Two checks, each made on `main` and on every release branch (`isReleaseBranch`,
 * `scripts/land/release-branch.mjs`), as a release branch changes only through the gate:
 *  - Merges. Each commit on `main` or a release branch committed within the last `--since-days`
 *    days leads back to the merged pull requests GitHub associates with it, into `main` or into
 *    that release branch. A commit with none is a finding. A commit on both is judged once. A merge
 *    is passing when the latest `review/agent` status on its head created at or before
 *    `merged_at` is `success` and was created by `github-actions[bot]`, the account
 *    `review-gate.yml` posts as, so a status any other account posts does not count. Any other
 *    merge is a finding.
 *  - Stalls. An open pull request against `main` or a release branch, not a draft, whose author
 *    the gate honours (`HONOURED_ASSOCIATIONS`), is a finding when its latest `review/agent`
 *    status is `pending` (it is pending at that head), or `success` posted by the gate (it is
 *    holding at that head), and was created more than the settings' `inspectAfterHours` ago.
 *
 * Each finding is one issue whose title names the finding and nothing that changes between runs.
 * An issue is opened only when no issue labelled `inspection`, open or closed, has that title, so
 * closing an issue is how the crew says it has seen it. Inspection writes nothing but issues and
 * the `inspection` label: it never comments on, labels or changes a pull request, and starts no
 * workflow. Its request allowlist (`assertAllowedRequest`) is checked before any network call.
 *
 * Output: one line per finding, saying whether an issue was opened or one was already there, and a
 * last line with the counts. Exit code: 0 when no issue was opened, 1 when at least one was, 2 when
 * a request fails, the settings do not read or the arguments are wrong (nothing more is opened).
 *
 * Usage:
 *   node scripts/dispatch/inspect.mjs [--repo owner/name] [--since-days N]
 */
import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ghAuthToken } from './github.mjs'
import { readSettings } from './settings.mjs'
import { HONOURED_ASSOCIATIONS } from '../land/check-author.mjs'
import { isLandingBase, isReleaseBranch } from '../land/release-branch.mjs'

const API = 'https://api.github.com'
const MAIN = 'main'
const LABEL = 'inspection'
// The label inspection applies, for `init` to create (`scripts/dispatch/init.mjs`, `LABELS`).
export const INSPECTION_LABEL = LABEL
const CONTEXT = 'review/agent'
const GATE_ACCOUNT = 'github-actions[bot]'
const PAGE = 100
const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
export const DEFAULT_SINCE_DAYS = 7
const LABEL_COLOR = 'fbca04'
const LABEL_DESCRIPTION = "Raised by steward's inspection (scripts/dispatch/inspect.mjs)"

// ------------------------------------------------------------ requests / allowlist

function repoPath(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error(`repo must be "owner/name", got: ${repo}`)
  return `${API}/repos/${repo}`
}

function requireSha(sha) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error(`sha must be a full 40-character SHA, got: ${sha}`)
  return sha
}

/** `branch`, percent-encoded, if it is one inspection reads: `main` or a release branch. */
function requireBranch(branch) {
  if (!isLandingBase(branch)) throw new Error(`branch must be main or a release branch, got: ${branch}`)
  return encodeURIComponent(branch)
}

/** Request to list the commits of `branch` committed at or after `since` (an ISO time). */
export function buildListBranchCommits(repo, branch, since, page = 1) {
  return {
    method: 'GET',
    url: `${repoPath(repo)}/commits?sha=${requireBranch(branch)}&since=${encodeURIComponent(since)}&per_page=${PAGE}&page=${page}`,
  }
}

/** Request to list `main`'s commits committed at or after `since` (an ISO time). */
export function buildListMainCommits(repo, since, page = 1) {
  return buildListBranchCommits(repo, MAIN, since, page)
}

/** Request to list the branches whose names start `release/v`; the caller keeps the release branches. */
export function buildListReleaseBranchRefs(repo) {
  return { method: 'GET', url: `${repoPath(repo)}/git/matching-refs/heads/release/v` }
}

/** Request to list the pull requests GitHub associates with a commit. */
export function buildListCommitPullRequests(repo, sha, page = 1) {
  return { method: 'GET', url: `${repoPath(repo)}/commits/${requireSha(sha)}/pulls?per_page=${PAGE}&page=${page}` }
}

/** Request to list a commit's statuses. */
export function buildListCommitStatuses(repo, sha, page = 1) {
  return { method: 'GET', url: `${repoPath(repo)}/commits/${requireSha(sha)}/statuses?per_page=${PAGE}&page=${page}` }
}

/** Request to list the open pull requests against `base`: `main`, or a release branch. */
export function buildListOpenPullRequests(repo, page = 1, base = MAIN) {
  return { method: 'GET', url: `${repoPath(repo)}/pulls?base=${requireBranch(base)}&state=open&per_page=${PAGE}&page=${page}` }
}

/** Request to list the issues labelled `inspection`, open or closed. */
export function buildListInspectionIssues(repo, page = 1) {
  return { method: 'GET', url: `${repoPath(repo)}/issues?labels=${LABEL}&state=all&per_page=${PAGE}&page=${page}` }
}

/** Request to create an issue labelled `inspection`. */
export function buildCreateInspectionIssue(repo, { title, body }) {
  if (typeof title !== 'string' || typeof body !== 'string') throw new Error('title and body must be strings')
  return { method: 'POST', url: `${repoPath(repo)}/issues`, body: { title, body, labels: [LABEL] } }
}

/** Request to create the `inspection` label. */
export function buildCreateInspectionLabel(repo) {
  return {
    method: 'POST',
    url: `${repoPath(repo)}/labels`,
    body: { name: LABEL, color: LABEL_COLOR, description: LABEL_DESCRIPTION },
  }
}

const N = '[1-9][0-9]*'
const SHA_PATH = '[0-9a-f]{40}'
const landingBase = (encoded) => {
  try {
    return isLandingBase(decodeURIComponent(encoded))
  } catch {
    return false
  }
}
// [method, path after the repo, check of the body, check of the branch name the path captures]:
// the requests the `build*` functions above produce, and nothing else. A rule with a branch check
// captures the branch name, percent-encoded, as its first group; only `main` and a release
// branch pass.
const ALLOWED = [
  ['GET', new RegExp(`^/commits\\?sha=([^&=]+)&since=[^&=]+&per_page=${PAGE}&page=${N}$`), null, landingBase],
  ['GET', /^\/git\/matching-refs\/heads\/release\/v$/, null],
  ['GET', new RegExp(`^/commits/${SHA_PATH}/pulls\\?per_page=${PAGE}&page=${N}$`), null],
  ['GET', new RegExp(`^/commits/${SHA_PATH}/statuses\\?per_page=${PAGE}&page=${N}$`), null],
  ['GET', new RegExp(`^/pulls\\?base=([^&=]+)&state=open&per_page=${PAGE}&page=${N}$`), null, landingBase],
  ['GET', new RegExp(`^/issues\\?labels=${LABEL}&state=all&per_page=${PAGE}&page=${N}$`), null],
  [
    'POST',
    /^\/issues$/,
    (body) =>
      sameKeys(body, ['title', 'body', 'labels']) &&
      Array.isArray(body.labels) &&
      body.labels.length === 1 &&
      body.labels[0] === LABEL,
  ],
  ['POST', /^\/labels$/, (body) => sameKeys(body, ['name', 'color', 'description']) && body.name === LABEL],
]

function sameKeys(body, keys) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false
  const actual = Object.keys(body)
  return actual.length === keys.length && keys.every((key) => actual.includes(key))
}

/**
 * Throws unless `request` is one of the operations this module performs. Runs before any network
 * call.
 */
export function assertAllowedRequest(repo, request) {
  const prefix = repoPath(repo)
  const url = typeof request?.url === 'string' ? request.url : ''
  const rest = url.startsWith(`${prefix}/`) ? url.slice(prefix.length) : null
  const rule =
    rest &&
    ALLOWED.find(([method, re, , branchOk]) => {
      if (method !== request.method) return false
      const match = re.exec(rest)
      return match !== null && (branchOk === undefined || branchOk(match[1]))
    })
  if (!rule) {
    throw new Error(`refusing a request outside the operations inspect.mjs performs: ${request?.method} ${url}`)
  }
  const bodyOk = rule[2] === null ? request.body === undefined : rule[2](request.body)
  if (!bodyOk) throw new Error(`refusing a request with an unexpected body: ${request.method} ${url}`)
}

// --------------------------------------------------------------------- I/O

/**
 * The token: `GH_TOKEN` when it is set and not empty (the scheduled workflow sets it to
 * `github.token`), otherwise the output of `gh auth token`. `ghAuthToken` reads no environment
 * variable, so the `GH_TOKEN` step is here.
 */
export async function resolveToken(env = process.env, authToken = ghAuthToken) {
  const fromEnv = env.GH_TOKEN
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return authToken()
}

/**
 * Builds the context the requests are sent through. `fetch` and `getToken` are injectable; the
 * token is read once, on first use. A failed request throws an error carrying its `status` and
 * its parsed JSON `body` (`null` when the response is not JSON).
 */
export function createInspectContext({ repo, fetch = globalThis.fetch, getToken = resolveToken }) {
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
        const text = await response.text()
        const error = new Error(`${request.method} ${request.url} failed: ${response.status} ${text}`)
        error.status = response.status
        try {
          error.body = JSON.parse(text)
        } catch {
          error.body = null
        }
        throw error
      }
      return response.json()
    },
  }
}

/** Every item of a paged listing: pages are read until one comes back short. */
async function listAll(ctx, build) {
  const all = []
  for (let page = 1; ; page++) {
    const json = await ctx.send(build(page))
    all.push(...json)
    if (json.length < PAGE) return all
  }
}

// ----------------------------------------------------------------- reading

const shortSha = (sha) => sha.slice(0, 7)
const pullUrl = (repo, number) => `https://github.com/${repo}/pull/${number}`
const commitUrl = (repo, sha) => `https://github.com/${repo}/commit/${sha}`

/**
 * The latest `review/agent` status among `statuses`, created at or before `before` (a time in ms)
 * when one is given. The latest is by `created_at`, then by `id`. `null` when there is none.
 */
export function latestReviewStatus(statuses, before = Infinity) {
  let latest = null
  for (const s of statuses) {
    if (s.context !== CONTEXT) continue
    const at = Date.parse(s.created_at)
    if (!Number.isFinite(at) || at > before) continue
    if (latest === null || at > latest.at || (at === latest.at && (s.id ?? 0) > (latest.id ?? 0))) {
      latest = { at, id: s.id, state: s.state, creator: s.creator?.login ?? null }
    }
  }
  return latest
}

const postedByGate = (status) => status.creator === GATE_ACCOUNT

// ------------------------------------------------------------- the checks

/**
 * The release branches of the repository, sorted: the branches whose names start `release/v` that
 * `isReleaseBranch` accepts. `isReleaseBranch` is the only definition of a release branch's name;
 * the prefix in the request only narrows the listing.
 */
export async function listReleaseBranches(ctx) {
  // One request: GitHub's matching-refs listing does not page, and answers every matching ref.
  const refs = await ctx.send(buildListReleaseBranchRefs(ctx.repo))
  const prefix = 'refs/heads/'
  return refs
    .map((r) => (typeof r?.ref === 'string' && r.ref.startsWith(prefix) ? r.ref.slice(prefix.length) : null))
    .filter((name) => isReleaseBranch(name))
    .sort()
}

/**
 * Findings among the merges to `main` and to each release branch in the window. A finding is
 * `{ kind, title, body }`; the titles name the finding and nothing that changes between runs.
 * `branches` is the release branches; it is read when not given.
 */
export async function inspectMerges(ctx, { now, sinceDays, branches }) {
  const since = new Date(now - sinceDays * DAY_MS)
  const releaseBranches = branches ?? (await listReleaseBranches(ctx))
  const statusesBySha = new Map()
  const judged = new Set()
  const judgedOnMain = new Set()
  const pullsBySha = new Map()
  const findings = []
  for (const branch of [MAIN, ...releaseBranches]) {
    const commits = (
      await listAll(ctx, (page) => buildListBranchCommits(ctx.repo, branch, since.toISOString(), page))
    ).filter((c) => Date.parse(c.commit?.committer?.date) >= since.getTime())
    for (const { sha } of commits) {
      // A commit on `main` and on a release branch is judged once, as a commit of `main`. A
      // commit not on `main` is judged on each release branch it is on, whatever another said.
      if (branch === MAIN) judgedOnMain.add(sha)
      else if (judgedOnMain.has(sha)) continue
      if (!pullsBySha.has(sha)) {
        pullsBySha.set(sha, await listAll(ctx, (page) => buildListCommitPullRequests(ctx.repo, sha, page)))
      }
      const merged = pullsBySha.get(sha).filter(
        (pr) => pr.merged_at && (pr.base?.ref === MAIN || pr.base?.ref === branch),
      )
      if (merged.length === 0) {
        const where = branch === MAIN ? '`main`' : `\`main\` or \`${branch}\``
        findings.push({
          kind: 'no-pull-request',
          title: `Inspection: ${shortSha(sha)} on ${branch} without a pull request`,
          body:
            `Commit [${shortSha(sha)}](${commitUrl(ctx.repo, sha)}) is on \`${branch}\`, committed within the ` +
            `last ${sinceDays} days, and GitHub associates no merged pull request against ${where} with it. ` +
            `It reached \`${branch}\` without going through the gate.`,
        })
        continue
      }
      for (const pr of merged) {
        if (judged.has(pr.number)) continue
        judged.add(pr.number)
        const head = pr.head.sha
        if (!statusesBySha.has(head)) {
          statusesBySha.set(head, await listAll(ctx, (page) => buildListCommitStatuses(ctx.repo, head, page)))
        }
        const verdict = latestReviewStatus(statusesBySha.get(head), Date.parse(pr.merged_at))
        if (verdict !== null && verdict.state === 'success' && postedByGate(verdict)) continue
        const seen =
          verdict === null
            ? 'no `review/agent` status'
            : `a \`review/agent\` status \`${verdict.state}\` created by ${verdict.creator}`
        findings.push({
          kind: 'merged-without-verdict',
          title: `Inspection: #${pr.number} merged without a passing verdict`,
          body:
            `[#${pr.number}](${pullUrl(ctx.repo, pr.number)}) merged into \`${pr.base.ref}\` at ${pr.merged_at}, ` +
            `and its head \`${shortSha(head)}\` had no passing verdict by then: the latest read was ${seen} ` +
            `(a passing verdict is a \`success\` created by \`${GATE_ACCOUNT}\` at or before the merge).`,
        })
      }
    }
  }
  return findings
}

/**
 * Findings among the open pull requests, into `main` or a release branch, that the review side has
 * stopped moving on. `branches` is the release branches; it is read when not given.
 */
export async function inspectStalls(ctx, { now, afterHours, branches }) {
  const releaseBranches = branches ?? (await listReleaseBranches(ctx))
  const open = []
  for (const base of [MAIN, ...releaseBranches]) {
    const pulls = await listAll(ctx, (page) => buildListOpenPullRequests(ctx.repo, page, base))
    open.push(...pulls.map((pr) => ({ pr, base })))
  }
  const findings = []
  for (const { pr, base } of open) {
    if (pr.draft === true || !HONOURED_ASSOCIATIONS.includes(pr.author_association)) continue
    const head = pr.head.sha
    const status = latestReviewStatus(await listAll(ctx, (page) => buildListCommitStatuses(ctx.repo, head, page)))
    if (status === null || now - status.at <= afterHours * HOUR_MS) continue
    let kind
    if (status.state === 'pending') kind = 'pending'
    else if (status.state === 'success' && postedByGate(status)) kind = 'holding'
    else continue
    const since = new Date(status.at).toISOString()
    findings.push({
      kind,
      title: `Inspection: #${pr.number} ${kind} at ${shortSha(head)}`,
      body:
        kind === 'pending'
          ? `[#${pr.number}](${pullUrl(ctx.repo, pr.number)}) into \`${base}\` has been waiting for a verdict ` +
            `at \`${shortSha(head)}\` since ${since}, longer than ${afterHours} hours (the settings' \`inspectAfterHours\`): ` +
            '`review/agent` is still `pending`.'
          : `[#${pr.number}](${pullUrl(ctx.repo, pr.number)}) into \`${base}\` has held a passing verdict ` +
            `at \`${shortSha(head)}\` since ${since}, longer than ${afterHours} hours (the settings' \`inspectAfterHours\`), and is ` +
            'still open: `review/agent` is `success` and nothing has landed it.',
    })
  }
  return findings
}

// ----------------------------------------------------------------- raising

/** Whether a failed label creation is GitHub saying the label already exists. */
function isLabelAlreadyExists(error) {
  return (
    error.status === 422 &&
    Array.isArray(error.body?.errors) &&
    error.body.errors.some((e) => e?.code === 'already_exists')
  )
}

/**
 * Raises each finding as an issue unless one labelled `inspection`, open or closed, already has
 * its title. The label is created once, just before the first issue is opened, and a 422 whose
 * `errors` holds an `already_exists` entry means the repository already has it; any other failure
 * is thrown. Returns one result per finding, passing each to
 * `onResult` as it is settled, so a later failure does not lose the lines of issues already opened.
 */
export async function raiseFindings(ctx, findings, onResult = () => {}) {
  const titles = new Set(
    (await listAll(ctx, (page) => buildListInspectionIssues(ctx.repo, page)))
      .filter((issue) => !issue.pull_request)
      .map((issue) => issue.title),
  )
  const results = []
  let labelled = false
  for (const finding of findings) {
    if (titles.has(finding.title)) {
      results.push({ finding, opened: false })
      onResult(results.at(-1))
      continue
    }
    if (!labelled) {
      try {
        await ctx.send(buildCreateInspectionLabel(ctx.repo))
      } catch (error) {
        if (!isLabelAlreadyExists(error)) throw error
      }
      labelled = true
    }
    const issue = await ctx.send(buildCreateInspectionIssue(ctx.repo, finding))
    titles.add(finding.title)
    results.push({ finding, opened: true, number: issue.number })
    onResult(results.at(-1))
  }
  return results
}

/**
 * Runs both checks and raises what they find, passing each line to `out` as it is settled and the
 * line of counts last. Returns the results and the exit code the counts give.
 */
export async function inspect(ctx, { now, sinceDays, afterHours }, out = () => {}) {
  const branches = await listReleaseBranches(ctx)
  const findings = [
    ...(await inspectMerges(ctx, { now, sinceDays, branches })),
    ...(await inspectStalls(ctx, { now, afterHours, branches })),
  ]
  const results = await raiseFindings(ctx, findings, (r) =>
    out(r.opened ? `opened #${r.number}: ${r.finding.title}` : `already raised: ${r.finding.title}`),
  )
  const opened = results.filter((r) => r.opened).length
  out(`${results.length} findings: ${opened} opened, ${results.length - opened} already raised`)
  return { results, opened, exitCode: opened > 0 ? 1 : 0 }
}

// --------------------------------------------------------------------- CLI

const USAGE = 'usage: node scripts/dispatch/inspect.mjs [--repo owner/name] [--since-days N]'

function parseArgs(argv) {
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
  const days = take('--since-days')
  if (args.length > 0) throw new Error(USAGE)
  let sinceDays = DEFAULT_SINCE_DAYS
  if (days !== undefined) {
    sinceDays = /^[1-9][0-9]*$/.test(days) ? Number(days) : NaN
    if (!Number.isSafeInteger(sinceDays)) throw new Error(`--since-days must be a positive integer, got: ${days}`)
  }
  return { repo, sinceDays }
}

/**
 * Runs the command and returns its exit code. Everything it reads from outside is injectable:
 * `cwd` (where the settings are), `env`, `fetch`, `getToken`, the clock `now` (ms) and the output.
 */
export async function main(
  argv,
  { cwd = process.cwd(), env = process.env, fetch = globalThis.fetch, getToken, now = Date.now(), out = console.log, err = console.error } = {},
) {
  try {
    const args = parseArgs(argv)
    const settings = await readSettings(cwd)
    const repo = args.repo ?? settings.repo
    const ctx = createInspectContext({ repo, fetch, getToken: getToken ?? (() => resolveToken(env)) })
    const { exitCode } = await inspect(
      ctx,
      { now, sinceDays: args.sinceDays, afterHours: settings.inspectAfterHours },
      out,
    )
    return exitCode
  } catch (error) {
    err(error.message)
    return 2
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
