// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as spawnModule from './spawn.mjs'
import { resolveClaudeExecutable, runSession, spawnSession } from './spawn.mjs'
import { buildInvocation } from './invocation.mjs'
import { classifySession, RAW_RECORD_FIELDS, validateRawRecord } from './outcome.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const STAND_IN = path.join(here, 'fixtures', 'stand-in-session.mjs')
const CODER_TEMPLATE = readFileSync(path.join(repoRoot, '.claude/prompts/coder.md'), 'utf8')

const NODE = process.execPath
const run = (mode, arg, overrides = {}) => runSession({
  role: 'coder',
  executable: NODE,
  cwd: repoRoot,
  args: arg === undefined ? [STAND_IN, mode] : [STAND_IN, mode, String(arg)],
  env: process.env,
  prompt: 'hello',
  timeoutMs: 20_000,
  stallMs: 20_000,
  ...overrides,
})

const isGone = (pid) => {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error.code === 'ESRCH'
  }
}

// A killed process can linger briefly before the OS reaps it (a zombie on
// POSIX), so a descendant is given a moment to go rather than checked once.
const waitGone = async (pid, ms = 3000) => {
  const deadline = Date.now() + ms
  while (!isGone(pid)) {
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 50))
  }
  return true
}

// Runs the `tree` stand-in and returns the result plus the grandchild's pid,
// killing the grandchild afterwards if it survived so a failure cannot leak.
const runTree = async (overrides) => {
  const result = await run('tree', undefined, overrides)
  const grandchild = Number(result.record.stdout.match(/grandchild (\d+)/)?.[1])
  expect(grandchild).toBeGreaterThan(0)
  const grandchildGone = await waitGone(grandchild)
  if (!grandchildGone) process.kill(grandchild, 'SIGKILL')
  return { ...result, grandchildGone }
}

const STORY = { id: 'OQ-65', path: 'stories/OQ-65-spawn-sessions.md', text: 'story text', model: 'sonnet' }
const CODER_OPTIONS = {
  role: 'coder',
  promptTemplate: CODER_TEMPLATE,
  story: STORY,
  branch: 'story/OQ-65-spawn-sessions',
  cwd: repoRoot,
  baseEnv: { PATH: '/usr/bin' },
  emptyGhConfigDir: '/tmp/empty-gh',
}

describe('OQ-65/AC-1 the entry point joins invocation, run and classification', () => {
  it('runs what buildInvocation built and returns classifySession of the record', async () => {
    const expected = buildInvocation(CODER_OPTIONS)
    const record = { role: 'coder', exitCode: 0, signal: null, stdout: '{"not":"a result"}', stoppedFor: null }
    const fakeRun = vi.fn().mockResolvedValue({ record, pid: 1 })

    const result = await spawnSession({ ...CODER_OPTIONS, executable: '/bin/claude.exe', run: fakeRun })

    expect(fakeRun).toHaveBeenCalledOnce()
    expect(fakeRun.mock.calls[0][0]).toMatchObject({
      role: 'coder',
      executable: '/bin/claude.exe',
      args: expected.args,
      env: expected.env,
    })
    // The injected-block boundary carries a fresh random nonce per render.
    const unnonced = (text) => text.replace(/\b[0-9a-f]{12}\b/g, '<nonce>')
    expect(unnonced(fakeRun.mock.calls[0][0].prompt)).toBe(unnonced(expected.prompt))
    expect(result.classification).toEqual(classifySession(record))
    expect(result.output).toEqual({ not: 'a result' })
    expect(result.record).toEqual(record)
  })

  it('carries a real process through to a classification', async () => {
    const result = await spawnSession({
      ...CODER_OPTIONS,
      executable: NODE,
      run: (o) => runSession({ ...o, args: [STAND_IN, 'exit', '3'] }),
    })
    expect(result.classification.outcome).toBe('died')
    expect(result.classification.reason).toBe('exit code 3')
    expect(result.output).toBeNull()
  })

  it('reports a timeout through the classification', async () => {
    const result = await spawnSession({
      ...CODER_OPTIONS,
      executable: NODE,
      timeoutMs: 300,
      run: (o) => runSession({ ...o, args: [STAND_IN, 'sleep'] }),
    })
    expect(result.classification.outcome).toBe('timed-out')
  })
})

