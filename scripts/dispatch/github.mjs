#!/usr/bin/env node
/**
 * The GitHub operations the dispatch loop performs (OQ-68), and nothing else:
 * create a pull request, replace its title and body, post a comment, read its
 * state, read its labels, list its comments, and convert it to a draft (OQ-87).
 * The conversion is GraphQL only, and is the one GraphQL request the allowlist
 * admits: one mutation text, with the pull request's node id as its one variable.
 * OQ-112 adds three more: list the open pull requests for one head branch, list
 * open issues carrying a given set of labels, and create an issue.
 *
 * Shape (AC-2): every operation has a pure `build*` function that returns the
 * request that *would* be sent, and a pure `parse*` function for the response.
 * The single place that performs I/O is `send`, which takes an injectable
 * `fetch`. The token is read once from `gh auth token` (`ghAuthToken`) and is
 * added to the request there, so builders never see it. `gh` is used for
 * authentication alone.
 *
 * What this module deliberately does not do:
 *  - Write the `review/agent` commit status (AC-3). `.github/workflows/review-gate.yml`
 *    derives it from the marker comment `composeMarkerComment` produces.
 *  - Trigger any workflow. Only the owner, or `land.mjs` run by the dispatcher (OQ-50), triggers
 *    the landing sweep, and `land.mjs` has its own allowlist.
 *  - Apply a label to a pull request, count rounds, or decide what a verdict
 *    means (OQ-48). It creates an issue with labels (OQ-112), never applies one.
 *  - Spawn sessions, render prompts, or read stories (AC-7).
 *
 * The marker grammar mirrors the grep in review-gate.yml, which works line by
 * line: a marker counts only when it lies on one line, so the patterns below use
 * horizontal whitespace and never `\s`. A test checks a composed comment against
 * a transcription of the workflow's pattern, and that a split marker is no verdict.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const API = 'https://api.github.com'
const GRAPHQL_URL = `${API}/graphql`

// The one GraphQL request this module sends (OQ-87). `assertAllowedRequest`
// admits a GraphQL body only if its `query` is this text, byte for byte.
const CONVERT_TO_DRAFT_MUTATION =
  'mutation ConvertToDraft($pullRequestId: ID!) { convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) { pullRequest { isDraft } } }'

// The verdicts a marker may be *written* with. `fail` is deliberately absent (AC-4).
export const WRITABLE_VERDICTS = ['pass', 'pass-with-observations', 'block']

// `fail` is the deprecated spelling of `block`; accepted when reading only.
const DEPRECATED_VERDICTS = { fail: 'block' }

// Horizontal whitespace only: the gate greps line by line, so `\s` (which matches
// a newline) would accept markers the gate ignores. A candidate runs to `-->` or
// to the end of its line, so an unterminated or split marker is classified as
// malformed rather than skipped.
const ANY_MARKER_RE = /<!--[^\S\n]*agent-review\b[^\n]*?(?:-->|$)/gm
const FIELDS_RE = /^<!--[^\S\n]*agent-review[^\S\n]+head=(\S+)[^\S\n]+verdict=(\S+)[^\S\n]*-->$/
// Transcribes the pattern review-gate.yml greps for, line by line.
const WELL_FORMED_RE =
  /<!--[^\S\n]*agent-review[^\S\n]+head=([0-9a-f]{40})[^\S\n]+verdict=(pass-with-observations|pass|block|fail)[^\S\n]*-->/g
const SHA_RE = /^[0-9a-f]{40}$/

// ---------------------------------------------------------------- requests

function repoPath(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) {
    throw new Error(`repo must be "owner/name", got: ${repo}`)
  }
  return `${API}/repos/${repo}`
}

function requirePrNumber(number) {
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`pull request number must be a positive integer, got: ${number}`)
  }
  return number
}

function requireString(name, value) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  return value
}

/** Request to open a pull request from `head` into `base`. */
export function buildCreatePullRequest(repo, { title, body, head, base = 'main', draft }) {
  if (typeof draft !== 'boolean') throw new Error('draft must be a boolean')
  return {
    method: 'POST',
    url: `${repoPath(repo)}/pulls`,
    body: {
      title: requireString('title', title),
      body: requireString('body', body),
      head: requireString('head', head),
      base,
      draft,
    },
  }
}

/** Request to overwrite (not append to) a pull request's title and body. */
export function buildReplacePullRequest(repo, number, { title, body }) {
  return {
    method: 'PATCH',
    url: `${repoPath(repo)}/pulls/${requirePrNumber(number)}`,
    body: { title: requireString('title', title), body: requireString('body', body) },
  }
}

