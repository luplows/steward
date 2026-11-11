// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { handoffRecord, readRaw, writeHandoffs } from './handoff-fixture.mjs'
import { handoffsPath, lockPath, readHandoffs, updateHandoffs } from './handoff.mjs'

const DISPATCH = path.dirname(fileURLToPath(import.meta.url))
const HANDOFF_URL = JSON.stringify(pathToFileURL(path.join(DISPATCH, 'handoff.mjs')).href)
const FIXTURE_URL = JSON.stringify(pathToFileURL(path.join(DISPATCH, 'handoff-fixture.mjs')).href)

// Every test has a temporary home of its own: the real `~/.steward/` is never read or written. The
// second process each test starts is a real `node`, which the test waits for, never kills by name.
let base
beforeAll(() => { base = mkdtempSync(path.join(tmpdir(), 'steward-lock-')) })
afterAll(() => { rmSync(base, { recursive: true, force: true }) })

let counter = 0
const freshHome = () => {
  const dir = path.join(base, `home-${++counter}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** Starts `script` as a module in a new node process; resolves its handle once it prints `ready`. */
function child(script, ...args) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)))
  let seen = ''
  const ready = new Promise((resolve) => {
    proc.stdout.on('data', (chunk) => {
      seen += chunk
      if (seen.includes('ready')) resolve()
    })
  })
  return { proc, exited, ready }
}

const pending = (n) => handoffRecord({ order: n })

describe('ST-93: writes to handoffs.json are serialized by a lock file', () => {
  it('ST-93: a write waits for a lock another process holds, then succeeds and loses nothing', async () => {
    const home = freshHome()
    const file = writeHandoffs(home, [pending(1), pending(2)])
    // The second process completes H-1 inside its locked step, which takes 700 ms.
    const script = `
      import { updateHandoffs } from ${HANDOFF_URL}
      const [, file] = process.argv
      updateHandoffs(file, (handoffs) => {
        console.log('ready')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700)
        const done = { admissionId: null, at: '2026-11-10T11:00:00.000Z', branch: 'b', headSha: 'd'.repeat(40), pr: { number: 3, url: 'u' }, draft: false }
        return { handoffs: handoffs.map((h) => (h.id === 'H-1' ? { ...h, status: 'completed', completion: done } : h)) }
      })
    `
    const other = child(script, file)
    await other.ready
    const started = Date.now()
    const result = updateHandoffs(file, (handoffs) => ({ handoffs: handoffs.map((h) => (h.id === 'H-2' ? { ...h, status: 'withdrawn' } : h)), result: 'done' }))
    const waited = Date.now() - started
    expect(await other.exited).toBe(0)
    expect(result).toEqual({ ok: true, result: 'done' })
    expect(waited).toBeGreaterThan(300)
    expect(readRaw(home).map((h) => [h.id, h.status])).toEqual([['H-1', 'completed'], ['H-2', 'withdrawn']])
    expect(existsSync(lockPath(file))).toBe(false)
  })

  it('ST-93: two processes writing as fast as they can lose no update', async () => {
    const home = freshHome()
    const file = writeHandoffs(home, [pending(1)])
    const add = `
      import { updateHandoffs } from ${HANDOFF_URL}
      import { handoffRecord } from ${FIXTURE_URL}
      export function addMany(file, count) {
        for (let i = 0; i < count; i += 1) {
          updateHandoffs(file, (handoffs, next) => {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
            return { handoffs: [...handoffs, handoffRecord({ order: next })], nextOrder: next + 1 }
          })
        }
      }
    `
    const script = `${add}
      const [, file] = process.argv
      console.log('ready')
      addMany(file, 25)
    `
    const other = child(script, file)
    await other.ready
    for (let i = 0; i < 25; i += 1) {
      updateHandoffs(file, (handoffs, next) => {
        sleepSync(2)
        return { handoffs: [...handoffs, handoffRecord({ order: next })], nextOrder: next + 1 }
      })
    }
    expect(await other.exited).toBe(0)
    const { handoffs, nextOrder } = readHandoffs(file)
    expect(handoffs).toHaveLength(51)
    expect(new Set(handoffs.map((h) => h.id)).size).toBe(51)
    expect(nextOrder).toBe(52)
    expect(existsSync(lockPath(file))).toBe(false)
  })

  /** The write that every refusal test attempts: it must change nothing when it is refused. */
  const attempt = (file, waitMs = 200) => {
    let changed = false
    const started = Date.now()
    try {
      updateHandoffs(file, (handoffs) => { changed = true; return { handoffs: handoffs.map((h) => ({ ...h, status: 'withdrawn' })) } }, { waitMs })
    } catch (error) {
      return { error, changed, waited: Date.now() - started }
    }
    return { error: null, changed, waited: Date.now() - started }
  }

  it('ST-93: a lock left by a process that is not running is never taken over: the write refuses after the wait, naming the file, the process and the time, and changes nothing', () => {
    const home = freshHome()
    const file = writeHandoffs(home, [pending(1)])
    const { pid } = spawnSync(process.execPath, ['-e', ''])
    const recorded = JSON.stringify({ pid, at: '2026-11-10T10:00:00.000Z' })
    writeFileSync(lockPath(file), recorded)
    const before = readFileSync(file, 'utf8')
    const { error, changed, waited } = attempt(file)
    expect(error).toMatchObject({ phase: 'lock' })
    expect(error.message).toContain(lockPath(file))
    expect(error.message).toContain(`it records process ${pid}, taken 2026-11-10T10:00:00.000Z`)
    expect(error.message).toContain('If that process is not running, delete the file')
    expect(waited).toBeGreaterThanOrEqual(150)
    expect(changed).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(readFileSync(lockPath(file), 'utf8')).toBe(recorded)
  })

  it('ST-93: a lock whose contents are not a lock is refused in the same way, and left', () => {
    const home = freshHome()
    const file = writeHandoffs(home, [pending(1)])
    writeFileSync(lockPath(file), 'not a lock')
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockPath(file), old, old)
    const before = readFileSync(file, 'utf8')
    const { error, changed } = attempt(file)
    expect(error).toMatchObject({ phase: 'lock' })
    expect(error.message).toContain('what it records cannot be read')
    expect(error.message).toContain('delete the file')
    expect(changed).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(readFileSync(lockPath(file), 'utf8')).toBe('not a lock')
  })

  it('ST-93: a lock that cannot be read at all is refused after the wait and not spun on, and left', () => {
    const home = freshHome()
    const file = writeHandoffs(home, [pending(1)])
    // A folder where the lock file should be: it exists, and reading it fails.
    mkdirSync(lockPath(file))
    const before = readFileSync(file, 'utf8')
    const { error, changed, waited } = attempt(file)
    expect(error).toMatchObject({ phase: 'lock' })
    expect(error.message).toContain('what it records cannot be read')
    expect(waited).toBeGreaterThanOrEqual(150)
    expect(waited).toBeLessThan(3000)
    expect(changed).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(existsSync(lockPath(file))).toBe(true)
  })

  it('ST-93: a lock a live process holds past the wait refuses the write, which changes nothing and leaves the lock', async () => {
    const home = freshHome()
    const file = writeHandoffs(home, [pending(1)])
    const holder = child(`
      import { writeFileSync } from 'node:fs'
      const [, lock] = process.argv
      writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' })
      console.log('ready')
      await new Promise((resolve) => setTimeout(resolve, 1500))
    `, lockPath(file))
    await holder.ready
    const before = readFileSync(file, 'utf8')
    let changed = false
    const started = Date.now()
    expect(() => updateHandoffs(file, () => { changed = true; return { handoffs: [] } }, { waitMs: 300 })).toThrow(
      expect.objectContaining({ phase: 'lock', message: expect.stringContaining('is held, and stayed held') }),
    )
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    expect(changed).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(existsSync(lockPath(file))).toBe(true)
    expect(await holder.exited).toBe(0)
  })

  it('ST-93: the lock is released when the change throws, refuses or writes nothing', () => {
    const home = freshHome()
    const file = writeHandoffs(home, [pending(1)])
    expect(() => updateHandoffs(file, () => { throw new Error('boom') })).toThrow('boom')
    expect(existsSync(lockPath(file))).toBe(false)
    expect(updateHandoffs(file, () => ({ refuse: 'no' }))).toMatchObject({ ok: false, reason: 'no' })
    expect(existsSync(lockPath(file))).toBe(false)
    expect(updateHandoffs(file, () => ({ result: 1 }))).toEqual({ ok: true, result: 1 })
    expect(existsSync(lockPath(file))).toBe(false)
    expect(handoffsPath(home)).toBe(file)
  })
})
