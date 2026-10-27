import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACTOR_PATTERN, HEAD_PATTERN, MANUAL_PERMISSIONS, runRunway } from './runway.mjs'
import { fakeGitHub, pull, REPO, SHA_OF } from './runway-fake.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8')

const HEAD = SHA_OF(1)
const mergeArgs = (number, sha = SHA_OF(number)) => [String(number), '--repo', REPO, '--squash', '--match-head-commit', sha]

/** A manual request of pull request 1 at its head by `alice`, who has write permission. */
const manual = (extra = {}) => ({
  repo: REPO,
  prInput: '1',
  modeInput: 'manual',
  headInput: HEAD,
  eventName: 'workflow_dispatch',
  actor: 'alice',
  ...extra,
})
/** The fake for it: `land` false unless said otherwise, which is the case manual mode exists for. */
const github = (options = {}) => fakeGitHub({ pulls: [pull(1)], land: false, permissions: { alice: 'write' }, ...options })
const refusedLine = (logs) => logs.find((line) => line.startsWith('::error title=Landing refused::'))

describe('ST-54/AC-4: an unattended dispatch needs land true on main', () => {
  it.each([
    ['no mode and only a pull request', { prInput: '1' }],
    ['no inputs at all', {}],
    ['the default mode named', { modeInput: 'unattended', prInput: '1' }],
  ])('ST-54/AC-4: with land false, %s merges nothing and says why', (_name, inputs) => {
    const { deps, merges, logs } = github()
    const result = runRunway({ repo: REPO, actor: 'alice', eventName: 'workflow_dispatch', ...inputs }, deps)
    expect(result).toMatchObject({ landed: null })
    expect(result.refused).toMatch(/standing authorization absent: land is false/)
    expect(merges).toEqual([])
    expect(refusedLine(logs)).toContain('land is false')
  })

  it('ST-54/AC-2: with land true it merges exactly as before, naming no mode', () => {
    for (const inputs of [{}, { prInput: '1' }, { modeInput: 'unattended', prInput: '1' }]) {
      const { deps, merges, logs } = github({ land: true })
      expect(runRunway({ repo: REPO, ...inputs }, deps)).toEqual({ landed: 1 })
      expect(merges).toEqual([mergeArgs(1)])
      expect(logs).toContain('Standing authorization: land is true in steward.config.json on main.')
      expect(logs).toContain(`::notice title=Landed::PR #1 merged at ${HEAD}`)
    }
  })

  it('ST-54/AC-2: what the caller says about land cannot override main: only main\'s file is read', () => {
    const { deps, merges, calls } = github({ land: false })
    // A pilot whose own settings said true sends exactly this; the runway has no way to be told.
    expect(runRunway({ repo: REPO, prInput: '1', modeInput: 'unattended' }, deps)).toMatchObject({ landed: null })
    expect(merges).toEqual([])
    expect(calls.some((args) => args.some((arg) => arg === `repos/${REPO}/contents/steward.config.json?ref=main`))).toBe(true)
  })

  it('ST-54/AC-4: a head given to an unattended dispatch is refused, as a manual request that left out its mode', () => {
    const { deps, merges } = github({ land: true })
    const result = runRunway({ repo: REPO, prInput: '1', headInput: HEAD }, deps)
    expect(result.refused).toMatch(/takes no head/)
    expect(merges).toEqual([])
  })

  it('ST-54/AC-4: the unattended path asks GitHub nothing about an actor', () => {
    const { deps, calls } = github({ land: true })
    runRunway({ repo: REPO, prInput: '1', actor: 'alice' }, deps)
    expect(calls.some((args) => args.some((arg) => arg.includes('collaborators')))).toBe(false)
  })
})