describe('OQ-65/AC-2 the binary is started directly, never through a shell', () => {
  it('passes shell: false and does not name cmd.exe or a shell', async () => {
    const real = (await import('node:child_process')).spawn
    const spy = vi.fn(real)
    await run('exit', 0, { spawnFn: spy })

    expect(spy).toHaveBeenCalledOnce()
    const [executable, , options] = spy.mock.calls[0]
    expect(options.shell).toBe(false)
    expect(executable).toBe(NODE)
    expect(executable).not.toMatch(/cmd(\.exe)?$|(^|[\\/])(ba|z)?sh(\.exe)?$/i)
  })

  it('stops a session without a shell either', async () => {
    const real = (await import('node:child_process')).spawn
    const spy = vi.fn(real)
    await runTree({ spawnFn: spy, timeoutMs: 1000 })

    // The session itself, plus taskkill on Windows.
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1)
    for (const [executable, , options] of spy.mock.calls) {
      expect(options.shell).toBe(false)
      expect(executable).not.toMatch(/cmd(\.exe)?$|(^|[\\/])(ba|z)?sh(\.exe)?$/i)
    }
  })

  it('resolves the real binary beside a PATH entry, not the shim', () => {
    const bin = path.join('/npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    const found = resolveClaudeExecutable({
      env: { PATH: '/npm', APPDATA: '' },
      exists: (p) => p === bin,
    })
    expect(found).toBe(bin)
  })

  it('reports an error when it cannot resolve, rather than falling back to a shell', () => {
    expect(() => resolveClaudeExecutable({ env: { PATH: '/nowhere' }, exists: () => false }))
      .toThrow(/could not resolve the claude binary/)
    expect(() => resolveClaudeExecutable({ env: { CLAUDE_EXECUTABLE: '/missing' }, exists: () => false }))
      .toThrow(/CLAUDE_EXECUTABLE does not exist/)
  })

  it('rejects when the executable cannot be started', async () => {
    await expect(run('exit', 0, { executable: path.join(here, 'no-such-binary') })).rejects.toThrow()
  })
})

describe('OQ-65/AC-3 the prompt arrives on stdin, intact', () => {
  it('delivers a prompt longer than 32,767 characters, multibyte included', async () => {
    const prompt = 'line ✓ é 你好\n'.repeat(6000)
    expect(prompt.length).toBeGreaterThan(32_767)

    const { record } = await run('echo', undefined, { prompt })

    expect(record.exitCode).toBe(0)
    expect(JSON.parse(record.stdout)).toEqual({
      length: prompt.length,
      sha256: createHash('sha256').update(prompt, 'utf8').digest('hex'),
    })
  })

  it('keeps the prompt out of the argument list', () => {
    const { args, prompt } = buildInvocation(CODER_OPTIONS)
    expect(args.some((a) => a.includes(prompt.slice(0, 80)))).toBe(false)
  })
})

describe('OQ-65/AC-4 a timeout terminates the child', () => {
  it('kills the process, records the timeout, and the pid is gone', async () => {
    const { record, pid } = await run('sleep', undefined, { timeoutMs: 400 })
    expect(record.stoppedFor).toBe('timeout')
    expect(isGone(pid)).toBe(true)
  })

  it('kills the child\'s descendants too, not only the child', async () => {
    const { record, pid, grandchildGone } = await runTree({ timeoutMs: 1000 })
    expect(record.stoppedFor).toBe('timeout')
    expect(isGone(pid)).toBe(true)
    expect(grandchildGone).toBe(true)
  })
})

describe('OQ-65/AC-5 a silent session is terminated as stalled', () => {
  it('kills a session that stops producing output, and the pid is gone', async () => {
    const { record, pid } = await run('hang', undefined, { stallMs: 500, timeoutMs: 20_000 })
    expect(record.stoppedFor).toBe('stall')
    expect(record.stdout).toContain('started')
    expect(isGone(pid)).toBe(true)
  })

  it('kills a stalled session\'s descendants too', async () => {
    const { record, pid, grandchildGone } = await runTree({ stallMs: 1000, timeoutMs: 20_000 })
    expect(record.stoppedFor).toBe('stall')
    expect(isGone(pid)).toBe(true)
    expect(grandchildGone).toBe(true)
  })

  it('does not stall a session that keeps producing output', async () => {
    const { record, pid } = await run('chatty', 100, { stallMs: 500, timeoutMs: 1500 })
    expect(record.stoppedFor).toBe('timeout')
    expect(isGone(pid)).toBe(true)
  })
})

