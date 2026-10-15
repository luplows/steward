// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createContext } from './github.mjs'
import { describeUnit, findUnitLink, readUnit } from './unit.mjs'

// The readUnit tests build git repositories before each test; a slow machine
// needs more than Vitest's default 10 s (hook) and 5 s (test).
const GIT_TIMEOUT = 30_000

const ALL = ['issue', 'file', 'other']
const REPO = 'luplows/steward'

describe('ST-19/AC-1: the forms findUnitLink reads', () => {
  it('ST-19/AC-1: Unit: none, in any letter case, is the explicit no unit', () => {
    for (const text of ['none', 'None', 'NONE']) {
      expect(findUnitLink(`Unit: ${text}`, ALL)).toEqual({ kind: 'none' })
    }
  })

  it('ST-19/AC-1: Unit: #<n> is an issue link', () => {
    expect(findUnitLink('Unit: #12', ALL)).toEqual({ kind: 'link', type: 'issue', target: 12 })
  })

  it('ST-19/AC-1: text with no whitespace and no URL scheme is a file link', () => {
    expect(findUnitLink('Unit: stories/ST-19-x.md', ALL)).toEqual({
      kind: 'link',
      type: 'file',
      target: 'stories/ST-19-x.md',
    })
  })

  it('ST-19/AC-1: anything else, such as a URL or text with spaces, is an other link', () => {
    expect(findUnitLink('Unit: https://example.com/t/1', ALL)).toEqual({
      kind: 'link',
      type: 'other',
      target: 'https://example.com/t/1',
    })
    expect(findUnitLink('Unit: the thing we talked about', ALL)).toMatchObject({
      type: 'other',
      target: 'the thing we talked about',
    })
  })

  it('ST-19/AC-1: the line is the whole content after leading spaces', () => {
    expect(findUnitLink('  Unit: #3', ALL)).toMatchObject({ kind: 'link', target: 3 })
    expect(findUnitLink('see Unit: #3', ALL)).toEqual({ kind: 'missing' })
    expect(findUnitLink('Unit:\n', ALL)).toEqual({ kind: 'missing' })
    expect(findUnitLink('a\r\nUnit: #4\r\nb', ALL)).toMatchObject({ kind: 'link', target: 4 })
  })

  it('ST-19/AC-1: closing keywords, in any letter case, followed by #<n> are issue links when issue is read', () => {
    for (const keyword of [
      'close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved',
      'Closes', 'FIXES', 'rEsOlVeD',
    ]) {
      expect(findUnitLink(`This ${keyword} #7.`, ['issue'])).toEqual({
        kind: 'link',
        type: 'issue',
        target: 7,
      })
    }
    expect(findUnitLink('Fixes #7', ['file', 'other'])).toEqual({ kind: 'missing' })
    expect(findUnitLink('Fixes #7', [])).toEqual({ kind: 'missing' })
  })

  it('ST-19/AC-1: a #<n> naming another repository is not an issue link of this one', () => {
    expect(findUnitLink('Fixes other/repo#7', ALL)).toEqual({ kind: 'missing' })
    expect(findUnitLink('Closes luplows/steward#7', ALL)).toEqual({ kind: 'missing' })
    expect(findUnitLink('Fixes #7x and prefixes #8', ALL)).toEqual({ kind: 'missing' })
  })

  it('ST-19/AC-1: a link of a kind not in unitLinks is reported as such, not read', () => {
    expect(findUnitLink('Unit: #12', ['file'])).toEqual({
      kind: 'link',
      type: 'issue',
      target: 12,
      unread: true,
    })
    expect(findUnitLink('Unit: a.md', ['issue'])).toMatchObject({ type: 'file', unread: true })
    expect(findUnitLink('Unit: a.md', ['file'])).not.toHaveProperty('unread')
  })
})

