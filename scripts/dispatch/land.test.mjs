// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  BLOCKED_BOUND_MS,
  GATE_LAG_BOUND_MS,
  MAX_TOTAL_WAIT_MS,
  MAX_TRIGGERS,
  POLL_INTERVAL_MS,
  REVIEW_PENDING_BOUND_MS,
  SWEEP_RUN_BOUND_MS,
  UNKNOWN_BOUND_MS,
  assertAllowedRequest,
  CHECKS_PENDING_BOUND_MS,
  buildDispatchSweep,
  buildGetCheckRuns,
  buildGetCommitStatus,
  buildGetPullRequest,
  createLandContext,
  landPullRequest,
  recentLandingLatencies,
} from './land.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = 'luplows/tower-workshop-paths'
const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)
const BASE = `https://api.github.com/repos/${REPO}`

const pull = (over = {}) => ({
  head: { sha: SHA },
  state: 'open',
  merged: false,
  draft: false,
  labels: [],
  mergeable_state: 'clean',
  ...over,
})
const status = (state, others = []) => ({
  statuses: [...(state === 'absent' ? [] : [{ id: 1, context: 'review/agent', state }]), ...others],
})
const run = (name, conclusion, id = 1) => ({
  id,
  name,
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion,
})

/**
 * A fake GitHub and clock. `pullAt(t, dispatches)` returns the pull request as
 * of `t` ms after the start and the number of dispatches so far; `reviewAt`
 * likewise the `review/agent` state.
 */
function world({ pullAt, reviewAt = () => 'success', checksAt = () => [], statusesAt = () => [], landWhen = 'all-checks' }) {
  const w = { t: 0, requests: [], dispatches: [], dispatchTimes: [] }
  const dir = mkdtempSync(path.join(tmpdir(), 'land-test-'))
  w.log = path.join(dir, 'latency.jsonl')
  w.cleanup = () => rmSync(dir, { recursive: true, force: true })
  const fetch = async (url, init) => {
    const request = { method: init.method, url, body: init.body === undefined ? undefined : JSON.parse(init.body) }
    w.requests.push(request)
    const ok = (json, code = 200) => ({ ok: true, status: code, json: async () => json })
    if (init.method === 'POST') {
      w.dispatches.push(request)
      w.dispatchTimes.push(w.t)
      return ok(null, 204)
    }
    if (url.includes('/check-runs')) {
      const check_runs = checksAt(w.t)
      return ok({ total_count: check_runs.length, check_runs })
    }
    if (url.includes('/commits/')) return ok(status(reviewAt(w.t), statusesAt(w.t)))
    return ok(pullAt(w.t, w.dispatches.length))
  }
  const ctx = createLandContext({ repo: REPO, landing: true, landWhen, fetch, getToken: async () => 't' })
  w.run = (opts = {}) =>
    landPullRequest({
      number: 7,
      ctx,
      now: () => w.t,
      sleep: async (ms) => { w.t += ms },
      latencyLog: w.log,
      ...opts,
    })
  return w
}

describe('OQ-50/AC-1: land.mjs waits for landable, triggers the sweep, waits for merge', () => {
  it('waits through a pending review, triggers once it is landable, then reports the merge', async () => {
    const w = world({
      reviewAt: (t) => (t < 3 * POLL_INTERVAL_MS ? 'pending' : 'success'),
      pullAt: (t, dispatches) => pull({ merged: dispatches > 0 && t >= 5 * POLL_INTERVAL_MS, state: 'open', mergeable_state: t < 3 * POLL_INTERVAL_MS ? 'blocked' : 'clean' }),
    })
    const result = await w.run()
    expect(result).toMatchObject({ status: 'merged', pr: 7, headSha: SHA, triggers: 1 })
    expect(w.dispatches).toEqual([{ method: 'POST', url: `${BASE}/actions/workflows/land-approved.yml/dispatches`, body: { ref: 'main', inputs: { pr: '7' } } }])
    w.cleanup()
  })

  it('does not trigger while the pull request is not landable', async () => {
    const w = world({ pullAt: () => pull({ draft: true }) })
    await w.run()
    expect(w.dispatches).toEqual([])
    w.cleanup()
  })

  it('requires the review/agent status on the current head: reads it for the head SHA it saw', async () => {
    const w = world({ pullAt: (t, d) => pull({ merged: d > 0 }) })
    await w.run()
    expect(w.requests.some((r) => r.method === 'GET' && r.url === `${BASE}/commits/${SHA}/status`)).toBe(true)
    w.cleanup()
  })

  it('never builds a merge request: no exported builder produces one and the allowlist refuses one', () => {
    const built = [buildGetPullRequest(REPO, 7), buildGetCommitStatus(REPO, SHA), buildGetCheckRuns(REPO, SHA), buildDispatchSweep(REPO, 7)]
    for (const request of built) {
      expect(request.method).not.toBe('PUT')
      expect(request.url).not.toMatch(/\/merge(\?|$)/)
    }
    const merge = { method: 'PUT', url: `${BASE}/pulls/7/merge`, body: { merge_method: 'squash' } }
    expect(() => assertAllowedRequest(REPO, merge)).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'POST', url: `${BASE}/pulls/7/merge` })).toThrow(/refusing/)
  })

  it('never sends a merge request through a whole run either', async () => {
    const w = world({ pullAt: (t, d) => pull({ merged: d > 0 }) })
    await w.run()
    expect(w.requests.filter((r) => /\/merge(\?|$)/.test(r.url) || r.method === 'PUT')).toEqual([])
    w.cleanup()
  })
})