describe('ST-54/AC-4: a scoped manual dispatch by an authorized actor lands with land false', () => {
  it.each(MANUAL_PERMISSIONS)('ST-54/AC-4: an actor with %s permission lands the pull request at the authorized head', (permission) => {
    const { deps, merges, logs } = github({ permissions: { alice: permission } })
    expect(runRunway(manual(), deps)).toEqual({ landed: 1 })
    expect(merges).toEqual([mergeArgs(1, HEAD)])
    expect(logs).toContain(`::notice title=Landed::PR #1 merged at ${HEAD}`)
  })

  it('ST-54/AC-4: it also lands with land true', () => {
    const { deps, merges } = github({ land: true })
    expect(runRunway(manual(), deps)).toEqual({ landed: 1 })
    expect(merges).toEqual([mergeArgs(1)])
  })

  it('ST-54/AC-4: the permission is read from GitHub for the actor of the event, with one request', () => {
    const { deps, calls } = github()
    runRunway(manual(), deps)
    const permissionCalls = calls.filter((args) => args.some((arg) => arg.includes('collaborators')))
    expect(permissionCalls).toEqual([[`repos/${REPO}/collaborators/alice/permission`, '--jq', '.permission | tojson']])
  })

  it('ST-54/AC-6: the log names the mode, actor, pull request and authorized head, and the landing', () => {
    const { deps, logs } = github()
    runRunway(manual(), deps)
    const who = `mode="manual" actor="alice" PR="1" authorized head="${HEAD}"`
    expect(logs).toContain(`Landing authorized: ${who}`)
    expect(logs).toContain(`Landing PR #1: ${who}, merging at ${HEAD}`)
    expect(logs).toContain('Manual authorization: alice has write permission on owner/project; land is false in steward.config.json on main.')
  })

  it('ST-54/AC-6: an unattended landing logs its standing-authorization decision, and a refusal logs its reason', () => {
    const allowed = github({ land: true })
    runRunway({ repo: REPO, prInput: '1', actor: 'bob' }, allowed.deps)
    expect(allowed.logs).toContain('Standing authorization: land is true in steward.config.json on main.')
    expect(allowed.logs).toContain('Landing authorized: mode="unattended" actor="bob" PR="1" authorized head=""')
    const refused = github({ land: false })
    runRunway({ repo: REPO, prInput: '1', actor: 'bob' }, refused.deps)
    expect(refusedLine(refused.logs)).toBe(
      '::error title=Landing refused::mode="unattended" actor="bob" PR="1" authorized head="": standing authorization absent: land is false in steward.config.json on main',
    )
  })

  it('ST-54/AC-6: a raw input cannot add a line or a workflow command to the log', () => {
    const { deps, logs } = github()
    runRunway(manual({ actor: 'alice\n::set-output name=x::y', modeInput: 'manual' }), deps)
    expect(logs.every((line) => !line.includes('\n'))).toBe(true)
    expect(logs.filter((line) => line.startsWith('::')).every((line) => /^::(error|notice|warning) title=/.test(line))).toBe(true)
  })
})

