// @vitest-environment node

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { coordinatorPath, isRunning, runCoordinator, stopRequestPath } from './coordinator.mjs'
import { createContext } from './github.mjs'
import { admitReview, classifyResult, readReviews, reviewEnding, reviewsPath } from './review-admission.mjs'
import { fixtureSettings, fixtureUserConfig } from './settings-fixture.mjs'

const DISPATCH = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(DISPATCH, '..', '..')

// A stand-in coordinator process starts and is killed for real in one of these tests.
vi.setConfig({ testTimeout: 60_000 })

// Every test has a temporary home directory of its own: the real `~/.steward/` is never read or
// written. Reviews are stand-ins, and no test writes to GitHub or starts a model.
let base
beforeAll(() => { base = mkdtempSync(path.join(tmpdir(), 'steward-review-admission-')) })
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
    await sleep(25)
  }
}

// Every coordinator a test runs is stopped once its work has finished, and every process killed.
const coordinators = []
const processes = []
afterEach(async () => {
  for (const pid of processes.splice(0)) {
    if (isRunning(pid)) process.kill(pid)
    await until(() => !isRunning(pid))
  }
  for (const { home, coordinator } of coordinators.splice(0)) {
    writeFileSync(stopRequestPath(home), '')
    await coordinator.done
  }
})
const coordinatorIn = (home) => {
  const coordinator = runCoordinator({ homedir: home, pollMs: 20 })
  coordinators.push({ home, coordinator })
  return coordinator
}

const HEAD = 'a'.repeat(40)
const OTHER_HEAD = 'b'.repeat(40)
const candidate = (over = {}) => ({ repo: 'crew/client', number: 7, expectedHeadSha: HEAD, status: 'eligible', ...over })
const identity = { repo: 'crew/client', number: 7, headSha: HEAD }
const STARTED = '2026-11-02T10:00:00.000Z'
const now = () => new Date(STARTED)

/** A stand-in review, counting its calls, that resolves or rejects as `body` does. */
const standIn = (body = async () => ({ status: 'recorded', verdict: 'pass', commentId: 1, sessions: 1 })) => vi.fn(body)

/** A stand-in review held open until `release`. */
function held(result = { status: 'recorded', sessions: 1 }) {
  let release
  const opened = new Promise((resolve) => { release = () => resolve(result) })
  return { review: standIn(() => opened), release }
}

const seed = (home, content) => {
  const file = reviewsPath(home)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  return file
}

