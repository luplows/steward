// @vitest-environment node

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { dispatchCoder } from './coder.mjs'
import { scheduleReviews, waitMs, withoutCredentials } from './coordinator-scheduler.mjs'
import { coordinatorPath, main, readRecord, runCoordinator, stopRequestPath } from './coordinator.mjs'
import { createContext } from './github.mjs'
import { createInspectContext, inspect, inspectMerges, inspectStalls, main as inspection } from './inspect.mjs'
import { landPullRequest } from './land.mjs'
import { ownedCheckoutPath, projectsPath, updateOwnedCheckout } from './project.mjs'
import { interruptRunning, readReviews, reviewEnding, reviewsPath } from './review-admission.mjs'
import { runRotation } from './rotation.mjs'
import { fixtureSettings, fixtureUserConfig } from './settings-fixture.mjs'
import { userConfigPath } from './user-config.mjs'
import { runRunway } from '../land/runway.mjs'

// AC-9: reaching any of these from scheduled work fails the test that did. The fixer has no module
// yet: it is the coder taken up again, which `dispatchCoder` stands for here.
const { forbidden } = vi.hoisted(() => ({ forbidden: () => { throw new Error('scheduled review work attempted an unrelated operation') } }))
vi.mock('./land.mjs', () => ({ landPullRequest: vi.fn(forbidden) }))
vi.mock('./coder.mjs', () => ({ dispatchCoder: vi.fn(forbidden) }))
vi.mock('./rotation.mjs', () => ({ runRotation: vi.fn(forbidden) }))
vi.mock('../land/runway.mjs', async (original) => ({ ...await original(), runRunway: vi.fn(forbidden) }))
vi.mock('./inspect.mjs', async (original) => ({
  ...await original(), main: vi.fn(forbidden), inspect: vi.fn(forbidden), inspectMerges: vi.fn(forbidden), inspectStalls: vi.fn(forbidden),
}))

const DISPATCH = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(DISPATCH, '..', '..')
const COORDINATOR = path.join(DISPATCH, 'coordinator.mjs')
const execFileAsync = promisify(execFile)

vi.setConfig({ testTimeout: 60_000 })

// Every test has a temporary home directory of its own: the real `~/.steward/` is never read or
// written. Reviews are stand-ins, or the real reviewer with a stand-in session and GitHub, and time
// is an injected clock, so no test sleeps for an interval.
let base
beforeAll(() => { base = realpathSync(mkdtempSync(path.join(tmpdir(), 'steward-scheduler-'))) })
afterAll(() => { rmSync(base, { recursive: true, force: true }) })

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
    await sleep(5)
  }
}

const INTERVAL = 15
const INTERVAL_MS = INTERVAL * 60_000
const A = 'crew/alpha'
const B = 'crew/beta'
const C = 'crew/gamma'
const HEAD = 'a'.repeat(40)
const eligible = (repo, number, expectedHeadSha = HEAD) => ({ repo, number, expectedHeadSha, status: 'eligible' })
const named = ({ repo, number }) => `${repo}#${number}`

function seed(file, content) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  return file
}
const writeProjects = (home, repos) => seed(projectsPath(home), {
  projects: repos.map((repo) => ({ repo, checkout: path.join(home, 'work', repo), ownedCheckout: ownedCheckoutPath(home, repo) })),
})

/** A clock a test moves on: `wait` holds until `elapse` releases the earliest one. */
function controllableClock() {
  let at = Date.parse('2026-11-02T10:00:00.000Z')
  const waits = []
  return {
    now: () => new Date(at),
    wait: vi.fn((ms) => new Promise((resolve) => waits.push({ ms, resolve }))),
    waits,
    elapse() {
      const { ms, resolve } = waits.shift()
      at += ms
      resolve()
    },
  }
}

const running = []
afterEach(async () => {
  for (const { coordinator, scheduling } of running.splice(0)) {
    coordinator.fail(new Error('the test is over'))
    await coordinator.done
    await scheduling
  }
  for (const effect of [landPullRequest, runRunway, runRotation, dispatchCoder, inspection, inspect, inspectMerges, inspectStalls]) {
    expect(effect).not.toHaveBeenCalled()
  }
})

/**
 * A coordinator in this process, scheduling with stand-ins, for `repos`. `listings` maps a repository
 * to what discovery returns, or an `Error` to throw, and tests change it between scans. `reply`
 * answers each review. Each review's name is pushed to `reviewed`.
 */
function schedule({ repos = [], home = freshHome(), listings = {}, reply = () => ({ status: 'recorded', sessions: 1 }), writeRecords = true, ...over } = {}) {
  if (writeRecords) writeProjects(home, repos)
  const clock = controllableClock()
  const reviewed = []
  const coordinator = runCoordinator({ homedir: home, pollMs: 10, now: clock.now, fields: { intervalMinutes: INTERVAL } })
  const listCandidates = vi.fn(async ({ ctx }) => {
    const found = listings[ctx.repo] ?? []
    if (found instanceof Error) throw found
    return found
  })
  const updateCheckout = vi.fn(async () => {})
  const review = vi.fn(async (args) => {
    reviewed.push(named(args.candidate))
    return reply(args.candidate, reviewed.length)
  })
  const contexts = vi.fn((repo) => ({ ctx: { repo } }))
  const scheduling = scheduleReviews({
    homedir: home, coordinator, intervalMinutes: INTERVAL, contexts, listCandidates, updateCheckout, review, now: clock.now, wait: clock.wait, ...over,
  })
  const handle = { home, clock, reviewed, coordinator, listCandidates, updateCheckout, review, contexts, listings, scheduling }
  running.push(handle)
  return handle
}
/** Waits until the scheduler has run out of known work and is waiting for scan number `n`. */
const idle = (h, n = 1) => until(() => h.clock.wait.mock.calls.length >= n && h.clock.waits.length > 0)
const recordOf = (h) => readRecord(coordinatorPath(h.home))
const nextScan = async (h, n) => {
  h.clock.elapse()
  await idle(h, n)
}