describe('OQ-50/AC-2: each reason a pull request cannot land is its own status', () => {
  const stops = async (status, pullAt, reviewAt) => {
    const w = world({ pullAt, reviewAt })
    const result = await w.run()
    expect(result.status).toBe(status)
    expect(w.dispatches).toEqual([])
    expect(w.t).toBeLessThanOrEqual(MAX_TOTAL_WAIT_MS)
    w.cleanup()
    return result
  }

  it('draft', () => stops('draft', () => pull({ draft: true, mergeable_state: 'draft' })))
  it('review-blocked label', () => stops('review-blocked', () => pull({ labels: [{ name: 'review-blocked' }] })))
  it('review/agent failure', () => stops('review-failed', () => pull(), () => 'failure'))
  it('review/agent pending past its bound', async () => {
    const w = world({ pullAt: () => pull({ mergeable_state: 'blocked' }), reviewAt: () => 'pending' })
    expect((await w.run()).status).toBe('review-pending')
    expect(w.t).toBeGreaterThanOrEqual(REVIEW_PENDING_BOUND_MS)
    expect(w.dispatches).toEqual([])
    w.cleanup()
  })
  it('mergeable_state blocked past its bound, with the checks landWhen names green', async () => {
    const w = world({ pullAt: () => pull({ mergeable_state: 'blocked' }) })
    expect((await w.run()).status).toBe('github-blocked')
    expect(w.t).toBeGreaterThanOrEqual(BLOCKED_BOUND_MS)
    expect(w.dispatches).toEqual([])
    w.cleanup()
  })
  it('mergeable_state blocked that clears inside its bound is waited through', async () => {
    const w = world({ pullAt: (t, d) => pull({ mergeable_state: t < 60_000 ? 'blocked' : 'clean', merged: d > 0 }) })
    expect((await w.run()).status).toBe('merged')
    w.cleanup()
  })
  it('mergeable_state dirty', () => stops('conflict', () => pull({ mergeable_state: 'dirty' })))
  it('the head moved while waiting', async () => {
    const w = world({
      pullAt: (t) => pull({ head: { sha: t < 2 * POLL_INTERVAL_MS ? SHA : SHA2 }, mergeable_state: 'blocked' }),
      reviewAt: () => 'pending',
    })
    const result = await w.run()
    expect(result).toMatchObject({ status: 'head-moved', headSha: SHA, newHeadSha: SHA2 })
    expect(w.dispatches).toEqual([])
    w.cleanup()
  })
  it('closed without merging', () => stops('closed', () => pull({ state: 'closed' })))
})

