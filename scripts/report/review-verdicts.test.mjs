// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  DEFAULT_LIMIT,
  actedOnVerdicts,
  assertAllowedRequest,
  buildListPullRequests,
  createContext,
  formatReport,
  gatherVerdicts,
  listRecentPullRequests,
  parsePullRequests,
  tallyVerdicts,
} from './review-verdicts.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = 'luplows/tower-workshop-paths'
const SHA = 'a'.repeat(40)

// The pattern review-gate.yml greps for, transcribed line by line exactly as
// scripts/dispatch/github.test.mjs transcribes it -- the fixture the
// pattern-agreement test (AC-4) checks this module's counting against.
const WORKFLOW_MARKER_RE =
  /<!--[^\S\n]*agent-review[^\S\n]+head=[0-9a-f]{40}[^\S\n]+verdict=(pass-with-observations|pass|block|fail)[^\S\n]*-->/

function comment({ id, body, association = 'OWNER' }) {
  return { id, user: { login: 'whoever' }, author_association: association, created_at: '2026-01-01T00:00:00Z', body }
}

function marker(verdict, sha = SHA) {
  return `<!-- agent-review head=${sha} verdict=${verdict} -->`
}

function fakeFetch(responsesByUrl) {
  const calls = []
  const fn = vi.fn(async (url) => {
    calls.push(url)
    const entry = responsesByUrl.find(([re]) => re.test(url))
    if (!entry) throw new Error(`unexpected fetch: ${url}`)
    const json = entry[1]
    return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) }
  })
  fn.calls = calls
  return fn
}

describe('OQ-47/AC-5: parsing and tallying are pure, fetch is injectable, no network', () => {
  it('tallyVerdicts and actedOnVerdicts are ordinary pure functions over fixtures', () => {
    const perPullRequest = [
      { number: 1, verdicts: [{ verdict: 'pass', deprecatedSpelling: false }] },
      { number: 2, verdicts: [] },
    ]
    expect(tallyVerdicts(perPullRequest)).toEqual(
      expect.objectContaining({ pullRequestsScanned: 2, gatedPullRequests: 1, verdictsRecorded: 1 }),
    )
    expect(
      actedOnVerdicts([
        { marker: { kind: 'marker', headSha: SHA, verdict: 'pass', deprecatedSpelling: false }, authorAssociation: 'OWNER' },
        { marker: { kind: 'absent' }, authorAssociation: 'OWNER' },
      ]),
    ).toEqual([{ verdict: 'pass', deprecatedSpelling: false }])
  })

  it('gatherVerdicts only ever calls the injected fetch, never globalThis.fetch', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('must not reach the real network')
    })
    try {
      const fetch = fakeFetch([
        [/\/pulls\?/, [{ number: 1, head: { sha: SHA }, created_at: '2026-01-01T00:00:00Z' }]],
        [/\/issues\/1\/comments/, [comment({ id: 1, body: marker('pass') })]],
      ])
      const ctx = createContext({ repo: REPO, fetch, token: 'tkn' })
      const result = await gatherVerdicts(ctx, { limit: 1 })
      expect(result).toEqual([{ number: 1, verdicts: [{ verdict: 'pass', deprecatedSpelling: false }] }])
      expect(globalFetch).not.toHaveBeenCalled()
    } finally {
      globalFetch.mockRestore()
    }
  })

  it('createContext omits Authorization when no token is given', async () => {
    const fetch = fakeFetch([[/\/pulls\?/, []]])
    const ctx = createContext({ repo: REPO, fetch })
    await ctx.send(buildListPullRequests(REPO))
    expect(fetch).toHaveBeenCalledTimes(1)
    const init = fetch.mock.calls[0][1]
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('assertAllowedRequest refuses anything outside the two listings this module reads', () => {
    expect(() => assertAllowedRequest(REPO, { method: 'GET', url: `https://api.github.com/repos/${REPO}/pulls?state=all&sort=created&direction=desc&per_page=100&page=1` })).not.toThrow()
    expect(() => assertAllowedRequest(REPO, { method: 'POST', url: `https://api.github.com/repos/${REPO}/issues/1/comments` })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'GET', url: `https://api.github.com/repos/${REPO}/pulls/1/merge` })).toThrow(/refusing/)
  })
})

