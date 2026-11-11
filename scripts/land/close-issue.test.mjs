import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeLinkedIssue, planIssueClosure } from './close-issue.mjs'
import { runRunway } from './runway.mjs'
import { fakeGitHub, pull, REPO, SHA_OF } from './runway-fake.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8')

const BODY = 'Unit: #5\nCloses #5\n\nDone.'
const OPEN = { 5: { state: 'open' } }

const unattended = { repo: REPO }
const manual = {
  repo: REPO,
  prInput: '1',
  modeInput: 'manual',
  headInput: SHA_OF(1),
  eventName: 'workflow_dispatch',
  actor: 'alice',
}
const closureLines = (logs) => logs.filter((line) => /title=(No Issue closed|Issue)/.test(line))
const warnings = (logs) => logs.filter((line) => line.startsWith('::warning'))

/** Lands pull request 1 with `options` for the fake and `request` for the runway. */
function land({ body = BODY, base = 'main', request = unattended, ...options } = {}) {
  const github = fakeGitHub({
    pulls: [pull(1, { body, base })],
    issues: structuredClone(OPEN),
    permissions: { alice: 'write' },
    ...options,
  })
  const result = runRunway(request, github.deps)
  return { result, ...github }
}

describe('ST-76/AC-1: a landing closes the Issue its body links and says it closes', () => {
  it.each([
    ['unattended', unattended],
    ['manual', manual],
  ])('ST-76/AC-1: a %s landing into main closes the one Issue, through the API, after the merge', (_name, request) => {
    const { result, patches, calls, merges, logs } = land({ request })
    expect(result).toEqual({ landed: 1 })
    expect(merges).toHaveLength(1)
    expect(patches).toEqual([`repos/${REPO}/issues/5`])
    const patch = calls.find((args) => args.includes('PATCH'))
    expect(patch).toEqual(['-X', 'PATCH', `repos/${REPO}/issues/5`, '-f', 'state=closed', '-f', 'state_reason=completed'])
    expect(logs.indexOf(`::notice title=Landed::PR #1 merged at ${SHA_OF(1)}`)).toBeLessThan(logs.findIndex((l) => l.includes('title=Issue closed')))
    expect(warnings(logs)).toEqual([])
  })

  it('ST-76/AC-1: the forms ST-92 writes into a handoff pull request close the Issue', () => {
    const { patches } = land({ body: 'Unit: #12\nCloses #12\n\nThe coder wrote this.\nCoder: model=x', issues: { 12: { state: 'open' } } })
    expect(patches).toEqual([`repos/${REPO}/issues/12`])
  })

  it('ST-76/AC-1: an Issue that is already closed is a successful no-op', () => {
    const { result, patches, logs } = land({ issues: { 5: { state: 'closed' } } })
    expect(result).toEqual({ landed: 1 })
    expect(patches).toEqual([])
    expect(logs).toContain('::notice title=Issue already closed::Issue #5 was already closed when PR #1 merged.')
    expect(warnings(logs)).toEqual([])
  })

  it('ST-76/AC-1: with issue links disabled in unitLinks, nothing is closed, and the reason is reported', () => {
    for (const unitLinks of [['file'], [], 'issue', null]) {
      const { result, patches, logs } = land({ unitLinks })
      expect(result).toEqual({ landed: 1 })
      expect(patches).toEqual([])
      expect(warnings(logs).join('\n')).toContain('unitLinks does not include "issue"')
    }
  })

  it('ST-76/AC-6: a number that is a pull request is not closed', () => {
    const { patches, logs } = land({ issues: { 5: { state: 'open', pull_request: {} } } })
    expect(patches).toEqual([])
    expect(warnings(logs).join('\n')).toContain('#5 is a pull request')
  })
})

describe('ST-76/AC-2: no closing reference is silent; one that does not qualify says why', () => {
  it.each([
    ['a bare Unit: #5', 'Unit: #5'],
    ['no Unit: and no reference', 'Just a change.'],
    ['a file Unit:', 'Unit: stories/ST-1.md'],
    ['Unit: none', 'Unit: none'],
    ['two Unit: lines', 'Unit: #5\nUnit: #6'],
    ['an empty body', ''],
    ['a mention that is no closing keyword', 'Unit: #5\nSee #5 and luplows/steward#5'],
  ])('ST-76/AC-2: %s closes nothing and warns of nothing', (_name, body) => {
    const { result, patches, logs } = land({ body })
    expect(result).toEqual({ landed: 1 })
    expect(patches).toEqual([])
    expect(closureLines(logs)).toEqual([])
    expect(warnings(logs)).toEqual([])
  })

  it.each([
    ['no Unit: line', 'Closes #5', 'no "Unit: #<n>" line'],
    ['a file Unit:', 'Unit: stories/ST-1.md\nCloses #5', 'not an Issue of this repository'],
    ['Unit: none', 'Unit: none\nCloses #5', 'not an Issue of this repository'],
    ['an ambiguous unit', 'Unit: #5\nUnit: #6\nCloses #5', '2 Unit: lines'],
    ['a different Issue', 'Unit: #5\nCloses #6', 'is not its unit, Issue #5'],
    ['an extra conflicting reference', 'Unit: #5\nCloses #5\nFixes #6', 'closing references #5, #6, and a reference to any Issue but its unit, #5, is a conflict'],
  ])('ST-76/AC-2: %s with a closing reference closes nothing and gives an actionable reason', (_name, body, reason) => {
    const { result, patches, logs } = land({ body })
    expect(result).toEqual({ landed: 1 })
    expect(patches).toEqual([])
    const lines = warnings(logs)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('::warning title=No Issue closed::PR #1 merged, and no Issue was closed:')
    expect(lines[0]).toContain(reason)
    expect(lines[0]).toContain('Close the Issue by hand')
  })

  it('ST-76/AC-2: the same reference twice is one reference', () => {
    expect(planIssueClosure('Unit: #5\nCloses #5\nfixes #5', ['issue'])).toEqual({ action: 'close', issue: 5 })
  })
})

