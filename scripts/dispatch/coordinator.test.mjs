// @vitest-environment node

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { coordinatorPath, isRunning, main, readRecord, runCoordinator, stopRequestPath } from './coordinator.mjs'

const DISPATCH = path.dirname(fileURLToPath(import.meta.url))

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
  mkdirSync(dir, { recursive: true })
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
    pollMs: 20,
    out: (line) => lines.out.push(line),
    err: (line) => lines.err.push(line),
    ...options,
  })
  return { code, out: lines.out.join('\n'), err: lines.err.join('\n') }
}

const statusOf = async (homedir) => JSON.parse((await run(['status', '--json'], homedir)).out)

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
    const record = readRecord(coordinatorPath(home))

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
    const first = readRecord(coordinatorPath(home))
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

describe('steward coordinator: its command line', () => {
  it('a command it does not take prints its usage and exits 2', async () => {
    const result = await run(['restart'], freshHome())
    expect(result.code).toBe(2)
    expect(result.err).toMatch(/^usage: steward coordinator start/)
  })
})
