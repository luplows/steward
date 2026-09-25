// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as github from './github.mjs'
import {
  buildCreatePullRequest,
  buildGetPullRequestLabels,
  buildGetPullRequestState,
  buildListComments,
  buildPostComment,
  buildReplacePullRequest,
  composeMarkerComment,
  createContext,
  createPullRequest,
  getPullRequestLabels,
  getPullRequestState,
  listPullRequestComments,
  parseComments,
  parseMarkerComment,
  postComment,
  replacePullRequest,
} from './github.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = 'luplows/tower-workshop-paths'
const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)

// The pattern review-gate.yml greps with, transcribed from the workflow.
const WORKFLOW_MARKER_RE =
  /<!--[\s]*agent-review[\s]+head=[0-9a-f]{40}[\s]+verdict=(pass-with-observations|pass|block|fail)[\s]*-->/

// The same pattern with horizontal whitespace, as grep applies it one line at a time.
const WORKFLOW_MARKER_RE_LINEWISE =
  /<!--[^\S\n]*agent-review[^\S\n]+head=[0-9a-f]{40}[^\S\n]+verdict=(pass-with-observations|pass|block|fail)[^\S\n]*-->/

function allBuiltRequests() {
  return [
    buildCreatePullRequest(REPO, { title: 't', body: 'b', head: 'h', draft: true }),
    buildReplacePullRequest(REPO, 7, { title: 't', body: 'b' }),
    buildPostComment(REPO, 7, 'hello'),
    buildGetPullRequestState(REPO, 7),
    buildGetPullRequestLabels(REPO, 7),
    buildListComments(REPO, 7),
  ]
}

function fakeFetch(responses) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    const next = responses.shift()
    return { ok: next.ok ?? true, status: next.status ?? 200, json: async () => next.json, text: async () => JSON.stringify(next.json) }
  }
  fn.calls = calls
  return fn
}

describe('OQ-68/AC-1: the operations', () => {
  it('OQ-68/AC-1: creates a pull request from title, body and draft flag', () => {
    expect(buildCreatePullRequest(REPO, { title: 'T', body: 'B', head: 'story/x', draft: true })).toEqual({
      method: 'POST',
      url: `https://api.github.com/repos/${REPO}/pulls`,
      body: { title: 'T', body: 'B', head: 'story/x', base: 'main', draft: true },
    })
    expect(() => buildCreatePullRequest(REPO, { title: 'T', body: 'B', head: 'h' })).toThrow(/draft/)
  })

  it('OQ-68/AC-1: replaces title and body with PATCH, never appending', () => {
    expect(buildReplacePullRequest(REPO, 12, { title: 'T', body: 'whole new body' })).toEqual({
      method: 'PATCH',
      url: `https://api.github.com/repos/${REPO}/pulls/12`,
      body: { title: 'T', body: 'whole new body' },
    })
  })

  it('OQ-68/AC-1: posts a comment, reads state, labels and comments', () => {
    expect(buildPostComment(REPO, 12, 'hi')).toEqual({
      method: 'POST',
      url: `https://api.github.com/repos/${REPO}/issues/12/comments`,
      body: { body: 'hi' },
    })
    expect(buildGetPullRequestState(REPO, 12).url).toBe(`https://api.github.com/repos/${REPO}/pulls/12`)
    expect(buildGetPullRequestLabels(REPO, 12).url).toContain(`/issues/12/labels`)
    expect(buildListComments(REPO, 12, 2).url).toContain(`/issues/12/comments?per_page=100&page=2`)
  })

  it('OQ-68/AC-1: rejects a bad repo or pull request number', () => {
    expect(() => buildPostComment('nope', 1, 'x')).toThrow(/owner\/name/)
    expect(() => buildPostComment(REPO, 0, 'x')).toThrow(/positive integer/)
  })

  it('OQ-68/AC-1: reads state and labels from responses', async () => {
    const fetch = fakeFetch([
      {
        json: {
          head: { sha: SHA },
          draft: true,
          labels: [{ name: 'review-blocked' }],
          mergeable: null,
          mergeable_state: 'unknown',
        },
      },
      { json: [{ name: 'a' }, { name: 'b' }] },
    ])
    const ctx = createContext({ repo: REPO, fetch, getToken: async () => 't' })
    expect(await getPullRequestState(ctx, 3)).toEqual({
      headSha: SHA,
      draft: true,
      labels: ['review-blocked'],
      mergeable: null,
      mergeableState: 'unknown',
    })
    expect(await getPullRequestLabels(ctx, 3)).toEqual(['a', 'b'])
  })
})