describe('ST-54/AC-4: each of these refuses the merge, with a reason in the log', () => {
  const refuses = (inputs, reason, options = {}) => {
    const { deps, merges, logs } = github(options)
    const result = runRunway(manual(inputs), deps)
    expect(result.landed).toBeNull()
    expect(result.refused).toMatch(reason)
    expect(merges).toEqual([])
    expect(refusedLine(logs)).toMatch(reason)
  }

  it('ST-54/AC-4: an unknown mode', () => {
    for (const modeInput of ['auto', 'MANUAL', ' manual', 'manual ', 'unattended\n']) refuses({ modeInput }, /unknown mode/)
  })

  it('ST-54/AC-4: an event other than workflow_dispatch', () => {
    for (const eventName of ['push', 'schedule', 'pull_request', '']) refuses({ eventName }, /needs a workflow_dispatch event/)
  })

  it('ST-54/AC-4: missing or malformed scope: the pull request number', () => {
    for (const prInput of ['', '0', '01', '1 2', '1;x', '-1', 'abc']) refuses({ prInput }, /one positive pull request number/)
  })

  it('ST-54/AC-4: missing or malformed scope: the head', () => {
    for (const headInput of ['', HEAD.slice(0, 39), `${HEAD}c`, HEAD.toUpperCase(), `${'g'.repeat(39)}c`, ' ' + HEAD.slice(1), 'main']) {
      refuses({ headInput }, /full 40-character head SHA/)
    }
  })

  it('ST-54/AC-4: an unqualified actor', () => {
    for (const actor of ['', 'a b', '../x', 'x/../y', 'x?y', 'a'.repeat(40), '-a', 'a-', 'a--b', 'a[bot]', 'a\nb']) {
      refuses({ actor }, /qualified actor/)
    }
  })

  it('ST-54/AC-4: an actor with no write, maintain or admin permission', () => {
    for (const permission of ['read', 'triage', 'none', '', 'WRITE']) {
      refuses({}, /manual landing needs admin, maintain, write/, { permissions: { alice: permission } })
    }
  })

  it('ST-54/AC-4: an unreadable permission', () => {
    refuses({}, /permission of alice on owner\/project cannot be read/, { permissions: {} })
    const { deps, merges, logs } = github()
    const api = deps.api
    deps.api = (args) => (args.some((arg) => arg.includes('collaborators')) ? 'not json' : api(args))
    expect(runRunway(manual(), deps).refused).toMatch(/cannot be read/)
    expect(merges).toEqual([])
    expect(refusedLine(logs)).toBeDefined()
  })

  it('ST-54/AC-4: the pull request is at another head than the one authorized', () => {
    const { deps, merges, logs } = github({ pulls: [pull(1, { sha: SHA_OF(9) })] })
    const result = runRunway(manual(), deps)
    expect(result.refused).toBe(`PR #1 is at ${SHA_OF(9)}, not the authorized head ${HEAD}; a new request is needed`)
    expect(merges).toEqual([])
    expect(refusedLine(logs)).toContain('a new request is needed')
  })

  it('ST-54/AC-4: the patterns it checks are the full lowercase SHA, a login, and the three permissions', () => {
    expect(HEAD_PATTERN.test(HEAD)).toBe(true)
    expect(ACTOR_PATTERN.test('a-b')).toBe(true)
    expect(MANUAL_PERMISSIONS).toEqual(['admin', 'maintain', 'write'])
  })
})

describe('ST-54/AC-4: settings on main that are missing, malformed or unreadable fail closed, in both modes', () => {
  const BAD = [
    ['land missing', JSON.stringify({ landWhen: 'all-checks' })],
    ['land a string', JSON.stringify({ land: 'true', landWhen: 'all-checks' })],
    ['land null', JSON.stringify({ land: null, landWhen: 'all-checks' })],
    ['land a number', JSON.stringify({ land: 1, landWhen: 'all-checks' })],
    ['landWhen missing', JSON.stringify({ land: true })],
    ['landWhen empty', JSON.stringify({ land: true, landWhen: [] })],
    ['landWhen a name', JSON.stringify({ land: true, landWhen: 'test' })],
    ['landWhen with a duplicate', JSON.stringify({ land: true, landWhen: ['a', 'a'] })],
    ['not JSON', '{"land": tru'],
    ['empty', ''],
    ['an array', '[]'],
    ['null', 'null'],
  ]

  it.each(BAD)('ST-54/AC-4: %s: nothing merges, unattended or manual, and the reason is logged', (_name, settingsText) => {
    for (const inputs of [{ modeInput: 'unattended', prInput: '1' }, {}]) {
      const { deps, merges, logs } = github({ settingsText })
      const request = inputs.modeInput ? { repo: REPO, ...inputs } : manual()
      expect(runRunway(request, deps).refused).toBeDefined()
      expect(merges).toEqual([])
      expect(refusedLine(logs)).toMatch(/steward\.config\.json on main|landWhen must be/)
    }
  })

  it('ST-54/AC-4: a file that cannot be fetched at all', () => {
    const { deps, merges, logs } = github()
    const api = deps.api
    deps.api = (args) => {
      if (args.some((arg) => arg.includes('/contents/'))) throw new Error('gh: Not Found (HTTP 404)')
      return api(args)
    }
    expect(runRunway(manual(), deps).refused).toMatch(/steward\.config\.json on main cannot be read: gh: Not Found/)
    expect(runRunway({ repo: REPO, prInput: '1' }, deps).refused).toMatch(/cannot be read/)
    expect(merges).toEqual([])
    expect(refusedLine(logs)).toBeDefined()
  })

  it('ST-54/AC-4: settings are read before any pull request is looked at', () => {
    const { deps, calls } = github({ settingsText: 'null' })
    runRunway(manual(), deps)
    expect(calls.some((args) => args.some((arg) => arg.startsWith(`repos/${REPO}/pulls`)))).toBe(false)
  })
})

