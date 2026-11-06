// @vitest-environment node

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { codexCoderArgs, codexReviewerArgs, rateLimitsRpc, readCodexUsage, spawnCodexCoder, spawnCodexReviewer } from './codex.mjs'

// What `account/rateLimits/read` answered on the ChatGPT Plus plan on 2026-10-16, trimmed.
const PLUS = {
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1792180062 },
    secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1792717728 },
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    planType: 'plus',
  },
}
// A free plan's shape: one 30-day window, and no 5-hour or weekly one.
const FREE = {
  rateLimits: { primary: { usedPercent: 12, windowDurationMins: 43200, resetsAt: 1794000000 }, secondary: null, planType: 'free' },
}

let dir
beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), 'steward-codex-')) })
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

/**
 * A stand-in for `codex app-server --listen stdio://`, run with node: it answers `initialize` and
 * then `account/rateLimits/read` with `answer`, or, with `silent`, never answers the second.
 */
function fakeAppServer({ answer, silent = false }) {
  const script = path.join(dir, `app-server-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(script, `
    let buffer = ''
    const reply = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
    if (process.argv.slice(2).join(' ') !== 'app-server --listen stdio://') { console.error('bad args'); process.exit(3) }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      buffer += chunk
      let nl
      while ((nl = buffer.indexOf('\\n')) !== -1) {
        const m = JSON.parse(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1)
        if (m.method === 'initialize') reply({ id: m.id, result: { userAgent: 'fake' } })
        if (m.method === 'account/rateLimits/read' && !${silent}) reply({ id: m.id, result: ${JSON.stringify(answer ?? null)} })
      }
    })
    setInterval(() => {}, 1000)
  `)
  // The executable is node running the stand-in, given the arguments the real one gets. `first`
  // is the process the first call starts, the app server: on Windows `killTree` calls it again
  // to run `taskkill`, and that one is not the process under test.
  const fake = (_executable, args, options) => {
    const child = spawn(process.execPath, [script, ...args], options)
    fake.first ??= child
    return child
  }
  return fake
}

/** Resolves once `child` has exited, or rejects after `ms`: the stand-in never exits by itself. */
function exitsWithin(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL') // so that a failing test leaves no process running
      reject(new Error(`the process had not exited after ${ms} ms`))
    }, ms)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}

describe('ST-32/AC-3: Codex usage, read with no model call', () => {
  it('ST-32/AC-3: the app-server exchange sends initialize, then account/rateLimits/read, and stops the process', async () => {
    const spawnFn = fakeAppServer({ answer: PLUS })
    const answer = await rateLimitsRpc({ executable: 'codex', cwd: dir, timeoutMs: 20_000, spawnFn })
    expect(answer).toEqual({ ok: true, result: PLUS })
    await expect(exitsWithin(spawnFn.first, 5000)).resolves.toBeUndefined()
  }, 30_000)

  it('ST-32/AC-3: a Plus-shaped answer gives the 300-minute window as session and the 10080-minute one as weekly', async () => {
    const usage = await readCodexUsage({ executable: 'codex', cwd: dir, rpc: async () => ({ ok: true, result: PLUS }) })
    // Only each window's percent and reset time leave the module.
    expect(usage).toEqual({
      ok: true,
      session: { percent: 4, resetsAt: 1792180062 },
      weekly: { percent: 1, resetsAt: 1792717728 },
    })
  })

  it('ST-32/AC-3: the windows are found by their length, whichever of primary and secondary holds them', async () => {
    const swapped = { rateLimits: { primary: PLUS.rateLimits.secondary, secondary: PLUS.rateLimits.primary } }
    const usage = await readCodexUsage({ executable: 'codex', cwd: dir, rpc: async () => ({ ok: true, result: swapped }) })
    expect(usage).toMatchObject({ ok: true, session: { percent: 4 }, weekly: { percent: 1 } })
  })

  it('ST-32/AC-3: a free-plan answer, with one 43200-minute window, is unreadable', async () => {
    const usage = await readCodexUsage({ executable: 'codex', cwd: dir, rpc: async () => ({ ok: true, result: FREE }) })
    expect(usage).toEqual({ ok: false, reason: "Codex's rate limits have no 300-minute (session) window" })
  })

  it('ST-32/AC-3: a usedPercent that is not a number is unreadable', async () => {
    const bad = { rateLimits: { ...PLUS.rateLimits, secondary: { ...PLUS.rateLimits.secondary, usedPercent: '1' } } }
    const usage = await readCodexUsage({ executable: 'codex', cwd: dir, rpc: async () => ({ ok: true, result: bad }) })
    expect(usage).toEqual({ ok: false, reason: "Codex's 10080-minute window has no numeric usedPercent" })
  })

  it('ST-32/AC-3: no answer within the time limit is unreadable, and the process is stopped', async () => {
    const started = Date.now()
    const spawnFn = fakeAppServer({ silent: true })
    const usage = await readCodexUsage({
      executable: 'codex', cwd: dir, timeoutMs: 1500,
      rpc: (o) => rateLimitsRpc({ ...o, spawnFn }),
    })
    expect(usage).toEqual({ ok: false, reason: 'codex app-server gave no rate limits within 1.5 seconds' })
    expect(Date.now() - started).toBeLessThan(15_000)
    await expect(exitsWithin(spawnFn.first, 5000)).resolves.toBeUndefined()
  }, 30_000)

  it('ST-32/AC-3: a process that cannot start is unreadable', async () => {
    const usage = await readCodexUsage({ executable: path.join(dir, 'no-such-codex.exe'), cwd: dir, timeoutMs: 5000 })
    expect(usage.ok).toBe(false)
    expect(usage.reason).toMatch(/codex app-server/)
  }, 30_000)
})

describe('ST-32/AC-2, AC-5: the Codex reviewer session', () => {
  it('ST-32/AC-5: the invocation is read-only, in the checkout, and never widens the sandbox', () => {
    const args = codexReviewerArgs({ checkout: 'C:/tmp/tw-review-x/tree', model: 'gpt-6.1-sol', effort: 'high', outputFile: 'C:/tmp/tw-review-x/last.txt' })
    expect(args).toEqual([
      'exec', '-s', 'read-only', '-C', 'C:/tmp/tw-review-x/tree', '-m', 'gpt-6.1-sol',
      '-c', 'model_reasoning_effort="high"', '--json', '-o', 'C:/tmp/tw-review-x/last.txt', '--ephemeral', '-',
    ])
    for (const wider of ['workspace-write', 'danger-full-access', '--dangerously-bypass-approvals-and-sandbox', '--full-auto']) {
      expect(args).not.toContain(wider)
    }
  })

  const record = (over = {}) => ({ role: 'reviewer', exitCode: 0, signal: null, stdout: '{"type":"turn.completed"}\n', stoppedFor: null, ...over })

  it('ST-32/AC-2: starts codex exec with the prompt on stdin, in the checkout and the given environment, and reads the last message', async () => {
    const calls = []
    const result = await spawnCodexReviewer({
      executable: 'C:/codex.exe', cwd: 'C:/tmp/tree', model: 'gpt-6.1-sol', effort: 'xhigh', prompt: 'review this',
      env: { PATH: '/bin', GH_CONFIG_DIR: 'C:/tmp/gh' }, outputFile: 'C:/tmp/last.txt',
      run: async (o) => { calls.push(o); return { record: record(), pid: 1 } },
      readText: async (file) => `last message from ${file}`,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      role: 'reviewer', executable: 'C:/codex.exe', cwd: 'C:/tmp/tree', prompt: 'review this',
      env: { PATH: '/bin', GH_CONFIG_DIR: 'C:/tmp/gh' },
    })
    expect(calls[0].args.slice(0, 3)).toEqual(['exec', '-s', 'read-only'])
    expect(calls[0].args).toContain('model_reasoning_effort="xhigh"')
    expect(result.classification.outcome).toBe('completed')
    expect(result.output.result).toBe('last message from C:/tmp/last.txt')
  })

  it.each([
    ['timed-out', { stoppedFor: 'timeout' }],
    ['stalled', { stoppedFor: 'stall' }],
    ['died', { exitCode: 1 }],
    ['died', { exitCode: null, signal: 'SIGKILL' }],
  ])('ST-32/AC-2: a session that is stopped or fails is %s, with no output', async (outcome, over) => {
    const result = await spawnCodexReviewer({
      executable: 'codex', cwd: 'C:/tmp/tree', model: 'm', effort: 'low', prompt: 'p', env: {}, outputFile: 'C:/tmp/o.txt',
      run: async () => ({ record: record(over), pid: 1 }), readText: async () => 'never read',
    })
    expect(result.classification.outcome).toBe(outcome)
    expect(result.output).toBeNull()
  })

  it('ST-32/AC-2: a missing or empty last message is malformed-output', async () => {
    const base = { executable: 'codex', cwd: 'C:/tmp/tree', model: 'm', effort: 'low', prompt: 'p', env: {}, outputFile: 'C:/tmp/o.txt', run: async () => ({ record: record(), pid: 1 }) }
    const missing = await spawnCodexReviewer({ ...base, readText: async () => { throw new Error('ENOENT') } })
    expect(missing.classification.outcome).toBe('malformed-output')
    const empty = await spawnCodexReviewer({ ...base, readText: async () => '  \n' })
    expect(empty.classification.outcome).toBe('malformed-output')
  })
})

describe('ST-15/AC-2: the Codex coder invocation', () => {
  const given = {
    worktree: 'C:/tmp/tw-coder-x/tree', model: 'gpt-6.1-sol', effort: 'high', windowsSandbox: 'elevated',
    sessionTemp: 'C:/tmp/tw-coder-x/codex-session-1', outputFile: 'C:/tmp/tw-coder-x/codex-session-1-last-message.txt',
  }

  it('ST-15/AC-2: is exactly the trial list, in order', () => {
    expect(codexCoderArgs(given)).toEqual([
      'exec', '-s', 'workspace-write', '-C', 'C:/tmp/tw-coder-x/tree', '-m', 'gpt-6.1-sol',
      '-c', 'model_reasoning_effort="high"',
      '-c', 'approval_policy="never"',
      '-c', 'windows.sandbox="elevated"',
      '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
      '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
      '--add-dir', 'C:/tmp/tw-coder-x/codex-session-1',
      '--ignore-user-config', '--json', '-o', 'C:/tmp/tw-coder-x/codex-session-1-last-message.txt', '--ephemeral', '-',
    ])
  })

  it('ST-15/AC-2: takes the Windows sandbox mode and the effort from its arguments', () => {
    const args = codexCoderArgs({ ...given, windowsSandbox: 'unelevated', effort: 'xhigh' })
    expect(args).toContain('windows.sandbox="unelevated"')
    expect(args).toContain('model_reasoning_effort="xhigh"')
  })

  it('ST-15/AC-2: refuses a missing argument, and never widens the sandbox', () => {
    for (const name of Object.keys(given)) {
      expect(() => codexCoderArgs({ ...given, [name]: '' })).toThrow(`codexCoderArgs requires ${name}`)
    }
    for (const wider of ['read-only', 'danger-full-access', '--dangerously-bypass-approvals-and-sandbox', '--full-auto']) {
      expect(codexCoderArgs(given)).not.toContain(wider)
    }
  })
})

describe('ST-15/AC-3: the Codex coder session', () => {
  const REPORT = 'Done.\n\n## PR title\nDo the thing\n\n## PR body\n### What changed\n\nIt did.\n\n## Open as\nready'
  const record = (over = {}) => ({ role: 'coder', exitCode: 0, signal: null, stdout: '{"type":"turn.completed"}\n', stoppedFor: null, ...over })
  const base = (scratch, over = {}) => ({
    executable: 'C:/codex.exe', cwd: path.join(scratch, 'tree'), model: 'gpt-6.1-sol', effort: 'high', windowsSandbox: 'elevated',
    prompt: 'implement this', baseEnv: { PATH: '/bin', GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret', TMP: 'C:/shared/tmp' },
    emptyGhConfigDir: path.join(scratch, 'gh-config'), scratch, ...over,
  })

  it('ST-15/AC-3: runs through runSession with the prompt on stdin, the coder environment and the session temp folder', async () => {
    const scratch = mkdtempSync(path.join(dir, 'coder-'))
    const calls = []
    const result = await spawnCodexCoder({
      ...base(scratch), timeoutMs: 1234, stallMs: 567,
      run: async (o) => { calls.push(o); return { record: record(), pid: 1 } },
      readText: async () => REPORT,
    })
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call).toMatchObject({ role: 'coder', executable: 'C:/codex.exe', cwd: path.join(scratch, 'tree'), prompt: 'implement this', timeoutMs: 1234, stallMs: 567 })
    expect(call.args.slice(0, 3)).toEqual(['exec', '-s', 'workspace-write'])
    const folder = call.args[call.args.indexOf('--add-dir') + 1]
    const outputFile = call.args[call.args.indexOf('-o') + 1]
    // The temporary variables name the session temp folder, which is new and in the scratch directory.
    expect(call.env).toMatchObject({ TMP: folder, TEMP: folder, TMPDIR: folder, PATH: '/bin', GH_CONFIG_DIR: path.join(scratch, 'gh-config') })
    expect(call.env).not.toHaveProperty('GH_TOKEN')
    expect(call.env).not.toHaveProperty('GITHUB_TOKEN')
    expect(path.dirname(folder)).toBe(scratch)
    expect(existsSync(folder)).toBe(true)
    expect(path.dirname(outputFile)).toBe(scratch)
    expect(existsSync(outputFile)).toBe(false)
    expect(path.relative(path.join(scratch, 'tree'), folder).startsWith('..')).toBe(true)
    expect(path.relative(path.join(scratch, 'tree'), outputFile).startsWith('..')).toBe(true)
    expect(result.classification).toMatchObject({ outcome: 'completed', prText: { status: 'parsed', title: 'Do the thing', draft: false } })
    expect(result.output.result).toBe(REPORT)
  })

  it('ST-15/AC-3: each session gets its own new folder and output file', async () => {
    const scratch = mkdtempSync(path.join(dir, 'coder-'))
    const seen = []
    for (let i = 0; i < 2; i++) {
      await spawnCodexCoder({ ...base(scratch), run: async (o) => { seen.push(o.args); return { record: record(), pid: 1 } }, readText: async () => REPORT })
    }
    const folders = seen.map((args) => args[args.indexOf('--add-dir') + 1])
    const files = seen.map((args) => args[args.indexOf('-o') + 1])
    expect(new Set(folders).size).toBe(2)
    expect(new Set(files).size).toBe(2)
  })

  it('ST-15/AC-3: reads the last message from the file it named', async () => {
    const scratch = mkdtempSync(path.join(dir, 'coder-'))
    const read = []
    let named
    await spawnCodexCoder({
      ...base(scratch),
      run: async (o) => { named = o.args[o.args.indexOf('-o') + 1]; return { record: record(), pid: 1 } },
      readText: async (file) => { read.push(file); return REPORT },
    })
    expect(read).toEqual([named])
  })

  it('ST-15/AC-3: a report without a PR block is completed, with prText not parsed', async () => {
    const scratch = mkdtempSync(path.join(dir, 'coder-'))
    const result = await spawnCodexCoder({ ...base(scratch), run: async () => ({ record: record(), pid: 1 }), readText: async () => 'Just prose.' })
    expect(result.classification.outcome).toBe('completed')
    expect(result.classification.prText.status).not.toBe('parsed')
    expect(result.output.result).toBe('Just prose.')
  })

  it.each([
    ['timed-out', { stoppedFor: 'timeout' }],
    ['stalled', { stoppedFor: 'stall' }],
    ['died', { exitCode: 1 }],
    ['died', { exitCode: null, signal: 'SIGKILL' }],
  ])('ST-15/AC-3: the outcome is %s as the reviewer one is, with no output', async (outcome, over) => {
    const scratch = mkdtempSync(path.join(dir, 'coder-'))
    const run = async () => ({ record: record(over), pid: 1 })
    const coder = await spawnCodexCoder({ ...base(scratch), run, readText: async () => 'never read' })
    const reviewer = await spawnCodexReviewer({
      executable: 'codex', cwd: 'C:/tmp/tree', model: 'm', effort: 'low', prompt: 'p', env: {}, outputFile: 'C:/tmp/o.txt',
      run: async () => ({ record: record({ ...over, role: 'reviewer' }), pid: 1 }), readText: async () => 'never read',
    })
    expect(coder.classification.outcome).toBe(outcome)
    expect(coder.classification.outcome).toBe(reviewer.classification.outcome)
    expect(coder.output).toBeNull()
  })

  it('ST-15/AC-3: a missing or empty last message is malformed-output', async () => {
    const scratch = mkdtempSync(path.join(dir, 'coder-'))
    const run = async () => ({ record: record(), pid: 1 })
    const missing = await spawnCodexCoder({ ...base(scratch), run, readText: async () => { throw new Error('ENOENT') } })
    expect(missing.classification.outcome).toBe('malformed-output')
    const empty = await spawnCodexCoder({ ...base(scratch), run, readText: async () => ' \n' })
    expect(empty.classification.outcome).toBe('malformed-output')
  })

  it('ST-15/AC-3: requires the scratch directory of the dispatch', async () => {
    await expect(spawnCodexCoder({ ...base(dir), scratch: undefined, run: async () => ({ record: record() }) })).rejects.toThrow('requires scratch')
  })
})