/** `steward coordinator status --json` in a process of its own, as a person runs it. */
async function statusFromAnotherProcess(home) {
  const env = { ...process.env, USERPROFILE: home, HOME: home }
  const { stdout } = await execFileAsync(process.execPath, [COORDINATOR, 'status', '--json'], { env, encoding: 'utf8' })
  return JSON.parse(stdout)
}

async function command(argv, home, options = {}) {
  const lines = { out: [], err: [] }
  const code = await main(argv, {
    homedir: home, env: {}, pollMs: 20, out: (line) => lines.out.push(line), err: (line) => lines.err.push(line), ...options,
  })
  return { code, out: lines.out.join('\n'), err: lines.err.join('\n') }
}

describe('ST-61/AC-1: only activated projects', () => {
  it('an initial scan lists only the activated projects at once, brings the owned checkout to main, and passes it as repoDir', async () => {
    const h = schedule({ repos: [A], listings: { [A]: [eligible(A, 1)], 'crew/inactive': [eligible('crew/inactive', 9)] } })
    await idle(h)
    expect(h.listCandidates.mock.calls.map(([{ ctx }]) => ctx.repo)).toEqual([A])
    expect(h.reviewed).toEqual([`${A}#1`])
    const owned = ownedCheckoutPath(h.home, A)
    expect(h.updateCheckout.mock.calls).toEqual([[owned]])
    expect(h.review.mock.calls[0][0].repoDir).toBe(owned)
    expect(h.updateCheckout.mock.invocationCallOrder[0]).toBeLessThan(h.review.mock.invocationCallOrder[0])
  })

  it('with no activated project, a scan makes no GitHub context and lists nothing, as for a detached coordinator in a test\'s temporary home', async () => {
    const h = schedule({ repos: [] })
    await idle(h)
    expect(h.contexts).not.toHaveBeenCalled()
    expect(h.listCandidates).not.toHaveBeenCalled()
    expect(h.updateCheckout).not.toHaveBeenCalled()
    expect(h.review).not.toHaveBeenCalled()
  })

  it('only a candidate listReviewCandidates calls eligible is reviewed', async () => {
    const h = schedule({
      repos: [A],
      listings: { [A]: [{ ...eligible(A, 1), status: 'draft', reason: 'a draft' }, { ...eligible(A, 2), status: 'already-reviewed' }, eligible(A, 3)] },
    })
    await idle(h)
    expect(h.reviewed).toEqual([`${A}#3`])
  })

  it('unreadable records at a scan: no discovery, no review, status gives the reason, nothing is activated, and a later scan carries on', async () => {
    const home = freshHome()
    const file = seed(projectsPath(home), '{ "projects": [')
    const h = schedule({ home, writeRecords: false, listings: { [A]: [eligible(A, 1)] } })
    await idle(h)
    expect(h.listCandidates).not.toHaveBeenCalled()
    expect(h.review).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf8')).toBe('{ "projects": [')
    const status = await statusFromAnotherProcess(home)
    expect(status.recordsProblem).toContain(`${file} is malformed`)

    writeProjects(home, [A])
    await nextScan(h, 2)
    expect(h.reviewed).toEqual([`${A}#1`])
    expect(recordOf(h).recordsProblem).toBe(null)
  })

  it('records unreadable before an admission: that admission does not happen', async () => {
    const home = freshHome()
    const h = schedule({
      home, repos: [A], listings: { [A]: [eligible(A, 1), eligible(A, 2)] },
      reply: () => {
        seed(projectsPath(home), 'not json')
        return { status: 'recorded', sessions: 1 }
      },
    })
    await idle(h)
    expect(h.reviewed).toEqual([`${A}#1`])
    expect(recordOf(h).recordsProblem).toContain('is malformed')
  })
})

describe('ST-61/AC-1: the records read again after the checkout update, just before admitting', () => {
  it('a project deactivated while its checkout updates: its queue is dropped, no review of it starts, and the others carry on', async () => {
    const home = freshHome()
    const h = schedule({
      home, repos: [A, B], listings: { [A]: [eligible(A, 1), eligible(A, 2)], [B]: [eligible(B, 3)] },
      updateCheckout: vi.fn(async (dir) => {
        if (dir === ownedCheckoutPath(home, A)) writeProjects(home, [B])
      }),
    })
    await idle(h)
    expect(h.reviewed).toEqual([`${B}#3`])
    expect(readReviews(reviewsPath(home)).map(({ repo }) => repo)).toEqual([B])
  })

  it('records that become unreadable while a checkout updates: no review starts, and status gives the reason', async () => {
    const home = freshHome()
    const file = projectsPath(home)
    const h = schedule({
      home, repos: [A], listings: { [A]: [eligible(A, 1)] },
      updateCheckout: vi.fn(async () => { seed(file, 'not json') }),
    })
    await idle(h)
    expect(h.review).not.toHaveBeenCalled()
    expect(existsSync(reviewsPath(home))).toBe(false)
    expect((await statusFromAnotherProcess(home)).recordsProblem).toContain(`${file} is malformed`)
  })
})

describe('ST-61/AC-2: fair turns', () => {
  it('two projects with several candidates alternate, each in its own candidates\' order, whichever order the records are in', async () => {
    const h = schedule({ repos: [B, A], listings: { [A]: [eligible(A, 1), eligible(A, 2)], [B]: [eligible(B, 3), eligible(B, 4)] } })
    await idle(h)
    expect(h.reviewed).toEqual([`${A}#1`, `${B}#3`, `${A}#2`, `${B}#4`])
  })

  it('a project with nothing eligible gets no turn, and one with heads left carries on alone', async () => {
    const h = schedule({ repos: [A, B, C], listings: { [A]: [eligible(A, 1), eligible(A, 2), eligible(A, 3)], [B]: [], [C]: [eligible(C, 4)] } })
    await idle(h)
    expect(h.reviewed).toEqual([`${A}#1`, `${C}#4`, `${A}#2`, `${A}#3`])
    expect(h.updateCheckout).not.toHaveBeenCalledWith(ownedCheckoutPath(h.home, B))
  })

  it('a project deactivated between turns gets no more turns', async () => {
    const home = freshHome()
    const h = schedule({
      home, repos: [A, B], listings: { [A]: [eligible(A, 1), eligible(A, 2)], [B]: [eligible(B, 3)] },
      reply: () => {
        writeProjects(home, [A])
        return { status: 'recorded', sessions: 1 }
      },
    })
    await idle(h)
    expect(h.reviewed).toEqual([`${A}#1`, `${A}#2`])
  })

  it('a project activated between turns is discovered at the next scan and takes its place in the order', async () => {
    const home = freshHome()
    const h = schedule({
      home, repos: [A, C], listings: { [A]: [eligible(A, 1)], [B]: [eligible(B, 2)], [C]: [eligible(C, 3)] },
      reply: () => {
        writeProjects(home, [A, B, C])
        return { status: 'recorded', sessions: 1 }
      },
    })
    await idle(h)
    expect(h.reviewed).toEqual([`${A}#1`, `${C}#3`])
    h.listings[A] = [eligible(A, 4)]
    h.listings[C] = [eligible(C, 5)]
    await nextScan(h, 2)
    // The position, gamma, carries over the scan, so the round begins again at alpha.
    expect(h.reviewed.slice(2)).toEqual([`${A}#4`, `${B}#2`, `${C}#5`])
  })

  it('the position carries over a scan, and a restart begins a new round', async () => {
    const home = freshHome()
    const listings = { [A]: [eligible(A, 1)] }
    const h = schedule({ home, repos: [A, B], listings })
    await idle(h)
    expect(h.reviewed).toEqual([`${A}#1`])
    listings[A] = [eligible(A, 2)]
    listings[B] = [eligible(B, 3)]
    await nextScan(h, 2)
    expect(h.reviewed.slice(1)).toEqual([`${B}#3`, `${A}#2`])

    h.coordinator.fail(new Error('restarted'))
    await h.coordinator.done
    await h.scheduling
    listings[A] = [eligible(A, 4)]
    listings[B] = [eligible(B, 5)]
    const again = schedule({ home, repos: [A, B], listings })
    await idle(again)
    expect(again.reviewed).toEqual([`${A}#4`, `${B}#5`])
  })
})

describe('ST-61/AC-3: one review at a time', () => {
  it('with a stand-in review held open, no second one starts, whatever else is known', async () => {
    let release
    const h = schedule({
      repos: [A, B], listings: { [A]: [eligible(A, 1)], [B]: [eligible(B, 2)] },
      reply: (_candidate, n) => (n === 1 ? new Promise((resolve) => { release = () => resolve({ status: 'recorded', sessions: 1 }) }) : { status: 'recorded', sessions: 1 }),
    })
    await until(() => h.review.mock.calls.length === 1)
    await sleep(50)
    expect(h.reviewed).toEqual([`${A}#1`])
    expect(h.clock.wait).not.toHaveBeenCalled()
    release()
    await idle(h)
    expect(h.reviewed).toEqual([`${A}#1`, `${B}#2`])
  })

  it('manual commands reach neither the scheduler nor its position', () => {
    for (const name of ['review', 'rotation', 'land']) {
      expect(readFileSync(path.join(DISPATCH, `${name}.mjs`), 'utf8')).not.toMatch(/coordinator-scheduler|coordinator\.mjs/)
    }
  })
})

describe('ST-61/AC-4: scanning', () => {
  it('consecutive known reviews have no interval between them, and discovery runs once for them', async () => {
    const waitsSeen = []
    const h = schedule({
      repos: [A], listings: { [A]: [eligible(A, 1), eligible(A, 2), eligible(A, 3)] },
      reply: () => {
        waitsSeen.push(h.clock.wait.mock.calls.length)
        return { status: 'recorded', sessions: 1 }
      },
    })
    await idle(h)
    expect(waitsSeen).toEqual([0, 0, 0])
    expect(h.listCandidates).toHaveBeenCalledTimes(1)
  })

  it('with nothing left it starts no session and does not busy-loop: one wait, of the interval, and no scan until it ends', async () => {
    const h = schedule({ repos: [A] })
    await idle(h)
    await sleep(50)
    expect(h.review).not.toHaveBeenCalled()
    expect(h.listCandidates).toHaveBeenCalledTimes(1)
    expect(h.clock.wait.mock.calls).toEqual([[INTERVAL_MS]])
    expect(recordOf(h).nextScanAt).toBe('2026-11-02T10:15:00.000Z')
  })

  it('new work is discovered at a later scan', async () => {
    const h = schedule({ repos: [A] })
    await idle(h)
    h.listings[A] = [eligible(A, 1)]
    await nextScan(h, 2)
    expect(h.reviewed).toEqual([`${A}#1`])
    expect(h.listCandidates).toHaveBeenCalledTimes(2)
    expect(recordOf(h).nextScanAt).toBe('2026-11-02T10:30:00.000Z')
  })

  it('the largest interval ST-63 accepts: the next scan\'s time is unknown, the coordinator carries on, and it waits and scans as normal', async () => {
    const largest = Math.floor(Number.MAX_SAFE_INTEGER / 60_000)
    const h = schedule({ repos: [A], intervalMinutes: largest })
    await idle(h)
    expect(h.clock.wait.mock.calls).toEqual([[largest * 60_000]])
    expect(h.coordinator.admitting()).toBe(true)
    expect(recordOf(h).nextScanAt).toBe(null)
    expect(await statusFromAnotherProcess(h.home)).toMatchObject({ status: 'running', nextScanAt: null })

    await nextScan(h, 2)
    expect(h.listCandidates).toHaveBeenCalledTimes(2)
    expect(h.coordinator.admitting()).toBe(true)
  })

  it('the real wait holds for an interval longer than one timer can', async () => {
    vi.useFakeTimers()
    try {
      const longest = 2 ** 31 - 1
      const timer = vi.spyOn(globalThis, 'setTimeout')
      let over = false
      const waiting = waitMs(longest + 60_000).then(() => { over = true })
      await vi.advanceTimersByTimeAsync(longest)
      expect(over).toBe(false)
      await vi.advanceTimersByTimeAsync(60_000)
      await waiting
      expect(over).toBe(true)
      // A real `setTimeout` given more than this fires at once, which fake timers do not show.
      expect(timer.mock.calls.map(([, ms]) => ms)).toEqual([longest, 60_000])
      timer.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ST-61/AC-6: failures and refusals do not loop', () => {
  it('a discovery failure starts no review of that project, is in status, does not stop the others, and is retried at the next scan', async () => {
    const h = schedule({ repos: [A, B], listings: { [A]: new Error('GitHub said 502'), [B]: [eligible(B, 1)] } })
    await idle(h)
    expect(h.reviewed).toEqual([`${B}#1`])
    expect(h.listCandidates).toHaveBeenCalledTimes(2)
    const status = await statusFromAnotherProcess(h.home)
    expect(status.projectProblems).toEqual([{ repo: A, reason: 'discovery failed: GitHub said 502' }])

    h.listings[A] = [eligible(A, 2)]
    h.listings[B] = []
    await nextScan(h, 2)
    expect(h.listCandidates).toHaveBeenCalledTimes(4)
    expect(h.reviewed).toEqual([`${B}#1`, `${A}#2`])
    expect(recordOf(h).projectProblems).toEqual([])
  })

  it('a checkout failure starts no review of that project, is in status, does not stop the others, and is retried at the next scan', async () => {
    const home = freshHome()
    let broken = true
    const h = schedule({
      home, repos: [A, B], listings: { [A]: [eligible(A, 1), eligible(A, 2)], [B]: [eligible(B, 3)] },
      updateCheckout: vi.fn(async (dir) => {
        if (broken && dir === ownedCheckoutPath(home, A)) throw new Error('fatal: could not read from remote')
      }),
    })
    await idle(h)
    expect(h.reviewed).toEqual([`${B}#3`])
    expect(recordOf(h).projectProblems).toEqual([
      { repo: A, reason: 'could not bring the owned checkout to origin\'s main: fatal: could not read from remote' },
    ])

    broken = false
    h.listings[B] = []
    await nextScan(h, 2)
    expect(h.reviewed).toEqual([`${B}#3`, `${A}#1`, `${A}#2`])
    expect(recordOf(h).projectProblems).toEqual([])
  })

  it('a real owned checkout that is missing is such a failure, with no review', async () => {
    const home = freshHome()
    const h = schedule({ home, repos: [A], listings: { [A]: [eligible(A, 1)] }, updateCheckout: updateOwnedCheckout })
    await idle(h)
    expect(h.review).not.toHaveBeenCalled()
    expect(recordOf(h).projectProblems[0].reason).toContain('is not a checkout')
  })

  for (const [status, refusal, reason] of [
    ['over-usage', { window: 'weekly', percent: 95, limit: 90, resetsAt: 'later' }, 'the weekly window is at 95%, at or over the limit of 90%; it resets at later'],
    ['usage-unknown', { reason: 'the usage could not be read' }, 'the usage could not be read'],
  ]) {
    it(`${status}: no more reviews until the next scan, where the reviewer checks again, with the reason in status`, async () => {
      let refusing = true
      const h = schedule({
        repos: [A, B], listings: { [A]: [eligible(A, 1), eligible(A, 2)], [B]: [eligible(B, 3)] },
        reply: () => (refusing ? { status, ...refusal } : { status: 'recorded', sessions: 1 }),
      })
      await idle(h)
      expect(h.reviewed).toEqual([`${A}#1`])
      expect(h.listCandidates).toHaveBeenCalledTimes(2)
      const seen = await statusFromAnotherProcess(h.home)
      expect(seen.usage).toEqual({ status, reason })
      expect(seen.lastOutcome).toMatchObject({ status, counted: 'no-model-refusal' })
      await sleep(50)
      expect(h.reviewed).toHaveLength(1)

      refusing = false
      await nextScan(h, 2)
      expect(h.reviewed.slice(1)).toEqual([`${B}#3`, `${A}#1`, `${A}#2`])
      expect(recordOf(h).usage).toBe(null)
    })
  }

  it('another no-model refusal ends that head\'s turn only, and the head may be considered again at a later scan', async () => {
    let refusing = true
    const h = schedule({
      repos: [A], listings: { [A]: [eligible(A, 1), eligible(A, 2)] },
      reply: ({ number }) => (refusing && number === 1 ? { status: 'head-moved', reason: 'moved' } : { status: 'recorded', sessions: 1 }),
    })
    await idle(h)
    expect(h.reviewed).toEqual([`${A}#1`, `${A}#2`])
    expect(reviewEnding({ homedir: h.home, repo: A, number: 1, headSha: HEAD })).toBe('no-model-refusal')

    refusing = false
    h.listings[A] = [eligible(A, 1)]
    await nextScan(h, 2)
    expect(h.reviewed).toEqual([`${A}#1`, `${A}#2`, `${A}#1`])
  })
})

describe('ST-61/AC-6a: a record that cannot be kept ends the coordinator', () => {
  it('a stand-in record-failed goes to fail, and nothing more is admitted', async () => {
    const admission = vi.fn(async () => ({ status: 'record-failed', file: 'reviews.json', reason: 'the record could not be written' }))
    const h = schedule({ repos: [A], listings: { [A]: [eligible(A, 1), eligible(A, 2)] }, admission })
    expect((await h.coordinator.done).message).toBe('the record could not be written')
    await h.scheduling
    expect(admission).toHaveBeenCalledTimes(1)
    expect(h.coordinator.admit(() => {})).toBe(false)
    expect(existsSync(coordinatorPath(h.home))).toBe(false)
  })

  it('a reviews.json that cannot be read at a scan ends it through reviewEnding, starting no review, and the next start refuses the file', async () => {
    const home = freshHome()
    const file = seed(reviewsPath(home), '{ "reviews": [')
    const h = schedule({ home, repos: [A], listings: { [A]: [eligible(A, 1)] } })
    expect((await h.coordinator.done).message).toContain(`${file} is malformed`)
    await h.scheduling
    expect(h.review).not.toHaveBeenCalled()
    expect(h.clock.wait).not.toHaveBeenCalled()

    seed(userConfigPath({ env: {}, homedir: home }), fixtureUserConfig())
    const spawnFn = vi.fn()
    const again = await command(['start'], home, { spawnFn })
    expect(again.code).toBe(1)
    expect(again.err).toContain(`${file} is malformed`)
    expect(spawnFn).not.toHaveBeenCalled()
  })

  it('a reviews.json unreadable just before admitting ends it through reviewEnding, with nothing admitted', async () => {
    const home = freshHome()
    const file = reviewsPath(home)
    const admission = vi.fn()
    const h = schedule({
      home, repos: [A], listings: { [A]: [eligible(A, 1)] },
      updateCheckout: async () => { seed(file, 'not json') },
      admission,
    })
    expect((await h.coordinator.done).message).toContain(`${file} is malformed`)
    expect(admission).not.toHaveBeenCalled()
  })

  it('an outcome that cannot be written ends it, and the next start moves the entry still running', async () => {
    const home = freshHome()
    const file = reviewsPath(home)
    const h = schedule({
      home, repos: [A], listings: { [A]: [eligible(A, 1), eligible(A, 2)] },
      reply: () => {
        mkdirSync(`${file}.tmp`)
        return { status: 'recorded', sessions: 1 }
      },
    })
    expect(await h.coordinator.done).toBeInstanceOf(Error)
    await h.scheduling
    expect(h.reviewed).toEqual([`${A}#1`])
    expect(readReviews(file).map(({ state }) => state)).toEqual(['running'])

    rmSync(`${file}.tmp`, { recursive: true })
    expect(interruptRunning({ homedir: home }).map(({ number }) => number)).toEqual([1])
    expect(reviewEnding({ homedir: home, repo: A, number: 1, headSha: HEAD })).toBe('model-consuming-failure')
  })

  it('already-admitted ends that head\'s turn and starts no session', async () => {
    const home = freshHome()
    const entry = { repo: A, number: 1, headSha: HEAD, state: 'running', startedAt: '2026-11-02T09:00:00.000Z' }
    seed(reviewsPath(home), { reviews: [entry] })
    const h = schedule({ home, repos: [A], listings: { [A]: [eligible(A, 1), eligible(A, 2)] } })
    await idle(h)
    expect(h.reviewed).toEqual([`${A}#2`])
    expect(readReviews(reviewsPath(home))[0]).toEqual(entry)
  })

  it('already-admitted is the last outcome when nothing follows it', async () => {
    const home = freshHome()
    seed(reviewsPath(home), { reviews: [{ repo: A, number: 1, headSha: HEAD, state: 'running', startedAt: '2026-11-02T09:00:00.000Z' }] })
    const h = schedule({ home, repos: [A], listings: { [A]: [eligible(A, 1)] } })
    await idle(h)
    expect(h.review).not.toHaveBeenCalled()
    expect(recordOf(h).lastOutcome).toEqual({ repo: A, number: 1, headSha: HEAD, status: 'already-admitted', at: '2026-11-02T10:00:00.000Z' })
  })
})

describe('ST-61/AC-7: a failed head is not paid for twice', () => {
  for (const [name, reply] of [
    ['session-failed', () => ({ status: 'session-failed', reason: 'stalled', sessions: 1 })],
    ['malformed-verdict', () => ({ status: 'malformed-verdict', reason: 'twice', sessions: 2 })],
    ['a review that threw', () => { throw new Error('it threw') }],
  ]) {
    it(`${name}: not reviewed on later scans or after a restart, listed by status with its entry unchanged, and a new head is eligible`, async () => {
      const home = freshHome()
      const listings = { [A]: [eligible(A, 1)] }
      const h = schedule({ home, repos: [A], listings, reply })
      await idle(h)
      expect(h.reviewed).toEqual([`${A}#1`])
      await nextScan(h, 2)
      await nextScan(h, 3)
      expect(h.review).toHaveBeenCalledTimes(1)
      expect(h.listCandidates).toHaveBeenCalledTimes(3)

      const before = readFileSync(reviewsPath(home), 'utf8')
      const status = await statusFromAnotherProcess(home)
      expect(status.failedHeads).toEqual([{ repo: A, number: 1, headSha: HEAD, status: expect.any(String), endedAt: expect.any(String) }])
      expect(readFileSync(reviewsPath(home), 'utf8')).toBe(before)

      h.coordinator.fail(new Error('restarted'))
      await h.coordinator.done
      await h.scheduling
      const again = schedule({ home, repos: [A], listings })
      await idle(again)
      expect(again.review).not.toHaveBeenCalled()

      const newer = 'b'.repeat(40)
      listings[A] = [eligible(A, 1, newer)]
      await nextScan(again, 2)
      expect(again.review).toHaveBeenCalledTimes(1)
      expect(again.review.mock.calls[0][0].candidate.expectedHeadSha).toBe(newer)
    })
  }

  it('discovery listing the same pull request and head twice: a failure of the first means the second starts no review, and the next head still does', async () => {
    const h = schedule({
      repos: [A], listings: { [A]: [eligible(A, 1), eligible(A, 1), eligible(A, 2)] },
      reply: ({ number }) => (number === 1 ? { status: 'session-failed', reason: 'stalled', sessions: 1 } : { status: 'recorded', sessions: 1 }),
    })
    await idle(h)
    expect(h.reviewed).toEqual([`${A}#1`, `${A}#2`])
    expect(reviewEnding({ homedir: h.home, repo: A, number: 1, headSha: HEAD })).toBe('model-consuming-failure')
  })

  it('an interrupted head is not reviewed again either', async () => {
    const home = freshHome()
    seed(reviewsPath(home), {
      reviews: [{ repo: A, number: 1, headSha: HEAD, state: 'ended', startedAt: '2026-11-02T09:00:00.000Z', endedAt: '2026-11-02T09:01:00.000Z', result: { status: 'interrupted' } }],
    })
    const h = schedule({ home, repos: [A], listings: { [A]: [eligible(A, 1)] } })
    await idle(h)
    expect(h.review).not.toHaveBeenCalled()
    const { failedHeads } = await statusFromAnotherProcess(home)
    expect(failedHeads).toEqual([{ repo: A, number: 1, headSha: HEAD, status: 'interrupted', endedAt: '2026-11-02T09:01:00.000Z' }])
  })

  it('a verdict from a manual review takes the head out of discovery, and a verdict or refusal is not listed as failed', async () => {
    const h = schedule({ repos: [A], listings: { [A]: [eligible(A, 1), eligible(A, 2)] }, reply: ({ number }) => (number === 1 ? { status: 'recorded', sessions: 1 } : { status: 'head-moved', reason: 'moved' }) })
    await idle(h)
    h.listings[A] = [{ ...eligible(A, 1), status: 'already-reviewed', reason: 'a verdict is already at its head' }]
    await nextScan(h, 2)
    expect(h.review).toHaveBeenCalledTimes(2)
    expect(await statusFromAnotherProcess(h.home)).not.toHaveProperty('failedHeads')
  })
})

describe('ST-61/AC-8: stop, deactivation and status', () => {
  const heldReview = () => {
    const held = { release: null }
    held.reply = () => new Promise((resolve) => { held.release = () => resolve({ status: 'recorded', sessions: 1 }) })
    return held
  }

  it('a stop during a stand-in review: the review finishes, its outcome is written, nothing more is admitted, and no scan follows', async () => {
    const held = heldReview()
    const h = schedule({ repos: [A, B], listings: { [A]: [eligible(A, 1)], [B]: [eligible(B, 2)] }, reply: held.reply })
    await until(() => held.release !== null)
    const stopped = await command(['stop'], h.home)
    expect(stopped.out).toMatch(/^stopping: /)
    const stopping = await statusFromAnotherProcess(h.home)
    expect(stopping).toMatchObject({ status: 'stopping', intervalMinutes: INTERVAL, active: { repo: A, number: 1, headSha: HEAD } })

    held.release()
    expect(await h.coordinator.done).toBe(null)
    await h.scheduling
    expect(h.reviewed).toEqual([`${A}#1`])
    expect(h.listCandidates).toHaveBeenCalledTimes(2)
    expect(h.clock.wait).not.toHaveBeenCalled()
    expect(reviewEnding({ homedir: h.home, repo: A, number: 1, headSha: HEAD })).toBe('verdict')
    expect(existsSync(coordinatorPath(h.home))).toBe(false)
    expect(existsSync(stopRequestPath(h.home))).toBe(false)
  })

  it('a stop while idle ends the wait, without the interval passing', async () => {
    const h = schedule({ repos: [A] })
    await idle(h)
    expect((await command(['stop'], h.home)).out).toMatch(/^stopped: /)
    expect(await h.coordinator.done).toBe(null)
    await h.scheduling
    expect(h.clock.waits).toHaveLength(1)
  })

  it('a project deactivated during a stand-in review: that review finishes, and the project is not admitted afterwards', async () => {
    const home = freshHome()
    const held = heldReview()
    const h = schedule({ home, repos: [A], listings: { [A]: [eligible(A, 1), eligible(A, 2)] }, reply: held.reply })
    await until(() => held.release !== null)
    writeProjects(home, [])
    held.release()
    await idle(h)
    expect(h.reviewed).toEqual([`${A}#1`])
    expect(reviewEnding({ homedir: home, repo: A, number: 1, headSha: HEAD })).toBe('verdict')
  })

  it('status, in a separate process, shows the active project, PR and full head, the interval, the next scan, the last outcome and the reasons', async () => {
    const held = heldReview()
    const h = schedule({
      repos: [A, B], listings: { [A]: new Error('GitHub said 502'), [B]: [eligible(B, 1), eligible(B, 2)] },
      reply: ({ number }) => (number === 1 ? { status: 'head-moved', reason: 'it moved' } : held.reply()),
    })
    await until(() => held.release !== null)
    const during = await statusFromAnotherProcess(h.home)
    expect(during).toMatchObject({
      status: 'running',
      pid: process.pid,
      intervalMinutes: INTERVAL,
      nextScanAt: null,
      active: { repo: B, number: 2, headSha: HEAD },
      lastOutcome: { repo: B, number: 1, headSha: HEAD, status: 'head-moved', counted: 'no-model-refusal', reason: 'it moved' },
      projectProblems: [{ repo: A, reason: 'discovery failed: GitHub said 502' }],
      recordsProblem: null,
    })
    held.release()
    await idle(h)
    const after = await statusFromAnotherProcess(h.home)
    expect(after.active).toBe(null)
    expect(after.nextScanAt).toBe('2026-11-02T10:15:00.000Z')
    expect(after.lastOutcome).toMatchObject({ number: 2, status: 'recorded', counted: 'verdict' })

    const lines = []
    expect(await main(['status'], { homedir: h.home, out: (line) => lines.push(line) })).toBe(0)
    const text = lines.join('\n')
    expect(text).toContain('Scan interval: 15 minutes.')
    expect(text).toContain('Next scan: 2026-11-02T10:15:00.000Z.')
    expect(text).toContain(`Last outcome: ${B} pull request #2, head ${HEAD}: recorded (verdict)`)
    expect(text).toContain(`${A}: no review until a later scan: discovery failed: GitHub said 502`)
  })

  it('status says when the record of reviews cannot be read, and still reports, and changes nothing', async () => {
    const home = freshHome()
    const file = seed(reviewsPath(home), '{ "reviews": [')
    const seen = await statusFromAnotherProcess(home)
    expect(seen.status).toBe('stopped')
    expect(seen.reviewsProblem).toContain(`${file} is malformed`)
    expect(readFileSync(file, 'utf8')).toBe('{ "reviews": [')
    expect((await command(['status'], home)).out).toContain(`The record of reviews cannot be read: ${file} is malformed`)
  })

  it('no credentials reach the record: a URL\'s user and password are taken out of a reason', async () => {
    expect(withoutCredentials('fatal: unable to access \'https://me:s3cret@github.com/crew/alpha.git/\'')).toBe('fatal: unable to access \'https://github.com/crew/alpha.git/\'')
    const h = schedule({ repos: [A], listings: { [A]: new Error('unable to access https://me:s3cret@github.com/crew/alpha.git') } })
    await idle(h)
    expect(readFileSync(coordinatorPath(h.home), 'utf8')).not.toContain('s3cret')
    expect(JSON.stringify(await statusFromAnotherProcess(h.home))).not.toContain('s3cret')
  })

  it('a failed write of these fields is not fatal: the coordinator carries on, and its next write replaces them', async () => {
    const home = freshHome()
    const blocker = `${coordinatorPath(home)}.tmp`
    const held = heldReview()
    const h = schedule({
      home, repos: [A], listings: { [A]: [eligible(A, 1), eligible(A, 2)] },
      updateCheckout: async () => { if (!existsSync(blocker)) mkdirSync(blocker) },
      reply: ({ number }) => (number === 1 ? held.reply() : { status: 'recorded', sessions: 1 }),
    })
    await until(() => held.release !== null)
    // `active` could not be written, so the record is as it was before this review.
    expect(recordOf(h).active ?? null).toBe(null)
    held.release()
    await until(() => h.reviewed.length === 2)
    await until(() => h.clock.waits.length > 0)
    expect(h.coordinator.admitting()).toBe(true)
    rmSync(blocker, { recursive: true })
    h.listings[A] = []
    await nextScan(h, 2)
    expect(recordOf(h)).toMatchObject({ lastOutcome: { number: 2, status: 'recorded' }, active: null, intervalMinutes: INTERVAL })
  })

  it('once the coordinator has removed its record, report does not write it back', async () => {
    const home = freshHome()
    const coordinator = runCoordinator({ homedir: home, pollMs: 10, fields: { intervalMinutes: INTERVAL } })
    coordinator.fail(new Error('over'))
    await coordinator.done
    coordinator.report({ active: null })
    expect(existsSync(coordinatorPath(home))).toBe(false)
  })

  it('report writes only when a field changes', async () => {
    const home = freshHome()
    const coordinator = runCoordinator({ homedir: home, pollMs: 10, fields: { intervalMinutes: INTERVAL } })
    running.push({ coordinator, scheduling: Promise.resolve() })
    coordinator.report({ active: null })
    // A mark no write of the coordinator's would keep, so that its going shows a write happened.
    const file = coordinatorPath(home)
    const marked = JSON.stringify({ ...readRecord(file), mark: true })
    writeFileSync(file, marked)
    coordinator.report({ active: null })
    expect(readFileSync(file, 'utf8')).toBe(marked)
    coordinator.report({ intervalMinutes: INTERVAL })
    expect(readFileSync(file, 'utf8')).toBe(marked)

    // A write that fails leaves the file as it was, and the next one carries what it had.
    const blocker = `${file}.tmp`
    mkdirSync(blocker)
    coordinator.report({ active: { repo: A, number: 1, headSha: HEAD } })
    expect(readFileSync(file, 'utf8')).toBe(marked)
    rmSync(blocker, { recursive: true })
    coordinator.report({ nextScanAt: null })
    const record = readRecord(file)
    expect(record).toMatchObject({ active: { repo: A, number: 1, headSha: HEAD }, nextScanAt: null, intervalMinutes: INTERVAL, state: 'running' })
    expect(record).not.toHaveProperty('mark')
  })
})

const git = (cwd, ...args) => execFileSync('git', [
  '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args,
], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

describe('ST-61/AC-9: only reviews, whatever a project\'s conventions', () => {
  const UNDER = { ok: true, session: { percent: 10, resetsAt: 't1' }, weekly: { percent: 10, resetsAt: 't2' } }
  const ISSUES = 'crew/issues'
  const FILES = 'crew/files'
  const INACTIVE = 'crew/inactive'
  const UNIT = 'A plain client requirement, with no story frontmatter.'

  /** A local origin of `repo`, whose main has its settings, and a branch `change` with a head. */
  function origin(root, repo, settings) {
    const [, name] = repo.split('/')
    const bare = path.join(root, `${name}.git`)
    const seedDir = path.join(root, `${name}-seed`)
    git(root, 'init', '-q', '--bare', '-b', 'main', bare)
    git(root, 'clone', '-q', bare, seedDir)
    mkdirSync(path.join(seedDir, 'policy'))
    mkdirSync(path.join(seedDir, 'work'))
    writeFileSync(path.join(seedDir, 'policy', 'review.md'), '# Client checklist\n\n## Client policy\n\n1. Respect the client requirement.\n')
    writeFileSync(path.join(seedDir, 'work', 'requirement.md'), UNIT)
    writeFileSync(path.join(seedDir, 'steward.config.json'), JSON.stringify(fixtureSettings({ repo, rulesFile: 'policy/review.md', setup: null, check: null, ...settings })))
    git(seedDir, 'add', '.')
    git(seedDir, 'commit', '-qm', 'client base')
    git(seedDir, 'push', '-q', 'origin', 'main')
    git(seedDir, 'checkout', '-qb', 'change')
    writeFileSync(path.join(seedDir, `${name}.txt`), name)
    git(seedDir, 'add', '.')
    git(seedDir, 'commit', '-qm', 'a change')
    git(seedDir, 'push', '-q', 'origin', 'change')
    return { bare, seedDir, head: git(seedDir, 'rev-parse', 'HEAD') }
  }

  /** A stand-in GitHub for `repo`, which admits reads and the reviewer's marker comment. */
  function github(repo, pull) {
    const requests = [], posted = []
    const prefix = `/repos/${repo}`
    const fetch = async (url, init) => {
      const u = new URL(url)
      requests.push(`${init.method} ${u.pathname}`)
      const json = (data) => ({ ok: true, json: async () => data })
      if (init.method === 'GET') {
        if (u.pathname === `${prefix}/git/matching-refs/heads/release/v`) return json([])
        if (u.pathname === `${prefix}/pulls`) return json(u.searchParams.get('base') === 'main' && Number(u.searchParams.get('page') ?? 1) === 1 ? [pull] : [])
        if (u.pathname === `${prefix}/pulls/${pull.number}`) return json(pull)
        if (u.pathname === `${prefix}/issues/${pull.number}/labels`) return json([])
        if (u.pathname === `${prefix}/issues/${pull.number}/comments`) {
          return json(posted.map((body, i) => ({ id: i + 1, user: { login: 'crew' }, author_association: 'OWNER', body })))
        }
        if (u.pathname === `${prefix}/issues/81`) return json({ number: 81, title: 'Client issue', body: UNIT })
      }
      if (init.method === 'POST' && u.pathname === `${prefix}/issues/${pull.number}/comments`) {
        posted.push(JSON.parse(init.body).body)
        return json({ id: 123 })
      }
      throw new Error(`forbidden or unexpected GitHub operation: ${init.method} ${url}`)
    }
    const auth = { repo, fetch, getToken: async () => 'fixture-token' }
    return { contexts: { ctx: createContext(auth), inspectCtx: createInspectContext(auth) }, requests, posted }
  }

  it('two activated projects with issue and file unit links, one with land true and one false, and an inactive one: each reviewed once, in turns, from origin\'s main, with nothing but a marker comment written', async () => {
    const root = path.join(base, `origins-${++counter}`)
    mkdirSync(root)
    const home = freshHome()
    const issues = origin(root, ISSUES, { unitLinks: ['issue'], land: true })
    const files = origin(root, FILES, { unitLinks: ['file'], land: false })
    for (const [repo, { bare }] of [[ISSUES, issues], [FILES, files]]) {
      const owned = ownedCheckoutPath(home, repo)
      mkdirSync(path.dirname(owned), { recursive: true })
      git(root, 'clone', '-q', '--no-checkout', '--branch', 'main', '--single-branch', bare, owned)
    }
    writeProjects(home, [ISSUES, FILES])
    const pull = (number, head, body) => ({
      number, head: { sha: head, ref: 'change' }, base: { ref: 'main' }, state: 'open', author_association: 'OWNER', draft: false, labels: [], body,
    })
    const hubs = {
      [ISSUES]: github(ISSUES, pull(1, issues.head, 'Closes #81')),
      [FILES]: github(FILES, pull(2, files.head, 'Unit: work/requirement.md')),
      [INACTIVE]: github(INACTIVE, pull(3, HEAD, 'Unit: none')),
    }
    const contexts = vi.fn((repo) => hubs[repo].contexts)

    const sessions = []
    const run = async (args) => {
      sessions.push(args)
      const head = args.prompt.includes(issues.head) ? issues.head : files.head
      const result = JSON.stringify({ head, verdict: 'pass', summary: 'Read client policy.', findings: [], sections: [{ name: 'Client policy', applied: true }] })
      return { pid: 1, record: {
        role: 'reviewer', exitCode: 0, signal: null, stoppedFor: null,
        stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result }),
      } }
    }
    const reviewOptions = {
      baseEnv: {}, userConfig: async () => fixtureUserConfig(), usage: async () => UNDER, scratchRoot: root,
      sessionOptions: { run, executable: 'stand-in', timeoutMs: 4567, stallMs: 3456, maxBudgetUsd: 1.25 },
    }

    const clock = controllableClock()
    const coordinator = runCoordinator({ homedir: home, pollMs: 10, now: clock.now, fields: { intervalMinutes: INTERVAL } })
    const scheduling = scheduleReviews({ homedir: home, coordinator, intervalMinutes: INTERVAL, contexts, reviewOptions, now: clock.now, wait: clock.wait })
    running.push({ coordinator, scheduling })
    await until(() => clock.waits.length > 0, 45_000)

    expect(contexts).not.toHaveBeenCalledWith(INACTIVE)
    expect(hubs[INACTIVE].requests).toEqual([])
    // `crew/files` sorts before `crew/issues`.
    expect(readReviews(reviewsPath(home)).map(({ repo, number, result }) => [repo, number, result.status])).toEqual([
      [FILES, 2, 'recorded'], [ISSUES, 1, 'recorded'],
    ])
    expect(sessions).toHaveLength(2)
    for (const { prompt } of sessions) {
      expect(prompt).toContain(UNIT)
      expect(prompt).toContain('Client policy')
    }
    for (const repo of [ISSUES, FILES]) {
      expect(hubs[repo].posted).toHaveLength(1)
      expect(hubs[repo].requests.filter((r) => !r.startsWith('GET '))).toHaveLength(1)
      expect(hubs[repo].requests.some((r) => /dispatches|statuses|merges/.test(r))).toBe(false)
    }
    expect(git(ownedCheckoutPath(home, ISSUES), 'rev-parse', 'HEAD')).toBe(git(issues.seedDir, 'rev-parse', 'origin/main'))

    // A verdict now stands at each head, so a later scan starts no session.
    clock.elapse()
    await until(() => clock.wait.mock.calls.length === 2, 45_000)
    expect(sessions).toHaveLength(2)
  })

  it('the owned checkout is brought to origin\'s main for a turn, not left where activation put it', async () => {
    const root = path.join(base, `origins-${++counter}`)
    mkdirSync(root)
    const home = freshHome()
    const { bare, seedDir } = origin(root, ISSUES, { unitLinks: ['issue'] })
    const owned = ownedCheckoutPath(home, ISSUES)
    mkdirSync(path.dirname(owned), { recursive: true })
    git(root, 'clone', '-q', '--no-checkout', '--branch', 'main', '--single-branch', bare, owned)
    git(seedDir, 'checkout', '-q', 'main')
    writeFileSync(path.join(seedDir, 'later.txt'), 'later')
    git(seedDir, 'add', '.')
    git(seedDir, 'commit', '-qm', 'main moved')
    git(seedDir, 'push', '-q', 'origin', 'main')
    const moved = git(seedDir, 'rev-parse', 'HEAD')
    const atReview = []
    const h = schedule({
      home, repos: [ISSUES], listings: { [ISSUES]: [eligible(ISSUES, 1)] }, updateCheckout: updateOwnedCheckout,
      reply: () => {
        atReview.push(git(owned, 'rev-parse', 'HEAD'))
        return { status: 'recorded', sessions: 1 }
      },
    })
    await idle(h)
    expect(atReview).toEqual([moved])
  })

  it('the fairness and scanning are documented, and the design has no ST-61 marker', () => {
    const design = readFileSync(path.join(ROOT, 'docs', 'agent-workflow-design.md'), 'utf8')
    expect(design).not.toMatch(/\*\*Planned \([^)]*\bST-61\b/)
    const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ')
    expect(readme).toContain('round-robin')
    expect(readme).toContain('scanIntervalMinutes')
  })
})