describe('OQ-50/AC-3: unknown is waited through and the sweep is re-triggered', () => {
  it('replays #123/#125: skipped as unknown once, landed on the re-trigger', async () => {
    // First trigger at t=0 finds it clean; the sweep runs and skips it because GitHub
    // reports `unknown` after another merge; it turns clean again; the re-trigger lands it.
    const w = world({
      pullAt: (t, dispatches) => {
        if (dispatches === 0) return pull()
        if (dispatches === 1) return pull({ mergeable_state: t < 60_000 ? 'unknown' : 'clean' })
        return pull({ merged: true })
      },
    })
    const result = await w.run()
    expect(result).toMatchObject({ status: 'merged', triggers: 2 })
    expect(w.dispatchTimes[1] - w.dispatchTimes[0]).toBeGreaterThanOrEqual(SWEEP_RUN_BOUND_MS)
    w.cleanup()
  })

  it('re-triggers while still open after a run that landed an older PR first', async () => {
    const w = world({ pullAt: (t, d) => pull({ merged: d >= 2 }) })
    expect((await w.run()).triggers).toBe(2)
    w.cleanup()
  })

  it('re-reads unknown after a delay rather than treating it as final, but not forever', async () => {
    const w = world({ pullAt: () => pull({ mergeable_state: 'unknown' }) })
    const result = await w.run()
    expect(result.status).toBe('unknown')
    expect(w.t).toBeGreaterThanOrEqual(UNKNOWN_BOUND_MS)
    expect(w.requests.filter((r) => r.url.endsWith('/pulls/7')).length).toBeGreaterThan(3)
    w.cleanup()
  })

  it('bounds the number of triggers with a named constant', async () => {
    const w = world({ pullAt: () => pull() })
    const result = await w.run()
    expect(result).toMatchObject({ status: 'trigger-limit', triggers: MAX_TRIGGERS })
    expect(w.dispatches).toHaveLength(MAX_TRIGGERS)
    w.cleanup()
  })

  it('bounds the total wait with a named constant', async () => {
    // Blocked, then clean, over and over: no single bound trips, the total does.
    const w = world({ pullAt: (t) => pull({ mergeable_state: Math.floor(t / 60_000) % 2 ? 'clean' : 'blocked' }), reviewAt: () => 'success' })
    const result = await w.run({ number: 7 })
    expect(['timeout', 'trigger-limit']).toContain(result.status)
    expect(w.t).toBeLessThanOrEqual(MAX_TOTAL_WAIT_MS + POLL_INTERVAL_MS)
    w.cleanup()
  })
})

describe('OQ-104/AC-1 and AC-3: passedAt waits out a gate that has not caught up yet', () => {
  it('OQ-104/AC-3: passedAt equal to the head, failure for two polls then success, lands normally', async () => {
    const w = world({
      reviewAt: (t) => (t < 2 * POLL_INTERVAL_MS ? 'failure' : 'success'),
      pullAt: (t, dispatches) => pull({ mergeable_state: 'clean', merged: dispatches > 0 }),
    })
    const result = await w.run({ passedAt: SHA })
    expect(result).toMatchObject({ status: 'merged', triggers: 1 })
    expect(w.dispatches).toHaveLength(1)
    expect(w.t).toBeLessThan(GATE_LAG_BOUND_MS)
    w.cleanup()
  })

  it('OQ-104/AC-1: passedAt equal to the head, failure throughout, returns gate-lag at the bound', async () => {
    const w = world({ reviewAt: () => 'failure', pullAt: () => pull({ mergeable_state: 'clean' }) })
    const result = await w.run({ passedAt: SHA })
    expect(result.status).toBe('gate-lag')
    expect(w.t).toBeGreaterThanOrEqual(GATE_LAG_BOUND_MS)
    expect(w.dispatches).toEqual([])
    w.cleanup()
  })

  it('OQ-104/AC-1: passedAt given but different from the head stays review-failed at once', async () => {
    const w = world({ reviewAt: () => 'failure', pullAt: () => pull() })
    const result = await w.run({ passedAt: SHA2 })
    expect(result.status).toBe('review-failed')
    expect(w.t).toBe(0)
    expect(w.dispatches).toEqual([])
    w.cleanup()
  })
})

describe('OQ-93/AC-4: land.mjs names its pull request on every trigger', () => {
  it('builds the dispatch with the pull request number as the one input', () => {
    expect(buildDispatchSweep(REPO, 7)).toEqual({
      method: 'POST',
      url: `${BASE}/actions/workflows/land-approved.yml/dispatches`,
      body: { ref: 'main', inputs: { pr: '7' } },
    })
    expect(() => buildDispatchSweep(REPO)).toThrow(/positive integer/)
  })

  it('a run of landPullRequest({ number: 7 }) sends only dispatches naming 7', async () => {
    const w = world({ pullAt: () => pull({ merged: false, state: 'open', mergeable_state: 'clean' }) })
    const result = await w.run({ number: 7 })
    expect(result.status).toBe('trigger-limit')
    expect(w.dispatches.length).toBeGreaterThan(1)
    for (const d of w.dispatches) expect(d.body).toEqual({ ref: 'main', inputs: { pr: '7' } })
    w.cleanup()
  })
})