/** Request to post an ordinary comment on a pull request. */
export function buildPostComment(repo, number, body) {
  return {
    method: 'POST',
    url: `${repoPath(repo)}/issues/${requirePrNumber(number)}/comments`,
    body: { body: requireString('body', body) },
  }
}

export function buildGetPullRequestState(repo, number) {
  return { method: 'GET', url: `${repoPath(repo)}/pulls/${requirePrNumber(number)}` }
}

export function buildGetPullRequestLabels(repo, number) {
  return { method: 'GET', url: `${repoPath(repo)}/issues/${requirePrNumber(number)}/labels?per_page=100` }
}

export function buildListComments(repo, number, page = 1) {
  return {
    method: 'GET',
    url: `${repoPath(repo)}/issues/${requirePrNumber(number)}/comments?per_page=100&page=${page}`,
  }
}

/** Request to list open pull requests whose head is `branch` (OQ-112's AC-1). */
export function buildListPullRequestsForHead(repo, branch) {
  const owner = repo.split('/')[0]
  return {
    method: 'GET',
    url: `${repoPath(repo)}/pulls?head=${encodeURIComponent(`${owner}:${requireString('branch', branch)}`)}&state=open`,
  }
}

/** Request to list open issues carrying every one of `labels` (OQ-112's AC-1). */
export function buildListIssuesByLabels(repo, labels, page = 1) {
  if (!Array.isArray(labels) || labels.length === 0 || labels.some((l) => typeof l !== 'string')) {
    throw new Error(`labels must be a non-empty array of strings, got: ${JSON.stringify(labels)}`)
  }
  return {
    method: 'GET',
    url: `${repoPath(repo)}/issues?labels=${encodeURIComponent(labels.join(','))}&state=open&per_page=100&page=${page}`,
  }
}

/** Request to create an issue with a title, a body and labels (OQ-112's AC-1). */
export function buildCreateIssue(repo, { title, body, labels }) {
  if (!Array.isArray(labels) || labels.some((l) => typeof l !== 'string')) {
    throw new Error(`labels must be an array of strings, got: ${JSON.stringify(labels)}`)
  }
  return {
    method: 'POST',
    url: `${repoPath(repo)}/issues`,
    body: { title: requireString('title', title), body: requireString('body', body), labels },
  }
}

/** Request to convert the pull request with this node id to a draft (GraphQL). */
export function buildConvertPullRequestToDraft(nodeId) {
  return {
    method: 'POST',
    url: GRAPHQL_URL,
    body: { query: CONVERT_TO_DRAFT_MUTATION, variables: { pullRequestId: requireString('nodeId', nodeId) } },
  }
}

// --------------------------------------------------------------- responses

/** Reduces a pull request response to what the loop reads. */
export function parsePullRequestState(json) {
  return {
    headSha: json.head.sha,
    headRef: json.head.ref ?? null,
    baseRef: json.base?.ref ?? null,
    body: json.body ?? '',
    draft: json.draft === true,
    labels: (json.labels ?? []).map((label) => label.name),
    // `mergeable` is null while GitHub is still computing it; passed through as-is.
    mergeable: json.mergeable ?? null,
    mergeableState: json.mergeable_state ?? null,
  }
}

export function parseLabels(json) {
  return json.map((label) => label.name)
}

/** Reduces a page of pull requests to what the loop reads (OQ-112's AC-1). */
export function parsePullRequests(json) {
  return json.map((pr) => ({ number: pr.number, headRef: pr.head?.ref ?? null }))
}

/** Reduces a page of issues to what the loop reads (OQ-112's AC-1). Interprets nothing. */
export function parseIssues(json) {
  return json.map((issue) => ({ number: issue.number, title: issue.title }))
}

// ----------------------------------------------------------------- markers

/**
 * Composes the comment that records a verdict: `findings` followed by exactly
 * one marker line (AC-3b). A `null` verdict composes no comment and returns
 * `null` -- REVIEW.md: a reviewer not in a position to review leaves the PR
 * pending. `fail` is never written (AC-4).
 */