describe('ST-52/AC-1: a note before the review starts', () => {
  it('writes a running entry for the repository, PR and full head to reviews.json before the review starts', async () => {
    const home = freshHome()
    const file = reviewsPath(home)
    expect(file).toBe(path.join(home, '.steward', 'state', 'reviews.json'))
    const { admit } = coordinatorIn(home)
    let seen
    const review = standIn(async () => {
      seen = JSON.parse(readFileSync(file, 'utf8'))
      return { status: 'recorded', sessions: 1 }
    })
    await admitReview({ homedir: home, admit, candidate: candidate(), review, now })
    expect(review).toHaveBeenCalledTimes(1)
    expect(seen).toEqual({ reviews: [{ ...identity, state: 'running', startedAt: STARTED }] })
  })

  it('hands the review what reviewCandidate takes: the candidate, repoDir, ctx and reviewOptions', async () => {
    const home = freshHome()
    const { admit } = coordinatorIn(home)
    const review = standIn()
    const args = { repoDir: 'owned-checkout', ctx: { repo: 'crew/client' }, reviewOptions: { baseEnv: {} } }
    await admitReview({ homedir: home, admit, candidate: candidate(), review, ...args })
    expect(review).toHaveBeenCalledWith({ candidate: candidate(), ...args })
  })

  it('runs the review as admitted work: a stop waits for it, and the coordinator exits once its ending is written', async () => {
    const home = freshHome()
    const coordinator = runCoordinator({ homedir: home, pollMs: 20 })
    const { review, release } = held()
    const outcome = admitReview({ homedir: home, admit: coordinator.admit, candidate: candidate(), review })
    await until(() => review.mock.calls.length === 1)
    writeFileSync(stopRequestPath(home), '')
    await until(() => !existsSync(stopRequestPath(home)))
    expect(readReviews(reviewsPath(home))[0].state).toBe('running')
    release()
    expect(await coordinator.done).toBe(null)
    expect(readReviews(reviewsPath(home))[0].state).toBe('ended')
    expect((await outcome).status).toBe('ended')
  })

  it('once admission has closed, writes nothing and starts nothing', async () => {
    const home = freshHome()
    const coordinator = runCoordinator({ homedir: home, pollMs: 20 })
    writeFileSync(stopRequestPath(home), '')
    await coordinator.done
    const review = standIn()
    const outcome = await admitReview({ homedir: home, admit: coordinator.admit, candidate: candidate(), review })
    expect(outcome).toEqual({ status: 'admission-closed' })
    expect(review).not.toHaveBeenCalled()
    expect(existsSync(reviewsPath(home))).toBe(false)
  })

  it('when the entry cannot be written, starts no review and reports the failure with the file\'s path', async () => {
    const home = freshHome()
    // The state folder is a file, so reviews.json can be neither read nor written under it.
    mkdirSync(path.join(home, '.steward'))
    writeFileSync(path.join(home, '.steward', 'state'), '')
    // So a coordinator cannot keep its own record there: this one's home is another.
    const { admit } = coordinatorIn(freshHome())
    const review = standIn()
    const outcome = await admitReview({ homedir: home, admit, candidate: candidate(), review })
    expect(outcome).toMatchObject({ status: 'record-failed', file: reviewsPath(home) })
    expect(outcome.reason).toBeTruthy()
    expect(outcome).not.toHaveProperty('entry')
    expect(review).not.toHaveBeenCalled()
  })

  for (const [name, content] of [
    ['an empty file', ''],
    ['invalid JSON', '{ "reviews": ['],
    ['not an object', '[]'],
    ['no reviews list', '{}'],
    ['another key beside reviews', { reviews: [], more: 1 }],
    ['an entry with no state', { reviews: [{ ...identity, startedAt: STARTED }] }],
    ['an entry with an unknown state', { reviews: [{ ...identity, state: 'paused', startedAt: STARTED }] }],
    ['an entry with a short head', { reviews: [{ ...identity, headSha: 'abc', state: 'running', startedAt: STARTED }] }],
    ['an ended entry with no result', { reviews: [{ ...identity, state: 'ended', startedAt: STARTED, endedAt: STARTED }] }],
  ]) {
    it(`reports ${name} as malformed, names the file, starts no review and leaves it as it was`, async () => {
      const home = freshHome()
      const file = seed(home, content)
      const before = readFileSync(file, 'utf8')
      const { admit } = coordinatorIn(home)
      const review = standIn()
      const outcome = await admitReview({ homedir: home, admit, candidate: candidate(), review })
      expect(outcome).toMatchObject({ status: 'record-failed', file })
      expect(outcome.reason).toContain(`${file} is malformed`)
      expect(review).not.toHaveBeenCalled()
      expect(readFileSync(file, 'utf8')).toBe(before)
      expect(() => readReviews(file)).toThrow(/is malformed/)
    })
  }

  it('reads as empty only when there is no file', () => {
    expect(readReviews(reviewsPath(freshHome()))).toEqual([])
  })

  it('refuses a candidate that is no full identity, writing nothing and starting nothing', async () => {
    const home = freshHome()
    const { admit } = coordinatorIn(home)
    const review = standIn()
    for (const over of [{ expectedHeadSha: 'abc' }, { number: 0 }, { repo: 'nothing' }]) {
      await expect(admitReview({ homedir: home, admit, candidate: candidate(over), review })).rejects.toThrow(/not a review identity/)
    }
    expect(review).not.toHaveBeenCalled()
    expect(existsSync(reviewsPath(home))).toBe(false)
  })
})