describe('ST-54/AC-5: manual mode changes only the land restriction; every other condition holds with land false', () => {
  const lands = (pullOptions, extra = {}, request = {}) => {
    const { deps, merges, logs } = github({ pulls: [pull(1, pullOptions)], ...extra })
    const result = runRunway(manual(request), deps)
    return { result, merges, logs }
  }

  it('ST-54/AC-5: the baseline lands, so each case below fails for its own reason', () => {
    expect(lands({}).merges).toEqual([mergeArgs(1)])
  })

  it('ST-54/AC-5: a draft, or a base that cannot be landed on, is not a candidate', () => {
    expect(lands({ draft: true }).merges).toEqual([])
    expect(lands({ base: 'other' }).merges).toEqual([])
    expect(lands({ base: 'release/v1.2.3' }).merges).toEqual([mergeArgs(1)])
  })

  it('ST-54/AC-5: an author the gate does not honour is skipped', () => {
    for (const association of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', '']) {
      const { merges, logs } = lands({ association })
      expect(merges, association).toEqual([])
      expect(logs.some((line) => line.includes('not a writer, skipping'))).toBe(true)
    }
  })

  it('ST-54/AC-5: review-blocked is skipped, with or without breaker-override', () => {
    expect(lands({ labels: ['review-blocked'] }).merges).toEqual([])
    expect(lands({ labels: ['review-blocked', 'breaker-override'] }, { blockedCount: 5 }).merges).toEqual([])
  })

  it('ST-54/AC-5: a tripped circuit breaker skips, and keeps both of its exemptions', () => {
    expect(lands({}, { blockedCount: 5 }).merges).toEqual([])
    expect(lands({ labels: ['breaker-override'] }, { blockedCount: 5 }).merges).toEqual([mergeArgs(1)])
    expect(lands({ files: ['.github/workflows/ci.yml'] }, { blockedCount: 5 }).merges).toEqual([mergeArgs(1)])
    expect(lands({ files: ['.github/workflows/ci.yml', 'README.md'] }, { blockedCount: 5 }).merges).toEqual([])
  })

  it('ST-54/AC-5: review/agent must be success on the head, absent, pending or failing alike', () => {
    expect(lands({ statuses: [] }).merges).toEqual([])
    for (const state of ['pending', 'failure', 'error']) {
      expect(lands({ statuses: [{ context: 'review/agent', state, id: 2 }] }).merges, state).toEqual([])
    }
  })

  it('ST-54/AC-5: the checks landWhen names must be green', () => {
    const failing = { name: 'test', status: 'completed', conclusion: 'failure', id: 1 }
    const waiting = { name: 'test', status: 'in_progress', conclusion: null, id: 1 }
    expect(lands({ checkRuns: [failing] }).merges).toEqual([])
    expect(lands({ checkRuns: [waiting] }).merges).toEqual([])
    expect(lands({ checkRuns: [] }, { landWhen: ['test'] }).merges).toEqual([])
  })

  it('ST-54/AC-5: GitHub\'s mergeability must allow it', () => {
    for (const mergeableState of ['dirty', 'blocked', 'unknown', 'behind', 'draft']) {
      expect(lands({ mergeableState }).merges, mergeableState).toEqual([])
    }
    expect(lands({ mergeableState: 'unstable' }).merges).toEqual([mergeArgs(1)])
  })

  it('ST-54/AC-5: a head other than the authorized one is refused, whichever way it moved', () => {
    const { result, merges } = lands({ sha: SHA_OF(2) })
    expect(result.refused).toMatch(/not the authorized head/)
    expect(merges).toEqual([])
  })

  it('ST-54/AC-5: the merge is still --match-head-commit at the authorized head, so a push at the merge boundary is refused by GitHub', () => {
    const { deps, merges } = github()
    deps.merge = (args) => {
      merges.push(args)
      throw new Error('head branch was modified')
    }
    expect(() => runRunway(manual(), deps)).toThrow(/head branch was modified/)
    expect(merges).toEqual([mergeArgs(1, HEAD)])
    expect(merges[0].slice(-2)).toEqual(['--match-head-commit', HEAD])
  })

  it('ST-54/AC-5: it never falls back to another pull request, the oldest included', () => {
    const open = [pull(1), pull(2), pull(3)]
    const named = github({ pulls: open })
    expect(runRunway(manual({ prInput: '2', headInput: SHA_OF(2) }), named.deps)).toEqual({ landed: 2 })
    expect(named.merges).toEqual([mergeArgs(2)])
    const absent = github({ pulls: open })
    expect(runRunway(manual({ prInput: '9', headInput: SHA_OF(9) }), absent.deps)).toEqual({ landed: null })
    expect(absent.merges).toEqual([])
    const skipped = github({ pulls: [pull(1), pull(2, { labels: ['review-blocked'] })] })
    expect(runRunway(manual({ prInput: '2', headInput: SHA_OF(2) }), skipped.deps)).toEqual({ landed: null })
    expect(skipped.merges).toEqual([])
  })

  it('ST-54/AC-5: at most one pull request, and only through the runway\'s one merge call', () => {
    const source = read('scripts', 'land', 'runway.mjs')
    expect(source.match(/merge\(\[/g)).toHaveLength(1)
  })
})

describe('ST-54/AC-6: no manual request changes a later unattended run', () => {
  it('ST-54/AC-6: manual success, then manual refusal, then unattended: with land false the unattended ones merge nothing', () => {
    const first = github({ pulls: [pull(1), pull(2)] })
    expect(runRunway(manual(), first.deps)).toEqual({ landed: 1 })
    // A new run, as after a restart: nothing is carried but what main says.
    const refused = github({ pulls: [pull(2)], permissions: { alice: 'read' } })
    expect(runRunway(manual({ prInput: '2', headInput: SHA_OF(2) }), refused.deps).refused).toBeDefined()
    for (const inputs of [{}, { prInput: '2' }, { modeInput: 'unattended', prInput: '2' }]) {
      const later = github({ pulls: [pull(2)] })
      expect(runRunway({ repo: REPO, actor: 'alice', eventName: 'workflow_dispatch', ...inputs }, later.deps).refused).toMatch(/land is false/)
      expect(later.merges).toEqual([])
    }
    expect(refused.merges).toEqual([])
  })

  it('ST-54/AC-6: the same dependencies, run again, behave the same: the runway keeps no state between runs', () => {
    const { deps, merges } = github({ pulls: [pull(1), pull(2)] })
    expect(runRunway(manual(), deps)).toEqual({ landed: 1 })
    expect(runRunway({ repo: REPO, prInput: '2' }, deps).refused).toMatch(/land is false/)
    expect(runRunway({ repo: REPO }, deps).refused).toMatch(/land is false/)
    expect(merges).toEqual([mergeArgs(1)])
  })
})

describe('ST-54/AC-4: the command reads the actor and event from the workflow\'s context, never from an input', () => {
  const runway = read('scripts', 'land', 'runway.mjs')
  const files = ['.github/workflows/land-approved.yml', 'templates/workflows/land-approved.yml']

  it('ST-54/AC-4: runway.mjs takes ACTOR and EVENT_NAME from the environment, and the workflows set them from github.actor and github.event_name', () => {
    expect(runway).toContain("actor: process.env.ACTOR ?? ''")
    expect(runway).toContain("eventName: process.env.EVENT_NAME ?? ''")
    for (const file of files) {
      const text = read(...file.split('/'))
      expect(text).toMatch(/^ {10}ACTOR: \$\{\{ github\.actor \}\}$/m)
      expect(text).toMatch(/^ {10}EVENT_NAME: \$\{\{ github\.event_name \}\}$/m)
    }
  })

  it('ST-54/AC-4: no workflow input is named actor, event or permission', () => {
    for (const file of files) {
      const inputs = read(...file.split('/')).match(/workflow_dispatch:\n {4}inputs:\n([\s\S]*?)\n\npermissions:/)[1]
      const names = [...inputs.matchAll(/^ {6}(\w+):$/gm)].map((m) => m[1])
      expect(names).toEqual(['pr', 'mode', 'head'])
    }
  })
})
