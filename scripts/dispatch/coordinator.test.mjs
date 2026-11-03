// @vitest-environment node

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { coordinatorPath, isRunning, main, readRecord, runCoordinator, stopRequestPath } from './coordinator.mjs'
import { admitReview, readReviews, reviewEnding, reviewsPath } from './review-admission.mjs'
import { fixtureUserConfig } from './settings-fixture.mjs'
import { userConfigPath } from './user-config.mjs'

const DISPATCH = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(DISPATCH, '..', '..')

// Detached coordinators start and stop for real in some of these tests.
vi.setConfig({ testTimeout: 60_000 })

// Every test has a temporary home directory of its own: the real `~/.steward/` is never read or
// written. Every process a test starts is stopped, or killed, before the test ends.
let base
beforeAll(() => { base = mkdtempSync(path.join(tmpdir(), 'steward-coordinator-')) })
afterAll(() => { rmSync(base, { recursive: true, force: true }) })

const started = []
afterEach(async () => {
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

/** Runs `steward coordinator <argv>` in `homedir`, collecting its output. */
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

const statusOf = async (homedir) => JSON.parse((await run(['status', '--json'], homedir)).out)

/**
 * The record of a coordinator that has started, once it has stopped changing. With no activated
 * project its first scan writes to it just after `start` reports `started`, and then nothing does.
 * Whether a write landed is not asked: one refused because `start` was reading is not fatal (AC-8).
 */
async function settledRecord(homedir) {
  const read = () => {
    try {
      return JSON.stringify(readRecord(coordinatorPath(homedir)))
    } catch {
      return undefined
    }
  }
  let last
  await until(() => {
    const seen = read()
    const same = seen !== undefined && seen === last
    last = seen
    return same
  })
  return readRecord(coordinatorPath(homedir))
}

/** A process id that was running and is not any more. */
function deadPid() {
  const { pid } = spawnSync(process.execPath, ['-e', ''])
  expect(isRunning(pid)).toBe(false)
  return pid
}

/** A `spawn` that counts the processes it starts and remembers them for clean-up. */
function countingSpawn() {
  const spawned = []
  const spawnFn = (...args) => {
    const child = spawn(...args)
    spawned.push(child.pid)
    started.push(child.pid)
    return child
  }
  return { spawnFn, spawned }
}

describe('ST-58/AC-1: start launches a detached coordinator and reports started once it acknowledges', () => {
  it('reports started with the process id from the record the background process wrote, and the process keeps running after start returns', async () => {
    const home = freshHome()
    const { spawnFn, spawned } = countingSpawn()
    const result = await run(['start'], home, { spawnFn })
    expect(result.code).toBe(0)
    expect(spawned).toHaveLength(1)
    const record = readRecord(coordinatorPath(home))
    expect(record.pid).toBe(spawned[0])
    expect(result.out).toMatch(new RegExp(`^started: .* process ${record.pid}, started ${record.startedAt}`))
    expect(result.out).toContain('keeps running after this terminal closes')
    await sleep(300)
    expect(isRunning(record.pid)).toBe(true)

    const stopped = await run(['stop'], home)
    expect(stopped.code).toBe(0)
    expect(stopped.out).toMatch(/^stopped: /)
    await until(() => !isRunning(record.pid))
    expect(existsSync(coordinatorPath(home))).toBe(false)
  })

  it('does not report started when the process ends before it writes its record', async () => {
    const home = freshHome()
    // A process that exits at once, writing nothing: the launch failed.
    const spawnFn = () => spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    const result = await run(['start'], home, { spawnFn })
    expect(result.code).toBe(1)
    expect(result.out).not.toMatch(/started/)
    expect(result.err).toMatch(/did not start: the process ended before it wrote its record/)
  })

  it('does not report started when no record appears in time, and stops the process it launched', async () => {
    const home = freshHome()
    const { spawned } = countingSpawn()
    const spawnFn = () => {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
      spawned.push(child.pid)
      started.push(child.pid)
      return child
    }
    const result = await run(['start'], home, { spawnFn, waitMs: 500 })
    expect(result.code).toBe(1)
    expect(result.err).toMatch(/wrote no record within 0.5 seconds, and was stopped/)
    await until(() => !isRunning(spawned[0]))
  })
})

describe('ST-58/AC-2: one coordinator, by its record', () => {
  it('a second start while the first is running starts nothing and reports already-running, exiting nonzero', async () => {
    const home = freshHome()
    const { spawnFn, spawned } = countingSpawn()
    expect((await run(['start'], home, { spawnFn })).code).toBe(0)
    const record = await settledRecord(home)

    const second = await run(['start'], home, { spawnFn })
    expect(second.code).toBe(1)
    expect(second.err).toContain(`already-running: this OS user's coordinator is already running, as process ${record.pid}, started ${record.startedAt}`)
    expect(spawned).toEqual([record.pid])
    expect(readRecord(coordinatorPath(home))).toEqual(record)

    expect((await run(['stop'], home)).code).toBe(0)
    await until(() => !isRunning(record.pid))
  })

  it('the record holds the process id, start time and state, and nothing else', async () => {
    const home = freshHome()
    const coordinator = runCoordinator({ homedir: home, pollMs: 20, now: () => new Date('2026-11-01T10:00:00Z') })
    const raw = JSON.parse(readFileSync(coordinatorPath(home), 'utf8'))
    expect(raw).toEqual({ pid: process.pid, startedAt: '2026-11-01T10:00:00.000Z', state: 'running' })
    writeFileSync(stopRequestPath(home), '')
    await coordinator.done
  })
})

describe('ST-58/AC-3: status, running or not, machine-readable', () => {
  it('with no record: stopped, and it starts nothing', async () => {
    const home = freshHome()
    expect(await statusOf(home)).toEqual({ status: 'stopped' })
    const text = await run(['status'], home)
    expect(text.code).toBe(0)
    expect(text.out).toBe('stopped: no coordinator is running for this OS user.')
    expect(existsSync(coordinatorPath(home))).toBe(false)
  })

  it('with a running coordinator: running, with its process id and start time and no other field', async () => {
    const home = freshHome()
    const coordinator = runCoordinator({ homedir: home, pollMs: 20 })
    expect(await statusOf(home)).toEqual({ status: 'running', pid: process.pid, startedAt: coordinator.record.startedAt })
    expect((await run(['status'], home)).out).toMatch(/^running: the coordinator is process \d+/)
    writeFileSync(stopRequestPath(home), '')
    await coordinator.done
  })

  it('with a record whose process is gone: stopped, saying the previous coordinator ended without removing its record', async () => {
    const home = freshHome()
    const pid = deadPid()
    mkdirSync(path.dirname(coordinatorPath(home)), { recursive: true })
    writeFileSync(coordinatorPath(home), JSON.stringify({ pid, startedAt: '2026-11-01T10:00:00.000Z', state: 'running' }))
    expect(await statusOf(home)).toEqual({
      status: 'stopped', pid, startedAt: '2026-11-01T10:00:00.000Z', note: 'the previous coordinator ended without removing its record',
    })
    expect((await run(['status'], home)).out).toMatch(/^stopped: the previous coordinator ended without removing its record/)
  })
})

describe('ST-58/AC-4: stop drains, returns promptly, and closes admission on acknowledgment', () => {
  it('with a held job: stop returns stopping, admission is refused, and the coordinator stops when the job completes', async () => {
    const home = freshHome()
    const coordinator = runCoordinator({ homedir: home, pollMs: 20 })
    let release
    const held = new Promise((resolve) => { release = resolve })
    expect(coordinator.admit(() => held)).toBe(true)

    const stopped = await run(['stop'], home)
    expect(stopped.code).toBe(0)
    expect(stopped.out).toMatch(/^stopping: the coordinator, process \d+, admits no more work/)
    expect(stopped.out).toContain('this does not wait for that')

    let ranLater = false
    expect(coordinator.admit(async () => { ranLater = true })).toBe(false)
    expect((await statusOf(home)).status).toBe('stopping')

    const again = await run(['stop'], home)
    expect(again.code).toBe(0)
    expect(again.out).toMatch(/^stopping: /)

    release()
    expect(await coordinator.done).toBe(null)
    expect(ranLater).toBe(false)
    expect(existsSync(coordinatorPath(home))).toBe(false)
    expect(await statusOf(home)).toEqual({ status: 'stopped' })

    const already = await run(['stop'], home)
    expect(already.code).toBe(0)
    expect(already.out).toBe('stopped: no coordinator is running for this OS user; there is nothing to stop.')
  })

  it('a stop request is acknowledged before admission is refused, not after the coordinator exits', async () => {
    const home = freshHome()
    const coordinator = runCoordinator({ homedir: home, pollMs: 20 })
    let release
    expect(coordinator.admit(() => new Promise((resolve) => { release = resolve }))).toBe(true)
    writeFileSync(stopRequestPath(home), '')
    await until(() => readRecord(coordinatorPath(home))?.state === 'stopping')
    expect(existsSync(stopRequestPath(home))).toBe(false)
    expect(coordinator.admit(async () => {})).toBe(false)
    release()
    await coordinator.done
  })
})

describe('ST-58/AC-5: exiting and starting again', () => {
  it('an ordinary stop with no admitted work removes the record', async () => {
    const home = freshHome()
    const coordinator = runCoordinator({ homedir: home, pollMs: 20 })
    expect((await run(['stop'], home)).out).toMatch(/^stopped: .* had no work running/)
    expect(await coordinator.done).toBe(null)
    expect(existsSync(coordinatorPath(home))).toBe(false)
  })

  it('start after a coordinator was killed while idle replaces its record, says so, and starts', async () => {
    const home = freshHome()
    const { spawnFn, spawned } = countingSpawn()
    expect((await run(['start'], home, { spawnFn })).code).toBe(0)
    const first = await settledRecord(home)
    process.kill(first.pid)
    await until(() => !isRunning(first.pid))
    expect(readRecord(coordinatorPath(home))).toEqual(first)

    const again = await run(['start'], home, { spawnFn })
    expect(again.code).toBe(0)
    expect(again.out).toContain(`The previous coordinator, process ${first.pid}, started ${first.startedAt}, ended without removing its record; replacing that record.`)
    const second = readRecord(coordinatorPath(home))
    expect(second.pid).toBe(spawned[1])
    expect(second.pid).not.toBe(first.pid)
    expect(again.out).toMatch(new RegExp(`started: .* process ${second.pid}`))

    expect((await run(['stop'], home)).code).toBe(0)
    await until(() => !isRunning(second.pid))
  })
})

describe('ST-58/AC-6: manual commands do not ask the coordinator', () => {
  it('review, rotation and land read neither the coordinator module nor its record', () => {
    for (const name of ['review', 'rotation', 'land']) {
      const source = readFileSync(path.join(DISPATCH, `${name}.mjs`), 'utf8')
      expect(source).not.toMatch(/coordinator\.mjs|coordinator\.json|coordinator\.stop/)
    }
  })
})

const HEAD = 'a'.repeat(40)
const candidate = { repo: 'crew/client', number: 7, expectedHeadSha: HEAD }
const identity = { repo: 'crew/client', number: 7, headSha: HEAD }
const STARTED = '2026-11-01T09:00:00.000Z'
const runningEntry = (over = {}) => ({ ...identity, state: 'running', startedAt: STARTED, ...over })
const endedEntry = (over = {}) => ({
  ...identity, number: 3, state: 'ended', startedAt: STARTED, endedAt: STARTED, result: { status: 'recorded', sessions: 1 }, ...over,
})

function seedFile(file, content) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  return file
}
const seedReviews = (home, content) => seedFile(reviewsPath(home), content)
/** A record naming a process that has gone, as a coordinator killed leaves. */
const seedStaleRecord = (home) => {
  const record = { pid: deadPid(), startedAt: STARTED, state: 'running' }
  seedFile(coordinatorPath(home), record)
  return record
}

describe('ST-60/AC-3: a graceful stop and start', () => {
  it('a stand-in review held through a stop finishes and writes its outcome, and it survives a restart', async () => {
    const home = freshHome()
    const coordinator = runCoordinator({ homedir: home, pollMs: 20 })
    let release
    const review = vi.fn(() => new Promise((resolve) => { release = () => resolve({ status: 'recorded', sessions: 1 }) }))
    const outcome = admitReview({ homedir: home, admit: coordinator.admit, candidate, review })
    await until(() => review.mock.calls.length === 1)

    expect((await run(['stop'], home)).out).toMatch(/^stopping: /)
    const later = vi.fn()
    expect(await admitReview({ homedir: home, admit: coordinator.admit, candidate: { ...candidate, number: 8 }, review: later })).toEqual({ status: 'admission-closed' })
    expect(later).not.toHaveBeenCalled()
    expect(readReviews(reviewsPath(home))[0].state).toBe('running')

    release()
    expect(await coordinator.done).toBe(null)
    expect((await outcome).status).toBe('ended')
    const before = readFileSync(reviewsPath(home), 'utf8')

    const { spawnFn, spawned } = countingSpawn()
    const again = await run(['start'], home, { spawnFn })
    expect(again.code).toBe(0)
    expect(again.out).toMatch(/^started: /)
    expect(again.out).not.toMatch(/interrupted/)
    expect(readFileSync(reviewsPath(home), 'utf8')).toBe(before)
    expect(reviewEnding({ homedir: home, ...identity })).toBe('verdict')

    expect((await run(['stop'], home)).code).toBe(0)
    await until(() => !isRunning(spawned[0]))
  })
})

describe('ST-60/AC-4: interrupted while idle', () => {
  it('a stand-in coordinator killed with no running entry restarts as after a clean stop, leaving the entries as they were', async () => {
    const home = freshHome()
    const file = seedReviews(home, { reviews: [endedEntry()] })
    const before = readFileSync(file, 'utf8')
    const { spawnFn, spawned } = countingSpawn()
    expect((await run(['start'], home, { spawnFn })).code).toBe(0)
    const first = readRecord(coordinatorPath(home))
    process.kill(first.pid)
    await until(() => !isRunning(first.pid))

    const again = await run(['start'], home, { spawnFn })
    expect(again.code).toBe(0)
    expect(again.out).toMatch(/started: /)
    expect(again.out).not.toMatch(/interrupted/)
    expect(again.err).toBe('')
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(readRecord(coordinatorPath(home)).pid).toBe(spawned[1])

    expect((await run(['stop'], home)).code).toBe(0)
    await until(() => !isRunning(spawned[1]))
  })

  it('with no record of reviews at all, start writes none', async () => {
    const home = freshHome()
    seedStaleRecord(home)
    const { spawnFn, spawned } = countingSpawn()
    expect((await run(['start'], home, { spawnFn })).code).toBe(0)
    expect(existsSync(reviewsPath(home))).toBe(false)
    expect((await run(['stop'], home)).code).toBe(0)
    await until(() => !isRunning(spawned[0]))
  })
})

describe('ST-60/AC-4a: interrupted during a review', () => {
  it('a stand-in coordinator killed during a review: start moves its entry to interrupted, says so, and starts', async () => {
    const home = freshHome()
    const file = reviewsPath(home)
    const url = (name) => JSON.stringify(pathToFileURL(path.join(DISPATCH, name)).href)
    const script = `
      import { runCoordinator } from ${url('coordinator.mjs')}
      import { admitReview } from ${url('review-admission.mjs')}
      const [, homedir, candidate] = process.argv
      const { admit } = runCoordinator({ homedir })
      admitReview({ homedir, admit, candidate: JSON.parse(candidate), review: () => new Promise(() => {}) })
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, home, JSON.stringify(candidate)], { stdio: 'ignore' })
    started.push(child.pid)
    await until(() => existsSync(file) && readFileSync(file, 'utf8').endsWith('\n'))
    const [running] = readReviews(file)
    expect(running.state).toBe('running')
    process.kill(child.pid)
    await until(() => !isRunning(child.pid))
    expect(readReviews(file)).toEqual([running])

    const { spawnFn, spawned } = countingSpawn()
    const result = await run(['start'], home, { spawnFn })
    expect(result.code).toBe(0)
    expect(result.out).toContain(`crew/client pull request #7, head ${HEAD}`)
    expect(result.out).toContain('this head will not be reviewed again automatically')
    expect(result.out).toContain('A manual review of it, or a new head, is how it gets a verdict')
    expect(result.out).toMatch(/started: /)
    const [moved] = readReviews(file)
    expect(moved).toEqual({ ...running, state: 'ended', endedAt: expect.any(String), result: { status: 'interrupted' } })
    expect(reviewEnding({ homedir: home, ...identity })).toBe('model-consuming-failure')
    expect(readRecord(coordinatorPath(home)).pid).toBe(spawned[0])

    // Once moved, a later start has nothing to say about it.
    expect((await run(['stop'], home)).code).toBe(0)
    await until(() => !isRunning(spawned[0]))
    const before = readFileSync(file, 'utf8')
    const later = await run(['start'], home, { spawnFn })
    expect(later.out).not.toMatch(/interrupted/)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect((await run(['stop'], home)).code).toBe(0)
    await until(() => !isRunning(spawned[1]))
  })

  it('moves every running entry before the launch, names each, and leaves ended entries as they were', async () => {
    const home = freshHome()
    const other = runningEntry({ repo: 'crew/other', number: 9, headSha: 'b'.repeat(40) })
    const ended = endedEntry()
    const file = seedReviews(home, { reviews: [runningEntry(), ended, other] })
    let atLaunch
    const { spawnFn: counting, spawned } = countingSpawn()
    const spawnFn = (...args) => {
      atLaunch = readReviews(file)
      return counting(...args)
    }
    const result = await run(['start'], home, { spawnFn })
    expect(result.code).toBe(0)
    expect(result.out).toContain(`crew/client pull request #7, head ${HEAD}`)
    expect(result.out).toContain(`crew/other pull request #9, head ${'b'.repeat(40)}`)
    expect(atLaunch.map(({ state }) => state)).toEqual(['ended', 'ended', 'ended'])
    const reviews = readReviews(file)
    expect(reviews).toEqual(atLaunch)
    expect(reviews[1]).toEqual(ended)
    expect(reviews[0].result).toEqual({ status: 'interrupted' })
    expect(reviews[2].result).toEqual({ status: 'interrupted' })
    expect((await run(['stop'], home)).code).toBe(0)
    await until(() => !isRunning(spawned[0]))
  })

  it('a start that finds a running coordinator changes no entry and reports already-running', async () => {
    const home = freshHome()
    const { spawnFn, spawned } = countingSpawn()
    expect((await run(['start'], home, { spawnFn })).code).toBe(0)
    const file = seedReviews(home, { reviews: [runningEntry()] })
    const before = readFileSync(file, 'utf8')
    const second = await run(['start'], home, { spawnFn })
    expect(second.code).toBe(1)
    expect(second.err).toMatch(/^already-running: /)
    expect(second.out).toBe('')
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(spawned).toHaveLength(1)
    expect((await run(['stop'], home)).code).toBe(0)
    await until(() => !isRunning(spawned[0]))
  })

  it('a start that finds the file malformed refuses, launches nothing, names the file, and leaves the file, the record and a stop request as they were', async () => {
    const home = freshHome()
    const file = seedReviews(home, '{ "reviews": [')
    const record = seedStaleRecord(home)
    const stopFile = seedFile(stopRequestPath(home), 'left over\n')
    const spawnFn = vi.fn()
    const result = await run(['start'], home, { spawnFn })
    expect(result.code).toBe(1)
    expect(result.err).toContain(`The coordinator did not start: it could not read or update its record of reviews, ${file}.`)
    expect(result.err).toContain(`${file} is malformed`)
    expect(result.err).toContain('Nothing was started.')
    expect(result.out).toBe('')
    expect(spawnFn).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf8')).toBe('{ "reviews": [')
    expect(readRecord(coordinatorPath(home))).toEqual(record)
    expect(existsSync(stopFile)).toBe(true)
  })

  // A `start` whose own write fails is in `review-admission-write.test.mjs`.
})

describe('ST-60/AC-5: only start changes this', () => {
  it('status and stop change no entry and admit no work: with no coordinator, with a dead one, and with a running one', async () => {
    const home = freshHome()
    const file = seedReviews(home, { reviews: [runningEntry()] })
    const before = readFileSync(file, 'utf8')
    const spawnFn = vi.fn()
    const asks = async (status) => {
      for (const argv of [['status'], ['status', '--json']]) {
        const result = await run(argv, home, { spawnFn })
        expect(result.code).toBe(0)
        expect(result.out).toContain(status)
        expect(result.out).not.toMatch(/interrupted/)
      }
      expect(readFileSync(file, 'utf8')).toBe(before)
    }

    await asks('stopped')
    expect((await run(['stop'], home, { spawnFn })).out).toMatch(/^stopped: /)
    expect(readFileSync(file, 'utf8')).toBe(before)

    seedStaleRecord(home)
    await asks('stopped')
    expect((await run(['stop'], home, { spawnFn })).out).toMatch(/^stopped: /)
    expect(readFileSync(file, 'utf8')).toBe(before)
    rmSync(coordinatorPath(home))

    const coordinator = runCoordinator({ homedir: home, pollMs: 20 })
    await asks('running')
    // With no work admitted, it has none to wait for.
    expect((await run(['stop'], home, { spawnFn })).out).toMatch(/^stopped: .* had no work running/)
    expect(await coordinator.done).toBe(null)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(spawnFn).not.toHaveBeenCalled()
  })
})

describe('ST-60/AC-6: what an interruption does is documented', () => {
  it('the design of record has no ST-60 marker, and it and the README give the interruption and its accepted risk', () => {
    const design = readFileSync(path.join(ROOT, 'docs', 'agent-workflow-design.md'), 'utf8')
    expect(design).not.toMatch(/\*\*Planned \([^)]*\bST-60\b/)
    for (const doc of [design, readFileSync(path.join(ROOT, 'README.md'), 'utf8')]) {
      const text = doc.replace(/\s+/g, ' ')
      expect(text).toContain('`interrupted`')
      expect(text).toContain('may still post a verdict')
      expect(text).toContain('not reviewed again automatically')
    }
  })
})

describe('ST-61/AC-5: the interval', () => {
  // The interval is in the record `start` waits for. The next scan is shown with an injected clock,
  // in `coordinator-scheduler.test.mjs`.
  const configure = (home, config) => writeFileSync(userConfigPath({ env: {}, homedir: home }), typeof config === 'string' ? config : JSON.stringify(config))
  const { coordinator: _cadence, ...noSection } = fixtureUserConfig()

  it('with no coordinator section, start hands on the default, and status reports it, in a home with no activated project', async () => {
    const home = freshHome()
    configure(home, noSection)
    const { spawnFn, spawned } = countingSpawn()
    const started = await run(['start'], home, { spawnFn })
    expect(started.code).toBe(0)
    expect(started.out).toContain('every 15 minutes')
    expect(readRecord(coordinatorPath(home)).intervalMinutes).toBe(15)
    await settledRecord(home)
    const status = await statusOf(home)
    expect(status).toMatchObject({ status: 'running', intervalMinutes: 15 })
    expect(status).not.toHaveProperty('lastOutcome')
    expect(status.projectProblems ?? []).toEqual([])
    expect((await run(['status'], home)).out).toContain('Scan interval: 15 minutes.')
    expect((await run(['stop'], home)).code).toBe(0)
    await until(() => !isRunning(spawned[0]))
  })

  it('a configured interval is the effective one, and a change takes effect at the next start', async () => {
    const home = freshHome()
    configure(home, fixtureUserConfig({ coordinator: { scanIntervalMinutes: 10_080 } }))
    const { spawnFn, spawned } = countingSpawn()
    expect((await run(['start'], home, { spawnFn })).code).toBe(0)
    await settledRecord(home)
    expect((await statusOf(home)).intervalMinutes).toBe(10_080)

    configure(home, fixtureUserConfig({ coordinator: { scanIntervalMinutes: 60 } }))
    expect((await statusOf(home)).intervalMinutes).toBe(10_080)
    expect((await run(['stop'], home)).code).toBe(0)
    await until(() => !isRunning(spawned[0]))

    expect((await run(['start'], home, { spawnFn })).code).toBe(0)
    await settledRecord(home)
    expect((await statusOf(home)).intervalMinutes).toBe(60)
    expect((await run(['stop'], home)).code).toBe(0)
    await until(() => !isRunning(spawned[1]))
  })

  it('the largest interval ST-63 accepts: start and status say it in full, with no next scan, and the coordinator keeps running', async () => {
    const largest = Math.floor(Number.MAX_SAFE_INTEGER / 60_000)
    const home = freshHome()
    configure(home, fixtureUserConfig({ coordinator: { scanIntervalMinutes: largest } }))
    const { spawnFn, spawned } = countingSpawn()
    const result = await run(['start'], home, { spawnFn })
    expect(result.code).toBe(0)
    expect(result.out).toContain(`every ${largest} minutes`)
    await settledRecord(home)
    expect(isRunning(spawned[0])).toBe(true)
    const status = await statusOf(home)
    expect(status).toMatchObject({ status: 'running', intervalMinutes: largest })
    expect(status.nextScanAt ?? null).toBe(null)
    const text = (await run(['status'], home)).out
    expect(text).toContain(`Scan interval: ${largest} minutes.`)
    expect(text).not.toContain('Next scan')
    expect((await run(['stop'], home)).code).toBe(0)
    await until(() => !isRunning(spawned[0]))
  })

  for (const [name, config, message] of [
    ['an invalid interval', fixtureUserConfig({ coordinator: { scanIntervalMinutes: 0 } }), "'coordinator.scanIntervalMinutes' must be a positive integer"],
    ['a file that is not JSON', '{ "usageLimits":', 'invalid JSON'],
  ]) {
    it(`${name}: start refuses, starting nothing and changing nothing`, async () => {
      const home = freshHome()
      configure(home, config)
      const file = seedReviews(home, { reviews: [runningEntry()] })
      const before = readFileSync(file, 'utf8')
      const record = seedStaleRecord(home)
      const stopFile = seedFile(stopRequestPath(home), 'left over\n')
      const spawnFn = vi.fn()
      const result = await run(['start'], home, { spawnFn })
      expect(result.code).toBe(1)
      expect(result.err).toContain('The coordinator did not start: it could not read its scan interval from the user config.')
      expect(result.err).toContain(message)
      expect(result.err).toContain('Nothing was started.')
      expect(result.out).toBe('')
      expect(spawnFn).not.toHaveBeenCalled()
      expect(readFileSync(file, 'utf8')).toBe(before)
      expect(readRecord(coordinatorPath(home))).toEqual(record)
      expect(existsSync(stopFile)).toBe(true)
    })
  }

  it('no user config at all: start refuses, naming the file', async () => {
    const home = freshHome()
    rmSync(userConfigPath({ env: {}, homedir: home }))
    const spawnFn = vi.fn()
    const result = await run(['start'], home, { spawnFn })
    expect(result.code).toBe(1)
    expect(result.err).toContain(`${userConfigPath({ env: {}, homedir: home })}: file not found`)
    expect(spawnFn).not.toHaveBeenCalled()
  })
})

describe('steward coordinator: its command line', () => {
  it('a command it does not take prints its usage and exits 2', async () => {
    const result = await run(['restart'], freshHome())
    expect(result.code).toBe(2)
    expect(result.err).toMatch(/^usage: steward coordinator start/)
  })
})