describe('OQ-47/AC-2: distinguishes all four recorded verdicts', () => {
  it('does not collapse pass-with-observations into pass, and keeps block and fail apart', () => {
    const perPullRequest = [
      { number: 1, verdicts: [{ verdict: 'pass', deprecatedSpelling: false }] },
      { number: 2, verdicts: [{ verdict: 'pass-with-observations', deprecatedSpelling: false }] },
      { number: 3, verdicts: [{ verdict: 'block', deprecatedSpelling: false }] },
      { number: 4, verdicts: [{ verdict: 'block', deprecatedSpelling: true }] },
    ]
    const tally = tallyVerdicts(perPullRequest)
    expect(tally.counts).toEqual({ pass: 1, 'pass-with-observations': 1, block: 1, fail: 1 })
    expect(tally.blockingVerdicts).toBe(2)
  })
})

describe('OQ-47/AC-3: per-verdict count and per-pull-request count answer different questions', () => {
  it('a pull request with three blocking verdicts is one pull-request count, not three', () => {
    const perPullRequest = [
      {
        number: 117,
        verdicts: [
          { verdict: 'block', deprecatedSpelling: false },
          { verdict: 'block', deprecatedSpelling: false },
          { verdict: 'pass', deprecatedSpelling: false },
        ],
      },
      { number: 200, verdicts: [{ verdict: 'pass', deprecatedSpelling: false }] },
    ]
    const tally = tallyVerdicts(perPullRequest)
    expect(tally.blockingVerdicts).toBe(2)
    expect(tally.pullRequestsWithBlockingVerdict).toBe(1)
    expect(tally.blockingPullRequests).toEqual([{ number: 117, blocking: 2 }])
    expect(tally.gatedPullRequests).toBe(2)
    expect(tally.verdictsRecorded).toBe(4)
  })
})

describe('OQ-47/AC-4: counting agrees with the pattern review-gate.yml matches', () => {
  const fixtures = [
    { id: 1, body: marker('pass'), association: 'OWNER', expectWellFormed: true },
    { id: 2, body: marker('pass-with-observations'), association: 'MEMBER', expectWellFormed: true },
    { id: 3, body: marker('block'), association: 'COLLABORATOR', expectWellFormed: true },
    // Deprecated spelling: still well-formed by the workflow's own pattern.
    { id: 4, body: marker('fail'), association: 'OWNER', expectWellFormed: true },
    // Malformed: short sha, not matched by either the workflow pattern or this module.
    { id: 5, body: '<!-- agent-review head=abc verdict=pass -->', association: 'OWNER', expectWellFormed: false },
    // Unrecognised verdict word: not matched by either.
    { id: 6, body: marker('maybe'), association: 'OWNER', expectWellFormed: false },
  ]

  it('the transcription above has not drifted from review-gate.yml itself', async () => {
    const workflow = await readFile(path.join(here, '..', '..', '.github', 'workflows', 'review-gate.yml'), 'utf8')
    expect(workflow).toContain('agent-review[[:space:]]+head=[0-9a-f]{40}[[:space:]]+verdict=(pass-with-observations|pass|block|fail)')
  })

  it('every fixture: the workflow pattern matching agrees with parseMarkerComment via actedOnVerdicts', async () => {
    const { parseComments } = await import('../dispatch/github.mjs')
    const comments = parseComments(fixtures.map((f) => comment(f)))
    for (const [i, f] of fixtures.entries()) {
      expect(WORKFLOW_MARKER_RE.test(f.body)).toBe(f.expectWellFormed)
      expect(comments[i].marker.kind === 'marker').toBe(f.expectWellFormed)
    }
    // All fixture authors are privileged, so actedOnVerdicts counts exactly the
    // well-formed ones -- four, matching the story's "a deprecated fail and a
    // malformed marker" fixture set.
    const acted = actedOnVerdicts(comments)
    expect(acted).toHaveLength(4)
    expect(acted.filter((v) => v.deprecatedSpelling)).toHaveLength(1)
  })

  it('a well-formed marker from an unprivileged account is not counted, as the gate itself ignores it', async () => {
    const { parseComments } = await import('../dispatch/github.mjs')
    const comments = parseComments([
      comment({ id: 1, body: marker('block'), association: 'NONE' }),
      comment({ id: 2, body: marker('pass'), association: 'OWNER' }),
    ])
    expect(actedOnVerdicts(comments)).toEqual([{ verdict: 'pass', deprecatedSpelling: false }])
  })

  it('a well-formed, privileged marker naming an earlier round\'s head is still counted, because review-gate.yml acted on it when that head was current', async () => {
    // review-gate.yml compares a marker's head against the pull request's head
    // *at the moment the comment event fires*, not against wherever the pull
    // request ends up (see the module header). A marker from an earlier round
    // named the head that was current when it was posted, so the gate acted
    // on it then -- e.g. #117's three blocking rounds, each on a distinct
    // head, each one the gate actually failed the run for.
    const { parseComments } = await import('../dispatch/github.mjs')
    const earlierRoundSha = 'c'.repeat(40)
    const comments = parseComments([
      comment({ id: 1, body: marker('block', earlierRoundSha), association: 'OWNER' }),
      comment({ id: 2, body: marker('pass', SHA), association: 'OWNER' }),
    ])
    expect(actedOnVerdicts(comments)).toEqual([
      { verdict: 'block', deprecatedSpelling: false },
      { verdict: 'pass', deprecatedSpelling: false },
    ])
  })
})