export function composeMarkerComment({ headSha, verdict, findings = '' }) {
  if (verdict === null) return null
  if (!WRITABLE_VERDICTS.includes(verdict)) {
    throw new Error(`verdict must be one of ${WRITABLE_VERDICTS.join(', ')} or null, got: ${verdict}`)
  }
  if (!SHA_RE.test(headSha ?? '')) {
    throw new Error(`headSha must be the full 40-character lowercase hex SHA, got: ${headSha}`)
  }
  if (findings.match(ANY_MARKER_RE)) {
    throw new Error('findings must not itself contain an agent-review marker')
  }
  const marker = `<!-- agent-review head=${headSha} verdict=${verdict} -->`
  const text = findings.trimEnd()
  return text === '' ? marker : `${text}\n\n${marker}`
}

function classifyMalformed(raw) {
  const fields = raw.match(FIELDS_RE)
  if (!fields) return { reason: 'unparseable-marker', raw }
  if (!SHA_RE.test(fields[1])) return { reason: 'bad-head-sha', raw }
  return { reason: 'unrecognised-verdict', raw }
}

/**
 * Reads the verdict of one comment body by the gate's own rule (AC-6): a marker
 * counts only if it is well-formed on one line, and the last well-formed one wins.
 *  - `marker`: a verdict (`fail` read as `block`), with `malformed` listing any
 *    marker-like text that was not well-formed; that neither prevents nor
 *    replaces the verdict
 *  - `malformed`: no well-formed marker, but marker-like text, listed in `malformed`
 *  - `absent`: no marker-like text at all
 */
export function parseMarkerComment(body) {
  const text = body ?? ''
  const wellFormed = [...text.matchAll(WELL_FORMED_RE)]
  // What remains once the well-formed markers are removed is what the gate ignored.
  const malformed = (text.replace(WELL_FORMED_RE, '').match(ANY_MARKER_RE) ?? []).map(classifyMalformed)
  if (wellFormed.length === 0) {
    return malformed.length === 0 ? { kind: 'absent' } : { kind: 'malformed', malformed }
  }
  const [, headSha, verdictWord] = wellFormed[wellFormed.length - 1]
  const deprecatedSpelling = Object.hasOwn(DEPRECATED_VERDICTS, verdictWord)
  return {
    kind: 'marker',
    headSha,
    verdict: deprecatedSpelling ? DEPRECATED_VERDICTS[verdictWord] : verdictWord,
    deprecatedSpelling,
    malformed,
  }
}

/** Parses a page of comment objects, preserving order. Interprets nothing. */
export function parseComments(json) {
  return json.map((comment) => ({
    id: comment.id,
    author: comment.user?.login ?? null,
    authorAssociation: comment.author_association ?? null,
    createdAt: comment.created_at,
    body: comment.body ?? '',
    marker: parseMarkerComment(comment.body),
  }))
}

// --------------------------------------------------------------------- I/O

/** Reads the token from `gh auth token`. Used for authentication alone. */
export async function ghAuthToken() {
  const { stdout } = await execFileAsync('gh', ['auth', 'token'])
  const token = stdout.trim()
  if (!token) throw new Error('`gh auth token` returned nothing; run `gh auth login`')
  return token
}

const PR = '[1-9][0-9]*'
// [method, path after the repo, permitted body keys or null for none]: the shapes
// of the REST requests the `build*` functions above produce for `repo`, and
// nothing else. The one GraphQL request is admitted separately, below.
const ALLOWED = [
  ['POST', new RegExp('^/pulls$'), ['title', 'body', 'head', 'base', 'draft']],
  ['PATCH', new RegExp(`^/pulls/${PR}$`), ['title', 'body']],
  ['POST', new RegExp(`^/issues/${PR}/comments$`), ['body']],
  ['GET', new RegExp(`^/pulls/${PR}$`), null],
  ['GET', new RegExp(`^/issues/${PR}/labels\\?per_page=100$`), null],
  ['GET', new RegExp(`^/issues/${PR}/comments\\?per_page=100&page=[1-9][0-9]*$`), null],
  ['GET', new RegExp('^/pulls\\?head=[^&]+&state=open$'), null],
  ['GET', new RegExp('^/issues\\?labels=[^&]+&state=open&per_page=100&page=[1-9][0-9]*$'), null],
  ['POST', new RegExp('^/issues$'), ['title', 'body', 'labels']],
]

// The only GraphQL request admitted: `buildConvertPullRequestToDraft`'s shape.
function assertAllowedGraphql(request) {
  const body = request.body
  const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  const allowed =
    request.method === 'POST' &&
    isPlainObject(body) &&
    Object.keys(body).length === 2 &&
    body.query === CONVERT_TO_DRAFT_MUTATION &&
    isPlainObject(body.variables) &&
    Object.keys(body.variables).length === 1 &&
    typeof body.variables.pullRequestId === 'string'
  if (!allowed) {
    throw new Error(`refusing a GraphQL request other than the one mutation this module sends: ${request.method} ${request.url}`)
  }
}

