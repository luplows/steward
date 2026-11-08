// @vitest-environment node

import { describe, expect, it } from 'vitest'
import * as github from './github.mjs'
import {
  assertAllowedReadRequest,
  buildCompare,
  buildGetCommit,
  buildGetContents,
  buildGetTagObject,
  buildGetTagRef,
  createReadContext,
  readComparison,
  readCommit,
  readFileAt,
  readTagCommit,
} from './github-read.mjs'

const STEWARD = 'luplows/steward'
const PROJECT = 'acme/widgets'
const SHA = '0123456789abcdef0123456789abcdef01234567'
const SHA2 = 'fedcba9876543210fedcba9876543210fedcba98'
const API = 'https://api.github.com/repos'
const stewardPaths = (p) => p === 'package.json' || /^templates\/workflows\/[\w-]+\.yml$/.test(p)

const reply = (status, content) => ({ status, text: async () => (content === undefined ? '' : JSON.stringify(content)) })

describe('ST-69/AC-2: the reads of steward are GETs of five shapes', () => {
  it('ST-69/AC-2: each builder makes a GET of its own shape, and refuses what is not that shape', () => {
    expect(buildGetTagRef(STEWARD, 'v0.2.0')).toEqual({ method: 'GET', url: `${API}/${STEWARD}/git/ref/tags/v0.2.0` })
    expect(buildGetTagObject(STEWARD, SHA).url).toBe(`${API}/${STEWARD}/git/tags/${SHA}`)
    expect(buildGetCommit(STEWARD, SHA).url).toBe(`${API}/${STEWARD}/commits/${SHA}`)
    expect(buildCompare(STEWARD, SHA, SHA2).url).toBe(`${API}/${STEWARD}/compare/${SHA}...${SHA2}`)
    expect(buildGetContents(STEWARD, 'templates/workflows/review-gate.yml', SHA).url).toBe(
      `${API}/${STEWARD}/contents/templates/workflows/review-gate.yml?ref=${SHA}`,
    )
    expect(buildGetContents(PROJECT, 'steward.config.json', 'main').url).toBe(`${API}/${PROJECT}/contents/steward.config.json?ref=main`)
    expect(() => buildGetTagRef(STEWARD, '0.2.0')).toThrow(/vX\.Y\.Z/)
    expect(() => buildGetCommit(STEWARD, SHA.toUpperCase())).toThrow(/full lower-case SHA/)
    expect(() => buildGetCommit(STEWARD, 'main')).toThrow(/full lower-case SHA/)
    expect(() => buildCompare(STEWARD, SHA, 'abc')).toThrow(/full lower-case SHA/)
    expect(() => buildGetContents(STEWARD, '../x', SHA)).toThrow(/relative path/)
    expect(() => buildGetContents(STEWARD, 'a//b', SHA)).toThrow(/relative path/)
    expect(() => buildGetContents(STEWARD, 'package.json', 'v0.1.0')).toThrow(/ref must be main or a full/)
  })

  it('ST-69/AC-2: the allowlist admits those requests and nothing else', () => {
    const allow = (request, options) => assertAllowedReadRequest(STEWARD, request, options)
    const git = { git: true, contentPaths: stewardPaths }
    for (const request of [
      buildGetTagRef(STEWARD, 'v0.2.0'),
      buildGetTagObject(STEWARD, SHA),
      buildGetCommit(STEWARD, SHA),
      buildCompare(STEWARD, SHA, SHA2),
      buildGetContents(STEWARD, 'package.json', SHA),
      buildGetContents(STEWARD, 'templates/workflows/inspection.yml', 'main'),
    ]) {
      expect(() => allow(request, git), request.url).not.toThrow()
    }
    const refused = [
      { method: 'POST', url: `${API}/${STEWARD}/commits/${SHA}` },
      { method: 'DELETE', url: `${API}/${STEWARD}/git/ref/tags/v0.2.0` },
      { method: 'GET', url: `${API}/${STEWARD}/commits/${SHA}`, body: {} },
      { method: 'GET', url: `${API}/${STEWARD}/git/ref/heads/main` },
      { method: 'GET', url: `${API}/${STEWARD}/git/ref/tags/v0x2y0` },
      { method: 'GET', url: `${API}/${STEWARD}/compare/${SHA}xxx${SHA2}` },
      { method: 'GET', url: `${API}/${STEWARD}/commits/main` },
      { method: 'GET', url: `${API}/${STEWARD}/commits?sha=main` },
      { method: 'GET', url: `${API}/${STEWARD}/contents/package.json?ref=v0.1.0` },
      { method: 'GET', url: `${API}/${STEWARD}/contents/.github/workflows/review-gate.yml?ref=main` },
      { method: 'GET', url: `${API}/${STEWARD}/contents/templates/workflows/../../secrets?ref=main` },
      { method: 'GET', url: `${API}/${STEWARD}/pulls` },
      { method: 'GET', url: `${API}/${STEWARD}` },
      { method: 'GET', url: `${API}/other/repo/commits/${SHA}` },
      { method: 'GET', url: 'https://api.github.com/graphql' },
    ]
    for (const request of refused) expect(() => allow(request, git), `${request.method} ${request.url}`).toThrow(/refusing/)
  })

  it('ST-69/AC-2: a context for the project admits contents of its named paths only, and none of the git reads', () => {
    const project = { git: false, contentPaths: (p) => p === 'steward.config.json' || p === 'REVIEW.md' }
    expect(() => assertAllowedReadRequest(PROJECT, buildGetContents(PROJECT, 'steward.config.json', 'main'), project)).not.toThrow()
    expect(() => assertAllowedReadRequest(PROJECT, buildGetContents(PROJECT, 'REVIEW.md', 'main'), project)).not.toThrow()
    expect(() => assertAllowedReadRequest(PROJECT, buildGetContents(PROJECT, '.env', 'main'), project)).toThrow(/refusing/)
    expect(() => assertAllowedReadRequest(PROJECT, buildGetCommit(PROJECT, SHA), project)).toThrow(/refusing/)
    expect(() => assertAllowedReadRequest(PROJECT, buildCompare(PROJECT, SHA, SHA2), project)).toThrow(/refusing/)
  })

  it('ST-69/AC-2: github.mjs\'s contexts admit none of these requests: nothing existing was widened', () => {
    const requests = [
      buildGetTagRef(STEWARD, 'v0.2.0'),
      buildGetTagObject(STEWARD, SHA),
      buildGetCommit(STEWARD, SHA),
      buildCompare(STEWARD, SHA, SHA2),
      buildGetContents(STEWARD, 'package.json', SHA),
    ]
    for (const request of requests) expect(() => github.assertAllowedRequest(STEWARD, request), request.url).toThrow(/refusing/)
    expect(Object.keys(github).some((name) => /^(buildGet(TagRef|TagObject|Commit|Contents)|buildCompare|createReadContext)$/.test(name))).toBe(false)
  })

  it('ST-69/AC-2: a context sends only allowed requests, GET, with the token, and resolves status and body for a 404 too', async () => {
    const sent = []
    const ctx = createReadContext({
      repo: STEWARD,
      git: true,
      contentPaths: stewardPaths,
      getToken: async () => 'tok',
      fetch: async (url, init) => {
        sent.push({ url, init })
        return reply(404, { message: 'Not Found' })
      },
    })
    expect(await ctx.send(buildGetCommit(STEWARD, SHA))).toEqual({ status: 404, body: { message: 'Not Found' } })
    expect(sent[0].init.method).toBe('GET')
    expect(sent[0].init.headers.Authorization).toBe('Bearer tok')
    expect(sent[0].init.body).toBeUndefined()
    await expect(ctx.send({ method: 'POST', url: `${API}/${STEWARD}/commits/${SHA}` })).rejects.toThrow(/refusing/)
    expect(sent).toHaveLength(1)
  })
})