describe('OQ-47/AC-1: end-to-end report from listings, no stored state', () => {
  it('reproduces the story context table shape on a small fixture set', async () => {
    const pulls = [
      { number: 1, head: { sha: SHA }, created_at: '2026-01-03T00:00:00Z' },
      { number: 2, head: { sha: SHA }, created_at: '2026-01-02T00:00:00Z' },
      { number: 3, head: { sha: SHA }, created_at: '2026-01-01T00:00:00Z' },
    ]
    const fetch = fakeFetch([
      [/\/pulls\?/, pulls],
      [/\/issues\/1\/comments/, [comment({ id: 1, body: marker('pass-with-observations') })]],
      [/\/issues\/2\/comments/, [comment({ id: 2, body: marker('block') }), comment({ id: 3, body: marker('fail') })]],
      [/\/issues\/3\/comments/, []],
    ])
    const ctx = createContext({ repo: REPO, fetch })
    const perPullRequest = await gatherVerdicts(ctx, { limit: 3 })
    const tally = tallyVerdicts(perPullRequest)

    expect(tally.pullRequestsScanned).toBe(3)
    expect(tally.gatedPullRequests).toBe(2) // #3 carries no marker
    expect(tally.verdictsRecorded).toBe(3)
    expect(tally.counts).toEqual({ pass: 0, 'pass-with-observations': 1, block: 1, fail: 1 })
    expect(tally.blockingVerdicts).toBe(2)

    const report = formatReport(tally)
    expect(report).toContain('Verdicts recorded: 3')
    expect(report).toContain('fail (deprecated spelling of block): 1')
  })

  it('listRecentPullRequests paginates until it has enough, or the page is short', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ number: 100 - i, head: { sha: SHA }, created_at: '2026-01-01T00:00:00Z' }))
    const page2 = [{ number: 0, head: { sha: SHA }, created_at: '2025-12-31T00:00:00Z' }]
    const fetch = fakeFetch([
      [/page=1/, page1],
      [/page=2/, page2],
    ])
    const ctx = createContext({ repo: REPO, fetch })
    const result = await listRecentPullRequests(ctx, 101)
    expect(result).toHaveLength(101)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('parsePullRequests reads only number, head sha and created_at', () => {
    expect(parsePullRequests([{ number: 5, head: { sha: SHA }, created_at: 'x', title: 'ignored', body: 'ignored' }])).toEqual([
      { number: 5, headSha: SHA, createdAt: 'x' },
    ])
  })

  it('DEFAULT_LIMIT is a positive integer the CLI falls back to', () => {
    expect(Number.isInteger(DEFAULT_LIMIT)).toBe(true)
    expect(DEFAULT_LIMIT).toBeGreaterThan(0)
  })
})
