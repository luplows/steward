import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertLandWhen, checksGreen, mergeableOutcome, runwayDecision } from './checks-green.mjs'
import { readSettings } from '../dispatch/settings.mjs'
import { fakeGitHub, pull, REPO, SHA_OF } from './runway-fake.mjs'
import { runRunway } from './runway.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = path.join(ROOT, 'scripts', 'land', 'checks-green.mjs')
const WORKFLOW = readFileSync(path.join(ROOT, '.github', 'workflows', 'land-approved.yml'), 'utf8')
const SWEEP = readFileSync(path.join(ROOT, 'scripts', 'land', 'runway.mjs'), 'utf8')

const run = (name, conclusion, id = 1) => ({
  id,
  name,
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion,
})
const status = (context, state, id = 1) => ({ id, context, state })
const ALL = 'all-checks'

describe('ST-24/AC-1: checksGreen with "all-checks"', () => {
  it('ST-24/AC-1: every check green is green, with successes, neutrals, skips and a status', () => {
    const checkRuns = [run('test', 'success'), run('pending', 'neutral'), run('verdict', 'skipped')]
    const statuses = [status('ci/other', 'success')]
    expect(checksGreen({ checkRuns, statuses, landWhen: ALL })).toEqual({ green: true })
  })

  it('ST-24/AC-1: a head with no checks at all is green', () => {
    expect(checksGreen({ checkRuns: [], statuses: [], landWhen: ALL })).toEqual({ green: true })
  })

  it('ST-24/AC-1: one check not yet finished is waiting, by name', () => {
    const queued = { id: 3, name: 'queued', status: 'queued', conclusion: null }
    const result = checksGreen({ checkRuns: [run('test', 'success'), run('build', null, 2), queued], statuses: [status('ci/x', 'pending')], landWhen: ALL })
    expect(result).toEqual({ green: false, waiting: ['build', 'queued', 'ci/x'], failing: [] })
  })

  it('ST-24/AC-1: one failing check is failing, by name, whatever the failure', () => {
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'stale']) {
      const result = checksGreen({ checkRuns: [run('test', 'success'), run('lint', conclusion, 2)], statuses: [], landWhen: ALL })
      expect(result, conclusion).toEqual({ green: false, waiting: [], failing: ['lint'] })
    }
    for (const state of ['failure', 'error']) {
      const result = checksGreen({ checkRuns: [], statuses: [status('ci/x', state)], landWhen: ALL })
      expect(result, state).toEqual({ green: false, waiting: [], failing: ['ci/x'] })
    }
  })

  it('ST-24/AC-1: a waiting check and a failing one are each named', () => {
    const result = checksGreen({ checkRuns: [run('a', null), run('b', 'failure', 2)], statuses: [], landWhen: ALL })
    expect(result).toEqual({ green: false, waiting: ['a'], failing: ['b'] })
  })

  it('ST-24/AC-1: a rerun whose latest run is green after a failed one is green, in either order', () => {
    const failed = run('test', 'failure', 10)
    const rerun = run('test', 'success', 11)
    expect(checksGreen({ checkRuns: [failed, rerun], statuses: [], landWhen: ALL })).toEqual({ green: true })
    expect(checksGreen({ checkRuns: [rerun, failed], statuses: [], landWhen: ALL })).toEqual({ green: true })
  })

  it('ST-24/AC-1: a rerun that is red after a green run, or still running, is not green', () => {
    expect(checksGreen({ checkRuns: [run('test', 'success', 10), run('test', 'failure', 11)], statuses: [], landWhen: ALL }))
      .toEqual({ green: false, waiting: [], failing: ['test'] })
    expect(checksGreen({ checkRuns: [run('test', 'failure', 10), run('test', null, 11)], statuses: [], landWhen: ALL }))
      .toEqual({ green: false, waiting: ['test'], failing: [] })
  })

  it('ST-24/AC-1: the latest status of a context is the one read', () => {
    expect(checksGreen({ checkRuns: [], statuses: [status('ci/x', 'failure', 1), status('ci/x', 'success', 2)], landWhen: ALL }))
      .toEqual({ green: true })
  })

  it('ST-24/AC-1: review/agent failing, pending or absent while everything else is green is green here', () => {
    for (const state of ['failure', 'error', 'pending']) {
      const result = checksGreen({ checkRuns: [run('test', 'success')], statuses: [status('review/agent', state)], landWhen: ALL })
      expect(result, state).toEqual({ green: true })
    }
    expect(checksGreen({ checkRuns: [run('test', 'success')], statuses: [], landWhen: ALL })).toEqual({ green: true })
  })

  it('ST-24/AC-1: review/agent green does not make a failing check green', () => {
    const result = checksGreen({ checkRuns: [run('test', 'failure')], statuses: [status('review/agent', 'success')], landWhen: ALL })
    expect(result).toEqual({ green: false, waiting: [], failing: ['test'] })
  })

  it('ST-24/AC-1: a check run and a status of one name are both read', () => {
    expect(checksGreen({ checkRuns: [run('ci', 'success')], statuses: [status('ci', 'failure')], landWhen: ALL }))
      .toEqual({ green: false, waiting: [], failing: ['ci'] })
  })
})