describe('ST-52/AC-2: the same review is not started twice', () => {
  it('a later attempt while the first runs returns already-admitted, naming the entry, starts nothing and leaves it as it was', async () => {
    const home = freshHome()
    const { admit } = coordinatorIn(home)
    const first = held()
    const firstOutcome = admitReview({ homedir: home, admit, candidate: candidate(), review: first.review, now })
    await until(() => first.review.mock.calls.length === 1)
    const before = readFileSync(reviewsPath(home), 'utf8')

    const second = standIn()
    const outcome = await admitReview({ homedir: home, admit, candidate: candidate(), review: second })
    expect(outcome).toEqual({ status: 'already-admitted', entry: { ...identity, state: 'running', startedAt: STARTED } })
    expect(second).not.toHaveBeenCalled()
    expect(readFileSync(reviewsPath(home), 'utf8')).toBe(before)

    first.release()
    expect((await firstOutcome).status).toBe('ended')
  })

  it('a different head, PR or repository is a different identity', async () => {
    const home = freshHome()
    const running = { ...identity, state: 'running', startedAt: STARTED }
    seed(home, { reviews: [running] })
    const { admit } = coordinatorIn(home)
    for (const over of [{ expectedHeadSha: OTHER_HEAD }, { number: 8 }, { repo: 'crew/other' }]) {
      const review = standIn()
      const outcome = await admitReview({ homedir: home, admit, candidate: candidate(over), review })
      expect(outcome.status).toBe('ended')
      expect(review).toHaveBeenCalledTimes(1)
    }
    const reviews = readReviews(reviewsPath(home))
    expect(reviews).toHaveLength(4)
    expect(reviews[0]).toEqual(running)
  })

  it('ST-59\'s expected-head check still refuses, through the real reviewCandidate, when GitHub reports another head', async () => {
    const home = freshHome()
    const { admit } = coordinatorIn(home)
    const repoDir = path.join(home, 'owned-checkout')
    mkdirSync(repoDir)
    writeFileSync(path.join(repoDir, 'steward.config.json'), JSON.stringify(fixtureSettings({ repo: 'crew/client' })))
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ number: 7, head: { sha: OTHER_HEAD, ref: 'change' }, base: { ref: 'main' }, state: 'open', author_association: 'OWNER', draft: false, labels: [], body: '' }),
    }))
    const run = vi.fn()
    const outcome = await admitReview({
      homedir: home, admit, candidate: candidate(), repoDir,
      ctx: createContext({ repo: 'crew/client', fetch, getToken: async () => 'fixture-token' }),
      reviewOptions: { baseEnv: {}, userConfig: async () => fixtureUserConfig(), sessionOptions: { run } },
    })
    expect(outcome.status).toBe('ended')
    expect(outcome.entry).toMatchObject({ ...identity, state: 'ended', result: { status: 'head-moved' } })
    expect(outcome.reviewed.reason).toContain(HEAD)
    expect(run).not.toHaveBeenCalled()
    expect(fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true)
  })
})