describe('ST-19/AC-2: what findUnitLink returns', () => {
  it('ST-19/AC-2: a body with no Unit: line and no closing keyword is missing', () => {
    expect(findUnitLink('', ALL)).toEqual({ kind: 'missing' })
    expect(findUnitLink(undefined, ALL)).toEqual({ kind: 'missing' })
    expect(findUnitLink('Just prose.', ALL)).toEqual({ kind: 'missing' })
  })

  it('ST-19/AC-2: more than one distinct link is several, and lists them', () => {
    const found = findUnitLink('Unit: #12\nUnit: a.md\nFixes #13', ALL)
    expect(found).toEqual({
      kind: 'several',
      links: [
        { type: 'issue', target: 12 },
        { type: 'file', target: 'a.md' },
        { type: 'issue', target: 13 },
      ],
    })
  })

  it('ST-19/AC-2: a closing keyword naming the same issue as a Unit: #<n> line is one link', () => {
    expect(findUnitLink('Unit: #12\nCloses #12', ALL)).toEqual({
      kind: 'link',
      type: 'issue',
      target: 12,
    })
    expect(findUnitLink('Fixes #5\nCloses #5', ALL)).toMatchObject({ kind: 'link', target: 5 })
    expect(findUnitLink('Unit: a.md\nUnit: a.md', ALL)).toMatchObject({ kind: 'link' })
  })

  it('ST-19/AC-2: with unitLinks empty it returns missing or none only, and reports Unit: text as unread', () => {
    expect(findUnitLink('Unit: none', [])).toEqual({ kind: 'none' })
    expect(findUnitLink('Nothing here', [])).toEqual({ kind: 'missing' })
    expect(findUnitLink('Unit: #12\nUnit: a.md\nFixes #3', [])).toEqual({
      kind: 'missing',
      unread: ['#12', 'a.md'],
    })
  })
})

describe('ST-19/AC-3: readUnit', { timeout: GIT_TIMEOUT }, () => {
  let tmp
  let repoDir
  const git = (cwd, ...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd,
      encoding: 'utf8',
    })

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'unit-test-'))
    const origin = path.join(tmp, 'origin.git')
    const seed = path.join(tmp, 'seed')
    repoDir = path.join(tmp, 'repo')
    await mkdir(origin)
    await mkdir(seed)
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin)
    git(seed, 'init', '-q', '-b', 'main')
    git(seed, 'remote', 'add', 'origin', origin)
    await mkdir(path.join(seed, 'stories'))
    await writeFile(path.join(seed, 'stories', 'ST-1-on-main.md'), 'The unit on main.\n')
    git(seed, 'add', '.')
    git(seed, 'commit', '-q', '-m', 'base')
    git(seed, 'push', '-q', 'origin', 'main')
    git(seed, 'checkout', '-q', '-b', 'feature')
    await writeFile(path.join(seed, 'stories', 'ST-2-head-only.md'), 'Only at the head.\n')
    await writeFile(path.join(seed, 'stories', 'ST-1-on-main.md'), 'Edited at the head.\n')
    git(seed, 'add', '.')
    git(seed, 'commit', '-q', '-m', 'the pull request')
    git(seed, 'push', '-q', 'origin', 'feature')
    git(tmp, 'clone', '-q', origin, repoDir)
    git(repoDir, 'fetch', '-q', 'origin', 'feature')
    git(repoDir, 'checkout', '-q', 'feature')
  }, GIT_TIMEOUT)

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  }, GIT_TIMEOUT)

  const file = (target) => ({ kind: 'link', type: 'file', target })

  // A fetch standing in for GitHub: answers by issue number.
  function issueCtx(issues) {
    const calls = []
    const fetch = async (url, init) => {
      calls.push({ url, method: init.method })
      const number = Number(url.split('/').pop())
      const json = issues[number]
      if (json === undefined) return { ok: false, status: 404, text: async () => 'Not Found' }
      return { ok: true, status: 200, json: async () => json }
    }
    return { ctx: createContext({ repo: REPO, fetch, getToken: async () => 't' }), calls }
  }

  it('ST-19/AC-3: reads a file as it stands on main, never the head', async () => {
    const read = await readUnit(file('stories/ST-1-on-main.md'), { repoDir, base: 'main' })
    expect(read).toEqual({ read: true, text: 'The unit on main.\n' })
  })

  it('ST-19/AC-3: a file present at the head but not on main is unreadable, with the reason', async () => {
    const read = await readUnit(file('stories/ST-2-head-only.md'), { repoDir, base: 'main' })
    expect(read.read).toBe(false)
    expect(read.reason).toContain('stories/ST-2-head-only.md')
    expect(read.reason).toContain('origin/main')
    expect(
      await readUnit(file('stories/ST-2-head-only.md'), { repoDir, base: 'feature' }),
    ).toEqual({ read: true, text: 'Only at the head.\n' })
  })

  it('ST-19/AC-3: an absolute path, a .. segment, and a directory are unreadable, with the reason', async () => {
    for (const target of ['/etc/passwd', '\\x', 'C:/x', '../x', 'stories/../../x', 'a\\..\\b']) {
      const read = await readUnit(file(target), { repoDir, base: 'main' })
      expect(read.read).toBe(false)
      expect(read.reason).toContain('relative')
    }
    const dir = await readUnit(file('stories'), { repoDir, base: 'main' })
    expect(dir).toMatchObject({ read: false })
    expect(dir.reason).toContain('not a file')
  })

  it('ST-19/AC-3: reads an issue of this repository as its title and body', async () => {
    const { ctx, calls } = issueCtx({ 12: { number: 12, title: 'The title', body: 'The body.' } })
    const read = await readUnit(
      { kind: 'link', type: 'issue', target: 12 },
      { repoDir, base: 'main', ctx },
    )
    expect(read).toEqual({ read: true, text: 'The title\n\nThe body.' })
    expect(calls).toEqual([{ url: `https://api.github.com/repos/${REPO}/issues/12`, method: 'GET' }])
  })

  it('ST-19/AC-3: a number that is a pull request, or does not exist, is unreadable, with the reason', async () => {
    const { ctx } = issueCtx({
      5: { number: 5, title: 'A PR', body: 'b', pull_request: { url: 'x' } },
    })
    const link = (target) => ({ kind: 'link', type: 'issue', target })
    const pr = await readUnit(link(5), { repoDir, base: 'main', ctx })
    expect(pr.read).toBe(false)
    expect(pr.reason).toContain('pull request')
    const missing = await readUnit(link(99), { repoDir, base: 'main', ctx })
    expect(missing.read).toBe(false)
    expect(missing.reason).toContain('404')
  })

  it('ST-19/AC-3: an other link is not read: its text is returned as given', async () => {
    const link = { kind: 'link', type: 'other', target: 'https://example.com/t/1' }
    expect(await readUnit(link, { repoDir, base: 'main' })).toEqual({
      read: true,
      text: 'https://example.com/t/1',
    })
  })

  it('ST-19/AC-3: a link of a kind unitLinks does not include is not read', async () => {
    const link = { ...file('stories/ST-1-on-main.md'), unread: true }
    const read = await readUnit(link, { repoDir, base: 'main' })
    expect(read.read).toBe(false)
    expect(read.reason).toContain('unitLinks')
  })

  it('ST-19/AC-3: never throws for an unreadable link', async () => {
    const { ctx } = issueCtx({})
    await expect(
      readUnit({ kind: 'link', type: 'issue', target: 1 }, { repoDir: tmp, base: 'main', ctx }),
    ).resolves.toMatchObject({ read: false })
    await expect(
      readUnit(file('stories/ST-1-on-main.md'), { repoDir: path.join(tmp, 'nowhere'), base: 'main' }),
    ).resolves.toMatchObject({ read: false })
    await expect(
      readUnit({ kind: 'link', type: 'issue', target: 1 }, { repoDir, base: 'main' }),
    ).resolves.toMatchObject({ read: false })
    await expect(readUnit(undefined, { repoDir, base: 'main' })).resolves.toMatchObject({
      read: false,
    })
  })
})

