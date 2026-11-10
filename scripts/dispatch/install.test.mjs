// @vitest-environment node

// `installDependencies` runs the project's `setup` command (ST-7). The process starter is
// injected, so no test starts a real process, and none waits for a real long-running one.

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installDependencies } from './install.mjs'

const SETUP = { command: 'npm ci', timeoutMinutes: 5 }
const ENV = { PATH: '/bin', ONLY: 'this' }
// Far above any real pid limit, so that a group kill of it signals nothing real.
const FAKE_PID = 2_147_483_000

/** A fake child process. `behave(child)` says what it does once started. */
function fakeStarter(behave = () => {}) {
  const calls = []
  const children = []
  const spawnFn = (...args) => {
    const child = Object.assign(new EventEmitter(), {
      pid: FAKE_PID,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    })
    calls.push(args)
    children.push(child)
    // `taskkill` ends at once; everything else is the command under test.
    if (/taskkill/i.test(args[0])) setImmediate(() => child.emit('exit', 0))
    else behave(child)
    return child
  }
  return { spawnFn, calls, children }
}

const setupCalls = (starter) => starter.calls.filter(([file]) => !/taskkill/i.test(file))

afterEach(() => { vi.restoreAllMocks() })

describe('installDependencies', () => {
  it('ST-7/AC-1: runs the setting\'s command as one string through the shell, in the caller\'s cwd and env', async () => {
    const starter = fakeStarter((child) => setImmediate(() => child.emit('close', 0, null)))
    await installDependencies({ cwd: '/work/tree', env: ENV, setup: SETUP, spawnFn: starter.spawnFn })
    expect(setupCalls(starter)).toHaveLength(1)
    const [command, options] = setupCalls(starter)[0]
    expect(command).toBe('npm ci')
    expect(options.shell).toBe(true)
    expect(options.cwd).toBe('/work/tree')
    expect(options.env).toBe(ENV)
  })

  it('ST-7/AC-1: reads neither cwd nor env from the process', async () => {
    const starter = fakeStarter((child) => setImmediate(() => child.emit('close', 0, null)))
    process.env.ST7_SENTINEL = 'leak'
    try {
      await installDependencies({ cwd: '/work/tree', env: {}, setup: SETUP, spawnFn: starter.spawnFn })
    } finally {
      delete process.env.ST7_SENTINEL
    }
    const [, options] = setupCalls(starter)[0]
    expect(options.env).toEqual({})
    expect(options.cwd).not.toBe(process.cwd())
  })

  it('ST-7/AC-1 and AC-5: a null setup starts no process and resolves', async () => {
    const starter = fakeStarter()
    await expect(installDependencies({ cwd: '/work/tree', env: ENV, setup: null, spawnFn: starter.spawnFn }))
      .resolves.toBeUndefined()
    expect(starter.calls).toEqual([])
  })

  it('ST-7/AC-5: a setup that exits 0 resolves', async () => {
    const starter = fakeStarter((child) => setImmediate(() => child.emit('close', 0, null)))
    await expect(installDependencies({ cwd: '/w', env: ENV, setup: SETUP, spawnFn: starter.spawnFn }))
      .resolves.toBeUndefined()
  })

  it('ST-7/AC-5: a setup that exits non-zero rejects with the last lines of its output', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
    const starter = fakeStarter((child) => setImmediate(() => {
      child.stdout.emit('data', `${lines.slice(0, 15).join('\n')}\n`)
      child.stderr.emit('data', `${lines.slice(15).join('\n')}\n`)
      child.emit('close', 3, null)
    }))
    const error = await installDependencies({ cwd: '/w', env: ENV, setup: SETUP, spawnFn: starter.spawnFn })
      .catch((e) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('exited 3')
    expect(error.message).toContain('line 30')
    expect(error.message).toContain('line 11')
    expect(error.message).not.toContain('line 10\n')
  })

  it('ST-7/AC-5: a command that cannot be started rejects', async () => {
    const starter = fakeStarter((child) => setImmediate(() => child.emit('error', new Error('spawn ENOENT'))))
    await expect(installDependencies({ cwd: '/w', env: ENV, setup: SETUP, spawnFn: starter.spawnFn }))
      .rejects.toThrow(/spawn ENOENT/)
  })

  it('ST-7/AC-2 and AC-5: a setup that never exits is stopped at its limit, with its tree, and the rejection names the limit', async () => {
    const groupKill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const starter = fakeStarter() // never exits, never closes
    const error = await installDependencies({
      cwd: '/w', env: ENV, setup: { command: 'sleep 1000', timeoutMinutes: 7 }, timeoutMs: 20, spawnFn: starter.spawnFn,
    }).catch((e) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('20 ms')
    expect(error.message).toContain('sleep 1000')
    const child = starter.children[0]
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    if (process.platform === 'win32') {
      const [taskkill, args] = starter.calls[1]
      expect(taskkill).toMatch(/taskkill\.exe$/i)
      expect(args).toEqual(['/PID', String(FAKE_PID), '/T', '/F'])
    } else {
      expect(groupKill).toHaveBeenCalledWith(-FAKE_PID, 'SIGKILL')
    }
  })

  it('ST-7/AC-2: the limit is taken from the setting\'s minutes, named in the rejection', async () => {
    vi.useFakeTimers()
    try {
      vi.spyOn(process, 'kill').mockImplementation(() => true)
      const starter = fakeStarter()
      const result = installDependencies({
        cwd: '/w', env: ENV, setup: { command: 'slow', timeoutMinutes: 1 }, spawnFn: starter.spawnFn,
      }).catch((e) => e)
      await vi.advanceTimersByTimeAsync(59_999)
      expect(starter.children[0].kill).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(10) // the fake `taskkill` ends on setImmediate
      const error = await result
      expect(error.message).toContain('1 minute')
      expect(starter.children[0].kill).toHaveBeenCalledWith('SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('ST-7/AC-2: a limit longer than setTimeout can hold is not cut short', async () => {
    vi.useFakeTimers()
    try {
      vi.spyOn(process, 'kill').mockImplementation(() => true)
      const starter = fakeStarter()
      // 40000 minutes is 2.4e9 ms, over the 2^31 - 1 ms a single timer holds.
      const result = installDependencies({
        cwd: '/w', env: ENV, setup: { command: 'slow', timeoutMinutes: 40_000 }, spawnFn: starter.spawnFn,
      }).catch((e) => e)
      await vi.advanceTimersByTimeAsync(2 ** 31)
      expect(starter.children[0].kill).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(40_000 * 60_000 - 2 ** 31)
      await vi.advanceTimersByTimeAsync(10) // the fake `taskkill` ends on setImmediate
      const error = await result
      expect(error.message).toContain('40000 minutes')
      expect(starter.children[0].kill).toHaveBeenCalledWith('SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('ST-7/AC-5: a character split across two chunks of output is decoded whole', async () => {
    const euro = Buffer.from('€ done', 'utf8') // E2 82 AC ...
    const starter = fakeStarter((child) => setImmediate(() => {
      child.stdout.emit('data', euro.subarray(0, 2))
      child.stdout.emit('data', euro.subarray(2))
      child.emit('close', 1, null)
    }))
    const error = await installDependencies({ cwd: '/w', env: ENV, setup: SETUP, spawnFn: starter.spawnFn })
      .catch((e) => e)
    expect(error.message).toContain('€ done')
    expect(error.message).not.toContain('�')
  })

  it('ST-7/AC-2: a setup that closes after being stopped still rejects naming the limit', async () => {
    // The command closes as soon as the tree kill starts, before the kill has finished.
    const closeFirst = () => starter.children[0].emit('close', null, 'SIGKILL')
    vi.spyOn(process, 'kill').mockImplementation(() => { closeFirst(); return true })
    const starter = fakeStarter()
    const spawnFn = (file, ...rest) => {
      const child = starter.spawnFn(file, ...rest)
      if (/taskkill/i.test(file)) closeFirst()
      return child
    }
    const error = await installDependencies({
      cwd: '/w', env: ENV, setup: SETUP, timeoutMs: 20, spawnFn,
    }).catch((e) => e)
    expect(error.message).toContain('limit of 20 ms')
    expect(error.message).not.toContain('ended by')
  })

  for (const platform of ['win32', 'linux']) {
    it(`ST-7/AC-3: never passes an argument array beside shell: true (platform ${platform})`, async () => {
      const starter = fakeStarter((child) => setImmediate(() => child.emit('close', 0, null)))
      await installDependencies({ cwd: '/w', env: ENV, setup: SETUP, spawnFn: starter.spawnFn, platform })
      expect(setupCalls(starter)).toHaveLength(1)
      for (const call of starter.calls) {
        const withShell = call.some((arg) => arg !== null && typeof arg === 'object' && !Array.isArray(arg) && arg.shell === true)
        if (withShell) expect(call.some((arg) => Array.isArray(arg))).toBe(false)
      }
      const [command, options, ...rest] = setupCalls(starter)[0]
      expect(typeof command).toBe('string')
      expect(options.shell).toBe(true)
      expect(rest).toEqual([])
      // Off Windows the child leads a process group, for the tree kill; on Windows, no new console.
      expect(options.detached).toBe(platform !== 'win32')
    })
  }
})