describe('ST-24/AC-1: checksGreen with a list', () => {
  const checkRuns = [run('test', 'success'), run('lint', 'failure', 2), run('slow', null, 3)]

  it('ST-24/AC-1: only the named checks are read', () => {
    expect(checksGreen({ checkRuns, statuses: [], landWhen: ['test'] })).toEqual({ green: true })
  })

  it('ST-24/AC-1: a named check that is waiting or failing is named, and an unnamed one is not', () => {
    expect(checksGreen({ checkRuns, statuses: [], landWhen: ['test', 'lint', 'slow'] }))
      .toEqual({ green: false, waiting: ['slow'], failing: ['lint'] })
  })

  it('ST-24/AC-1: a named check that is absent is waiting', () => {
    expect(checksGreen({ checkRuns, statuses: [], landWhen: ['test', 'build'] }))
      .toEqual({ green: false, waiting: ['build'], failing: [] })
  })

  it('ST-24/AC-1: a named status is read as a status', () => {
    expect(checksGreen({ checkRuns: [], statuses: [status('ci/x', 'success')], landWhen: ['ci/x'] })).toEqual({ green: true })
  })

  it('ST-24/AC-1: review/agent named in the list is neither required nor waited for', () => {
    expect(checksGreen({ checkRuns, statuses: [status('review/agent', 'failure')], landWhen: ['test', 'review/agent'] }))
      .toEqual({ green: true })
    expect(checksGreen({ checkRuns, statuses: [], landWhen: ['review/agent'] })).toEqual({ green: true })
  })
})

describe('ST-24/AC-1: landWhen of the wrong form is refused', () => {
  it('ST-24/AC-1: assertLandWhen takes the forms settings.mjs takes', () => {
    for (const ok of [ALL, ['a'], ['a', 'b']]) expect(() => assertLandWhen(ok)).not.toThrow()
    for (const bad of [undefined, null, '', 'any', [], [''], ['a', 'a'], [1], {}]) {
      expect(() => assertLandWhen(bad), JSON.stringify(bad)).toThrow(/landWhen must be/)
    }
    expect(() => checksGreen({ checkRuns: [], statuses: [], landWhen: [] })).toThrow(/landWhen must be/)
  })
})

