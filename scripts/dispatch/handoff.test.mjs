// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fixtureSettings } from './settings-fixture.mjs'
import { handoffsPath, isSafeRelativePath, main as handoff } from './handoff.mjs'
import { main as project, projectsPath } from './project.mjs'

const REPO = 'acme/widgets'
const OTHER = 'acme/gadgets'

// Each activation clones a real repository.
vi.setConfig({ testTimeout: 60_000 })

// Every test runs in a temporary home and in temporary repositories whose `origin` is a local bare
// repository, with a stand-in for GitHub that answers an Issue from a table: the real `~/.steward/`
// is never read or written, no model starts, and nothing reaches GitHub. Git reads a global config
// of the tests' own.
let base
const GIT_ENV = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']
const savedEnv = {}
beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 'steward-handoff-'))
  for (const name of GIT_ENV) savedEnv[name] = process.env[name]
  const globalConfig = path.join(base, 'gitconfig')
  writeFileSync(globalConfig, '[user]\n\tname = Crew\n\temail = crew@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = globalConfig
  process.env.GIT_CONFIG_NOSYSTEM = '1'
})
afterAll(() => {
  for (const name of GIT_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedEnv[name]
  }
  rmSync(base, { recursive: true, force: true })
})

let counter = 0
const fresh = (name) => {
  const dir = path.join(base, `${name}-${++counter}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

const put = (dir, files) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), text)
  }
}

const BARES = new Map()
const urlOf = (repo) => `https://github.com/${repo}.git`

/** A checkout of `repo` with steward installed on `main` and `files` beside, pushed to a bare origin. */
function makeRepo(repo, { unitLinks = ['file', 'issue'], files = {} } = {}) {
  const dir = fresh('repo')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'remote', 'add', 'origin', urlOf(repo))
  put(dir, {
    'steward.config.json': `${JSON.stringify(fixtureSettings({ repo, unitLinks }), null, 2)}\n`,
    'REVIEW.md': '# Checklist\n\n## Every pull request\n\n1. The diff matches its description.\n',
    '.github/workflows/review-gate.yml': 'name: review-gate\n',
    ...files,
  })
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'start')
  const bare = fresh('origin')
  git(bare, 'init', '-q', '--bare', '-b', 'main')
  git(dir, 'push', '-q', bare, 'main')
  BARES.set(urlOf(repo), bare)
  return dir
}

/** Commits `files` (a null text deletes the file) to `origin`'s `main` and returns the new commit. */
function commitOnMain(repo, files) {
  const scratch = fresh('scratch')
  git(scratch, 'clone', '-q', BARES.get(urlOf(repo)), '.')
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) rmSync(path.join(scratch, rel))
    else put(scratch, { [rel]: text })
  }
  git(scratch, 'add', '-A')
  git(scratch, 'commit', '-q', '-m', 'more')
  git(scratch, 'push', '-q', 'origin', 'main')
  return git(scratch, 'rev-parse', 'HEAD')
}

const mainSha = (repo) => git(BARES.get(urlOf(repo)), 'rev-parse', 'refs/heads/main')

/** A home with each of `repos` activated. */
async function homeWith(repos = [[REPO, {}]]) {
  const home = fresh('home')
  for (const [repo, options] of repos) {
    const dir = makeRepo(repo, options)
    const code = await project(['activate', dir], { cwd: base, homedir: home, cloneUrl: (url) => BARES.get(url), out: () => {}, err: () => {} })
    expect(code).toBe(0)
  }
  return home
}

/** The Issues the GitHub stand-in knows, by repository and number, and every request it was sent. */
const issues = new Map()
const requests = []
const setIssue = (repo, number, fields) => issues.set(`${repo}#${number}`, fields)
const stubContext = ({ repo }) => ({
  repo,
  async send(request) {
    requests.push(request)
    const n = Number(/\/issues\/(\d+)$/.exec(request.url)?.[1])
    const found = issues.get(`${repo}#${n}`)
    if (request.method !== 'GET' || found === undefined) throw new Error(`${request.method} ${request.url} failed: 404 Not Found`)
    return found
  },
})
const issueJson = (number, title, body, { pr = false } = {}) => ({ number, title, body, ...(pr ? { pull_request: {} } : {}) })