describe('ST-52/AC-3: the entry records how it ended', () => {
  const ended = (result) => ({ ...identity, state: 'ended', startedAt: STARTED, endedAt: STARTED, result })

  it('a recorded review keeps the reviewer\'s status and sessions as returned, and nothing else', async () => {
    const home = freshHome()
    const { admit } = coordinatorIn(home)
    const reviewed = { status: 'recorded', headSha: HEAD, verdict: 'pass', commentId: 12, sessions: 2 }
    const outcome = await admitReview({ homedir: home, admit, candidate: candidate(), review: standIn(async () => reviewed), now })
    expect(outcome).toEqual({ status: 'ended', entry: ended({ status: 'recorded', sessions: 2 }), reviewed })
    expect(readReviews(reviewsPath(home))).toEqual([ended({ status: 'recorded', sessions: 2 })])
  })

  it('a returned failure keeps its status and sessions', async () => {
    const home = freshHome()
    const { admit } = coordinatorIn(home)
    const review = standIn(async () => ({ status: 'session-failed', outcome: 'timeout', reason: 'it stopped', sessions: 1 }))
    await admitReview({ homedir: home, admit, candidate: candidate(), review, now })
    expect(readReviews(reviewsPath(home))).toEqual([ended({ status: 'session-failed', sessions: 1 })])
  })

  it('a refusal returned before any session has no sessions', async () => {
    const home = freshHome()
    const { admit } = coordinatorIn(home)
    const review = standIn(async () => ({ status: 'over-usage', headSha: HEAD, resetsAt: 'later' }))
    await admitReview({ homedir: home, admit, candidate: candidate(), review, now })
    expect(readReviews(reviewsPath(home))).toEqual([ended({ status: 'over-usage' })])
  })

  it('a throw records threw and the error\'s message', async () => {
    const home = freshHome()
    const { admit } = coordinatorIn(home)
    const review = standIn(async () => { throw new Error('the reviewer broke') })
    const outcome = await admitReview({ homedir: home, admit, candidate: candidate(), review, now })
    const entry = ended({ status: 'threw', message: 'the reviewer broke' })
    expect(outcome).toEqual({ status: 'ended', entry })
    expect(readReviews(reviewsPath(home))).toEqual([entry])
  })

  it('an ended entry does not block a later admission, which replaces it', async () => {
    const home = freshHome()
    seed(home, { reviews: [ended({ status: 'session-failed', sessions: 1 })] })
    const { admit } = coordinatorIn(home)
    let during
    const review = standIn(async () => {
      during = readReviews(reviewsPath(home))
      return { status: 'recorded', sessions: 1 }
    })
    const outcome = await admitReview({ homedir: home, admit, candidate: candidate(), review, now })
    expect(review).toHaveBeenCalledTimes(1)
    expect(during).toEqual([{ ...identity, state: 'running', startedAt: STARTED }])
    expect(outcome.entry.result).toEqual({ status: 'recorded', sessions: 1 })
    expect(readReviews(reviewsPath(home))).toEqual([outcome.entry])
  })

  it('when the ending cannot be written, reports that with the file\'s path and how the review ended', async () => {
    const home = freshHome()
    const { admit } = coordinatorIn(home)
    const review = standIn(async () => {
      writeFileSync(reviewsPath(home), 'not JSON')
      return { status: 'recorded', sessions: 1 }
    })
    const outcome = await admitReview({ homedir: home, admit, candidate: candidate(), review, now })
    expect(outcome).toMatchObject({
      status: 'record-failed', file: reviewsPath(home), entry: ended({ status: 'recorded', sessions: 1 }), reviewed: { status: 'recorded' },
    })
    expect(outcome.reason).toContain('is malformed')
  })
})

describe('ST-52/AC-4: a coordinator that dies leaves its entry running', () => {
  it('a stand-in coordinator ended during a review leaves the entry running', async () => {
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
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, home, JSON.stringify(candidate())], { stdio: 'ignore' })
    processes.push(child.pid)
    await until(() => existsSync(file) && readFileSync(file, 'utf8').endsWith('\n'))
    const before = readReviews(file)
    expect(before).toEqual([{ ...identity, state: 'running', startedAt: expect.any(String) }])
    await sleep(300)
    expect(readReviews(file)).toEqual(before)

    process.kill(child.pid)
    await until(() => !isRunning(child.pid))
    await sleep(100)
    expect(readReviews(file)).toEqual(before)

    // No process check: to a later attempt, the entry still holds the identity, as it was.
    const review = standIn()
    const outcome = await admitReview({ homedir: home, admit: coordinatorIn(home).admit, candidate: candidate(), review })
    expect(outcome).toEqual({ status: 'already-admitted', entry: before[0] })
    expect(review).not.toHaveBeenCalled()
    expect(readReviews(file)).toEqual(before)
  })
})

