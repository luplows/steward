// @vitest-environment node

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { coordinatorPath, isRunning, main, readRecord, runCoordinator, stopRequestPath } from './coordinator.mjs'
import { admitReview, readReviews, reviewEnding, reviewsPath } from './review-admission.mjs'
import { fixtureUserConfig } from './settings-fixture.mjs'
import { userConfigPath } from './user-config.mjs'

// A write of `reviews.json` that fails, in a file of its own because it replaces these three of
// `node:fs` for what it imports. Each passes through until a test sets its hook, which throws to
// make the call fail. Detached coordinators are other processes, and are not touched.
const hooks = vi.hoisted(() => ({ writeFileSync: null, renameSync: null, rmSync: null }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal()
  const hooked = (name) => (...args) => {
    hooks[name]?.(...args)
    return fs[name](...args)
  }
  return { ...fs, writeFileSync: hooked('writeFileSync'), renameSync: hooked('renameSync'), rmSync: hooked('rmSync') }
})
const actual = await vi.importActual('node:fs')

// Detached coordinators start and stop for real in some of these tests.
vi.setConfig({ testTimeout: 60_000 })

// Every test has a temporary home directory of its own: the real `~/.steward/` is never read or
// written. Reviews are stand-ins, and every process a test starts is stopped or killed before it
// ends.
let base
beforeAll(() => { base = mkdtempSync(path.join(tmpdir(), 'steward-review-write-')) })
afterAll(() => { rmSync(base, { recursive: true, force: true }) })

const started = []
afterEach(async () => {
  Object.assign(hooks, { writeFileSync: null, renameSync: null, rmSync: null })
  for (const pid of started.splice(0)) {
    if (isRunning(pid)) process.kill(pid)
    await until(() => !isRunning(pid))
  }
})

let counter = 0
const freshHome = () => {
  const dir = path.join(base, `home-${++counter}`)
  mkdirSync(path.join(dir, '.steward'), { recursive: true })
  writeFileSync(userConfigPath({ env: {}, homedir: dir }), JSON.stringify(fixtureUserConfig()))
  return dir
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, ms = 15_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await sleep(25)
  }
}

const HEAD = 'a'.repeat(40)
const STARTED = '2026-11-02T10:00:00.000Z'
const now = () => new Date(STARTED)
const candidate = (over = {}) => ({ repo: 'crew/client', number: 7, expectedHeadSha: HEAD, ...over })
const identity = { repo: 'crew/client', number: 7, headSha: HEAD }
const runningEntry = { ...identity, state: 'running', startedAt: STARTED }

/** The way each step fails. A write gets part way first, so that a direct write would be caught. */
const failed = (message) => Object.assign(new Error(message), { code: 'ENOSPC' })
const FAILURES = [
  ['the write of the temporary file', 'part way through the write', (file) => {
    hooks.writeFileSync = (target) => {
      if (!String(target).startsWith(file)) return
      actual.writeFileSync(target, '{ "reviews": [')
      throw failed('part way through the write')
    }
  }],
  ['the rename', 'the rename failed', (file) => {
    hooks.renameSync = (from) => {
      if (String(from).startsWith(file)) throw failed('the rename failed')
    }
  }],
]

const stateFiles = (home) => readdirSync(path.dirname(reviewsPath(home))).sort()

async function run(argv, homedir, options = {}) {
  const lines = { out: [], err: [] }
  const code = await main(argv, {
    homedir,
    env: {},
    pollMs: 20,
    out: (line) => lines.out.push(line),
    err: (line) => lines.err.push(line),
    ...options,
  })
  return { code, out: lines.out.join('\n'), err: lines.err.join('\n') }
}

/** A real `start`, shown to move the entry, then a real `stop`. */
async function startMovesItToInterrupted(home) {
  const spawnFn = (...args) => {
    const child = spawn(...args)
    started.push(child.pid)
    return child
  }
  const result = await run(['start'], home, { spawnFn })
  expect(result.code).toBe(0)
  expect(result.out).toContain(`crew/client pull request #7, head ${HEAD}`)
  const [moved] = readReviews(reviewsPath(home))
  expect(moved).toEqual({ ...runningEntry, state: 'ended', endedAt: expect.any(String), result: { status: 'interrupted' } })
  expect(reviewEnding({ homedir: home, ...identity })).toBe('model-consuming-failure')
  const { pid } = readRecord(coordinatorPath(home))
  expect((await run(['stop'], home)).code).toBe(0)
  await until(() => !isRunning(pid))
}