describe('ST-24/AC-3: the runway decides with the same function', () => {
  const green = [run('test', 'success')]

  it('ST-24/AC-3: mergeableOutcome names each state', () => {
    expect(['clean', 'unstable', 'has_hooks'].map(mergeableOutcome)).toEqual(['landable', 'landable', 'landable'])
    expect(mergeableOutcome('dirty')).toBe('conflict')
    expect(mergeableOutcome('blocked')).toBe('github-blocked')
    expect(['unknown', 'behind', 'draft', undefined].map(mergeableOutcome)).toEqual(['unknown', 'unknown', 'unknown', 'unknown'])
  })

  it('ST-24/AC-3: runwayDecision lands only for named checks green and a state GitHub would merge', () => {
    for (const mergeableState of ['clean', 'unstable', 'has_hooks']) {
      expect(runwayDecision({ checkRuns: green, statuses: [], landWhen: ALL, mergeableState })).toEqual({ land: true })
    }
    for (const mergeableState of ['dirty', 'blocked', 'unknown', 'behind']) {
      expect(runwayDecision({ checkRuns: green, statuses: [], landWhen: ALL, mergeableState }).land, mergeableState).toBe(false)
    }
    const failing = runwayDecision({ checkRuns: [run('test', 'failure')], statuses: [], landWhen: ALL, mergeableState: 'clean' })
    expect(failing).toMatchObject({ land: false })
    expect(failing.reason).toContain('failing [test]')
  })

  it('ST-24/AC-3: a blocked state with the checks green says GitHub requires something landWhen does not name', () => {
    const decision = runwayDecision({ checkRuns: green, statuses: [], landWhen: ALL, mergeableState: 'blocked' })
    expect(decision.reason).toContain('GitHub requires something landWhen does not name')
  })

  const cli = (input) => spawnSync(process.execPath, [SCRIPT], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' })

  it('ST-24/AC-3: the CLI exits 0 printing ok when the pull request may land', () => {
    const result = cli({ checkRuns: green, statuses: [], landWhen: ALL, mergeableState: 'clean' })
    expect(result).toMatchObject({ status: 0, stdout: 'ok\n' })
  })

  it('ST-24/AC-3: the CLI exits 1 with the reason when it may not, and 2 when it cannot read its input', () => {
    const waiting = cli({ checkRuns: [run('test', null)], statuses: [], landWhen: ALL, mergeableState: 'clean' })
    expect(waiting.status).toBe(1)
    expect(waiting.stdout).toContain('waiting [test]')
    expect(cli({ checkRuns: green, statuses: [], landWhen: 'some', mergeableState: 'clean' }).status).toBe(2)
    expect(cli('not json').status).toBe(2)
    expect(cli({ statuses: [], landWhen: ALL, mergeableState: 'clean' }).status).toBe(2)
  })
})

describe('ST-24/AC-3: the runway decides with it in place of the mergeable_state test', () => {
  it('ST-24/AC-3: it no longer requires mergeable_state to be clean, and decides with checks-green.mjs', () => {
    expect(WORKFLOW).not.toContain('"${mergeable_state}"')
    expect(SWEEP).toMatch(/import \{ runwayDecision \} from '\.\/checks-green\.mjs'/)
    // GitHub's `unstable` (a check no rule requires is not green) is landable once the named checks are.
    const { deps } = fakeGitHub({ pulls: [pull(1, { mergeableState: 'unstable' })] })
    expect(runRunway({ repo: REPO }, deps)).toEqual({ landed: 1 })
  })

  it('ST-24/AC-3: it reads the head check runs and statuses with gh api, and landWhen from steward.config.json', () => {
    const { deps, calls } = fakeGitHub({ pulls: [pull(1)] })
    runRunway({ repo: REPO }, deps)
    const urls = calls.map((args) => args.find((arg) => arg.startsWith('repos/')))
    expect(urls).toContain(`repos/${REPO}/commits/${SHA_OF(1)}/check-runs?per_page=100`)
    expect(urls).toContain(`repos/${REPO}/commits/${SHA_OF(1)}/status?per_page=100`)
    expect(urls).toContain(`repos/${REPO}/contents/steward.config.json?ref=main`)
  })

  it('ST-24/AC-3: landWhen as the project names it decides which checks count', () => {
    const failing = { name: 'lint', status: 'completed', conclusion: 'failure', id: 5 }
    const named = fakeGitHub({ pulls: [pull(1, { checkRuns: [failing] })], landWhen: ['test'] })
    expect(runRunway({ repo: REPO }, named.deps)).toEqual({ landed: null })
    expect(named.logs.some((line) => line.includes('waiting [test]'))).toBe(true)
    const all = fakeGitHub({ pulls: [pull(1, { checkRuns: [failing] })] })
    expect(runRunway({ repo: REPO }, all.deps)).toEqual({ landed: null })
    expect(all.logs.some((line) => line.includes('failing [lint]'))).toBe(true)
  })

  it('ST-24/AC-3: a pull request that is not landable is skipped, and the loop goes on to the next', () => {
    const { deps, logs, merges } = fakeGitHub({
      pulls: [pull(1, { mergeableState: 'dirty' }), pull(2, { mergeableState: 'unknown' }), pull(3)],
    })
    expect(runRunway({ repo: REPO }, deps)).toEqual({ landed: 3 })
    expect(logs.some((line) => line.startsWith(`PR #1: not landable on ${SHA_OF(1)}`))).toBe(true)
    expect(logs.some((line) => line.startsWith(`PR #2: not landable on ${SHA_OF(2)}`))).toBe(true)
    expect(merges).toHaveLength(1)
  })

  it('ST-24/AC-3: the belt-and-braces check of review/agent and the merge by head are unchanged, and in order', () => {
    const { deps, merges } = fakeGitHub({ pulls: [pull(1)] })
    const order = []
    deps.api = ((api) => (args) => {
      order.push(args.some((arg) => arg.includes('/check-runs')) ? 'checks' : args.at(-1).endsWith('/status') ? 'review' : 'other')
      return api(args)
    })(deps.api)
    const merge = deps.merge
    deps.merge = (args) => {
      order.push('merge')
      merge(args)
    }
    runRunway({ repo: REPO }, deps)
    expect(order.indexOf('checks')).toBeGreaterThan(-1)
    expect(order.indexOf('review')).toBeGreaterThan(order.indexOf('checks'))
    expect(order.indexOf('merge')).toBeGreaterThan(order.indexOf('review'))
    expect(merges).toEqual([['1', '--repo', REPO, '--squash', '--match-head-commit', SHA_OF(1)]])

    for (const statuses of [[], [{ context: 'review/agent', state: 'pending', id: 3 }], [{ context: 'review/agent', state: 'failure', id: 3 }]]) {
      const skipped = fakeGitHub({ pulls: [pull(1, { statuses })] })
      expect(runRunway({ repo: REPO }, skipped.deps)).toEqual({ landed: null })
      expect(skipped.merges).toEqual([])
      expect(skipped.logs.some((line) => line.startsWith('PR #1: review/agent='))).toBe(true)
    }
  })

  it('ST-24/AC-3a: its permissions are the three it had and checks: read, with a comment saying why', () => {
    const permissions = WORKFLOW.slice(WORKFLOW.indexOf('\npermissions:'), WORKFLOW.indexOf('\n# Never two sweeps'))
    expect(permissions.split('\n').filter((line) => /^\s+\w[\w-]*: /.test(line)).map((l) => l.trim()))
      .toEqual(['contents: write', 'pull-requests: write', 'statuses: read', 'checks: read'])
    expect(permissions).toMatch(/# For reading the head's check runs[^\n]*\n\s+checks: read/)
  })

  it('ST-24/AC-3: steward.config.json has a landWhen the function accepts', async () => {
    const { landWhen } = await readSettings(ROOT)
    expect(() => assertLandWhen(landWhen)).not.toThrow()
  })
})