describe('OQ-65/AC-6 raw records conform to outcome.mjs', () => {
  const keys = [...RAW_RECORD_FIELDS].sort()

  it.each([
    ['exits', () => run('exit', 0), null, 'died'],
    ['times out', () => run('sleep', undefined, { timeoutMs: 300 }), 'timeout', 'timed-out'],
    ['stalls', () => run('hang', undefined, { stallMs: 300 }), 'stall', 'stalled'],
  ])('a session that %s', async (_name, start, stoppedFor, outcome) => {
    const { record } = await start()
    expect(Object.keys(record).sort()).toEqual(keys)
    expect(() => validateRawRecord(record)).not.toThrow()
    expect(record.stoppedFor).toBe(stoppedFor)
    // A stand-in that exits 0 with non-JSON output is not a completed session.
    expect(['died', 'malformed-output', outcome]).toContain(classifySession(record).outcome)
  })

  it('records the exit code of a session that exits', async () => {
    const { record } = await run('exit', 7)
    expect(record).toMatchObject({ role: 'coder', exitCode: 7, stoppedFor: null })
    expect(classifySession(record).outcome).toBe('died')
  })
})

describe('OQ-65/AC-7 no GitHub operation', () => {
  it('exports only the spawn surface', () => {
    expect(Object.keys(spawnModule).sort()).toEqual([
      'DEFAULT_STALL_MS',
      'DEFAULT_TIMEOUT_MS',
      'resolveClaudeExecutable',
      'runSession',
      'spawnSession',
    ])
  })

  it('imports nothing that talks to GitHub and names no gh call', () => {
    const source = readFileSync(path.join(here, 'spawn.mjs'), 'utf8')
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).sort()
    expect(imports).toEqual([
      './invocation.mjs', './outcome.mjs', 'node:child_process', 'node:fs', 'node:path',
    ])
    expect(source).not.toMatch(/api\.github\.com|\bgh (pr|api|run)\b/)
  })
})

describe('OQ-77/AC-1 runSession starts the process in the directory it is given', () => {
  it('runs the stand-in in a directory other than the test\'s own', async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'oq77-')))
    try {
      expect(dir).not.toBe(realpathSync(process.cwd()))
      const { record } = await run('cwd', undefined, { cwd: dir })
      expect(record.exitCode).toBe(0)
      expect(realpathSync(record.stdout)).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws before starting anything when cwd is missing', () => {
    const spy = vi.fn()
    expect(() => run('exit', 0, { cwd: undefined, spawnFn: spy })).toThrow(/requires a cwd/)
    expect(() => run('exit', 0, { cwd: '', spawnFn: spy })).toThrow(/requires a cwd/)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('OQ-77/AC-2 spawnSession passes cwd to run unchanged', () => {
  it('hands the same cwd to run', async () => {
    const record = { role: 'coder', exitCode: 0, signal: null, stdout: '{}', stoppedFor: null }
    const fakeRun = vi.fn().mockResolvedValue({ record, pid: 1 })
    await spawnSession({ ...CODER_OPTIONS, cwd: '/some/worktree', executable: '/bin/claude.exe', run: fakeRun })
    expect(fakeRun.mock.calls[0][0].cwd).toBe('/some/worktree')
  })

  it('throws before run is called when cwd is missing', async () => {
    const fakeRun = vi.fn()
    const { cwd: _omitted, ...withoutCwd } = CODER_OPTIONS
    await expect(spawnSession({ ...withoutCwd, executable: '/bin/claude.exe', run: fakeRun }))
      .rejects.toThrow(/requires a cwd/)
    expect(fakeRun).not.toHaveBeenCalled()
  })
})

describe('OQ-77/AC-3 a cwd that does not exist rejects', () => {
  it('rejects rather than running anywhere else', async () => {
    const spy = vi.fn()
    await expect(run('cwd', undefined, { cwd: path.join(tmpdir(), 'oq77-no-such-dir'), spawnFn: spy }))
      .rejects.toThrow(/cwd does not exist/)
    expect(spy).not.toHaveBeenCalled()
  })
})