describe('OQ-68/AC-2: injectable I/O', () => {
  it('OQ-68/AC-2: builders are pure and carry no token', () => {
    for (const request of allBuiltRequests()) {
      expect(JSON.stringify(request)).not.toMatch(/Bearer|Authorization/)
    }
    expect(buildPostComment(REPO, 1, 'x')).toEqual(buildPostComment(REPO, 1, 'x'))
  })

  it('OQ-68/AC-2: sends over the injected fetch, reading the token once', async () => {
    let tokenReads = 0
    const fetch = fakeFetch([{ json: { id: 1 } }, { json: { id: 2 } }, { json: {} }])
    const ctx = createContext({
      repo: REPO,
      fetch,
      getToken: async () => {
        tokenReads++
        return 'tok'
      },
    })
    await postComment(ctx, 5, 'one')
    await postComment(ctx, 5, 'two')
    await replacePullRequest(ctx, 5, { title: 't', body: 'b' })

    expect(tokenReads).toBe(1)
    expect(fetch.calls).toHaveLength(3)
    expect(fetch.calls[0].url).toBe(`https://api.github.com/repos/${REPO}/issues/5/comments`)
    expect(fetch.calls[0].init.method).toBe('POST')
    expect(fetch.calls[0].init.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(fetch.calls[0].init.body)).toEqual({ body: 'one' })
    expect(fetch.calls[2].init.method).toBe('PATCH')
  })

  it('OQ-68/AC-2: createPullRequest returns number, url and head', async () => {
    const fetch = fakeFetch([{ json: { number: 9, html_url: 'https://x/9', head: { sha: SHA } } }])
    const ctx = createContext({ repo: REPO, fetch, getToken: async () => 't' })
    expect(await createPullRequest(ctx, { title: 't', body: 'b', head: 'h', draft: false })).toEqual({
      number: 9,
      url: 'https://x/9',
      headSha: SHA,
    })
  })

  it('OQ-68/AC-2: a non-2xx response throws with the status', async () => {
    const fetch = fakeFetch([{ ok: false, status: 422, json: { message: 'nope' } }])
    const ctx = createContext({ repo: REPO, fetch, getToken: async () => 't' })
    await expect(postComment(ctx, 1, 'x')).rejects.toThrow(/422/)
  })

  it('OQ-68/AC-2: listing follows pages until a short one', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i, body: 'no marker', created_at: 't' }))
    const fetch = fakeFetch([{ json: full }, { json: [{ id: 100, body: 'last', created_at: 't' }] }])
    const ctx = createContext({ repo: REPO, fetch, getToken: async () => 't' })
    const comments = await listPullRequestComments(ctx, 1)
    expect(comments).toHaveLength(101)
    expect(fetch.calls[1].url).toContain('page=2')
  })
})

describe('OQ-68/AC-3: no commit status', () => {
  it('OQ-68/AC-3: no request this module can build targets a commit status, check or workflow', () => {
    for (const request of allBuiltRequests()) {
      expect(request.url).not.toMatch(/\/statuses\/|\/check-|\/actions\/|\/dispatches/)
      expect(JSON.stringify(request.body ?? {})).not.toContain('review/agent')
    }
  })

  it('OQ-68/AC-3: send itself refuses a status or workflow-dispatch request before any network call', async () => {
    const fetch = fakeFetch(Array.from({ length: 6 }, () => ({ json: {} })))
    const getToken = async () => 't'
    const ctx = createContext({ repo: REPO, fetch, getToken })
    const base = `https://api.github.com/repos/${REPO}`
    const refused = [
      { method: 'POST', url: `${base}/statuses/${SHA}`, body: { state: 'success', context: 'review/agent' } },
      { method: 'POST', url: `${base}/actions/workflows/land-approved.yml/dispatches`, body: { ref: 'main' } },
      { method: 'POST', url: `${base}/check-runs`, body: { name: 'x' } },
      { method: 'POST', url: `${base}/issues/7/comments`, body: { body: 'x', state: 'success' } },
      { method: 'GET', url: 'https://evil.example/pulls/7' },
      { method: 'DELETE', url: `${base}/pulls/7` },
    ]
    for (const request of refused) await expect(ctx.send(request)).rejects.toThrow(/refusing/)
    expect(fetch.calls).toHaveLength(0)
    for (const request of allBuiltRequests()) await ctx.send(request)
    expect(fetch.calls).toHaveLength(6)
  })

  it('OQ-68/AC-3: the source neither names the status endpoint nor a workflow dispatch', async () => {
    const source = await readFile(path.join(here, 'github.mjs'), 'utf8')
    expect(source).not.toMatch(/\/statuses|\/dispatches|\/check-runs/)
    expect(source).not.toContain("'review/agent'")
  })
})