describe('ST-60/AC-2: a write of the outcome that fails', () => {
  for (const [name, message, makeItFail] of FAILURES) {
    it(`when ${name} fails: the file is byte for byte as it was, no temporary file stays, the coordinator ends as a handled error, and the next start moves the entry to interrupted`, async () => {
      const home = freshHome()
      const file = reviewsPath(home)
      const coordinator = runCoordinator({ homedir: home, pollMs: 20 })
      let before
      const review = vi.fn(async () => {
        before = readFileSync(file, 'utf8')
        makeItFail(file)
        return { status: 'recorded', sessions: 1 }
      })
      const outcome = await admitReview({ homedir: home, admit: coordinator.admit, candidate: candidate(), review, now })
      Object.assign(hooks, { writeFileSync: null, renameSync: null })

      expect(outcome).toMatchObject({ status: 'record-failed', file, reason: message })
      expect(outcome.entry.result).toEqual({ status: 'recorded', sessions: 1 })
      expect(readFileSync(file, 'utf8')).toBe(before)
      expect(readReviews(file)).toEqual([runningEntry])
      expect(stateFiles(home)).toEqual(['coordinator.json', 'reviews.json'])

      // What the caller is to do with `record-failed`.
      coordinator.fail(new Error(outcome.reason))
      const later = vi.fn()
      expect(await admitReview({ homedir: home, admit: coordinator.admit, candidate: candidate({ number: 8 }), review: later })).toEqual({ status: 'admission-closed' })
      expect(later).not.toHaveBeenCalled()
      expect((await coordinator.done).message).toBe(message)
      expect(existsSync(coordinatorPath(home))).toBe(false)
      expect(readFileSync(file, 'utf8')).toBe(before)

      await startMovesItToInterrupted(home)
    })
  }

  it('when the temporary file cannot be removed either, the error reported is still the write\'s own', async () => {
    const home = freshHome()
    const file = reviewsPath(home)
    const coordinator = runCoordinator({ homedir: home, pollMs: 20 })
    const review = vi.fn(async () => {
      hooks.renameSync = () => { throw failed('the rename failed') }
      hooks.rmSync = (target) => {
        if (String(target).startsWith(file)) throw failed('the removal failed')
      }
      return { status: 'recorded', sessions: 1 }
    })
    const outcome = await admitReview({ homedir: home, admit: coordinator.admit, candidate: candidate(), review, now })
    Object.assign(hooks, { renameSync: null, rmSync: null })
    expect(outcome).toMatchObject({ status: 'record-failed', reason: 'the rename failed' })
    expect(readReviews(file)).toEqual([runningEntry])
    coordinator.fail(new Error(outcome.reason))
    await coordinator.done
  })
})

describe('ST-60/AC-4a: a start whose own write fails', () => {
  for (const [name, message, makeItFail] of FAILURES) {
    it(`when ${name} fails: it refuses, launches nothing, names the file, leaves the file, the record and a stop request as they were, and the next start moves the entry`, async () => {
      const home = freshHome()
      const file = reviewsPath(home)
      const state = path.dirname(file)
      mkdirSync(state, { recursive: true })
      writeFileSync(file, JSON.stringify({ reviews: [runningEntry] }))
      const before = readFileSync(file, 'utf8')
      const { pid: dead } = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
      await until(() => !isRunning(dead))
      const record = { pid: dead, startedAt: STARTED, state: 'running' }
      writeFileSync(coordinatorPath(home), JSON.stringify(record))
      writeFileSync(stopRequestPath(home), 'left over\n')

      makeItFail(file)
      const spawnFn = vi.fn()
      const result = await run(['start'], home, { spawnFn })
      Object.assign(hooks, { writeFileSync: null, renameSync: null })

      expect(result.code).toBe(1)
      expect(result.err).toContain(`The coordinator did not start: it could not read or update its record of reviews, ${file}. ${message}`)
      expect(result.err).toContain('Nothing was started.')
      expect(result.out).toBe('')
      expect(spawnFn).not.toHaveBeenCalled()
      expect(readFileSync(file, 'utf8')).toBe(before)
      expect(readRecord(coordinatorPath(home))).toEqual(record)
      expect(stateFiles(home)).toEqual(['coordinator.json', 'coordinator.stop', 'reviews.json'])

      await startMovesItToInterrupted(home)
    })
  }

  it('a temporary file already there trips nothing: reading ignores it, and the next write replaces it', async () => {
    const home = freshHome()
    const file = reviewsPath(home)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ reviews: [runningEntry] }))
    writeFileSync(`${file}.tmp`, '{ "reviews": [')
    expect(readReviews(file)).toEqual([runningEntry])
    await startMovesItToInterrupted(home)
    expect(stateFiles(home)).toEqual(['reviews.json'])
  })
})