describe('ST-76/AC-3: only a landing into main closes an Issue, and never gates one', () => {
  it('ST-76/AC-3: a merge into a release branch closes nothing and says so', () => {
    const { result, patches, logs } = land({ base: 'release/v1.2.3' })
    expect(result).toEqual({ landed: 1 })
    expect(patches).toEqual([])
    expect(warnings(logs)).toEqual([])
    expect(logs.join('\n')).toContain('merged into "release/v1.2.3", not main')
  })

  it('ST-76/AC-3: a release-branch landing with no closing reference says nothing about Issues', () => {
    const { logs } = land({ base: 'release/v1.2.3', body: 'Unit: #5' })
    expect(closureLines(logs)).toEqual([])
  })

  it('ST-76/AC-3: a merge gh refuses fails the run and reads and closes no Issue', () => {
    const github = fakeGitHub({ pulls: [pull(1, { body: BODY })], issues: structuredClone(OPEN) })
    github.deps.merge = () => {
      throw new Error('gh: head commit changed')
    }
    expect(() => runRunway(unattended, github.deps)).toThrow('head commit changed')
    expect(github.patches).toEqual([])
    expect(github.calls.some((args) => args.some((a) => a.includes('/issues/')))).toBe(false)
  })

  it('ST-76/AC-3: a skipped pull request, a refused authorization and a pull request that is not landable close nothing', () => {
    const skipped = land({ pulls: [pull(1, { body: BODY, labels: ['review-blocked'] })] })
    const refused = land({ land: false })
    const red = land({ pulls: [pull(1, { body: BODY, statuses: [{ context: 'review/agent', state: 'failure', id: 2 }] })] })
    for (const run of [skipped, refused, red]) {
      expect(run.result.landed).toBeNull()
      expect(run.patches).toEqual([])
      expect(run.calls.some((args) => args.some((a) => a.includes('/issues/')))).toBe(false)
    }
  })
})

describe('ST-76/AC-5: a failed Issue read or update warns, and the merge stands', () => {
  it.each(['read', 'update'])('ST-76/AC-5: a failed %s still reports the pull request landed, with a warning naming both', (failIssue) => {
    const { result, merges, patches, calls, logs } = land({ failIssue })
    expect(result).toEqual({ landed: 1 })
    expect(merges).toHaveLength(1)
    expect(patches).toEqual([])
    const lines = warnings(logs)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('::warning title=Issue not closed::PR #1 merged, but Issue #5 could not be closed:')
    expect(lines[0]).toContain('The merge stands; close Issue #5 by hand.')
    // No retry: one read, and at most one update.
    expect(calls.filter((args) => args.some((a) => a === `repos/${REPO}/issues/5`)).length).toBe(failIssue === 'read' ? 1 : 2)
  })

  it('ST-76/AC-5: an error message with a line break cannot add a line to the log', () => {
    const logs = []
    const api = () => {
      throw new Error('boom\n::error::injected')
    }
    closeLinkedIssue({ repo: REPO, pr: 1, base: 'main', body: BODY, unitLinks: ['issue'] }, { api, log: (l) => logs.push(l) })
    expect(logs).toHaveLength(1)
    expect(logs[0]).not.toContain('\n')
  })

  it('ST-76/AC-5: cleaning up an Issue already closed twice is harmless', () => {
    const first = land()
    const second = land({ issues: { 5: { state: 'closed' } } })
    expect(first.patches).toHaveLength(1)
    expect(second.patches).toHaveLength(0)
    expect(warnings(second.logs)).toEqual([])
  })
})

describe('ST-76/AC-6: only the matching same-repository Issue can be updated', () => {
  it('ST-76/AC-6: every request about an Issue is to this repository and the one Issue the unit names', () => {
    const { calls } = land({ body: 'Unit: #5\nCloses #5', issues: { 5: { state: 'open' }, 6: { state: 'open' } } })
    const issueCalls = calls.flat().filter((a) => typeof a === 'string' && a.includes('issues'))
    expect(issueCalls.length).toBeGreaterThan(0)
    expect(new Set(issueCalls)).toEqual(new Set([`repos/${REPO}/issues/5`]))
  })

  it('ST-76/AC-6: a reference to another repository is no closing reference here', () => {
    const { patches } = land({ body: 'Unit: #5\nCloses other/repo#5' })
    expect(patches).toEqual([])
  })
})

describe('ST-76/AC-4: both land-approved.yml files grant issues: write, and no other new credential', () => {
  for (const [name, file] of [
    ['steward\'s own', ['.github', 'workflows', 'land-approved.yml']],
    ['the installed template', ['templates', 'workflows', 'land-approved.yml']],
  ]) {
    it(`ST-76/AC-4: ${name} grants issues: write to the job and uses only github.token`, () => {
      const text = read(...file)
      const permissions = text.slice(text.indexOf('\npermissions:'), text.indexOf('\n# Never two sweeps'))
      expect(permissions).toMatch(/\n {2}issues: write\n/)
      expect(text.match(/\$\{\{ *(secrets|github\.token)[^}]*\}\}/g).every((m) => m.includes('github.token'))).toBe(true)
      expect(text).not.toMatch(/secrets\./)
    })
  }
})