// The manual review and re-review, run with a `running` entry held, are in `review-work.test.mjs`,
// beside the fixture they use.
describe('ST-52/AC-5: manual commands neither read nor write reviews.json', () => {
  /** Every file `entry` imports, directly or not, by a relative path. */
  function importGraph(entry, seen = new Set()) {
    if (seen.has(entry)) return seen
    seen.add(entry)
    const source = readFileSync(entry, 'utf8')
    for (const [, relative] of source.matchAll(/(?:from\s+|import\s*\(?\s*)'(\.[^']+)'/g)) {
      importGraph(path.resolve(path.dirname(entry), relative), seen)
    }
    return seen
  }

  for (const name of ['review', 'rotation', 'land']) {
    it(`${name}.mjs and everything it imports reach neither this module nor the file`, () => {
      const graph = importGraph(path.join(DISPATCH, `${name}.mjs`))
      expect(graph.size).toBeGreaterThan(1)
      expect(graph.has(path.join(DISPATCH, 'review-admission.mjs'))).toBe(false)
      for (const file of graph) expect(readFileSync(file, 'utf8')).not.toMatch(/reviews\.json|review-admission/)
    })
  }
})

describe('ST-52/AC-6: automatic admission uses this record and admit, documented, with no lock around a rotation', () => {
  it('a review that admit has not run writes nothing and starts nothing', async () => {
    const home = freshHome()
    const jobs = []
    const review = standIn()
    const outcome = admitReview({ homedir: home, admit: (job) => { jobs.push(job); return true }, candidate: candidate(), review, now })
    await sleep(20)
    expect(jobs).toHaveLength(1)
    expect(review).not.toHaveBeenCalled()
    expect(existsSync(reviewsPath(home))).toBe(false)
    await jobs[0]()
    expect((await outcome).status).toBe('ended')
  })

  it('the design of record has no ST-52 marker, and says what the record does not do', () => {
    const design = readFileSync(path.join(ROOT, 'docs', 'agent-workflow-design.md'), 'utf8')
    expect(design).not.toMatch(/\*\*Planned \([^)]*\bST-52\b/)
    expect(design).toContain('admitReview')
    for (const doc of ['README.md', path.join('docs', 'controller.md')]) {
      const text = readFileSync(path.join(ROOT, doc), 'utf8').replace(/\s+/g, ' ')
      expect(text).toContain('~/.steward/state/reviews.json')
      expect(text).toContain('duplicate coordinator-dispatched work only')
    }
  })
})

describe('ST-60/AC-1: three ways a review counts', () => {
  const VERDICT = 'verdict'
  const REFUSAL = 'no-model-refusal'
  const FAILURE = 'model-consuming-failure'
  // Every status `reviewPullRequest` names, with and without `sessions` where it can have either.
  const RESULTS = [
    [{ status: 'recorded', sessions: 1 }, VERDICT],
    [{ status: 'already-reviewed', sessions: 2 }, VERDICT],
    [{ status: 'already-reviewed' }, VERDICT],
    [{ status: 'session-failed', sessions: 1 }, FAILURE],
    [{ status: 'malformed-verdict', sessions: 2 }, FAILURE],
    [{ status: 'cannot-review', sessions: 1 }, FAILURE],
    [{ status: 'no-verdict', sessions: 1 }, FAILURE],
    [{ status: 'head-moved', sessions: 1 }, FAILURE],
    [{ status: 'unrecordable', sessions: 1 }, FAILURE],
    [{ status: 'head-moved' }, REFUSAL],
    [{ status: 'invalid-expected-head' }, REFUSAL],
    [{ status: 'choice-unavailable' }, REFUSAL],
    [{ status: 'rereview-refused' }, REFUSAL],
    [{ status: 'rules-unreadable' }, REFUSAL],
    [{ status: 'reviewer-unavailable' }, REFUSAL],
    [{ status: 'over-usage' }, REFUSAL],
    [{ status: 'usage-unknown' }, REFUSAL],
  ]

  for (const [result, counted] of RESULTS) {
    it(`${result.status} ${result.sessions ? 'with' : 'without'} sessions counts as ${counted}`, () => {
      expect(classifyResult(result)).toBe(counted)
    })
  }

  it('a review that threw and one interrupted count as model-consuming failures, having no sessions', () => {
    expect(classifyResult({ status: 'threw', message: 'it broke' })).toBe(FAILURE)
    expect(classifyResult({ status: 'interrupted' })).toBe(FAILURE)
  })

  it('those are all the statuses review.mjs and the usage check it calls can return', () => {
    const source = (name) => readFileSync(path.join(DISPATCH, name), 'utf8')
    const named = (text) => [...text.matchAll(/status: '([a-z-]+)'/g)].map(([, status]) => status)
    const ternary = source('review.mjs').match(/const status = now\.headSha === pr\.headSha \? '([a-z-]+)' : '([a-z-]+)'/).slice(1)
    const found = new Set([...named(source('review.mjs')), ...ternary, ...named(source('usage.mjs'))])
    expect(found).toEqual(new Set(RESULTS.map(([{ status }]) => status)))
  })
})

