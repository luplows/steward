/**
 * The GitHub reads `steward upgrade` performs (ST-69), and nothing else: tags, commits, files at a
 * commit and comparisons of two commits, in steward's own repository and in the project's. Every
 * request is a GET. Its allowlist is its own and `github.mjs`'s is untouched, so no context there
 * may read or do anything more because of this module. As there, a pure `build*` function makes
 * each request, the one place that does I/O is `send`, which takes an injectable `fetch`, and the
 * token is read once from `gh auth token`.
 */
import { ghAuthToken } from './github.mjs'

const API = 'https://api.github.com'

function repoPath(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error(`repo must be "owner/name", got: ${repo}`)
  return `${API}/repos/${repo}`
}

// Two repositories are read through it: steward's own, for the tags, commits, templates and
// `package.json` the pins name, and the project's, for the files an upgrade inspects on `main`.

const TAG_RE = /^v\d+\.\d+\.\d+$/
const FULL_SHA_RE = /^[0-9a-f]{40}$/

/** Request to read the tag ref `tag` (`vX.Y.Z`): its object is a commit or an annotated tag. */
export function buildGetTagRef(repo, tag) {
  if (!TAG_RE.test(tag ?? '')) throw new Error(`tag must be of the form vX.Y.Z, got: ${tag}`)
  return { method: 'GET', url: `${repoPath(repo)}/git/ref/tags/${tag}` }
}

/** Request to read the annotated tag object with this lower-case full SHA. */
export function buildGetTagObject(repo, sha) {
  if (!FULL_SHA_RE.test(sha ?? '')) throw new Error(`sha must be a full lower-case SHA, got: ${sha}`)
  return { method: 'GET', url: `${repoPath(repo)}/git/tags/${sha}` }
}

/** Request to read the commit with this lower-case full SHA. */
export function buildGetCommit(repo, sha) {
  if (!FULL_SHA_RE.test(sha ?? '')) throw new Error(`sha must be a full lower-case SHA, got: ${sha}`)
  return { method: 'GET', url: `${repoPath(repo)}/commits/${sha}` }
}

/** Request to read the file `filePath` at `ref`: `main`, or a lower-case full SHA. */
export function buildGetContents(repo, filePath, ref) {
  if (typeof filePath !== 'string' || filePath === '' || filePath.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`path must be a relative path of named segments, got: ${filePath}`)
  }
  if (ref !== 'main' && !FULL_SHA_RE.test(ref ?? '')) throw new Error(`ref must be main or a full lower-case SHA, got: ${ref}`)
  return { method: 'GET', url: `${repoPath(repo)}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${ref}` }
}

/** Request to compare commit `base` with commit `head`: `status` is `ahead`, `behind`, `diverged` or `identical`. */
export function buildCompare(repo, base, head) {
  for (const sha of [base, head]) if (!FULL_SHA_RE.test(sha ?? '')) throw new Error(`sha must be a full lower-case SHA, got: ${sha}`)
  return { method: 'GET', url: `${repoPath(repo)}/compare/${base}...${head}` }
}