describe('OQ-50/AC-4: land.mjs sends only the sweep dispatch', () => {
  const dispatchUrl = (wf) => `${BASE}/actions/workflows/${wf}/dispatches`

  it('refuses any other workflow, any other ref or inputs, and any other write, before the network', async () => {
    let calls = 0
    const ctx = createLandContext({ repo: REPO, landing: true, landWhen: 'all-checks', fetch: async () => { calls++; return { ok: true, status: 204 } }, getToken: async () => 't' })
    const refused = [
      { method: 'POST', url: dispatchUrl('ci.yml'), body: { ref: 'main' } },
      { method: 'POST', url: dispatchUrl('review-gate.yml'), body: { ref: 'main' } },
      { method: 'POST', url: dispatchUrl('land-approved.yml'), body: { ref: 'other' } },
      { method: 'POST', url: dispatchUrl('land-approved.yml'), body: { ref: 'main', inputs: { x: '1' } } },
      { method: 'POST', url: dispatchUrl('land-approved.yml') },
      { method: 'POST', url: dispatchUrl('land-approved.yml'), body: { ref: 'main' } },
      { method: 'POST', url: dispatchUrl('land-approved.yml'), body: { ref: 'main', inputs: {} } },
      { method: 'POST', url: dispatchUrl('land-approved.yml'), body: { ref: 'main', inputs: { pr: '7', x: '1' } } },
      { method: 'POST', url: dispatchUrl('land-approved.yml'), body: { ref: 'main', inputs: { other: '7' } } },
      { method: 'POST', url: dispatchUrl('land-approved.yml'), body: { ref: 'main', inputs: { pr: 'abc' } } },
      { method: 'POST', url: dispatchUrl('land-approved.yml'), body: { ref: 'main', inputs: { pr: '07' } } },
      { method: 'POST', url: dispatchUrl('land-approved.yml'), body: { ref: 'main', inputs: { pr: 7 } } },
      { method: 'POST', url: dispatchUrl('land-approved.yml'), body: { ref: 'main', inputs: { pr: '7' }, extra: 1 } },
      { method: 'POST', url: dispatchUrl('land-approved.yml'), body: { inputs: { pr: '7' } } },
      { method: 'POST', url: `${BASE}/statuses/${SHA}`, body: { state: 'success', context: 'review/agent' } },
      { method: 'POST', url: `${BASE}/issues/7/comments`, body: { body: 'x' } },
      { method: 'POST', url: `${BASE}/pulls`, body: { title: 'x' } },
      { method: 'PATCH', url: `${BASE}/pulls/7`, body: { state: 'closed' } },
      { method: 'PUT', url: `${BASE}/pulls/7/merge`, body: {} },
      { method: 'DELETE', url: `${BASE}/git/refs/heads/x` },
      { method: 'GET', url: `${BASE}/pulls/7`, body: { x: 1 } },
      { method: 'GET', url: 'https://evil.example/pulls/7' },
    ]
    for (const request of refused) await expect(ctx.send(request)).rejects.toThrow(/refusing/)
    expect(calls).toBe(0)
  })

  it('permits the four requests it builds', async () => {
    let calls = 0
    const ctx = createLandContext({ repo: REPO, landing: true, landWhen: 'all-checks', fetch: async () => { calls++; return { ok: true, status: 204, json: async () => ({}) } }, getToken: async () => 't' })
    await ctx.send(buildGetPullRequest(REPO, 7))
    await ctx.send(buildGetCommitStatus(REPO, SHA))
    await ctx.send(buildGetCheckRuns(REPO, SHA))
    await ctx.send(buildDispatchSweep(REPO, 7))
    expect(calls).toBe(4)
  })

  it('github.mjs is unchanged in what it refuses: it still refuses the sweep dispatch', async () => {
    const { createContext } = await import('./github.mjs')
    const ctx = createContext({ repo: REPO, fetch: async () => { throw new Error('network') }, getToken: async () => 't' })
    await expect(ctx.send(buildDispatchSweep(REPO, 7))).rejects.toThrow(/refusing/)
  })

  it('neither coder.mjs nor review.mjs imports land.mjs', async () => {
    for (const file of ['coder.mjs', 'review.mjs']) {
      const source = await readFile(path.join(here, file), 'utf8')
      expect(source).not.toMatch(/land\.mjs/)
    }
  })
})

