// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { codeNextHandoff, admissionIsActive, interruptAdmissions } from './handoff-coding.mjs'
import { executeHandoff, handoffBranch } from './handoff-coder.mjs'
import { handoffRecord, readRaw, writeHandoffs } from './handoff-fixture.mjs'
import { coordinatorPath, main as coordinatorMain, runCoordinator, stopRequestPath } from './coordinator.mjs'
import { evidencePath, handoffsPath, main as handoff, readEvidence, readHandoffs, selectHandoff } from './handoff.mjs'
import { main as project, ownedCheckoutPath } from './project.mjs'
import { fixtureSettings, fixtureUserConfig } from './settings-fixture.mjs'

const REPO = 'acme/widgets'
const OTHER = 'acme/gadgets'

// Each activation clones a real repository.
vi.setConfig({ testTimeout: 60_000 })

// Every test runs in a temporary home and in temporary repositories whose `origin` is a local bare
// repository, with stand-ins for GitHub, for the coding run and for publication: the real
// `~/.steward/` is never read or written, no model starts, and nothing reaches GitHub. Git reads a
// global config of the tests' own.
let base
const GIT_ENV = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']
const savedEnv = {}
beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 'steward-coding-'))
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
const put = (dir, files) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), text)
  }
}

const BARES = new Map()
const urlOf = (repo) => `https://github.com/${repo}.git`

