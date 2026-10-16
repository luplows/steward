import { describe, expect, it } from 'vitest'
import { checkUsage, readUsage, runUsageProcess, USAGE_ARGS, USAGE_TIMEOUT_MS } from './usage.mjs'

const row = (kind, group, percent, resets_at = `r-${kind}-${percent}`) => ({ kind, group, percent, resets_at })
const message = (limits) => JSON.stringify({
  type: 'assistant', message: { content: [] }, usage_report: { rate_limits: { limits } },
})
const stream = (...lines) => lines.join('\n') + '\n'
const ok = (stdout) => async () => ({ exitCode: 0, stdout, timedOut: false })
const read = (stdout, extra = {}) => readUsage({ cwd: '/x', executable: 'claude', run: ok(stdout), ...extra })

describe('ST-31/AC-1: readUsage reads the plan\'s usage from `claude -p /usage`', () => {
  it('ST-31/AC-1: parses session 20 and weekly_all 21', async () => {
    const stdout = stream(
      JSON.stringify({ type: 'system', subtype: 'init' }),
      message([row('session', 'session', 20), row('weekly_all', 'weekly', 21)]),
      JSON.stringify({ type: 'result', subtype: 'success' }),
    )
    expect(await read(stdout)).toEqual({
      ok: true,
      session: { percent: 20, resetsAt: 'r-session-20' },
      weekly: { percent: 21, resetsAt: 'r-weekly_all-21' },
    })
  })

  it('ST-31/AC-1: takes the higher of two weekly rows', async () => {
    const stdout = stream(message([
      row('session', 'session', 5), row('weekly_all', 'weekly', 30), row('weekly_scoped', 'weekly', 62), row('weekly_other', 'weekly', 41),
    ]))
    expect((await read(stdout)).weekly).toEqual({ percent: 62, resetsAt: 'r-weekly_scoped-62' })
  })

  it('ST-31/AC-1: runs the executable with the documented arguments, in the given directory, with a 30-second limit', async () => {
    const seen = []
    const stdout = stream(message([row('session', 'session', 1), row('weekly_all', 'weekly', 1)]))
    const run = async (options) => (seen.push(options), { exitCode: 0, stdout, timedOut: false })
    await readUsage({ cwd: '/some/dir', executable: '/bin/claude', run })
    expect(seen).toEqual([{
      executable: '/bin/claude',
      args: ['-p', '/usage', '--output-format', 'stream-json', '--verbose'],
      cwd: '/some/dir',
      timeoutMs: 30_000,
    }])
    expect(USAGE_ARGS).toEqual(seen[0].args)
    expect(USAGE_TIMEOUT_MS).toBe(30_000)
  })

  it('ST-31/AC-1: a failed run is ok: false', async () => {
    const result = await readUsage({
      cwd: '/x', executable: 'claude', run: async () => ({ exitCode: 1, stdout: '', timedOut: false }),
    })
    expect(result).toMatchObject({ ok: false })
    expect(result.reason).toContain('exited with code 1')
  })

  it('ST-31/AC-1: a runner that throws is ok: false', async () => {
    const result = await readUsage({
      cwd: '/x', executable: 'claude', run: async () => { throw new Error('spawn ENOENT') },
    })
    expect(result).toMatchObject({ ok: false })
    expect(result.reason).toContain('spawn ENOENT')
  })

  it('ST-31/AC-1: a timeout is ok: false', async () => {
    const result = await readUsage({
      cwd: '/x', executable: 'claude', run: async () => ({ exitCode: null, stdout: '', timedOut: true }),
    })
    expect(result).toMatchObject({ ok: false })
    expect(result.reason).toContain('timed out')
  })

  it('ST-31/AC-1: no message carrying usage_report is ok: false', async () => {
    const stdout = stream(JSON.stringify({ type: 'result', subtype: 'success' }), 'not json')
    expect(await read(stdout)).toMatchObject({ ok: false })
  })

  it('ST-31/AC-1: rate_limits: null is ok: false', async () => {
    const stdout = stream(JSON.stringify({ type: 'assistant', usage_report: { rate_limits: null } }))
    expect(await read(stdout)).toMatchObject({ ok: false })
  })

  it('ST-31/AC-1: a missing session row is ok: false', async () => {
    const result = await read(stream(message([row('weekly_all', 'weekly', 21)])))
    expect(result).toMatchObject({ ok: false })
    expect(result.reason).toContain('session')
  })

  it('ST-31/AC-1: a missing weekly row is ok: false', async () => {
    const result = await read(stream(message([row('session', 'session', 20)])))
    expect(result).toMatchObject({ ok: false })
    expect(result.reason).toContain('weekly')
  })

  it('ST-31/AC-1: the default runner reports a failed process\'s exit code, started without a shell', async () => {
    const result = await runUsageProcess({
      executable: process.execPath, args: ['-e', 'process.exit(3)'], cwd: process.cwd(), timeoutMs: 20_000,
    })
    expect(result).toMatchObject({ exitCode: 3, timedOut: false })
  })
})

describe('ST-31/AC-3: checkUsage names the first window at or over the limit', () => {
  const limits = { session: 70, weekly: 75 }
  const usageOf = (session, weekly) => async () => ({
    ok: true, session: { percent: session, resetsAt: 's' }, weekly: { percent: weekly, resetsAt: 'w' },
  })

  it('ST-31/AC-3: session is named before weekly', async () => {
    expect(await checkUsage({ read: usageOf(80, 80), cwd: '/x', limits })).toEqual({
      status: 'over-usage', window: 'session', percent: 80, limit: 70, resetsAt: 's',
    })
  })

  it('ST-31/AC-3: is null one under each limit, and over at each limit exactly', async () => {
    expect(await checkUsage({ read: usageOf(69, 74), cwd: '/x', limits })).toBeNull()
    expect(await checkUsage({ read: usageOf(70, 0), cwd: '/x', limits })).toMatchObject({ window: 'session', percent: 70 })
    expect(await checkUsage({ read: usageOf(0, 75), cwd: '/x', limits })).toMatchObject({ window: 'weekly', percent: 75, limit: 75 })
  })

  it('ST-31/AC-3: an unreadable usage is usage-unknown with the reason', async () => {
    const unreadable = async () => ({ ok: false, reason: 'boom' })
    expect(await checkUsage({ read: unreadable, cwd: '/x', limits, extra: { storyId: 'ST-1' } })).toEqual({
      status: 'usage-unknown', storyId: 'ST-1', reason: 'boom',
    })
  })
})