describe('ST-19/AC-5: describeUnit', () => {
  const issue = { kind: 'link', type: 'issue', target: 12 }

  it('ST-19/AC-5: a link it read, with what it read', () => {
    expect(describeUnit(issue, { read: true, text: 'T\n\nB' })).toBe(
      'Unit: the pull request body links its unit as issue #12. It is read as it stands on main, and follows:\n\nT\n\nB',
    )
    expect(
      describeUnit(
        { kind: 'link', type: 'other', target: 'https://x/1' },
        { read: true, text: 'https://x/1' },
      ),
    ).toBe(
      'Unit: the pull request body links its unit as other https://x/1, which is not read. Its text as given:\n\nhttps://x/1',
    )
  })

  it('ST-19/AC-5: a link it could not read, and why', () => {
    expect(describeUnit(issue, { read: false, reason: '#12 is a pull request, not an issue' })).toBe(
      'Unit: the pull request body links its unit as issue #12. It could not be read: #12 is a pull request, not an issue.',
    )
  })

  it('ST-19/AC-5: Unit: none', () => {
    expect(describeUnit({ kind: 'none' })).toBe(
      'Unit: none. The pull request body states that it implements no unit.',
    )
  })

  it('ST-19/AC-5: no Unit: line at all', () => {
    expect(describeUnit({ kind: 'missing' })).toBe('Unit: the pull request body has no Unit: line.')
    expect(describeUnit({ kind: 'missing', unread: ['a.md'] })).toContain('not read: a.md.')
  })

  it('ST-19/AC-5: several is described as such, listing the links, none read', () => {
    expect(
      describeUnit({ kind: 'several', links: [issue, { type: 'file', target: 'a.md' }] }),
    ).toBe(
      'Unit: the pull request body links several units. None was read:\n- issue #12\n- file a.md',
    )
  })
})