let clock = 0
/** Runs `steward handoff <args>`; resolves `{ code, out, err }`. */
async function run(args, home, extra = {}) {
  const out = []
  const err = []
  const code = await handoff(args, {
    homedir: home,
    now: () => new Date(Date.UTC(2026, 10, 10, 12, 0, ++clock)),
    createContext: stubContext,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...extra,
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

const records = (home) => JSON.parse(readFileSync(handoffsPath(home), 'utf8'))
const bytes = (home) => readFileSync(handoffsPath(home), 'utf8')
const edit = (home, change) => {
  const data = records(home)
  change(data)
  writeFileSync(handoffsPath(home), `${JSON.stringify(data, null, 2)}\n`)
}
const setStatus = (home, id, status) => edit(home, (d) => { d.handoffs.find((h) => h.id === id).status = status })

describe('ST-89/AC-1: add approves one file or Issue of an activated project', () => {
  it('ST-89/AC-1: a file on main that is no story is approved, and nothing in the project changes', async () => {
    const home = await homeWith([[REPO, { files: { 'docs/plan.md': 'Just prose, no story schema.\n' } }]])
    const result = await run(['add', '--repo', REPO, '--file', 'docs/plan.md'], home)
    expect(result.err).toBe('')
    expect(result.code).toBe(0)
    expect(result.out).toContain('Approved H-1')
    expect(records(home).handoffs.map((h) => [h.id, h.status, h.text])).toEqual([['H-1', 'pending', 'Just prose, no story schema.\n']])
    expect(requests).toEqual([])
  })

  it('ST-89/AC-1: an Issue is approved', async () => {
    const home = await homeWith()
    setIssue(REPO, 7, issueJson(7, 'Add a thing', 'Do it.\n'))
    const result = await run(['add', '--repo', REPO, '--issue', '7'], home)
    expect(result.err).toBe('')
    expect(result.code).toBe(0)
    expect(records(home).handoffs[0]).toMatchObject({ id: 'H-1', source: { kind: 'issue', number: 7 }, text: 'Add a thing\n\nDo it.' })
    expect(requests.every((r) => r.method === 'GET')).toBe(true)
  })

  it('ST-89/AC-1: a repository that is not activated is refused and records nothing', async () => {
    const home = await homeWith()
    makeRepo(OTHER)
    const result = await run(['add', '--repo', OTHER, '--file', 'REVIEW.md'], home)
    expect(result.code).toBe(1)
    expect(result.err).toContain(`${OTHER} is not activated`)
    expect(existsSync(handoffsPath(home))).toBe(false)
  })

  it('ST-89/AC-1: a project with no activations at all is refused', async () => {
    const result = await run(['add', '--repo', REPO, '--file', 'REVIEW.md'], fresh('home'))
    expect(result.code).toBe(1)
    expect(result.err).toContain('is not activated')
  })

  it.each([
    ['file', ['issue'], ['--file', 'REVIEW.md']],
    ['issue', ['file'], ['--issue', '3']],
    ['file', [], ['--file', 'REVIEW.md']],
  ])('ST-89/AC-1: a %s is refused when unitLinks is %j', async (kind, unitLinks, flags) => {
    const home = await homeWith([[REPO, { unitLinks }]])
    setIssue(REPO, 3, issueJson(3, 'T', 'B'))
    const result = await run(['add', '--repo', REPO, ...flags], home)
    expect(result.code).toBe(1)
    expect(result.err).toContain(`does not include "${kind}"`)
    expect(existsSync(handoffsPath(home))).toBe(false)
  })

  it.each(['../secret', '/etc/passwd', 'C:/x', 'a\\b', 'a//b', './a', 'a/./b', 'a/..', '', 'a/b/', 'a\nb'])('ST-89/AC-1: the unsafe path %j is refused', async (bad) => {
    const home = await homeWith()
    const result = await run(['add', '--repo', REPO, '--file', bad], home)
    expect(result.code).toBe(1)
    expect(result.err).toContain('Not approved')
    expect(existsSync(handoffsPath(home))).toBe(false)
    expect(isSafeRelativePath(bad)).toBe(false)
  })

  it('ST-89/AC-1: a file that is not on origin main, or is a folder there, is refused', async () => {
    const home = await homeWith()
    const missing = await run(['add', '--repo', REPO, '--file', 'docs/none.md'], home)
    expect(missing.code).toBe(1)
    expect(missing.err).toContain('cannot be read from origin/main')
    const folder = await run(['add', '--repo', REPO, '--file', '.github'], home)
    expect(folder.code).toBe(1)
    expect(folder.err).toContain('is not a file on origin/main')
    expect(existsSync(handoffsPath(home))).toBe(false)
  })

  it('ST-89/AC-1: a file only on a feature branch is not read', async () => {
    const home = await homeWith()
    const scratch = fresh('scratch')
    git(scratch, 'clone', '-q', BARES.get(urlOf(REPO)), '.')
    git(scratch, 'checkout', '-q', '-b', 'feature')
    put(scratch, { 'branch-only.md': 'x\n' })
    git(scratch, 'add', '-A')
    git(scratch, 'commit', '-q', '-m', 'branch')
    git(scratch, 'push', '-q', 'origin', 'feature')
    const result = await run(['add', '--repo', REPO, '--file', 'branch-only.md'], home)
    expect(result.code).toBe(1)
    expect(existsSync(handoffsPath(home))).toBe(false)
  })

  it('ST-89/AC-1: a missing Issue, and a pull request given as an Issue, are refused', async () => {
    const home = await homeWith()
    setIssue(REPO, 9, issueJson(9, 'A pull request', 'x', { pr: true }))
    const missing = await run(['add', '--repo', REPO, '--issue', '8'], home)
    expect(missing.code).toBe(1)
    expect(missing.err).toContain('Issue #8 cannot be read')
    const pr = await run(['add', '--repo', REPO, '--issue', '9'], home)
    expect(pr.code).toBe(1)
    expect(pr.err).toContain('#9 is a pull request, not an Issue')
    expect(existsSync(handoffsPath(home))).toBe(false)
  })

  it.each([
    [['add']],
    [['add', '--repo', REPO]],
    [['add', '--repo', REPO, '--file', 'REVIEW.md', '--issue', '3']],
    [['add', '--repo', REPO, '--file']],
    [['add', '--repo', REPO, '--file', 'a', '--file', 'b']],
    [['add', '--file', 'REVIEW.md']],
    [['approve']],
    [['list', 'extra']],
    [['show']],
  ])('ST-89/AC-1: the command line %j is refused with the usage and exit code 2', async (args) => {
    const result = await run(args, await homeWith())
    expect(result.code).toBe(2)
    expect(result.err).toContain('usage: steward handoff add')
  })

  it.each(['notarepo', '0', '-3', '1.5', '12abc', '99999999999999999999'])('ST-89/AC-1: --repo or --issue value %j that is not one is refused', async (bad) => {
    const home = await homeWith()
    const asRepo = await run(['add', '--repo', bad, '--file', 'REVIEW.md'], home)
    const asIssue = await run(['add', '--repo', REPO, '--issue', bad], home)
    expect(asRepo.code).toBe(1)
    expect(asIssue.code).toBe(1)
    expect(existsSync(handoffsPath(home))).toBe(false)
  })
})

describe('ST-89/AC-2: what an approval stores', () => {
  it('ST-89/AC-2: a file keeps its exact text, original path, repository, full main commit and time', async () => {
    const text = '  Spaces first\r\n\r\nand trailing lines\n\n'
    const home = await homeWith([[REPO, { files: { 'notes/Plan v2.md': text } }]])
    const sha = mainSha(REPO)
    // main moves on after the approval; the approval keeps the commit it was read at.
    const result = await run(['add', '--repo', REPO, '--file', 'notes/Plan v2.md'], home)
    expect(result.code).toBe(0)
    commitOnMain(REPO, { 'other.md': 'unrelated\n' })
    expect(records(home)).toEqual({
      nextOrder: 2,
      handoffs: [{
        id: 'H-1',
        order: 1,
        repo: REPO,
        source: { kind: 'file', path: 'notes/Plan v2.md' },
        status: 'pending',
        version: 1,
        approvedAt: expect.stringMatching(/^2026-11-10T12:00:\d\d\.000Z$/),
        text,
        provenance: { commit: sha },
        history: [],
      }],
    })
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('ST-89/AC-2: an Issue keeps its number, title, body and a fingerprint of its text', async () => {
    const home = await homeWith()
    setIssue(REPO, 12, issueJson(12, 'Title here', 'Body\nlines\n'))
    expect((await run(['add', '--repo', REPO, '--issue', '12'], home)).code).toBe(0)
    const [h] = records(home).handoffs
    expect(h.source).toEqual({ kind: 'issue', number: 12 })
    expect(h.text).toBe('Title here\n\nBody\nlines')
    expect(h.provenance).toEqual({ number: 12, title: 'Title here', body: 'Body\nlines\n', fingerprint: sha256('Title here\n\nBody\nlines') })
  })

  it('ST-89/AC-2: the approval order is one strict sequence across projects, and survives a withdrawal', async () => {
    const home = await homeWith([[REPO, { files: { 'a.md': 'a\n' } }], [OTHER, { files: { 'b.md': 'b\n' } }]])
    setIssue(OTHER, 4, issueJson(4, 'T', 'B'))
    expect((await run(['add', '--repo', REPO, '--file', 'a.md'], home)).code).toBe(0)
    expect((await run(['add', '--repo', OTHER, '--file', 'b.md'], home)).code).toBe(0)
    expect((await run(['withdraw', 'H-2'], home)).code).toBe(0)
    expect((await run(['add', '--repo', OTHER, '--issue', '4'], home)).code).toBe(0)
    const data = records(home)
    expect(data.handoffs.map((h) => [h.id, h.order, h.repo, h.status])).toEqual([
      ['H-1', 1, REPO, 'pending'],
      ['H-2', 2, OTHER, 'withdrawn'],
      ['H-3', 3, OTHER, 'pending'],
    ])
    expect(data.nextOrder).toBe(4)
  })

  it('ST-89/AC-2: the approvals are not kept in the project, config.json or projects.json', async () => {
    const home = await homeWith([[REPO, { files: { 'a.md': 'a\n' } }]])
    const projectsBefore = readFileSync(projectsPath(home), 'utf8')
    const owned = path.join(path.dirname(projectsPath(home)), 'checkouts', 'acme', 'widgets')
    const before = git(owned, 'status', '--porcelain')
    await run(['add', '--repo', REPO, '--file', 'a.md'], home)
    expect(handoffsPath(home)).toBe(path.join(home, '.steward', 'state', 'handoffs.json'))
    expect(readFileSync(projectsPath(home), 'utf8')).toBe(projectsBefore)
    expect(existsSync(path.join(home, '.steward', 'config.json'))).toBe(false)
    expect(git(owned, 'status', '--porcelain')).toBe(before)
    expect(readdirSync(path.join(home, '.steward', 'state')).sort()).toEqual(['checkouts', 'handoffs.json', 'projects.json'])
  })
})

describe('ST-89/AC-3: list and show read the records in a fresh process', () => {
  it('ST-89/AC-3: list and show give the complete text, version and source, start nothing and call no GitHub', async () => {
    const home = await homeWith([[REPO, { files: { 'a.md': 'first line\nsecond line\n' } }]])
    setIssue(REPO, 5, issueJson(5, 'Issue title', 'Issue body'))
    await run(['add', '--repo', REPO, '--file', 'a.md'], home)
    await run(['add', '--repo', REPO, '--issue', '5'], home)
    const sha = mainSha(REPO)
    requests.length = 0
    const contexts = vi.fn(stubContext)
    const before = bytes(home)

    const list = await run(['list'], home, { createContext: contexts })
    expect(list.code).toBe(0)
    expect(list.out).toContain(`H-1  pending  v1  ${REPO}  file a.md`)
    expect(list.out).toContain(`H-2  pending  v1  ${REPO}  Issue #5`)
    const showFile = await run(['show', 'H-1'], home, { createContext: contexts })
    expect(showFile.code).toBe(0)
    expect(showFile.out).toContain('first line\nsecond line\n')
    expect(showFile.out).toContain(`main ${sha}`)
    expect(showFile.out).toContain('version:   1')
    const showIssue = await run(['show', 'H-2'], home, { createContext: contexts })
    expect(showIssue.out).toContain('Issue title\n\nIssue body')
    expect(showIssue.out).toContain(`fingerprint ${sha256('Issue title\n\nIssue body')}`)
    expect(contexts).not.toHaveBeenCalled()
    expect(requests).toEqual([])
    expect(bytes(home)).toBe(before)
  })

  it('ST-89/AC-3: list says so when nothing is approved, and writes no file', async () => {
    const home = fresh('home')
    const result = await run(['list'], home)
    expect(result.code).toBe(0)
    expect(result.out).toContain('No handoff is approved')
    expect(existsSync(handoffsPath(home))).toBe(false)
  })

  it('ST-89/AC-3: show of an unknown ID explains and lists the known ones', async () => {
    const home = await homeWith([[REPO, { files: { 'a.md': 'a\n' } }]])
    await run(['add', '--repo', REPO, '--file', 'a.md'], home)
    const result = await run(['show', 'H-9'], home)
    expect(result.code).toBe(1)
    expect(result.err).toContain('H-9 is not a handoff')
    expect(result.err).toContain('The approved ones are H-1')
  })
})

describe('ST-89/AC-4: repeating add, and reapproval', () => {
  const setup = async () => {
    const home = await homeWith([[REPO, { files: { 'a.md': 'one\n', 'b.md': 'bee\n' } }]])
    expect((await run(['add', '--repo', REPO, '--file', 'a.md'], home)).code).toBe(0)
    return home
  }

  it('ST-89/AC-4: add again at the same text reports the existing handoff and changes nothing', async () => {
    const home = await setup()
    const before = bytes(home)
    const again = await run(['add', '--repo', REPO, '--file', 'a.md'], home)
    expect(again.code).toBe(0)
    expect(again.out).toContain('H-1 already approves this file a.md')
    expect(bytes(home)).toBe(before)
  })

  it('ST-89/AC-4: add again for a held handoff at the same text reports it too', async () => {
    const home = await setup()
    setStatus(home, 'H-1', 'held')
    const again = await run(['add', '--repo', REPO, '--file', 'a.md'], home)
    expect(again.code).toBe(0)
    expect(again.out).toContain('(held, version 1)')
    expect(records(home).handoffs).toHaveLength(1)
  })

  it('ST-89/AC-4: add again after the text changed is refused and points to reapprove', async () => {
    const home = await setup()
    commitOnMain(REPO, { 'a.md': 'two\n' })
    const before = bytes(home)
    const again = await run(['add', '--repo', REPO, '--file', 'a.md'], home)
    expect(again.code).toBe(1)
    expect(again.err).toContain('`steward handoff reapprove H-1`')
    expect(bytes(home)).toBe(before)
  })

  it('ST-89/AC-4: reapprove reads the source again, keeps the ID and the place in order, and appends the old version', async () => {
    const home = await setup()
    expect((await run(['add', '--repo', REPO, '--file', 'b.md'], home)).code).toBe(0)
    const first = records(home).handoffs[0]
    const newCommit = commitOnMain(REPO, { 'a.md': 'two\n' })
    const result = await run(['reapprove', 'H-1'], home)
    expect(result.err).toBe('')
    expect(result.code).toBe(0)
    const data = records(home)
    expect(data.handoffs.map((h) => [h.id, h.order, h.version, h.status])).toEqual([['H-1', 1, 2, 'pending'], ['H-2', 2, 1, 'pending']])
    expect(data.handoffs[0]).toMatchObject({ text: 'two\n', provenance: { commit: newCommit } })
    expect(data.handoffs[0].history).toEqual([{ version: 1, approvedAt: first.approvedAt, text: 'one\n', provenance: first.provenance }])
    expect(data.nextOrder).toBe(3)
    // A third version stacks onto the history.
    commitOnMain(REPO, { 'a.md': 'three\n' })
    expect((await run(['reapprove', 'H-1'], home)).code).toBe(0)
    expect(records(home).handoffs[0].history.map((e) => [e.version, e.text])).toEqual([[1, 'one\n'], [2, 'two\n']])
  })

  it('ST-89/AC-4: reapprove of a pending handoff whose text is unchanged changes nothing', async () => {
    const home = await setup()
    commitOnMain(REPO, { 'unrelated.md': 'x\n' })
    const before = bytes(home)
    const result = await run(['reapprove', 'H-1'], home)
    expect(result.code).toBe(0)
    expect(result.out).toContain('still has the approved text')
    expect(bytes(home)).toBe(before)
  })

  it('ST-89/AC-4: reapprove of a held handoff returns it to pending', async () => {
    const home = await setup()
    setStatus(home, 'H-1', 'held')
    commitOnMain(REPO, { 'a.md': 'two\n' })
    expect((await run(['reapprove', 'H-1'], home)).code).toBe(0)
    expect(records(home).handoffs[0]).toMatchObject({ status: 'pending', version: 2, text: 'two\n' })
  })

  it('ST-89/AC-4: an Issue is reapproved from its new title and body', async () => {
    const home = await homeWith()
    setIssue(REPO, 5, issueJson(5, 'Old', 'old body'))
    await run(['add', '--repo', REPO, '--issue', '5'], home)
    setIssue(REPO, 5, issueJson(5, 'New', 'new body'))
    expect((await run(['reapprove', 'H-1'], home)).code).toBe(0)
    const [h] = records(home).handoffs
    expect(h).toMatchObject({ version: 2, text: 'New\n\nnew body', provenance: { title: 'New', body: 'new body' } })
    expect(h.history[0]).toMatchObject({ version: 1, text: 'Old\n\nold body', provenance: { title: 'Old' } })
  })

  it.each(['admitted', 'completed', 'withdrawn'])('ST-89/AC-4: reapprove of a %s handoff is refused and changes nothing', async (status) => {
    const home = await setup()
    setStatus(home, 'H-1', status)
    commitOnMain(REPO, { 'a.md': 'two\n' })
    const before = bytes(home)
    const result = await run(['reapprove', 'H-1'], home)
    expect(result.code).toBe(1)
    expect(result.err).toContain(`H-1 is ${status} and is not reapproved`)
    expect(bytes(home)).toBe(before)
  })

  it.each(['admitted', 'completed'])('ST-89/AC-4: add of a source whose handoff is %s is refused', async (status) => {
    const home = await setup()
    setStatus(home, 'H-1', status)
    const before = bytes(home)
    const result = await run(['add', '--repo', REPO, '--file', 'a.md'], home)
    expect(result.code).toBe(1)
    expect(result.err).toContain(`already ${status} as H-1`)
    expect(bytes(home)).toBe(before)
  })

  it('ST-89/AC-4: reapprove with a source that can no longer be read is refused and changes nothing', async () => {
    const home = await setup()
    commitOnMain(REPO, { 'a.md': null })
    const before = bytes(home)
    const result = await run(['reapprove', 'H-1'], home)
    expect(result.code).toBe(1)
    expect(result.err).toContain('Not reapproved')
    expect(bytes(home)).toBe(before)
  })

  it('ST-89/AC-4: reapprove of an unknown ID explains', async () => {
    const result = await run(['reapprove', 'H-4'], await setup())
    expect(result.code).toBe(1)
    expect(result.err).toContain('H-4 is not a handoff')
  })
})

describe('ST-89/AC-5: withdraw', () => {
  const setup = async () => {
    const home = await homeWith([[REPO, { files: { 'a.md': 'one\n' } }]])
    await run(['add', '--repo', REPO, '--file', 'a.md'], home)
    commitOnMain(REPO, { 'a.md': 'two\n' })
    await run(['reapprove', 'H-1'], home)
    return home
  }

  it.each(['pending', 'held'])('ST-89/AC-5: a %s handoff is withdrawn and keeps its text and history', async (status) => {
    const home = await setup()
    setStatus(home, 'H-1', status)
    const before = records(home).handoffs[0]
    const result = await run(['withdraw', 'H-1'], home)
    expect(result.code).toBe(0)
    expect(records(home).handoffs[0]).toEqual({ ...before, status: 'withdrawn' })
    expect(records(home).handoffs[0].history).toHaveLength(1)
  })

  it('ST-89/AC-5: withdrawing again says so and changes nothing; a withdrawn handoff cannot be reapproved, and can be added anew', async () => {
    const home = await setup()
    await run(['withdraw', 'H-1'], home)
    const before = bytes(home)
    const again = await run(['withdraw', 'H-1'], home)
    expect(again.code).toBe(0)
    expect(again.out).toContain('already withdrawn')
    expect(bytes(home)).toBe(before)
    expect((await run(['reapprove', 'H-1'], home)).code).toBe(1)
    expect((await run(['add', '--repo', REPO, '--file', 'a.md'], home)).code).toBe(0)
    expect(records(home).handoffs.map((h) => [h.id, h.status])).toEqual([['H-1', 'withdrawn'], ['H-2', 'pending']])
  })

  it.each(['admitted', 'completed'])('ST-89/AC-5: a %s handoff is not withdrawn', async (status) => {
    const home = await setup()
    setStatus(home, 'H-1', status)
    const before = bytes(home)
    const result = await run(['withdraw', 'H-1'], home)
    expect(result.code).toBe(1)
    expect(result.err).toContain(`H-1 is ${status}`)
    expect(result.err).toContain('cannot cancel or withdraw it')
    expect(bytes(home)).toBe(before)
  })

  it('ST-89/AC-5: an unknown ID fails with an explanation, whether or not any handoff exists', async () => {
    const none = await run(['withdraw', 'H-1'], fresh('home'))
    expect(none.code).toBe(1)
    expect(none.err).toContain('H-1 is not a handoff. None is approved yet.')
    const home = await setup()
    const some = await run(['withdraw', 'nonsense'], home)
    expect(some.code).toBe(1)
    expect(some.err).toContain('nonsense is not a handoff. The approved ones are H-1.')
  })
})

describe('ST-89/AC-6: a failed write, and records that cannot be trusted', () => {
  it('ST-89/AC-6: a failed write of add, reapprove and withdraw leaves the previous file as it was', async () => {
    const home = await homeWith([[REPO, { files: { 'a.md': 'one\n', 'b.md': 'bee\n' } }]])
    await run(['add', '--repo', REPO, '--file', 'a.md'], home)
    commitOnMain(REPO, { 'a.md': 'two\n' })
    const before = bytes(home)
    // The temporary file's name is a folder, so writing it fails before the rename.
    mkdirSync(`${handoffsPath(home)}.tmp`)
    for (const args of [['add', '--repo', REPO, '--file', 'b.md'], ['reapprove', 'H-1'], ['withdraw', 'H-1']]) {
      const result = await run(args, home)
      expect(result.code).toBe(1)
      expect(result.err).not.toBe('')
      expect(bytes(home)).toBe(before)
    }
    rmSync(`${handoffsPath(home)}.tmp`, { recursive: true })
    expect((await run(['reapprove', 'H-1'], home)).code).toBe(0)
  })

  it('ST-89/AC-6: a failed first write leaves no records file', async () => {
    const home = await homeWith([[REPO, { files: { 'a.md': 'one\n' } }]])
    mkdirSync(`${handoffsPath(home)}.tmp`)
    expect((await run(['add', '--repo', REPO, '--file', 'a.md'], home)).code).toBe(1)
    expect(existsSync(handoffsPath(home))).toBe(false)
  })

  const MUTATIONS = {
    'not JSON': (home) => writeFileSync(handoffsPath(home), '{ "handoffs": ['),
    'a different top-level shape': (home) => writeFileSync(handoffsPath(home), '[]'),
    'an extra top-level key': (home) => edit(home, (d) => { d.extra = 1 }),
    'a nextOrder that is not a number': (home) => edit(home, (d) => { d.nextOrder = '3' }),
    'a nextOrder not above the last order': (home) => edit(home, (d) => { d.nextOrder = 2 }),
    'an ID that is not its order': (home) => edit(home, (d) => { d.handoffs[1].id = 'H-7' }),
    'orders that do not rise': (home) => edit(home, (d) => { d.handoffs.reverse() }),
    'a missing key': (home) => edit(home, (d) => { delete d.handoffs[0].approvedAt }),
    'an extra key': (home) => edit(home, (d) => { d.handoffs[0].admit = true }),
    'an unknown status': (home) => edit(home, (d) => { d.handoffs[0].status = 'approved' }),
    'a repo that is not owner/name': (home) => edit(home, (d) => { d.handoffs[0].repo = 'widgets' }),
    'an unsafe file path': (home) => edit(home, (d) => { d.handoffs[0].source.path = '../x' }),
    'an Issue number of zero': (home) => edit(home, (d) => { d.handoffs[1].source.number = 0 }),
    'an unknown source kind': (home) => edit(home, (d) => { d.handoffs[0].source.kind = 'url' }),
    'a version without its history': (home) => edit(home, (d) => { d.handoffs[0].version = 2 }),
    'a history without its version': (home) => edit(home, (d) => { d.handoffs[0].history.push({ version: 1, approvedAt: d.handoffs[0].approvedAt, text: 'x', provenance: d.handoffs[0].provenance }) }),
    'a history entry of the wrong version': (home) => edit(home, (d) => { d.handoffs[0].version = 2; d.handoffs[0].history = [{ version: 5, approvedAt: d.handoffs[0].approvedAt, text: 'x', provenance: d.handoffs[0].provenance }] }),
    'a commit that is not a full SHA': (home) => edit(home, (d) => { d.handoffs[0].provenance.commit = d.handoffs[0].provenance.commit.slice(0, 7) }),
    'an Issue fingerprint that does not match its text': (home) => edit(home, (d) => { d.handoffs[1].provenance.fingerprint = 'abc' }),
    'an Issue text that does not match its title and body': (home) => edit(home, (d) => { d.handoffs[1].text = 'other' }),
    'a time that is not a date': (home) => edit(home, (d) => { d.handoffs[0].approvedAt = 'yesterday' }),
    'two open approvals of one source': (home) => edit(home, (d) => {
      d.handoffs.push({ ...structuredClone(d.handoffs[0]), id: 'H-3', order: 3 })
      d.nextOrder = 4
    }),
  }

  it.each(Object.keys(MUTATIONS))('ST-89/AC-6: records with %s refuse every command and are not changed', async (name) => {
    const home = await homeWith([[REPO, { files: { 'a.md': 'one\n', 'b.md': 'bee\n' } }]])
    setIssue(REPO, 5, issueJson(5, 'T', 'B'))
    await run(['add', '--repo', REPO, '--file', 'a.md'], home)
    await run(['add', '--repo', REPO, '--issue', '5'], home)
    MUTATIONS[name](home)
    const before = bytes(home)
    for (const args of [['add', '--repo', REPO, '--file', 'b.md'], ['list'], ['show', 'H-1'], ['reapprove', 'H-1'], ['withdraw', 'H-1']]) {
      const result = await run(args, home)
      expect(result.code, args.join(' ')).toBe(1)
      expect(result.err).toContain('handoffs.json')
    }
    expect(bytes(home)).toBe(before)
  })

  it('ST-89/AC-6: a records path that cannot be read refuses every command it is given', async () => {
    const home = fresh('home')
    mkdirSync(handoffsPath(home), { recursive: true })
    const result = await run(['add', '--repo', REPO, '--file', 'REVIEW.md'], home)
    expect(result.code).toBe(1)
    expect((await run(['list'], home)).code).toBe(1)
  })

  it('ST-89/AC-6: records that pass validation are accepted, with a held approval and a history', async () => {
    const home = await homeWith([[REPO, { files: { 'a.md': 'one\n' } }]])
    await run(['add', '--repo', REPO, '--file', 'a.md'], home)
    commitOnMain(REPO, { 'a.md': 'two\n' })
    await run(['reapprove', 'H-1'], home)
    setStatus(home, 'H-1', 'held')
    expect((await run(['list'], home)).code).toBe(0)
    expect((await run(['show', 'H-1'], home)).out).toContain('earlier versions: v1')
  })
})