describe('OQ-68/AC-3b: composing a marker comment', () => {
  it('OQ-68/AC-3b: produces exactly one marker line with the full sha', () => {
    for (const verdict of ['pass', 'pass-with-observations', 'block']) {
      const comment = composeMarkerComment({ headSha: SHA, verdict, findings: '- item 7: a finding' })
      expect(comment.match(/<!-- agent-review/g)).toHaveLength(1)
      expect(comment.trimEnd().split('\n').at(-1)).toBe(`<!-- agent-review head=${SHA} verdict=${verdict} -->`)
      expect(comment).toContain('- item 7: a finding')
    }
  })

  it('OQ-68/AC-3b: a null verdict composes no comment and is not an error', () => {
    expect(composeMarkerComment({ headSha: SHA, verdict: null, findings: 'x' })).toBeNull()
  })

  it('OQ-68/AC-3b: a composed comment matches the pattern review-gate.yml greps for', async () => {
    const comment = composeMarkerComment({ headSha: SHA, verdict: 'pass-with-observations', findings: 'ok' })
    expect(comment).toMatch(WORKFLOW_MARKER_RE)

    // Guard the transcription above against drifting from the workflow itself.
    const workflow = await readFile(path.join(here, '..', '..', '.github', 'workflows', 'review-gate.yml'), 'utf8')
    expect(workflow).toContain('agent-review[[:space:]]+head=[0-9a-f]{40}[[:space:]]+verdict=(pass-with-observations|pass|block|fail)')
  })

  it('OQ-68/AC-3b: rejects a short sha, an unknown verdict, or findings carrying a marker', () => {
    expect(() => composeMarkerComment({ headSha: 'abc123', verdict: 'pass' })).toThrow(/40-character/)
    expect(() => composeMarkerComment({ headSha: SHA.toUpperCase(), verdict: 'pass' })).toThrow(/40-character/)
    expect(() => composeMarkerComment({ headSha: SHA, verdict: 'maybe' })).toThrow(/verdict/)
    expect(() =>
      composeMarkerComment({ headSha: SHA, verdict: 'pass', findings: `<!-- agent-review head=${SHA} verdict=block -->` }),
    ).toThrow(/marker/)
  })
})

describe('OQ-68/AC-4: verdict=fail', () => {
  it('OQ-68/AC-4: is read as block, flagged as the deprecated spelling', () => {
    expect(parseMarkerComment(`x\n<!-- agent-review head=${SHA} verdict=fail -->`)).toEqual({
      kind: 'marker',
      headSha: SHA,
      verdict: 'block',
      deprecatedSpelling: true,
      malformed: [],
    })
  })

  it('OQ-68/AC-4: is never written', () => {
    expect(() => composeMarkerComment({ headSha: SHA, verdict: 'fail' })).toThrow()
  })
})

describe('OQ-68/AC-5: listing comments parses markers in order', () => {
  it('OQ-68/AC-5: returns each marker with head sha and verdict, in order, without interpreting them', () => {
    const parsed = parseComments([
      { id: 1, user: { login: 'a' }, created_at: 't1', body: `r1\n<!-- agent-review head=${SHA} verdict=block -->` },
      { id: 2, user: { login: 'b' }, created_at: 't2', body: 'a discussion comment' },
      { id: 3, user: { login: 'a' }, created_at: 't3', body: `<!-- agent-review head=${SHA2} verdict=pass -->` },
    ])
    expect(parsed.map((c) => c.id)).toEqual([1, 2, 3])
    expect(parsed[0].marker).toMatchObject({ kind: 'marker', headSha: SHA, verdict: 'block' })
    expect(parsed[1].marker).toEqual({ kind: 'absent' })
    expect(parsed[2].marker).toMatchObject({ kind: 'marker', headSha: SHA2, verdict: 'pass' })
  })
})