describe('OQ-50/AC-5: time from landable to trigger is bounded by the poll interval', () => {
  it('first trigger is sent within one poll interval of the pull request becoming landable', async () => {
    const landableFrom = 7 * POLL_INTERVAL_MS + 4_000
    const w = world({
      pullAt: (t, d) => pull({ mergeable_state: t < landableFrom ? 'unknown' : 'clean', merged: d > 0 }),
    })
    await w.run()
    expect(w.dispatchTimes[0] - landableFrom).toBeGreaterThanOrEqual(0)
    expect(w.dispatchTimes[0] - landableFrom).toBeLessThanOrEqual(POLL_INTERVAL_MS)
    w.cleanup()
  })

  it('the bound is written in the module', async () => {
    expect(await readFile(path.join(here, 'land.mjs'), 'utf8')).toMatch(/at most `POLL_INTERVAL_MS`/)
  })
})

describe('OQ-50/AC-7: landing latency is observable after the fact', () => {
  it('records when a pull request became landable, was triggered and merged, and reads it back', async () => {
    const landableFrom = 2 * POLL_INTERVAL_MS
    const w = world({
      pullAt: (t, d) => pull({ mergeable_state: t < landableFrom ? 'unknown' : 'clean', merged: d > 0 && t >= landableFrom + 2 * POLL_INTERVAL_MS }),
    })
    w.t = Date.parse('2026-09-25T10:00:00Z')
    const start = w.t
    await w.run()
    const [row] = await recentLandingLatencies(5, w.log)
    expect(row).toMatchObject({ pr: 7, status: 'merged' })
    expect(row.waitSeconds).toBe((w.dispatchTimes[0] - Date.parse(row.landableAt)) / 1000)
    expect(row.waitSeconds).toBeLessThanOrEqual(POLL_INTERVAL_MS / 1000)
    expect(row.mergeSeconds).toBeGreaterThanOrEqual(row.waitSeconds)
    expect(Date.parse(row.landableAt)).toBeGreaterThanOrEqual(start)
    w.cleanup()
  })

  it('answers "the last N" and records pull requests that never became landable', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'land-test-'))
    const log = path.join(dir, 'l.jsonl')
    const draft = world({ pullAt: () => pull({ draft: true }) })
    for (let i = 0; i < 3; i++) await draft.run({ latencyLog: log })
    draft.cleanup()
    const rows = await recentLandingLatencies(2, log)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ status: 'draft', landableAt: null, waitSeconds: null })
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(3)
    expect(await recentLandingLatencies(5, path.join(dir, 'absent.jsonl'))).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('OQ-123: the project root is the working directory, not the engine root', () => {
  it('OQ-123/AC-2: the default repoDir reads settings from the current working directory', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tw-land-cwd-'))
    try {
      const filePath = path.join(dir, 'steward.config.json')
      let threw
      try {
        execFileSync('node', [path.join(here, 'land.mjs'), '7'], { cwd: dir, encoding: 'utf8' })
      } catch (error) {
        threw = error
      }
      expect(threw).toBeTruthy()
      // Engine root (this checkout) has its own steward.config.json; the error
      // naming `dir`'s path proves settings came from the working directory
      // (the project root), not from the engine's own.
      expect(threw.stderr).toContain(filePath)
      expect(threw.stderr).toContain('file not found')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('ST-23: land in one look, and not at all when landing is off', () => {
  const merges = (afterTriggerMs) => (t, d, w) => d > 0 && t >= w.dispatchTimes[0] + afterTriggerMs

  it('ST-23/AC-1: each state that is not landable yet returns not-landable at once, with its reason and no trigger', async () => {
    const cases = [
      ['review-pending', () => pull(), () => 'pending'],
      ['review-pending', () => pull(), () => 'absent'],
      ['gate-lag', () => pull(), () => 'failure', { passedAt: SHA }],
      ['unknown', () => pull({ mergeable_state: 'unknown' })],
    ]
    for (const [reason, pullAt, reviewAt, extra] of cases) {
      const w = world({ pullAt, reviewAt })
      const result = await w.run({ once: true, ...extra })
      expect(result).toMatchObject({ status: 'not-landable', reason, pr: 7, triggers: 0 })
      expect(w.dispatches).toEqual([])
      expect(w.t).toBe(0)
      w.cleanup()
    }
  })

  it('ST-23/AC-1: a terminal state is returned as without once, and a merged or closed pull request too', async () => {
    const cases = [
      ['draft', () => pull({ draft: true })],
      ['review-blocked', () => pull({ labels: [{ name: 'review-blocked' }] })],
      ['review-failed', () => pull(), () => 'failure'],
      ['conflict', () => pull({ mergeable_state: 'dirty' })],
      ['closed', () => pull({ state: 'closed' })],
      ['merged', () => pull({ merged: true })],
    ]
    for (const [expected, pullAt, reviewAt] of cases) {
      const w = world({ pullAt, reviewAt })
      expect((await w.run({ once: true })).status).toBe(expected)
      expect(w.dispatches).toEqual([])
      expect(w.t).toBe(0)
      w.cleanup()
    }
  })

  it('ST-23/AC-1: a landable pull request is triggered once and returns merged when it merges within the bound', async () => {
    const w = world({ pullAt: (t, d) => pull({ merged: merges(2 * POLL_INTERVAL_MS)(t, d, w) }) })
    const result = await w.run({ once: true })
    expect(result).toMatchObject({ status: 'merged', triggers: 1 })
    expect(w.dispatches).toHaveLength(1)
    expect(w.t).toBeLessThanOrEqual(SWEEP_RUN_BOUND_MS)
    w.cleanup()
  })

  it('ST-23/AC-1: a landable pull request that has not merged by the bound returns sweep-pending, triggered once', async () => {
    const w = world({ pullAt: () => pull() })
    const result = await w.run({ once: true })
    expect(result).toMatchObject({ status: 'sweep-pending', triggers: 1 })
    expect(w.dispatches).toHaveLength(1)
    expect(w.t).toBe(SWEEP_RUN_BOUND_MS)
    w.cleanup()
  })

  it('ST-23/AC-1: a pull request closed or moved while the merge is awaited ends the call', async () => {
    const closed = world({ pullAt: (t, d) => pull({ state: d > 0 ? 'closed' : 'open' }) })
    expect((await closed.run({ once: true })).status).toBe('closed')
    closed.cleanup()
    const moved = world({ pullAt: (t, d) => pull({ head: { sha: d > 0 ? SHA2 : SHA } }) })
    expect(await moved.run({ once: true })).toMatchObject({ status: 'head-moved', newHeadSha: SHA2, triggers: 1 })
    expect(moved.dispatches).toHaveLength(1)
    moved.cleanup()
  })

  it('ST-23/AC-2: without once, with landing true, it still waits and re-triggers as before', async () => {
    const w = world({ pullAt: (t, d) => pull({ merged: d >= 2 }) })
    const result = await w.run()
    expect(result).toMatchObject({ status: 'merged', triggers: 2 })
    w.cleanup()
  })

  it('ST-23/AC-3: createLandContext requires landing to be a boolean', () => {
    expect(() => createLandContext({ repo: REPO })).toThrow(/landing must be true or false/)
    expect(() => createLandContext({ repo: REPO, landing: 'yes' })).toThrow(/landing must be true or false/)
    expect(createLandContext({ repo: REPO, landing: false, landWhen: 'all-checks' }).landing).toBe(false)
  })

  it('ST-23/AC-3: with landing false, either mode returns landing-off and sends nothing', async () => {
    for (const once of [false, true]) {
      const w = world({ pullAt: () => pull() })
      let sent = 0
      const ctx = createLandContext({ repo: REPO, landing: false, landWhen: 'all-checks', fetch: async () => { sent++; return { ok: true, status: 200, json: async () => pull() } }, getToken: async () => { sent++; return 't' } })
      const result = await w.run({ ctx, once })
      expect(result).toMatchObject({ status: 'landing-off', pr: 7, triggers: 0 })
      expect(sent).toBe(0)
      expect(w.requests).toEqual([])
      w.cleanup()
    }
  })

  it('ST-23/AC-3: every place that creates a land context passes the settings value', async () => {
    for (const file of ['land.mjs', 'loop.mjs', 'story.mjs']) {
      const source = await readFile(path.join(here, file), 'utf8')
      const calls = source.match(/createLandContext\(\{[^}]*\}\)/g) ?? []
      expect(calls.length, file).toBeGreaterThan(0)
      for (const call of calls) expect(call, file).toMatch(/\blanding\b/)
      expect(source, file).toMatch(/land: landing\b[^\n]*readSettings\(process\.cwd\(\)\)/)
    }
  })

  it('ST-23/AC-4: each once call appends its line to the latency log, whatever it returns', async () => {
    const w = world({ pullAt: (t, d) => pull({ merged: d > 0 && t >= 2 * POLL_INTERVAL_MS, mergeable_state: 'clean' }) })
    await w.run({ once: true })
    const waiting = world({ pullAt: () => pull(), reviewAt: () => 'pending' })
    await waiting.run({ once: true, latencyLog: w.log })
    const pending = world({ pullAt: () => pull() })
    await pending.run({ once: true, latencyLog: w.log })
    const rows = await recentLandingLatencies(10, w.log)
    expect(rows.map((r) => r.status)).toEqual(['merged', 'not-landable', 'sweep-pending'])
    expect(rows[0].mergeSeconds).not.toBeNull()
    expect(rows[1]).toMatchObject({ landableAt: null, triggeredAt: null })
    expect(rows[2].triggeredAt).not.toBeNull()
    expect(readFileSync(w.log, 'utf8').trim().split('\n')).toHaveLength(3)
    w.cleanup(); waiting.cleanup(); pending.cleanup()
  })
})

describe('ST-24: land when the checks landWhen names are green', () => {
  const CASES = ['clean', 'unstable', 'has_hooks', 'blocked', 'dirty', 'unknown', 'behind']

  it('ST-24/AC-2: the head check runs are one more read, on the allowlist and nothing else', () => {
    expect(buildGetCheckRuns(REPO, SHA)).toEqual({ method: 'GET', url: `${BASE}/commits/${SHA}/check-runs?per_page=100` })
    expect(() => assertAllowedRequest(REPO, buildGetCheckRuns(REPO, SHA))).not.toThrow()
    for (const url of [
      `${BASE}/commits/${SHA}/check-runs`,
      `${BASE}/commits/${SHA}/check-runs?per_page=100&page=2`,
      `${BASE}/commits/${SHA}/check-suites?per_page=100`,
      `${BASE}/check-runs/12`,
    ]) {
      expect(() => assertAllowedRequest(REPO, { method: 'GET', url })).toThrow(/refusing/)
    }
    expect(() => assertAllowedRequest(REPO, { method: 'POST', url: buildGetCheckRuns(REPO, SHA).url })).toThrow(/refusing/)
  })

  it('ST-24/AC-2: createLandContext requires landWhen', () => {
    expect(() => createLandContext({ repo: REPO, landing: true })).toThrow(/landWhen must be/)
    expect(() => createLandContext({ repo: REPO, landing: true, landWhen: [] })).toThrow(/landWhen must be/)
    expect(createLandContext({ repo: REPO, landing: true, landWhen: ['test'] }).landWhen).toEqual(['test'])
  })

  it('ST-24/AC-4: with the checks green, each mergeable_state lands, is a conflict, is github-blocked, or is waited for', async () => {
    const expected = {
      clean: 'merged', unstable: 'merged', has_hooks: 'merged', blocked: 'github-blocked', dirty: 'conflict', unknown: 'unknown', behind: 'unknown',
    }
    for (const state of CASES) {
      const w = world({
        pullAt: (t, d) => pull({ mergeable_state: state, merged: d > 0 }),
        checksAt: () => [run('test', 'success')],
      })
      const result = await w.run()
      expect(result.status, state).toBe(expected[state])
      expect(w.dispatches.length > 0, state).toBe(expected[state] === 'merged')
      w.cleanup()
    }
  })

  it('ST-24/AC-4: with once, each mergeable_state with the checks green lands, is a conflict, or is github-blocked rather than not-landable', async () => {
    const expected = {
      clean: 'merged', unstable: 'merged', has_hooks: 'merged', blocked: 'github-blocked', dirty: 'conflict', unknown: 'not-landable', behind: 'not-landable',
    }
    for (const state of CASES) {
      const w = world({
        pullAt: (t, d) => pull({ mergeable_state: state, merged: d > 0 }),
        checksAt: () => [run('test', 'success')],
      })
      const result = await w.run({ once: true })
      expect(result.status, state).toBe(expected[state])
      if (state === 'unknown') expect(result.reason).toBe('unknown')
      expect(w.dispatches.length > 0, state).toBe(expected[state] === 'merged')
      w.cleanup()
    }
  })

  it('ST-24/AC-2: github-blocked starts no runway, and a later call may try again', async () => {
    const w = world({ pullAt: () => pull({ mergeable_state: 'blocked' }), checksAt: () => [run('test', 'success')] })
    expect(await w.run({ once: true })).toMatchObject({ status: 'github-blocked', triggers: 0 })
    expect(w.dispatches).toEqual([])
    const later = world({
      pullAt: (t, d) => pull({ mergeable_state: t < 60_000 ? 'blocked' : 'clean', merged: d > 0 }),
      checksAt: () => [run('test', 'success')],
    })
    expect(await later.run()).toMatchObject({ status: 'merged', triggers: 1 })
    w.cleanup()
    later.cleanup()
  })

  it('ST-24/AC-2: mergeable_state clean no longer lands a head whose named checks are not green', async () => {
    const failing = world({ pullAt: () => pull({ mergeable_state: 'clean' }), checksAt: () => [run('test', 'failure')] })
    expect(await failing.run()).toMatchObject({ status: 'checks-failed', failing: ['test'], triggers: 0 })
    const pending = world({ pullAt: () => pull({ mergeable_state: 'clean' }), checksAt: () => [run('test', null)] })
    expect((await pending.run()).status).toBe('checks-pending')
    expect(pending.t).toBeGreaterThanOrEqual(CHECKS_PENDING_BOUND_MS)
    const once = world({ pullAt: () => pull({ mergeable_state: 'clean' }), checksAt: () => [run('test', null)] })
    expect(await once.run({ once: true })).toMatchObject({ status: 'not-landable', reason: 'checks-pending', waiting: ['test'] })
    for (const w of [failing, pending, once]) {
      expect(w.dispatches).toEqual([])
      w.cleanup()
    }
  })

  it('ST-24/AC-2: a pending check that finishes inside its bound is waited through', async () => {
    const w = world({
      pullAt: (t, d) => pull({ merged: d > 0 }),
      checksAt: (t) => [run('test', t < 60_000 ? null : 'success')],
    })
    expect(await w.run()).toMatchObject({ status: 'merged', triggers: 1 })
    w.cleanup()
  })

  it('ST-24/AC-2: with a landWhen list, only the named checks count', async () => {
    const w = world({
      landWhen: ['test'],
      pullAt: (t, d) => pull({ mergeable_state: 'unstable', merged: d > 0 }),
      checksAt: () => [run('test', 'success'), run('lint', 'failure')],
    })
    expect(await w.run()).toMatchObject({ status: 'merged', triggers: 1 })
    w.cleanup()
  })

  it('ST-24/AC-2: review/agent, the label and a draft are still required, and the checks are not read before them', async () => {
    const cases = [
      ['review-failed', () => pull(), () => 'failure'],
      ['draft', () => pull({ draft: true })],
      ['review-blocked', () => pull({ labels: [{ name: 'review-blocked' }] })],
      ['conflict', () => pull({ mergeable_state: 'dirty' })],
    ]
    for (const [expected, pullAt, reviewAt] of cases) {
      const w = world({ pullAt, reviewAt, checksAt: () => [run('test', 'success')] })
      expect((await w.run()).status).toBe(expected)
      expect(w.requests.some((r) => r.url.includes('/check-runs'))).toBe(false)
      expect(w.dispatches).toEqual([])
      w.cleanup()
    }
    const pending = world({ pullAt: () => pull(), reviewAt: () => 'pending', checksAt: () => [run('test', 'success')] })
    expect((await pending.run({ once: true })).reason).toBe('review-pending')
    expect(pending.requests.some((r) => r.url.includes('/check-runs'))).toBe(false)
    pending.cleanup()
  })

  it('ST-24/AC-2: a head whose check runs do not all fit in one page is not read as green', async () => {
    const w = world({ pullAt: () => pull() })
    const ctx = createLandContext({
      repo: REPO,
      landing: true,
      landWhen: 'all-checks',
      getToken: async () => 't',
      fetch: async (url) => ({
        ok: true,
        status: 200,
        json: async () => {
          if (url.includes('/check-runs')) return { total_count: 150, check_runs: [run('a', 'success')] }
          return url.includes('/commits/') ? status('success') : pull()
        },
      }),
    })
    await expect(w.run({ ctx })).rejects.toThrow(/150 check runs/)
    w.cleanup()
  })
})