/**
 * Throws unless `request` is a REST request the `build*` functions produce for
 * `repo`, or the one GraphQL request `buildConvertPullRequestToDraft`
 * produces. `send` calls this before any network call, so the
 * module's token cannot be used for anything else.
 */
export function assertAllowedRequest(repo, request) {
  const prefix = repoPath(repo)
  const url = typeof request?.url === 'string' ? request.url : ''
  if (url === GRAPHQL_URL) return assertAllowedGraphql(request)
  const rest = url.startsWith(`${prefix}/`) ? url.slice(prefix.length) : null
  const rule = rest && ALLOWED.find(([method, re]) => method === request.method && re.test(rest))
  if (!rule) {
    throw new Error(`refusing a request outside the operations this module performs: ${request?.method} ${url}`)
  }
  const keys = rule[2]
  const bodyKeys = request.body === undefined ? [] : Object.keys(request.body)
  if (keys === null ? bodyKeys.length > 0 : bodyKeys.some((k) => !keys.includes(k))) {
    throw new Error(`refusing a request with an unexpected body: ${request.method} ${url}`)
  }
}

/**
 * Builds the context the operations run in. `fetch` and `getToken` are
 * injectable; the token is read once, on first use.
 */
export function createContext({ repo, fetch = globalThis.fetch, getToken = ghAuthToken }) {
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
      return response.json()
    },
  }
}

export async function createPullRequest(ctx, args) {
  const json = await ctx.send(buildCreatePullRequest(ctx.repo, args))
  return { number: json.number, url: json.html_url, headSha: json.head.sha }
}

export async function replacePullRequest(ctx, number, args) {
  await ctx.send(buildReplacePullRequest(ctx.repo, number, args))
}

export async function postComment(ctx, number, body) {
  const json = await ctx.send(buildPostComment(ctx.repo, number, body))
  return { id: json.id }
}

export async function getPullRequestState(ctx, number) {
  return parsePullRequestState(await ctx.send(buildGetPullRequestState(ctx.repo, number)))
}

/**
 * Converts a pull request to a draft. Reads it first (the module's existing GET);
 * if it is already a draft nothing more is sent. Returns `{ draft, alreadyDraft }`,
 * `draft` being the state the mutation reports.
 */
export async function convertPullRequestToDraft(ctx, number) {
  const pr = await ctx.send(buildGetPullRequestState(ctx.repo, number))
  if (pr.draft === true) return { draft: true, alreadyDraft: true }
  if (typeof pr.node_id !== 'string' || pr.node_id === '') {
    throw new Error(`pull request #${number} has no node_id in its response`)
  }
  const json = await ctx.send(buildConvertPullRequestToDraft(pr.node_id))
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    throw new Error(`convert #${number} to draft failed: ${json.errors.map((e) => e.message).join('; ')}`)
  }
  const draft = json.data?.convertPullRequestToDraft?.pullRequest?.isDraft
  if (typeof draft !== 'boolean') throw new Error(`convert #${number} to draft: unexpected response ${JSON.stringify(json)}`)
  return { draft, alreadyDraft: false }
}

export async function getPullRequestLabels(ctx, number) {
  return parseLabels(await ctx.send(buildGetPullRequestLabels(ctx.repo, number)))
}

export async function listPullRequestComments(ctx, number) {
  const all = []
  for (let page = 1; ; page++) {
    const json = await ctx.send(buildListComments(ctx.repo, number, page))
    all.push(...parseComments(json))
    if (json.length < 100) return all
  }
}

/** Open pull requests whose head is `branch` (OQ-112's AC-1). */
export async function listOpenPullRequestsForHead(ctx, branch) {
  return parsePullRequests(await ctx.send(buildListPullRequestsForHead(ctx.repo, branch)))
}

/** Every open issue carrying every one of `labels` (OQ-112's AC-1). */
export async function listIssuesByLabels(ctx, labels) {
  const all = []
  for (let page = 1; ; page++) {
    const json = await ctx.send(buildListIssuesByLabels(ctx.repo, labels, page))
    all.push(...parseIssues(json))
    if (json.length < 100) return all
  }
}

/** Creates an issue with a title, a body and labels (OQ-112's AC-1). */
export async function createIssue(ctx, args) {
  const json = await ctx.send(buildCreateIssue(ctx.repo, args))
  return { number: json.number, url: json.html_url }
}