describe('OQ-68/AC-6: a verdict is read by the gate\'s rule', () => {
  it('OQ-68/AC-6: absent is reported as absent, not defaulted', () => {
    expect(parseMarkerComment('nothing here')).toEqual({ kind: 'absent' })
    expect(parseMarkerComment(undefined)).toEqual({ kind: 'absent' })
  })

  it('OQ-68/AC-6: a short sha is malformed', () => {
    expect(parseMarkerComment('<!-- agent-review head=abc123 verdict=pass -->')).toMatchObject({
      kind: 'malformed',
      malformed: [{ reason: 'bad-head-sha' }],
    })
  })

  it('OQ-68/AC-6: an unrecognised verdict is malformed, not defaulted', () => {
    expect(parseMarkerComment(`<!-- agent-review head=${SHA} verdict=approve -->`)).toMatchObject({
      kind: 'malformed',
      malformed: [{ reason: 'unrecognised-verdict' }],
    })
  })

  it('OQ-68/AC-6: an unparseable marker is malformed', () => {
    expect(parseMarkerComment('<!-- agent-review verdict=pass -->')).toMatchObject({
      kind: 'malformed',
      malformed: [{ reason: 'unparseable-marker' }],
    })
  })

  it('OQ-68/AC-6: a marker split across lines is not a verdict, as the gate finds none', () => {
    for (const body of [
      `<!-- agent-review\nhead=${SHA}\nverdict=pass -->`,
      `<!-- agent-review head=${SHA}\nverdict=pass -->`,
      `<!-- agent-review head=${SHA} verdict=pass\n-->`,
    ]) {
      expect(body).not.toMatch(WORKFLOW_MARKER_RE_LINEWISE)
      expect(parseMarkerComment(body)).toMatchObject({
        kind: 'malformed',
        malformed: [{ reason: 'unparseable-marker' }],
      })
    }
  })

  it('OQ-68/AC-6: a quoted malformed marker before a real one does not hide the real verdict', () => {
    // The shape of the runner's round-1 comment on #133: `\\n` in the template literals below is a literal backslash-n.
    const quoted = `<!-- agent-review\\nhead=${SHA}\\nverdict=pass -->`
    const real = `<!-- agent-review head=${SHA2} verdict=pass-with-observations -->`
    const body = `Findings. The marker ${quoted} was malformed.\n\n${real}`
    expect(body).toMatch(WORKFLOW_MARKER_RE_LINEWISE)
    expect(parseMarkerComment(body)).toMatchObject({
      kind: 'marker',
      headSha: SHA2,
      verdict: 'pass-with-observations',
      malformed: [{ reason: 'unparseable-marker', raw: quoted }],
    })
  })

  it('OQ-68/AC-6: the last well-formed marker wins, and a malformed one after it does not replace it', () => {
    const body =
      `<!-- agent-review head=${SHA} verdict=block -->\n<!-- agent-review head=${SHA2} verdict=pass -->\n` +
      `<!-- agent-review head=${SHA} verdict=nope -->`
    expect(parseMarkerComment(body)).toMatchObject({
      kind: 'marker',
      headSha: SHA2,
      verdict: 'pass',
      malformed: [{ reason: 'unrecognised-verdict' }],
    })
  })
})

describe('OQ-68/AC-7: module surface', () => {
  it('OQ-68/AC-7: exports exactly the GitHub operations and their pure helpers', () => {
    expect(Object.keys(github).sort()).toEqual(
      [
        'WRITABLE_VERDICTS',
        'assertAllowedRequest',
        'buildCreatePullRequest',
        'buildGetPullRequestLabels',
        'buildGetPullRequestState',
        'buildListComments',
        'buildPostComment',
        'buildReplacePullRequest',
        'composeMarkerComment',
        'createContext',
        'createPullRequest',
        'getPullRequestLabels',
        'getPullRequestState',
        'ghAuthToken',
        'listPullRequestComments',
        'parseComments',
        'parseLabels',
        'parseMarkerComment',
        'parsePullRequestState',
        'postComment',
        'replacePullRequest',
      ].sort(),
    )
  })

  it('OQ-68/AC-7: imports nothing from the loop modules and exposes no spawn, prompt, story or workflow call', async () => {
    const source = await readFile(path.join(here, 'github.mjs'), 'utf8')
    expect(source).not.toMatch(/from '\.\/(spawn|invocation|dispatch|queue|render|outcome)\.mjs'/)
    for (const name of Object.keys(github)) {
      expect(name).not.toMatch(/spawn|prompt|render|story|stories|dispatch|workflow|status|label(?!s)|round/i)
    }
  })
})