describe('ST-69/AC-2 and AC-4: the readers', () => {
  const ctxFor = (answers) =>
    createReadContext({
      repo: STEWARD,
      git: true,
      contentPaths: stewardPaths,
      getToken: async () => 't',
      fetch: async (url) => {
        const key = url.slice(`${API}/${STEWARD}`.length)
        const answer = answers[key]
        if (answer === undefined) throw new Error(`unexpected ${key}`)
        return reply(...answer)
      },
    })

  it('ST-69/AC-2: a tag names a commit, an annotated tag is followed to it, and a missing tag is null', async () => {
    const ctx = ctxFor({
      '/git/ref/tags/v1.0.0': [200, { object: { type: 'commit', sha: SHA.toUpperCase() } }],
      '/git/ref/tags/v1.1.0': [200, { object: { type: 'tag', sha: SHA2 } }],
      [`/git/tags/${SHA2}`]: [200, { object: { type: 'commit', sha: SHA } }],
      '/git/ref/tags/v2.0.0': [404, { message: 'Not Found' }],
      '/git/ref/tags/v3.0.0': [200, { object: { type: 'tree', sha: SHA } }],
      '/git/ref/tags/v4.0.0': [500, { message: 'boom' }],
    })
    expect(await readTagCommit(ctx, 'v1.0.0')).toBe(SHA)
    expect(await readTagCommit(ctx, 'v1.1.0')).toBe(SHA)
    expect(await readTagCommit(ctx, 'v2.0.0')).toBeNull()
    await expect(readTagCommit(ctx, 'v3.0.0')).rejects.toThrow(/does not name a commit/)
    await expect(readTagCommit(ctx, 'v4.0.0')).rejects.toThrow(/failed with 500: boom/)
  })

  it('ST-69/AC-2: a commit is found, or null for 404 and 422', async () => {
    const ctx = ctxFor({
      [`/commits/${SHA}`]: [200, { sha: SHA }],
      [`/commits/${SHA2}`]: [422, { message: 'No commit found' }],
    })
    expect(await readCommit(ctx, SHA)).toBe(SHA)
    expect(await readCommit(ctx, SHA2)).toBeNull()
  })

  it('ST-69/AC-5: a file is decoded from base64, null when missing, and an error for anything else', async () => {
    const content = Buffer.from('name: x\n').toString('base64')
    const ctx = ctxFor({
      [`/contents/package.json?ref=${SHA}`]: [200, { type: 'file', encoding: 'base64', content }],
      [`/contents/templates/workflows/a.yml?ref=${SHA}`]: [404, {}],
      [`/contents/templates/workflows/b.yml?ref=${SHA}`]: [200, [{ type: 'file' }]],
    })
    expect(await readFileAt(ctx, 'package.json', SHA)).toBe('name: x\n')
    expect(await readFileAt(ctx, 'templates/workflows/a.yml', SHA)).toBeNull()
    await expect(readFileAt(ctx, 'templates/workflows/b.yml', SHA)).rejects.toThrow(/not a file/)
  })

  it('ST-69/AC-4: a comparison gives GitHub\'s status', async () => {
    const ctx = ctxFor({ [`/compare/${SHA}...${SHA2}`]: [200, { status: 'diverged' }], [`/compare/${SHA2}...${SHA}`]: [500, {}] })
    expect(await readComparison(ctx, SHA, SHA2)).toBe('diverged')
    await expect(readComparison(ctx, SHA2, SHA)).rejects.toThrow(/failed with 500/)
  })
})
