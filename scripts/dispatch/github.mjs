#!/usr/bin/env node
/**
 * The GitHub operations the dispatch loop performs (OQ-68), and nothing else:
 * create a pull request, replace its title and body, post a comment, read its
 * state, read its labels, list its comments.
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
 *  - Trigger any workflow. Only the owner triggers the landing sweep.
 *  - Apply labels, count rounds, or decide what a verdict means (OQ-48).
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

// --------------------------------------------------------------- responses

/** Reduces a pull request response to what the loop reads. */
export function parsePullRequestState(json) {
  return {
    headSha: json.head.sha,
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
    createdAt: comment.created_at,
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
// of the six `build*` functions above, and nothing else.
const ALLOWED = [
  ['POST', new RegExp('^/pulls$'), ['title', 'body', 'head', 'base', 'draft']],
  ['PATCH', new RegExp(`^/pulls/${PR}$`), ['title', 'body']],
  ['POST', new RegExp(`^/issues/${PR}/comments$`), ['body']],
  ['GET', new RegExp(`^/pulls/${PR}$`), null],
  ['GET', new RegExp(`^/issues/${PR}/labels\\?per_page=100$`), null],
  ['GET', new RegExp(`^/issues/${PR}/comments\\?per_page=100&page=[1-9][0-9]*$`), null],
]

/**
 * Throws unless `request` has the shape one of the six `build*` functions
 * produces for `repo`. `send` calls this before any network call, so the
 * module's token cannot be used for anything else.
 */
export function assertAllowedRequest(repo, request) {
  const prefix = repoPath(repo)
  const url = typeof request?.url === 'string' ? request.url : ''
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