const READ_ROUTES = [
  /^\/git\/ref\/tags\/v[0-9]+\.[0-9]+\.[0-9]+$/,
  /^\/git\/tags\/[0-9a-f]{40}$/,
  /^\/commits\/[0-9a-f]{40}$/,
  /^\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/,
]
const CONTENTS_RE = /^\/contents\/([^?#]+)\?ref=(main|[0-9a-f]{40})$/

/**
 * Throws unless `request` is a GET of one of the shapes the builders above produce for `repo`. A
 * contents request is admitted only for a path `contentPaths` accepts; `git` says whether the
 * tag, commit and comparison reads are admitted at all.
 */
export function assertAllowedReadRequest(repo, request, { git, contentPaths }) {
  const prefix = repoPath(repo)
  const url = typeof request?.url === 'string' ? request.url : ''
  const rest = url.startsWith(`${prefix}/`) ? url.slice(prefix.length) : null
  const contents = rest === null ? null : CONTENTS_RE.exec(rest)
  const allowed =
    request?.method === 'GET' &&
    request.body === undefined &&
    rest !== null &&
    ((git && READ_ROUTES.some((re) => re.test(rest))) ||
      (contents !== null && contentPaths(contents[1].split('/').map(decodeURIComponent).join('/'))))
  if (!allowed) throw new Error(`refusing a request outside the reads this context performs: ${request?.method} ${url}`)
}

/**
 * A context that only reads: `send` resolves `{ status, body }` for any response, a 404 included,
 * and throws on a request outside the allowlist (`assertAllowedReadRequest`) or a network failure.
 * `fetch` and `getToken` are injectable.
 */
export function createReadContext({ repo, git, contentPaths, fetch = globalThis.fetch, getToken = ghAuthToken }) {
  repoPath(repo)
  let token
  return {
    repo,
    async send(request) {
      assertAllowedReadRequest(repo, request, { git, contentPaths })
      token ??= await getToken()
      const response = await fetch(request.url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      })
      const text = await response.text()
      let body = null
      try {
        body = text === '' ? null : JSON.parse(text)
      } catch {
        body = null
      }
      return { status: response.status, body }
    },
  }
}

const readFailure = (request, response) =>
  new Error(`${request.method} ${request.url} failed with ${response.status}${response.body?.message ? `: ${response.body.message}` : ''}`)

/**
 * Thrown by `readTagCommit` when GitHub answered for the tag and it does not lead to a commit:
 * an answer about the tag, not a failure to read it.
 */
export class TagNotACommit extends Error {}

/**
 * The commit the tag `tag` names (an annotated tag is followed to its commit, through at most five
 * tag objects), or `null` when there is no such tag. Throws `TagNotACommit` when the tag leads to
 * something else, or to a longer chain of tag objects.
 */
export async function readTagCommit(ctx, tag) {
  const request = buildGetTagRef(ctx.repo, tag)
  const response = await ctx.send(request)
  if (response.status === 404) return null
  if (response.status !== 200) throw readFailure(request, response)
  let object = response.body?.object
  for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) {
    const next = buildGetTagObject(ctx.repo, String(object.sha).toLowerCase())
    const answer = await ctx.send(next)
    if (answer.status !== 200) throw readFailure(next, answer)
    object = answer.body?.object
  }
  if (object?.type === 'tag') {
    throw new TagNotACommit(`the tag ${tag} of ${ctx.repo} leads through more than five tag objects, which steward does not follow to a commit`)
  }
  if (object?.type !== 'commit' || !FULL_SHA_RE.test(String(object.sha).toLowerCase())) {
    throw new TagNotACommit(`the tag ${tag} of ${ctx.repo} does not name a commit`)
  }
  return String(object.sha).toLowerCase()
}

/** The full SHA of the commit `sha` (lower-case, 40 hexadecimal characters), or `null` when there is no such commit. */
export async function readCommit(ctx, sha) {
  const request = buildGetCommit(ctx.repo, sha)
  const response = await ctx.send(request)
  if (response.status === 404 || response.status === 422) return null
  if (response.status !== 200) throw readFailure(request, response)
  return String(response.body?.sha).toLowerCase()
}

/** The text of the file `filePath` at `ref`, or `null` when it is not there. */
export async function readFileAt(ctx, filePath, ref) {
  const request = buildGetContents(ctx.repo, filePath, ref)
  const response = await ctx.send(request)
  if (response.status === 404) return null
  if (response.status !== 200) throw readFailure(request, response)
  const { type, encoding, content } = response.body ?? {}
  if (type !== 'file' || encoding !== 'base64' || typeof content !== 'string') {
    throw new Error(`${request.url}: not a file GitHub returned as base64 content`)
  }
  return Buffer.from(content, 'base64').toString('utf8')
}

/** GitHub's `status` for the comparison of `head` with `base`. */
export async function readComparison(ctx, base, head) {
  const request = buildCompare(ctx.repo, base, head)
  const response = await ctx.send(request)
  if (response.status !== 200) throw readFailure(request, response)
  return response.body?.status
}
