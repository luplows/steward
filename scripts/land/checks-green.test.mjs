import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertLandWhen, checksGreen, mergeableOutcome, runwayDecision } from './checks-green.mjs'
import { readSettings } from '../dispatch/settings.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = path.join(ROOT, 'scripts', 'land', 'checks-green.mjs')
const WORKFLOW = readFileSync(path.join(ROOT, '.github', 'workflows', 'land-approved.yml'), 'utf8')

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

describe('ST-24/AC-3: land-approved.yml calls it in place of the mergeable_state test', () => {
  it('ST-24/AC-3: it no longer requires mergeable_state to be clean, and calls checks-green.mjs', () => {
    expect(WORKFLOW).not.toMatch(/\[ "\$\{mergeable_state\}" != "clean" \]/)
    expect(WORKFLOW).toContain('node scripts/land/checks-green.mjs')
  })

  it('ST-24/AC-3: it reads the head check runs and statuses with gh api, and landWhen from steward.config.json', () => {
    expect(WORKFLOW).toContain('commits/${sha}/check-runs')
    expect(WORKFLOW).toContain('commits/${sha}/status?per_page=100')
    expect(WORKFLOW).toContain("jq -c '.landWhen' steward.config.json")
  })

  it('ST-24/AC-3: a pull request that is not landable is skipped with continue, in the per-pull-request loop', () => {
    const at = WORKFLOW.indexOf('node scripts/land/checks-green.mjs')
    const after = WORKFLOW.slice(at, WORKFLOW.indexOf('fi', at) + 2)
    expect(after).toMatch(/then\s*\n\s*echo "PR #\$\{pr\}: not landable[^\n]*\n\s*continue\s*\n\s*fi$/)
    const loopStart = WORKFLOW.indexOf('for pr in ${candidates}; do')
    expect(loopStart).toBeGreaterThan(-1)
    expect(at).toBeGreaterThan(loopStart)
  })

  it('ST-24/AC-3: the belt-and-braces check of review/agent and the merge by head are unchanged, and in order', () => {
    const checks = WORKFLOW.indexOf('node scripts/land/checks-green.mjs')
    const verdict = WORKFLOW.indexOf('select(.context == "review/agent") | .state')
    const merge = WORKFLOW.indexOf('gh pr merge "${pr}" --repo "${REPO}" --squash --match-head-commit "${sha}"')
    expect(WORKFLOW).toContain('if [ "${verdict}" != "success" ]; then')
    expect(checks).toBeGreaterThan(-1)
    expect(verdict).toBeGreaterThan(checks)
    expect(merge).toBeGreaterThan(verdict)
  })

  it('ST-24/AC-3: it takes no new permission', () => {
    const permissions = WORKFLOW.slice(WORKFLOW.indexOf('\npermissions:'), WORKFLOW.indexOf('\n# Never two sweeps'))
    expect(permissions.split('\n').filter((line) => /^\s+\w[\w-]*: /.test(line)).map((l) => l.trim()))
      .toEqual(['contents: write', 'pull-requests: write', 'statuses: read'])
  })

  it('ST-24/AC-3: steward.config.json has a landWhen the function accepts', async () => {
    const { landWhen } = await readSettings(ROOT)
    expect(() => assertLandWhen(landWhen)).not.toThrow()
  })
})