describe('ST-60/AC-2: ST-61 reads the count', () => {
  const ending = (home, over = {}) => reviewEnding({ homedir: home, ...identity, ...over })

  it('gives each of the three classes from the entry a real admission wrote, and null with no entry', async () => {
    const home = freshHome()
    const { admit } = coordinatorIn(home)
    expect(ending(home)).toBe(null)
    for (const [number, body, counted] of [
      [1, async () => ({ status: 'recorded', sessions: 1 }), 'verdict'],
      [2, async () => ({ status: 'over-usage', resetsAt: 'later' }), 'no-model-refusal'],
      [3, async () => ({ status: 'session-failed', sessions: 1 }), 'model-consuming-failure'],
      [4, async () => { throw new Error('it broke') }, 'model-consuming-failure'],
    ]) {
      expect((await admitReview({ homedir: home, admit, candidate: candidate({ number }), review: standIn(body) })).status).toBe('ended')
      expect(ending(home, { number })).toBe(counted)
    }
    expect(ending(home)).toBe(null)
    expect(ending(home, { number: 1, headSha: OTHER_HEAD })).toBe(null)
    expect(ending(home, { number: 1, repo: 'crew/other' })).toBe(null)
  })

  it('gives nothing for a running entry, and throws on a malformed file rather than reading it as none', () => {
    const home = freshHome()
    seed(home, { reviews: [{ ...identity, state: 'running', startedAt: STARTED }] })
    expect(ending(home)).toBe(null)
    seed(home, 'not JSON')
    expect(() => ending(home)).toThrow(/is malformed/)
  })

  it('writes the outcome before the admission resolves, so before another review is admitted', async () => {
    const home = freshHome()
    const { admit } = coordinatorIn(home)
    const first = held()
    const outcome = admitReview({ homedir: home, admit, candidate: candidate(), review: first.review })
    await until(() => first.review.mock.calls.length === 1)
    expect(ending(home)).toBe(null)
    first.release()
    await outcome
    expect(ending(home)).toBe('verdict')
  })

  // A write of the outcome that fails is in `review-admission-write.test.mjs`.

  it('fail waits for admitted work, and refuses more meanwhile', async () => {
    const home = freshHome()
    const coordinator = runCoordinator({ homedir: home, pollMs: 20 })
    let release
    expect(coordinator.admit(() => new Promise((resolve) => { release = resolve }))).toBe(true)
    await until(() => release !== undefined)
    const failure = new Error('the record could not be written')
    coordinator.fail(failure)
    expect(coordinator.admit(async () => {})).toBe(false)
    await sleep(100)
    expect(existsSync(coordinatorPath(home))).toBe(true)
    release()
    expect(await coordinator.done).toBe(failure)
    expect(existsSync(coordinatorPath(home))).toBe(false)
  })
})
