import { describe, expect, it } from 'vitest'
import { coderLineNames, firstWithUsage, withCoderLine } from './choices.mjs'

const LIMITS = { session: 70, weekly: 75 }
const usageAt = (session, weekly) => ({
  ok: true, session: { percent: session, resetsAt: 's' }, weekly: { percent: weekly, resetsAt: 'w' },
})

describe('ST-35/AC-2, AC-6: firstWithUsage tries the choices in order', () => {
  const choices = [
    { name: 'a', tool: 'claude' },
    { name: 'b', tool: 'claude' },
    { name: 'c', tool: 'codex' },
  ]

  it('ST-35/AC-2: starts the first choice whose tool is under the limits, reading each tool once', async () => {
    const reads = []
    const readers = {
      claude: async (o) => { reads.push(['claude', o]); return usageAt(99, 1) },
      codex: async (o) => { reads.push(['codex', o]); return usageAt(10, 10) },
    }
    const picked = await firstWithUsage({ candidates: choices, readers, cwd: '/r', limits: LIMITS })
    expect(picked.choice).toEqual(choices[2])
    expect(picked.skipped).toEqual([
      { name: 'a', status: 'over-usage', window: 'session', percent: 99, limit: 70 },
      { name: 'b', status: 'over-usage', window: 'session', percent: 99, limit: 70 },
    ])
    expect(reads).toEqual([['claude', { cwd: '/r' }], ['codex', { cwd: '/r' }]])
  })

  it('ST-35/AC-2: the first choice under its limits is started with nothing skipped, and later tools are not read', async () => {
    const readers = { claude: async () => usageAt(1, 1), codex: async () => { throw new Error('read') } }
    expect(await firstWithUsage({ candidates: choices, readers, cwd: '/r', limits: LIMITS }))
      .toEqual({ choice: choices[0], skipped: [] })
  })

  it('ST-35/AC-2: names the weekly window when only it is over, and an unreadable usage counts as spent', async () => {
    const readers = { claude: async () => usageAt(1, 80), codex: async () => ({ ok: false, reason: 'gone' }) }
    const picked = await firstWithUsage({ candidates: choices, readers, cwd: '/r', limits: LIMITS })
    expect(picked.refusal).toEqual({
      status: 'over-usage', window: 'weekly', percent: 80, limit: 75, resetsAt: 'w',
      skipped: [
        { name: 'a', status: 'over-usage', window: 'weekly', percent: 80, limit: 75 },
        { name: 'b', status: 'over-usage', window: 'weekly', percent: 80, limit: 75 },
        { name: 'c', status: 'usage-unknown', reason: 'gone' },
      ],
    })
  })

  it("ST-35/AC-2: returns the first choice's refusal, with extra, when none can start", async () => {
    const readers = { claude: async () => ({ ok: false, reason: 'first' }), codex: async () => usageAt(99, 99) }
    const picked = await firstWithUsage({ candidates: choices, readers, cwd: '/r', limits: LIMITS, extra: { storyId: 'ST-1' } })
    expect(picked.refusal).toMatchObject({ status: 'usage-unknown', storyId: 'ST-1', reason: 'first' })
    expect(picked.refusal.skipped.map((entry) => entry.name)).toEqual(['a', 'b', 'c'])
  })
})

describe('ST-35/AC-7, AC-8: the Coder: line', () => {
  it('ST-35/AC-8: coderLineNames reads the last line that starts Coder:, each name once, in order', () => {
    expect(coderLineNames('x\n\nCoder: sonnet, opus')).toEqual(['sonnet', 'opus'])
    expect(coderLineNames('Coder: a\nCoder: b,c , b\r\nmore')).toEqual(['b', 'c'])
    expect(coderLineNames('no line here')).toBeNull()
    expect(coderLineNames('  Coder: indented is not one')).toBeNull()
    expect(coderLineNames('Coder:   ')).toBeNull()
    expect(coderLineNames(undefined)).toBeNull()
  })

  it('ST-35/AC-7: withCoderLine drops every Coder: line and ends with the names', () => {
    expect(withCoderLine('Body.\nCoder: x\n\nMore.\n', ['sonnet', 'opus'])).toBe('Body.\n\nMore.\n\nCoder: sonnet, opus')
    expect(withCoderLine('', ['opus'])).toBe('Coder: opus')
    expect(withCoderLine('Coder: x', ['opus'])).toBe('Coder: opus')
  })
})