function makeRepo(repo, files = {}) {
  const dir = fresh('repo')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'remote', 'add', 'origin', urlOf(repo))
  put(dir, {
    'steward.config.json': `${JSON.stringify(fixtureSettings({ repo, unitLinks: ['file', 'issue'] }), null, 2)}\n`,
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

function commitOnMain(repo, files) {
  const scratch = fresh('scratch')
  git(scratch, 'clone', '-q', BARES.get(urlOf(repo)), '.')
  put(scratch, files)
  git(scratch, 'add', '-A')
  git(scratch, 'commit', '-q', '-m', 'more')
  git(scratch, 'push', '-q', 'origin', 'main')
}

/** A home with each project activated, and one file approved in each, in this order. */
async function homeWith(approvals) {
  const home = fresh('home')
  const repos = [...new Set(approvals.map(([repo]) => repo))]
  for (const repo of repos) {
    const files = Object.fromEntries(approvals.filter(([r]) => r === repo).map(([, file, text]) => [file, text]))
    const dir = makeRepo(repo, files)
    const code = await project(['activate', dir], { cwd: base, homedir: home, cloneUrl: (url) => BARES.get(url), out: () => {}, err: () => {} })
    expect(code).toBe(0)
  }
  for (const [repo, file] of approvals) expect((await run(['add', '--repo', repo, '--file', file], home)).code).toBe(0)
  return home
}

const stubContext = ({ repo }) => ({ repo, async send() { throw new Error('a stand-in context was sent a request') } })
let tick = 0
const now = () => new Date(Date.UTC(2026, 10, 10, 12, 0, ++tick))
async function run(args, home) {
  const out = []
  const err = []
  const code = await handoff(args, { homedir: home, now, createContext: stubContext, out: (l) => out.push(l), err: (l) => err.push(l) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

const HEAD = 'd'.repeat(40)
const records = (home) => readRaw(home)
const recordOf = (home, id) => records(home).find((h) => h.id === id)
const bytes = (home) => readFileSync(handoffsPath(home), 'utf8')
const pushedFor = (home, args, extra = {}) => ({
  status: 'pushed', repo: recordOf(home, args.handoffId).repo, handoffId: args.handoffId, version: args.version,
  branch: handoffBranch(recordOf(home, args.handoffId)), headSha: HEAD, pushed: true,
  proposedPr: { title: 'Do it', body: 'Done.', draft: false }, choice: { tool: 'claude', name: 'opus', model: 'claude-opus-4' }, ...extra,
})
const published = (number = 12) => ({ status: 'published', pr: { number, url: `https://github.com/acme/widgets/pull/${number}`, headSha: HEAD }, draft: false })
const refusal = (home, args, status, extra = {}) => ({ status, repo: recordOf(home, args.handoffId).repo, handoffId: args.handoffId, version: args.version, reason: `${status} stand-in`, ...extra })

/**
 * One coding turn for `home` with stand-ins: `execute` plays the coding run (by default it pushes),
 * `publish` plays publication (by default it opens pull request 12). `admitted` counts the work
 * the turn ran through `admit`.
 */
function turn(home, { execute, publish, admit, ...over } = {}) {
  const calls = { admitted: 0, ids: [] }
  const exec = vi.fn(execute ?? (async (args) => pushedFor(home, args)))
  const pub = vi.fn(publish ?? (async () => published()))
  const go = (over2 = {}) => codeNextHandoff({
    homedir: home, now, createContext: stubContext, newId: () => `adm-${++counter}`, execute: exec, publish: pub,
    admit: admit ?? ((job) => { calls.admitted += 1; Promise.resolve().then(job); return true }),
    ...over, ...over2,
  })
  return Object.assign(go, { exec, pub, calls })
}

const UNDER_LIMITS = { ok: true, session: { percent: 10, resetsAt: 't1' }, weekly: { percent: 10, resetsAt: 't2' } }
const REFUSE_UPDATE_HOOK = [
  '#!/bin/sh',
  'read old new ref',
  'if [ "$old" != "0000000000000000000000000000000000000000" ]; then',
  '  echo "refused by test hook" >&2',
  '  exit 1',
  'fi',
  'exit 0',
].join('\n')
/** A stand-in coder session: commits a file in its worktree and reports a pull request block. */
async function fakeSession({ cwd }) {
  writeFileSync(path.join(cwd, 'greeting.txt'), 'hello')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-q', '-m', 'implement')
  const report = 'Branch committed.\n\n## PR title\nAdd a greeting\n\n## PR body\n### What changed\n\nIt greets.\n\n## Open as\nready'
  const stdout = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: report })
  return { record: { role: 'coder', exitCode: 0, signal: null, stdout, stoppedFor: null }, pid: 1 }
}

const APPROVALS = [[OTHER, 'b.md', 'bravo\n'], [REPO, 'a.md', 'alpha\n'], [REPO, 'c.md', 'charlie\n']]

/** Blocks the next write of `handoffs.json`, as a full disk would: its temporary file cannot be made. */
const blockWrites = (home) => mkdirSync(`${handoffsPath(home)}.tmp`)
const unblockWrites = (home) => rmSync(`${handoffsPath(home)}.tmp`, { recursive: true, force: true })

describe('ST-93/AC-1: the oldest eligible handoff is admitted, one at a time, and awaited', () => {
  it('ST-93/AC-1: handoffs are coded in approval order across repositories, each turn waiting for its coding and its pull request', async () => {
    const home = await homeWith(APPROVALS)
    let open = 0
    let overlapped = false
    const order = []
    const t = turn(home, {
      execute: async (args) => {
        open += 1
        overlapped ||= open > 1
        order.push(args.handoffId)
        await new Promise((resolve) => setTimeout(resolve, 20))
        open -= 1
        return pushedFor(home, args)
      },
      publish: async () => { overlapped ||= open > 0; return published() },
    })
    expect(order).toEqual([])
    expect((await t()).status).toBe('completed')
    expect(recordOf(home, 'H-1')).toMatchObject({ repo: OTHER, status: 'completed' })
    expect(records(home).map((h) => h.status)).toEqual(['completed', 'pending', 'pending'])
    expect((await t()).status).toBe('completed')
    expect((await t()).status).toBe('completed')
    expect((await t()).status).toBe('none')
    expect(order).toEqual(['H-1', 'H-2', 'H-3'])
    expect(overlapped).toBe(false)
    expect(t.calls.admitted).toBe(3)
    expect(t.pub).toHaveBeenCalledTimes(3)
  })

  it('ST-93/AC-1: nothing eligible gives none, writes nothing, and runs no coding and no publication', async () => {
    const home = await homeWith(APPROVALS)
    await run(['withdraw', 'H-1'], home)
    await run(['withdraw', 'H-2'], home)
    await run(['withdraw', 'H-3'], home)
    const before = bytes(home)
    const t = turn(home)
    expect(await t()).toMatchObject({ status: 'none', skipped: [] })
    expect(bytes(home)).toBe(before)
    expect(t.exec).not.toHaveBeenCalled()
    expect(t.calls.admitted).toBe(0)
  })

  it('ST-93/AC-1: once admission is closed nothing is written and nothing is coded', async () => {
    const home = await homeWith(APPROVALS)
    const before = bytes(home)
    const t = turn(home, { admit: () => false })
    expect(await t()).toEqual({ status: 'admission-closed' })
    expect(bytes(home)).toBe(before)
    expect(t.exec).not.toHaveBeenCalled()
  })

  it('ST-93/AC-1: records that cannot be read give select-failed, with nothing coded', async () => {
    const home = await homeWith(APPROVALS)
    writeFileSync(handoffsPath(home), '{ not json')
    const t = turn(home)
    expect(await t()).toMatchObject({ status: 'select-failed', reason: expect.stringContaining('is malformed') })
    expect(t.exec).not.toHaveBeenCalled()
  })
})

describe('ST-93/AC-2: the admission is durable, unique and matched before anything starts', () => {
  it('ST-93/AC-2: the admission is in the record when the coding run starts, and that run is given its identity, which the record confirms and a different one does not', async () => {
    const home = await homeWith(APPROVALS)
    const seen = []
    const t = turn(home, {
      execute: async (args) => {
        const record = recordOf(home, 'H-1')
        seen.push({ record, args, active: await args.admissionIsActive(args.admission.id), other: await args.admissionIsActive('adm-other') })
        return pushedFor(home, args)
      },
    })
    await t()
    const [{ record, args, active, other }] = seen
    expect(record.status).toBe('admitted')
    expect(record.admission).toEqual({
      id: args.admission.id, handoffId: 'H-1', version: 1, repo: OTHER, branch: 'handoff/H-1-b-md', admittedAt: expect.any(String),
    })
    expect(args).toMatchObject({ handoffId: 'H-1', version: 1, homedir: home })
    expect(args.admission).toEqual({ id: record.admission.id, handoffId: 'H-1', version: 1 })
    expect(active).toBe(true)
    expect(other).toBe(false)
    // Once the run has ended, the admission is not active any more.
    expect(admissionIsActive(home, args.admission.id)).toBe(false)
    expect(recordOf(home, 'H-1')).not.toHaveProperty('admission')
  })

  it('ST-93/AC-2: each admission has an ID of its own', async () => {
    const home = await homeWith(APPROVALS)
    const ids = []
    const t = turn(home, { execute: async (args) => { ids.push(args.admission.id); return pushedFor(home, args) }, newId: undefined })
    await t()
    await t()
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(ids.every((id) => /^adm-[0-9a-f-]{36}$/.test(id))).toBe(true)
  })

  it('ST-93/AC-2: a failed admission write starts no coding run, leaves the record pending and blocks coding with an actionable reason', async () => {
    const home = await homeWith(APPROVALS)
    const before = bytes(home)
    blockWrites(home)
    const t = turn(home)
    const result = await t()
    unblockWrites(home)
    expect(result.status).toBe('blocked')
    expect(result.reason).toContain('no branch was claimed and no model was started')
    expect(result.reason).toContain(handoffsPath(home))
    expect(result.reason).toContain('restarted')
    expect(t.exec).not.toHaveBeenCalled()
    expect(t.pub).not.toHaveBeenCalled()
    expect(bytes(home)).toBe(before)
  })

  it('ST-93/AC-2: a handoff the records show as admitted, with no coding of this process running, blocks the turn before it selects anything', async () => {
    const home = await homeWith(APPROVALS)
    const record = recordOf(home, 'H-1')
    writeHandoffs(home, records(home).map((h) => (h.id !== 'H-1' ? h : {
      ...record, status: 'admitted', admission: { id: 'adm-old', handoffId: 'H-1', version: 1, repo: OTHER, branch: 'handoff/H-1-b-md', admittedAt: '2026-11-10T10:00:00.000Z' },
    })))
    const select = vi.fn(selectHandoff)
    const t = turn(home, { select })
    expect(await t()).toMatchObject({ status: 'blocked', handoffId: 'H-1', reason: expect.stringContaining('restarted') })
    expect(select).not.toHaveBeenCalled()
    expect(t.exec).not.toHaveBeenCalled()
  })

  it('ST-93/AC-2: a handoff whose approval changed between selection and admission is not admitted, and the newer version is what a later turn codes', async () => {
    const home = await homeWith(APPROVALS)
    const select = async (args) => {
      const selected = await selectHandoff(args)
      commitOnMain(OTHER, { 'b.md': 'bravo, changed\n' })
      expect((await run(['reapprove', 'H-1'], home)).code).toBe(0)
      return selected
    }
    const t = turn(home)
    const result = await t({ select })
    expect(result).toMatchObject({ status: 'not-admitted', handoffId: 'H-1', reason: expect.stringContaining('selected at version 1 and is now pending at version 2') })
    expect(t.exec).not.toHaveBeenCalled()
    expect(recordOf(home, 'H-1')).toMatchObject({ status: 'pending', version: 2 })
    expect(recordOf(home, 'H-1')).not.toHaveProperty('admission')
    await t()
    expect(t.exec).toHaveBeenCalledWith(expect.objectContaining({ handoffId: 'H-1', version: 2 }))
  })

  it('ST-93/AC-2: a handoff withdrawn between selection and admission is not admitted', async () => {
    const home = await homeWith(APPROVALS)
    const select = async (args) => {
      const selected = await selectHandoff(args)
      expect((await run(['withdraw', 'H-1'], home)).code).toBe(0)
      return selected
    }
    const t = turn(home)
    expect(await t({ select })).toMatchObject({ status: 'not-admitted', reason: expect.stringContaining('now withdrawn') })
    expect(t.exec).not.toHaveBeenCalled()
  })
})

describe('ST-93/AC-3: a pushed branch is published once, and the ending is recorded', () => {
  it('ST-93/AC-3: a published pull request completes the handoff with its pull request and head, and neither a later turn nor a restart codes it again', async () => {
    const home = await homeWith(APPROVALS)
    const t = turn(home)
    const result = await t()
    expect(result).toMatchObject({ status: 'completed', handoffId: 'H-1', branch: 'handoff/H-1-b-md', pr: { number: 12 } })
    expect(t.pub).toHaveBeenCalledTimes(1)
    expect(t.pub.mock.calls[0][0]).toMatchObject({ pushed: { status: 'pushed', handoffId: 'H-1', headSha: HEAD }, homedir: home })
    expect(recordOf(home, 'H-1')).toMatchObject({
      status: 'completed',
      completion: { admissionId: t.exec.mock.calls[0][0].admission.id, branch: 'handoff/H-1-b-md', headSha: HEAD, pr: { number: 12, url: 'https://github.com/acme/widgets/pull/12' }, draft: false },
    })
    expect(recordOf(home, 'H-1')).not.toHaveProperty('admission')
    const before = bytes(home)
    expect(interruptAdmissions({ homedir: home })).toEqual([])
    expect(bytes(home)).toBe(before)
    await t()
    await t()
    await t()
    expect(t.exec.mock.calls.map(([args]) => args.handoffId)).toEqual(['H-1', 'H-2', 'H-3'])
  })

  const STOPS = {
    'publication refused': {
      publish: async () => ({ status: 'head-moved', recoverable: true, reason: 'the branch moved' }),
      stop: { outcome: 'head-moved' },
      reason: 'the branch was pushed, but its pull request was not opened (head-moved): the branch moved',
    },
    'publication threw': {
      publish: async () => { throw new Error('GitHub went away') },
      stop: { outcome: 'publish-failed' },
      reason: 'GitHub went away',
    },
    'publication reported success with no pull request': {
      publish: async () => ({ status: 'published', pr: null }),
      stop: { outcome: 'no-pull-request' },
      reason: 'publication reported success with no pull request',
    },
  }
  it.each(Object.keys(STOPS))('ST-93/AC-3: when %s, the handoff is stopped with the branch and head it pushed, and is not coded or published again', async (name) => {
    const { publish, stop, reason } = STOPS[name]
    const home = await homeWith(APPROVALS)
    const t = turn(home, { publish })
    const result = await t()
    expect(result).toMatchObject({ status: 'stopped', handoffId: 'H-1', branch: 'handoff/H-1-b-md', pr: null })
    expect(result.reason).toContain(reason)
    expect(recordOf(home, 'H-1')).toMatchObject({
      status: 'stopped', stop: { admissionId: expect.any(String), at: expect.any(String), branch: 'handoff/H-1-b-md', headSha: HEAD, pr: null, retained: null, ...stop },
    })
    expect(recordOf(home, 'H-1').stop.reason).toContain(reason)
    expect(recordOf(home, 'H-1')).not.toHaveProperty('admission')
    await t()
    await t()
    expect(t.exec.mock.calls.map(([args]) => args.handoffId)).toEqual(['H-1', 'H-2', 'H-3'])
    expect(t.pub).toHaveBeenCalledTimes(3)
  })

  const FAILED = {
    'the session failed': (home, args) => refusal(home, args, 'session-failed', { branch: 'handoff/H-1-b-md', outcome: 'timed-out', reason: 'the session ran out of time', retained: { repoDir: '/owned/acme/gadgets', worktree: '/tmp/steward-handoff-x/tree', branch: 'handoff/H-1-b-md' } }),
    'nothing was committed': (home, args) => refusal(home, args, 'nothing-committed', { branch: 'handoff/H-1-b-md' }),
    'the branch was pushed with no description': (home, args) => refusal(home, args, 'pr-block-invalid', { branch: 'handoff/H-1-b-md', headSha: HEAD, retained: { repoDir: '/owned/acme/gadgets', branch: 'handoff/H-1-b-md' } }),
    'the claim failed': (home, args) => refusal(home, args, 'claim-failed', { branch: 'handoff/H-1-b-md' }),
  }
  it.each(Object.keys(FAILED))('ST-93/AC-3: when %s, the handoff is stopped with what is known, nothing is published and nothing is retried', async (name) => {
    const home = await homeWith(APPROVALS)
    const t = turn(home, { execute: async (args) => (args.handoffId === 'H-1' ? FAILED[name](home, args) : pushedFor(home, args)) })
    const result = await t()
    const known = FAILED[name](home, { handoffId: 'H-1', version: 1 })
    expect(result).toMatchObject({ status: 'stopped', outcome: known.status })
    const { stop } = recordOf(home, 'H-1')
    expect(recordOf(home, 'H-1').status).toBe('stopped')
    expect(stop).toMatchObject({ outcome: known.status, branch: 'handoff/H-1-b-md', headSha: known.headSha ?? null, retained: known.retained ?? null, pr: null })
    expect(stop.reason).toContain(known.status)
    expect(t.pub).not.toHaveBeenCalled()
    await t()
    expect(t.exec.mock.calls.map(([args]) => args.handoffId)).toEqual(['H-1', 'H-2'])
  })

  it('ST-93/AC-3: what a failed run reports that the record cannot hold is left out, so the file stays readable', async () => {
    const home = await homeWith(APPROVALS)
    const t = turn(home, {
      execute: async (args) => refusal(home, args, 'push-failed', { branch: '', headSha: 'not-a-sha', retained: { worktree: '/tmp/x' }, reason: undefined }),
    })
    expect(await t()).toMatchObject({ status: 'stopped', handoffId: 'H-1', branch: 'handoff/H-1-b-md', retained: null })
    expect(readHandoffs(handoffsPath(home)).handoffs[0]).toMatchObject({
      status: 'stopped', stop: { outcome: 'push-failed', branch: 'handoff/H-1-b-md', headSha: null, retained: null, reason: 'push-failed' },
    })
  })

  it('ST-93/AC-3: the real executeHandoff, with a scratch folder that cannot be removed after a branch was kept, still gives the coordinator the location, which its stopped record keeps', async () => {
    const home = await homeWith(APPROVALS)
    // The remote refuses the coder's push, so its commit stays on a local branch: the only copy.
    writeFileSync(path.join(BARES.get(urlOf(OTHER)), 'hooks', 'pre-receive'), REFUSE_UPDATE_HOOK, { mode: 0o755 })
    let executed
    const execute = async (args) => {
      executed = await executeHandoff({
        ...args,
        userConfig: async () => fixtureUserConfig(),
        usage: async () => UNDER_LIMITS,
        codexUsage: async () => UNDER_LIMITS,
        baseEnv: { PATH: '/bin', GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret' },
        sessionOptions: { executable: 'fake-claude', run: fakeSession },
        install: async () => {},
        removeScratch: async () => { throw new Error('EBUSY: resource busy') },
      })
      return executed
    }
    const t = turn(home, { execute })
    const result = await t()
    const owned = ownedCheckoutPath(home, OTHER)
    expect(executed.status).toBe('push-failed')
    expect(executed.scratchLeft).toEqual(expect.stringContaining('steward-handoff-'))
    expect(result).toMatchObject({ status: 'stopped', outcome: 'push-failed', retained: { repoDir: owned, branch: 'handoff/H-1-b-md' } })
    expect(recordOf(home, 'H-1')).toMatchObject({ status: 'stopped', stop: { outcome: 'push-failed', retained: { repoDir: owned, branch: 'handoff/H-1-b-md' } } })
    expect(git(owned, 'log', '-1', '--format=%s', 'refs/heads/handoff/H-1-b-md')).toBe('implement')
    rmSync(executed.scratchLeft, { recursive: true, force: true })
  })

  it('ST-93/AC-3: a coding run that throws, with the work it kept on the error, stops the handoff with that work named', async () => {
    const home = await homeWith(APPROVALS)
    const kept = { repoDir: '/owned/acme/gadgets', worktree: '/tmp/steward-handoff-x/tree', branch: 'handoff/H-1-b-md' }
    const t = turn(home, { execute: async () => { throw Object.assign(new Error('clean-up failed'), { retained: kept }) } })
    expect(await t()).toMatchObject({ status: 'stopped', outcome: 'threw', retained: kept })
    expect(recordOf(home, 'H-1').stop).toMatchObject({ outcome: 'threw', retained: kept, branch: 'handoff/H-1-b-md', headSha: null, pr: null })
    expect(recordOf(home, 'H-1').stop.reason).toContain('clean-up failed')
  })

  it('ST-93/AC-3: a record of the ending that cannot be written blocks coding and leaves the handoff admitted', async () => {
    const home = await homeWith(APPROVALS)
    const t = turn(home, { publish: async () => { blockWrites(home); return published() } })
    const result = await t()
    unblockWrites(home)
    expect(result.status).toBe('blocked')
    expect(result.reason).toContain('ended as completed')
    expect(result.reason).toContain('pull request #12')
    expect(result.reason).toContain('marked interrupted when the coordinator is restarted')
    expect(recordOf(home, 'H-1').status).toBe('admitted')
    // The next turn does not select another handoff behind it.
    const select = vi.fn(selectHandoff)
    expect((await t({ select })).status).toBe('blocked')
    expect(select).not.toHaveBeenCalled()
    expect(t.exec).toHaveBeenCalledTimes(1)
  })
})

describe('ST-93/AC-4: an admission left by the previous coordinator is interrupted, not run again', () => {
  it('ST-93/AC-4: a handoff admitted when the coordinator ended becomes interrupted, with what is known, and nothing else is touched or started', async () => {
    const home = await homeWith(APPROVALS)
    // A turn whose coding run never returns, as when the coordinator is killed during it.
    const hung = turn(home, { execute: () => new Promise(() => {}) })
    void hung()
    await vi.waitFor(() => expect(recordOf(home, 'H-1').status).toBe('admitted'), { timeout: 30_000 })
    const admitted = recordOf(home, 'H-1')
    const tree = () => readdirSync(home, { recursive: true }).filter((f) => !f.includes('handoffs.json')).sort()
    const before = tree()

    const moved = interruptAdmissions({ homedir: home, now })
    expect(moved).toEqual([admitted])
    const { admission, ...kept } = admitted
    expect(recordOf(home, 'H-1')).toEqual({
      ...kept,
      status: 'interrupted',
      stop: {
        admissionId: admission.id, at: expect.any(String), outcome: 'interrupted', reason: expect.stringContaining('ended before it recorded how the coding ended'),
        branch: 'handoff/H-1-b-md', headSha: null, pr: null, retained: null,
      },
    })
    expect(readHandoffs(handoffsPath(home)).handoffs[0].status).toBe('interrupted')
    expect(recordOf(home, 'H-2').status).toBe('pending')
    expect(tree()).toEqual(before)

    // The next coordinator codes the next handoff and never the interrupted one.
    const t = turn(home)
    await t()
    await t()
    await t()
    expect(t.exec.mock.calls.map(([args]) => args.handoffId)).toEqual(['H-2', 'H-3'])
    expect(recordOf(home, 'H-1').status).toBe('interrupted')
    expect(interruptAdmissions({ homedir: home, now })).toEqual([])
  })

  it('ST-93/AC-4: with nothing admitted, interrupting writes nothing, and a file that cannot be read throws', async () => {
    const home = await homeWith(APPROVALS)
    const before = bytes(home)
    expect(interruptAdmissions({ homedir: home })).toEqual([])
    expect(bytes(home)).toBe(before)
    const empty = fresh('home')
    expect(interruptAdmissions({ homedir: empty })).toEqual([])
    expect(existsSync(handoffsPath(empty))).toBe(false)
    writeFileSync(handoffsPath(home), '{ not json')
    expect(() => interruptAdmissions({ homedir: home })).toThrow('is malformed')
  })

  it('ST-93/AC-4: an admission whose update cannot be written leaves the file as it was', async () => {
    const home = await homeWith(APPROVALS)
    const hung = turn(home, { execute: () => new Promise(() => {}) })
    void hung()
    await vi.waitFor(() => expect(recordOf(home, 'H-1').status).toBe('admitted'), { timeout: 30_000 })
    const before = bytes(home)
    blockWrites(home)
    expect(() => interruptAdmissions({ homedir: home })).toThrow()
    unblockWrites(home)
    expect(bytes(home)).toBe(before)
  })
})

describe('ST-93/AC-5: a refusal before any claim or model is resolved after the admission is cleared', () => {
  it.each(['over-usage', 'usage-unknown', 'source-unavailable'])('ST-93/AC-5: a retryable %s refusal returns the handoff to pending, and a later turn codes it', async (status) => {
    const home = await homeWith(APPROVALS)
    const original = recordOf(home, 'H-1')
    let atResolution
    const t = turn(home, { execute: async (args) => (args.handoffId === 'H-1' && !atResolution ? refusal(home, args, status, { retryable: true }) : pushedFor(home, args)) })
    const result = await t()
    atResolution = recordOf(home, 'H-1')
    expect(result).toMatchObject({ status: 'retry-later', handoffId: 'H-1', reason: expect.stringContaining(status) })
    // Cleared by the time the turn resolved: back to exactly what was approved.
    expect(atResolution).toEqual(original)
    expect(admissionIsActive(home, t.exec.mock.calls[0][0].admission.id)).toBe(false)
    expect(t.pub).not.toHaveBeenCalled()
    // A later turn reconsiders it, as the oldest.
    expect((await t()).status).toBe('completed')
    expect(t.exec.mock.calls.map(([args]) => args.handoffId)).toEqual(['H-1', 'H-1'])
  })

  it('ST-93/AC-5: a changed-content refusal holds the handoff with its reason, and the source matching the approval again does not release it', async () => {
    const home = await homeWith(APPROVALS)
    const reason = 'file b.md of acme/gadgets no longer has the text approved as version 1 (read at main abc123def456)'
    let refused = false
    const t = turn(home, {
      execute: async (args) => {
        if (args.handoffId !== 'H-1' || refused) return pushedFor(home, args)
        refused = true
        return refusal(home, args, 'unit-changed', { reason, retryable: false })
      },
    })
    const result = await t()
    expect(result).toMatchObject({ status: 'held', handoffId: 'H-1', reason })
    expect(recordOf(home, 'H-1')).toMatchObject({ status: 'held', version: 1, hold: { reason, heldAt: expect.any(String) } })
    expect(recordOf(home, 'H-1')).not.toHaveProperty('admission')
    // The source changes and then returns to the approved text.
    commitOnMain(OTHER, { 'b.md': 'changed\n' })
    commitOnMain(OTHER, { 'b.md': 'bravo\n' })
    const next = await t()
    expect(next).toMatchObject({ status: 'completed', handoffId: 'H-2' })
    expect(recordOf(home, 'H-1').status).toBe('held')
    await t()
    expect(await t()).toMatchObject({ status: 'none', skipped: [expect.objectContaining({ id: 'H-1', state: 'held' })] })
    expect(t.exec.mock.calls.map(([args]) => args.handoffId)).toEqual(['H-1', 'H-2', 'H-3'])
    // Only the crew's reapproval releases it.
    expect((await run(['reapprove', 'H-1'], home)).code).toBe(0)
    expect(recordOf(home, 'H-1')).toMatchObject({ status: 'pending', version: 2 })
    expect(recordOf(home, 'H-1')).not.toHaveProperty('hold')
    expect(await t()).toMatchObject({ status: 'completed', handoffId: 'H-1' })
  })

  it('ST-93/AC-5: a refusal that is not retryable stops the handoff for the crew instead of retrying it', async () => {
    const home = await homeWith(APPROVALS)
    const t = turn(home, { execute: async (args) => (args.handoffId === 'H-1' ? refusal(home, args, 'no-git-identity', { missing: ['user.name'] }) : pushedFor(home, args)) })
    expect(await t()).toMatchObject({ status: 'stopped', handoffId: 'H-1', outcome: 'no-git-identity' })
    expect(recordOf(home, 'H-1')).toMatchObject({ status: 'stopped', stop: { outcome: 'no-git-identity', branch: 'handoff/H-1-b-md' } })
    await t()
    expect(t.exec.mock.calls.map(([args]) => args.handoffId)).toEqual(['H-1', 'H-2'])
  })

  it.each([['over-usage', 'retry-later'], ['unit-changed', 'held']])('ST-93/AC-5: when clearing the admission after a %s refusal fails, coding is blocked, the unresolved record is named, and nothing is dispatched again', async (status, ending) => {
    const home = await homeWith(APPROVALS)
    const t = turn(home, { execute: async (args) => { blockWrites(home); return refusal(home, args, status, { retryable: status === 'over-usage' }) } })
    const result = await t()
    unblockWrites(home)
    expect(result.status).toBe('blocked')
    expect(result.handoffId).toBe('H-1')
    expect(result.reason).toContain(`ended as ${ending}`)
    expect(result.reason).toContain('stays admitted')
    expect(recordOf(home, 'H-1').status).toBe('admitted')
    const select = vi.fn(selectHandoff)
    expect((await t({ select })).status).toBe('blocked')
    expect(select).not.toHaveBeenCalled()
    expect(t.exec).toHaveBeenCalledTimes(1)
    // The next start finds it admitted, and interrupts it.
    expect(interruptAdmissions({ homedir: home, now })).toHaveLength(1)
    expect(recordOf(home, 'H-1').status).toBe('interrupted')
  })
})

describe('ST-93/AC-6: stopped work stays inspectable from the records alone', () => {
  const stoppedRecord = (extra = {}) => handoffRecord({
    order: 1, repo: REPO, status: 'stopped',
    stop: {
      admissionId: 'adm-1', at: '2026-11-10T13:00:00.000Z', outcome: 'session-failed', reason: 'session-failed (the session timed-out): ran out of time',
      branch: 'handoff/H-1-docs-unit-1-md', headSha: HEAD, pr: null, retained: { repoDir: '/owned/acme/widgets', worktree: '/tmp/steward-handoff-x/tree', branch: 'handoff/H-1-docs-unit-1-md' },
    },
    ...extra,
  })

  it('ST-93/AC-6: handoff list shows each coded handoff with its reason, branch, pull request, kept work and next action, and needs no coordinator', async () => {
    const home = fresh('home')
    writeHandoffs(home, [
      stoppedRecord(),
      handoffRecord({
        order: 2, repo: OTHER, status: 'completed',
        completion: { admissionId: 'adm-2', at: '2026-11-10T14:00:00.000Z', branch: 'handoff/H-2-docs-unit-2-md', headSha: HEAD, pr: { number: 31, url: 'https://github.com/acme/gadgets/pull/31' }, draft: true },
      }),
      handoffRecord({
        order: 3, repo: REPO, status: 'interrupted',
        stop: { admissionId: 'adm-3', at: '2026-11-10T15:00:00.000Z', outcome: 'interrupted', reason: 'the coordinator ended', branch: 'handoff/H-3-docs-unit-3-md', headSha: null, pr: null, retained: null },
      }),
      handoffRecord({
        order: 4, repo: REPO, status: 'admitted',
        admission: { id: 'adm-4', handoffId: 'H-4', version: 1, repo: REPO, branch: 'handoff/H-4-docs-unit-4-md', admittedAt: '2026-11-10T16:00:00.000Z' },
      }),
    ])
    const result = await run(['list'], home)
    expect(result.code).toBe(0)
    const text = result.out
    expect(text).toContain('H-1  stopped  v1  acme/widgets  file docs/unit-1.md')
    expect(text).toContain('reason: session-failed (the session timed-out): ran out of time (2026-11-10T13:00:00.000Z)')
    expect(text).toContain('branch: handoff/H-1-docs-unit-1-md')
    expect(text).toContain(`head: ${HEAD}`)
    expect(text).toContain('work kept: worktree /tmp/steward-handoff-x/tree (branch handoff/H-1-docs-unit-1-md) in /owned/acme/widgets')
    expect(text).toContain('next: Inspect handoff/H-1-docs-unit-1-md on acme/widgets, and whether a pull request was opened from it, and the work kept at worktree')
    expect(text).toContain('refuses its source while it is stopped')
    expect(text).toContain('H-2  completed  v1  acme/gadgets  file docs/unit-2.md')
    expect(text).toContain('result: its pull request is open as a draft (2026-11-10T14:00:00.000Z)')
    expect(text).toContain('pull request: #31 https://github.com/acme/gadgets/pull/31')
    expect(text).toContain('H-3  interrupted  v1  acme/widgets')
    expect(text).toContain('git worktree list')
    expect(text).toContain('H-4  admitted  v1  acme/widgets')
    expect(text).toContain('reason: coding under admission adm-4 (2026-11-10T16:00:00.000Z)')
    expect(text).toContain('steward coordinator start')
    const shown = await run(['show', 'H-1'], home)
    expect(shown.out).toContain('reason: session-failed')
    expect(shown.out).toContain('next: Inspect')
  })

  it('ST-93/AC-6: add, reapprove and withdraw refuse a stopped or interrupted handoff, as they do an admitted one', async () => {
    const home = fresh('home')
    writeHandoffs(home, [stoppedRecord(), stoppedRecord({ order: 2, status: 'interrupted', file: 'docs/unit-2.md' })])
    const before = bytes(home)
    for (const id of ['H-1', 'H-2']) {
      expect((await run(['reapprove', id], home)).code).toBe(1)
      expect((await run(['withdraw', id], home)).code).toBe(1)
    }
    const add = await run(['add', '--repo', REPO, '--file', 'docs/unit-1.md'], home)
    expect(add.code).toBe(1)
    expect(add.err).toContain('is already stopped as H-1')
    expect(bytes(home)).toBe(before)
  })
})

describe('ST-93: the records of coding are validated', () => {
  const read = (home, handoffs) => { writeHandoffs(home, handoffs); return readHandoffs(handoffsPath(home)) }
  const admission = (over = {}) => ({ id: 'adm-1', handoffId: 'H-1', version: 1, repo: REPO, branch: 'handoff/H-1-x', admittedAt: '2026-11-10T10:00:00.000Z', ...over })
  const stop = (over = {}) => ({ admissionId: null, at: '2026-11-10T10:00:00.000Z', outcome: 'interrupted', reason: 'why', branch: null, headSha: null, pr: null, retained: null, ...over })

  it('ST-93: an admitted or completed handoff written before ST-93 has no admission or completion, and is still valid', () => {
    const home = fresh('home')
    expect(read(home, [handoffRecord({ status: 'admitted' }), handoffRecord({ order: 2, status: 'completed' })]).handoffs).toHaveLength(2)
  })

  it.each([
    ['an admission naming another handoff', { status: 'admitted', admission: admission({ handoffId: 'H-9' }) }, 'must name this handoff'],
    ['an admission naming another version', { status: 'admitted', admission: admission({ version: 2 }) }, 'must name this handoff'],
    ['an admission on a pending handoff', { admission: admission() }, 'cannot have `admission`'],
    ['a stopped handoff with no stop', { status: 'stopped' }, 'must say why and what is known'],
    ['a stop on a pending handoff', { stop: stop() }, 'cannot have `stop`'],
    ['a stop with an unknown key', { status: 'stopped', stop: { ...stop(), extra: 1 } }, 'stop must be'],
    ['a stop with a pull request that is no pull request', { status: 'stopped', stop: stop({ pr: { number: 0, url: 'u' } }) }, 'stop must be'],
    ['a stop with a head that is no SHA', { status: 'interrupted', stop: stop({ headSha: 'abc' }) }, 'stop must be'],
    ['a stop whose kept work names no folder', { status: 'stopped', stop: stop({ retained: { branch: 'b' } }) }, 'stop must be'],
    ['a completion on a stopped handoff', { status: 'stopped', stop: stop(), completion: {} }, 'cannot have `completion`'],
    ['a completion with no pull request', { status: 'completed', completion: { admissionId: null, at: '2026-11-10T10:00:00.000Z', branch: 'b', headSha: HEAD, pr: null, draft: false } }, 'completion must be'],
  ])('ST-93: %s is refused', (_name, extra, message) => {
    const home = fresh('home')
    expect(() => read(home, [handoffRecord(extra)])).toThrow(message)
  })

  it('ST-93: a stopped or interrupted handoff is valid with a stop, and a completed one with a completion', () => {
    const home = fresh('home')
    const records = read(home, [
      handoffRecord({ status: 'stopped', stop: stop({ pr: { number: 3, url: 'u' }, retained: { repoDir: '/r', branch: 'b' } }) }),
      handoffRecord({ order: 2, status: 'interrupted', stop: stop() }),
      handoffRecord({ order: 3, status: 'completed', completion: { admissionId: 'adm-3', at: '2026-11-10T10:00:00.000Z', branch: 'b', headSha: HEAD, pr: { number: 3, url: 'u' }, draft: true } }),
      handoffRecord({ order: 4, status: 'admitted', admission: admission({ handoffId: 'H-4' }) }),
    ]).handoffs
    expect(records.map((h) => h.status)).toEqual(['stopped', 'interrupted', 'completed', 'admitted'])
  })
})

describe('ST-93: a write reads the records afresh, after whatever it awaited', () => {
  const ISSUE = { number: 7, title: 'Add a thing', body: 'Do it.' }
  const admissionOf = (id, branch) => ({ id: 'adm-race', handoffId: id, version: 1, repo: REPO, branch, admittedAt: '2026-11-10T10:00:00.000Z' })
  const completionOf = (branch) => ({
    admissionId: 'adm-race', at: '2026-11-10T11:00:00.000Z', branch, headSha: HEAD, pr: { number: 3, url: 'https://github.com/acme/widgets/pull/3' }, draft: false,
  })
  /** What the coordinator writes to a record, written here as a stand-in during an await. */
  const COORDINATOR = {
    'an admission': (record) => ({ ...record, status: 'admitted', admission: admissionOf(record.id, `handoff/${record.id}-issue-7`) }),
    'a completion': (record) => ({ ...record, status: 'completed', completion: completionOf(`handoff/${record.id}-issue-7`) }),
  }
  const editRaw = (home, id, change) => {
    const data = JSON.parse(readFileSync(handoffsPath(home), 'utf8'))
    data.handoffs = data.handoffs.map((h) => (h.id === id ? change(h) : h))
    writeFileSync(handoffsPath(home), `${JSON.stringify(data, null, 2)}\n`)
  }
  /** A GitHub stand-in that answers Issue 7 with `issue`, and runs `during` while it is being read. */
  const issueContext = (getIssue, during = () => {}) => ({ repo }) => ({
    repo,
    async send() {
      await during()
      return getIssue()
    },
  })
  async function runWith(args, home, createContext) {
    const out = []
    const err = []
    const code = await handoff(args, { homedir: home, now, createContext, out: (l) => out.push(l), err: (l) => err.push(l) })
    return { code, out: out.join('\n'), err: err.join('\n') }
  }
  /** A home with Issue 7 approved as H-1. */
  async function issueHome() {
    const home = await homeWith([[REPO, 'a.md', 'alpha\n']])
    expect((await runWith(['withdraw', 'H-1'], home, stubContext)).code).toBe(0)
    expect((await runWith(['add', '--repo', REPO, '--issue', '7'], home, issueContext(() => ISSUE))).code).toBe(0)
    expect(records(home).map((h) => [h.id, h.status])).toEqual([['H-1', 'withdrawn'], ['H-2', 'pending']])
    return home
  }

  it.each(Object.keys(COORDINATOR))('ST-93/AC-2: add, while its source is read and the coordinator writes %s to another handoff, adds its record and keeps the coordinator\'s', async (name) => {
    const home = await issueHome()
    const before = recordOf(home, 'H-2')
    const during = () => editRaw(home, 'H-2', COORDINATOR[name])
    const result = await runWith(['add', '--repo', REPO, '--issue', '8'], home, issueContext(() => ({ ...ISSUE, number: 8 }), during))
    expect(result.code).toBe(0)
    expect(records(home).map((h) => [h.id, h.status])).toEqual([['H-1', 'withdrawn'], ['H-2', name === 'an admission' ? 'admitted' : 'completed'], ['H-3', 'pending']])
    expect(recordOf(home, 'H-2')).toEqual(COORDINATOR[name](before))
  })

  it('ST-93/AC-2: add refuses, recording nothing, when the same source was approved while it was read', async () => {
    const home = await issueHome()
    await runWith(['withdraw', 'H-2'], home, stubContext)
    const during = () => writeHandoffs(home, [...records(home), { ...recordOf(home, 'H-2'), id: 'H-3', order: 3, status: 'pending' }])
    const result = await runWith(['add', '--repo', REPO, '--issue', '7'], home, issueContext(() => ISSUE, during))
    expect(result.code).toBe(1)
    expect(result.err).toContain('was approved as H-3 while its source was read')
    expect(records(home).map((h) => h.id)).toEqual(['H-1', 'H-2', 'H-3'])
  })

  it.each(Object.keys(COORDINATOR))('ST-93/AC-3, ST-93/AC-4: reapprove, while its source is read and the coordinator writes %s to the same handoff, refuses and keeps the coordinator\'s', async (name) => {
    const home = await issueHome()
    const during = () => editRaw(home, 'H-2', COORDINATOR[name])
    const result = await runWith(['reapprove', 'H-2'], home, issueContext(() => ({ ...ISSUE, body: 'Do it differently.' }), during))
    expect(result.code).toBe(1)
    expect(result.err).toContain('H-2 changed while its source was read')
    expect(recordOf(home, 'H-2')).toMatchObject({ status: name === 'an admission' ? 'admitted' : 'completed', version: 1 })
    expect(recordOf(home, 'H-2')).toHaveProperty(name === 'an admission' ? 'admission' : 'completion')
  })

  it.each(Object.keys(COORDINATOR))('ST-93/AC-2: reapprove, while the coordinator writes %s to another handoff, reapproves its own and keeps the other', async (name) => {
    const home = await issueHome()
    expect((await runWith(['add', '--repo', REPO, '--issue', '8'], home, issueContext(() => ({ ...ISSUE, number: 8 })))).code).toBe(0)
    const during = () => editRaw(home, 'H-3', COORDINATOR[name])
    const result = await runWith(['reapprove', 'H-2'], home, issueContext(() => ({ ...ISSUE, body: 'Do it differently.' }), during))
    expect(result.code).toBe(0)
    expect(recordOf(home, 'H-2')).toMatchObject({ status: 'pending', version: 2 })
    expect(recordOf(home, 'H-3').status).toBe(name === 'an admission' ? 'admitted' : 'completed')
  })

  it.each(Object.keys(COORDINATOR))('ST-93/AC-2: a hold from selection, while its source is read and the coordinator writes %s to that handoff, is not written over it', async (name) => {
    const home = await issueHome()
    const during = () => editRaw(home, 'H-2', COORDINATOR[name])
    const result = await selectHandoff({ homedir: home, now, createContext: issueContext(() => ({ ...ISSUE, body: 'Changed.' }), during) })
    expect(result.result).toBe('no-eligible-handoffs')
    expect(result.skipped).toEqual([expect.objectContaining({ id: 'H-2', state: 'unavailable', reason: expect.stringContaining('changed while its source was read') })])
    expect(recordOf(home, 'H-2')).toMatchObject({ status: name === 'an admission' ? 'admitted' : 'completed' })
    expect(recordOf(home, 'H-2')).not.toHaveProperty('hold')
  })

  it('ST-93/AC-2: the coordinator, racing a withdraw, either admits the handoff before it is withdrawn, which then refuses, or does not admit it', async () => {
    const home = await homeWith(APPROVALS)
    // Withdrawn after selection and before admission: not admitted, and the withdrawal stands.
    const select = async (args) => {
      const selected = await selectHandoff(args)
      expect((await run(['withdraw', 'H-1'], home)).code).toBe(0)
      return selected
    }
    const t = turn(home)
    expect((await t({ select })).status).toBe('not-admitted')
    expect(recordOf(home, 'H-1').status).toBe('withdrawn')
    // Withdrawn while the coding runs: refused, and the ending is written to the record.
    let refusal0
    const t2 = turn(home, {
      execute: async (args) => {
        refusal0 = await run(['withdraw', args.handoffId], home)
        return pushedFor(home, args)
      },
    })
    expect((await t2()).status).toBe('completed')
    expect(refusal0.code).toBe(1)
    expect(refusal0.err).toContain('a coder has taken it')
    expect(recordOf(home, 'H-2').status).toBe('completed')
  })

  it('ST-93/AC-3: the coordinator\'s record of an ending is written onto the file as it is then, keeping what the crew added meanwhile', async () => {
    const home = await homeWith(APPROVALS)
    const t = turn(home, {
      execute: async (args) => {
        // The crew approves another handoff while the coding runs.
        await run(['withdraw', 'H-3'], home)
        expect((await run(['add', '--repo', REPO, '--file', 'c.md'], home)).code).toBe(0)
        return pushedFor(home, args)
      },
    })
    expect((await t()).status).toBe('completed')
    expect(records(home).map((h) => [h.id, h.status])).toEqual([['H-1', 'completed'], ['H-2', 'pending'], ['H-3', 'withdrawn'], ['H-4', 'pending']])
  })
})

describe('ST-93: what a run left survives a failed ending write, closure and restart', () => {
  const KEPT = { repoDir: '/owned/acme/gadgets', worktree: '/tmp/steward-handoff-x/tree', branch: 'handoff/H-1-b-md' }
  const statusOf = async (home) => {
    const out = []
    await coordinatorMain(['status', '--json'], { homedir: home, env: {}, out: (l) => out.push(l), err: () => {} })
    return JSON.parse(out.join('\n'))
  }
  const statusText = async (home) => {
    const out = []
    await coordinatorMain(['status'], { homedir: home, env: {}, out: (l) => out.push(l), err: () => {} })
    return out.join('\n')
  }

  /** A turn whose ending cannot be written, in a coordinator that is then stopped, as a person would. */
  async function failedThenClosed(home, options) {
    const coordinator = runCoordinator({ homedir: home, pollMs: 10 })
    const t = turn(home, { admit: coordinator.admit, ...options })
    const result = await t()
    unblockWrites(home)
    expect(result.status).toBe('blocked')
    writeFileSync(stopRequestPath(home), 'stop\n')
    expect(await coordinator.done).toBe(null)
    expect(existsSync(coordinatorPath(home))).toBe(false)
    return result
  }

  it('ST-93/AC-3, ST-93/AC-4, ST-93/AC-6: a failed ending write after a run that kept its worktree, then graceful closure and a restart: status and handoff list show the branch and the worktree throughout, and the interrupted record has them', async () => {
    const home = await homeWith(APPROVALS)
    const result = await failedThenClosed(home, {
      execute: async (args) => {
        blockWrites(home)
        return refusal(home, args, 'session-failed', { branch: 'handoff/H-1-b-md', outcome: 'timed-out', reason: 'the session ran out of time', retained: KEPT })
      },
    })
    const admissionId = recordOf(home, 'H-1').admission.id
    expect(result.reason).toContain(`What it left is kept in ${evidencePath(home)}`)
    expect(readEvidence(evidencePath(home))).toEqual([expect.objectContaining({ admissionId, handoffId: 'H-1', repo: OTHER, outcome: 'session-failed', branch: 'handoff/H-1-b-md', headSha: null, pr: null, retained: KEPT })])

    // No coordinator is running and the record says admitted: both commands show what is known.
    const shown = async () => {
      const json = await statusOf(home)
      const text = await statusText(home)
      const listed = (await run(['list'], home)).out
      return { json, text, listed }
    }
    const before = await shown()
    expect(before.json.status).toBe('stopped')
    expect(before.json.coding.running).toEqual([expect.objectContaining({ id: 'H-1', branch: 'handoff/H-1-b-md', kept: KEPT, reason: expect.stringContaining('ended as session-failed') })])
    for (const text of [before.text, before.listed]) {
      expect(text).toContain('branch: handoff/H-1-b-md')
      expect(text).toContain('work kept: worktree /tmp/steward-handoff-x/tree (branch handoff/H-1-b-md) in /owned/acme/gadgets')
    }

    // The next start interrupts it, with those facts, and clears the entry.
    expect(interruptAdmissions({ homedir: home, now })).toHaveLength(1)
    expect(recordOf(home, 'H-1')).toMatchObject({
      status: 'interrupted', stop: { admissionId, outcome: 'interrupted', branch: 'handoff/H-1-b-md', headSha: null, pr: null, retained: KEPT },
    })
    expect(recordOf(home, 'H-1').stop.reason).toContain('ended as session-failed')
    expect(readEvidence(evidencePath(home))).toEqual([])
    const after = await shown()
    expect(after.json.coding.stopped).toEqual([expect.objectContaining({ id: 'H-1', status: 'interrupted', branch: 'handoff/H-1-b-md', kept: KEPT })])
    for (const text of [after.text, after.listed]) {
      expect(text).toContain('work kept: worktree /tmp/steward-handoff-x/tree (branch handoff/H-1-b-md) in /owned/acme/gadgets')
    }
  })

  it('ST-93/AC-3, ST-93/AC-4, ST-93/AC-6: a failed ending write after a published pull request, then closure and a restart: the head and the pull request are in the interrupted record and both commands', async () => {
    const home = await homeWith(APPROVALS)
    await failedThenClosed(home, { publish: async () => { blockWrites(home); return published() } })
    const pr = { number: 12, url: 'https://github.com/acme/widgets/pull/12' }
    expect((await statusOf(home)).coding.running).toEqual([expect.objectContaining({ id: 'H-1', headSha: HEAD, pr })])
    expect(interruptAdmissions({ homedir: home, now })).toHaveLength(1)
    expect(recordOf(home, 'H-1').stop).toMatchObject({ outcome: 'interrupted', branch: 'handoff/H-1-b-md', headSha: HEAD, pr, retained: null })
    for (const text of [await statusText(home), (await run(['list'], home)).out]) {
      expect(text).toContain(`head: ${HEAD}`)
      expect(text).toContain('pull request: #12 https://github.com/acme/widgets/pull/12')
    }
  })

  it('ST-93/AC-4: an admission with no evidence is interrupted as before, and evidence for another admission is left', async () => {
    const home = await homeWith(APPROVALS)
    const t = turn(home, { execute: () => new Promise(() => {}) })
    void t()
    await vi.waitFor(() => expect(recordOf(home, 'H-1').status).toBe('admitted'), { timeout: 30_000 })
    const other = { admissionId: 'adm-other', handoffId: 'H-9', repo: OTHER, at: '2026-11-10T10:00:00.000Z', outcome: 'x', branch: null, headSha: null, pr: null, retained: null }
    writeFileSync(evidencePath(home), `${JSON.stringify({ evidence: [other] })}\n`)
    interruptAdmissions({ homedir: home, now })
    expect(recordOf(home, 'H-1').stop).toMatchObject({ branch: 'handoff/H-1-b-md', headSha: null, pr: null, retained: null })
    expect(readEvidence(evidencePath(home))).toEqual([other])
  })

  it('ST-93/AC-4: evidence that cannot be read refuses the interruption, naming the file, and changes nothing', async () => {
    const home = await homeWith(APPROVALS)
    const t = turn(home, { execute: () => new Promise(() => {}) })
    void t()
    await vi.waitFor(() => expect(recordOf(home, 'H-1').status).toBe('admitted'), { timeout: 30_000 })
    writeFileSync(evidencePath(home), '{ not json')
    const before = bytes(home)
    expect(() => interruptAdmissions({ homedir: home, now })).toThrow(evidencePath(home))
    expect(bytes(home)).toBe(before)
  })
})
