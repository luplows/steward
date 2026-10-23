// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  assertAllowedRequest,
  buildCreateInspectionIssue,
  buildCreateInspectionLabel,
  buildListCommitPullRequests,
  buildListCommitStatuses,
  buildListInspectionIssues,
  buildListBranchCommits,
  buildListMainCommits,
  buildListOpenPullRequests,
  buildListReleaseBranchRefs,
  createInspectContext,
  inspect,
  main,
  resolveToken,
} from './inspect.mjs'
import { fixtureSettings } from './settings-fixture.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..', '..')
const cliScript = path.join(here, 'cli.mjs')
const REPO = 'owner/repo'
const BASE = `https://api.github.com/repos/${REPO}`
const NOW = Date.parse('2026-10-20T12:00:00Z')
const HOUR = 60 * 60 * 1000
const GATE = 'github-actions[bot]'
const sha = (c) => c.repeat(40)
const iso = (ms) => new Date(ms).toISOString()
const hoursAgo = (h) => iso(NOW - h * HOUR)
const AFTER_HOURS = 24
const SINCE_DAYS = 7

const commit = (s, date = hoursAgo(2)) => ({ sha: s, commit: { committer: { date } } })
const mergedPull = (number, head, mergedAt, over = {}) => ({
  number,
  merged_at: mergedAt,
  base: { ref: 'main' },
  head: { sha: head },
  ...over,
})
let nextId = 1
const reviewStatus = (state, createdAt, creator = GATE, context = 'review/agent') => ({
  id: nextId++,
  context,
  state,
  created_at: createdAt,
  creator: { login: creator },
})
const openPull = (number, head, over = {}) => ({
  number,
  head: { sha: head, ref: `story/${number}` },
  draft: false,
  author_association: 'OWNER',
  ...over,
})
const issue = (title, state = 'open', number = 900) => ({ number, title, state })

/**
 * A fake GitHub. `commits` is main's commit list; `pulls[sha]` the pull requests of a commit;
 * `statuses[sha]` the statuses of a head; `open` the open pull requests; `issues` the issues
 * labelled `inspection`. `branches` maps the name of each branch the repository has that starts
 * `release/v` (a release branch or not) to its commit list. Every request is recorded; a POST to `/issues` answers a number, and
 * `labelExists` makes the label creation answer GitHub's 422 for a duplicate; `labelText` makes it
 * answer 422 with that response text instead.
 */
function world({ commits = [], branches = {}, pulls = {}, statuses = {}, open = [], issues = [], labelExists = false, labelText = null, failOn = null } = {}) {
  const w = { requests: [], posts: [], nextIssue: 1000 }
  const ok = (json) => ({ ok: true, status: 200, json: async () => json })
  w.fetch = async (url, init) => {
    const request = { method: init.method, url, body: init.body === undefined ? undefined : JSON.parse(init.body) }
    w.requests.push(request)
    if (failOn && failOn(request)) return { ok: false, status: 500, text: async () => 'boom' }
    if (init.method === 'POST') {
      w.posts.push(request)
      if (url.endsWith('/labels')) {
        const duplicate = JSON.stringify({
          message: 'Validation Failed',
          errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }],
        })
        if (labelText !== null) return { ok: false, status: 422, text: async () => labelText }
        return labelExists ? { ok: false, status: 422, text: async () => duplicate } : ok({ name: 'inspection' })
      }
      return ok({ number: w.nextIssue++ })
    }
    const path = url.slice(BASE.length)
    if (path === '/git/matching-refs/heads/release/v') {
      return ok(Object.keys(branches).map((name) => ({ ref: `refs/heads/${name}` })))
    }
    if (path.startsWith('/commits?')) {
      const name = decodeURIComponent(path.match(/sha=([^&]+)/)[1])
      return ok(name === 'main' ? commits : (branches[name] ?? []))
    }
    let m = path.match(/^\/commits\/([0-9a-f]{40})\/pulls\?/)
    if (m) return ok(pulls[m[1]] ?? [])
    m = path.match(/^\/commits\/([0-9a-f]{40})\/statuses\?/)
    if (m) return ok(statuses[m[1]] ?? [])
    if (path.startsWith('/pulls?')) {
      const base = decodeURIComponent(path.match(/base=([^&]+)/)[1])
      return ok(open.filter((pr) => (pr.base?.ref ?? 'main') === base))
    }
    if (path.startsWith('/issues?')) return ok(issues)
    throw new Error(`unexpected request ${init.method} ${url}`)
  }
  w.ctx = createInspectContext({ repo: REPO, fetch: w.fetch, getToken: async () => 'tok' })
  w.run = (over = {}) =>
    inspect(w.ctx, { now: NOW, sinceDays: SINCE_DAYS, afterHours: AFTER_HOURS, ...over }, (line) => (w.lines ??= []).push(line))
  return w
}

const titlesOpened = (w) => w.posts.filter((r) => r.url.endsWith('/issues')).map((r) => r.body.title)

/** One squash-merged pull request, #n, whose head `H` has the given statuses. */
function mergeWorld(statusList, { mergedAt = hoursAgo(1), issues = [] } = {}) {
  const head = sha('b')
  return world({
    commits: [commit(sha('a'))],
    pulls: { [sha('a')]: [mergedPull(7, head, mergedAt)] },
    statuses: { [head]: statusList },
    issues,
  })
}

describe('ST-29/AC-1: the command, its arguments and the token', () => {
  it('ST-29/AC-1: cli.mjs has an inspect command that runs inspect.mjs', async () => {
    const { COMMANDS } = await import('./cli.mjs')
    expect(COMMANDS.inspect).toBe(path.join(here, 'inspect.mjs'))
    expect(COMMANDS.inspect.endsWith(path.join('scripts', 'dispatch', 'inspect.mjs'))).toBe(true)
  })

  it('ST-29/AC-1: through cli.mjs, a --since-days that is not a positive integer exits 2 with nothing sent', () => {
    for (const bad of ['0', '-3', '1.5', 'x', '']) {
      let status
      let stderr = ''
      try {
        execFileSync(process.execPath, [cliScript, 'inspect', '--since-days', bad], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
        status = 0
      } catch (error) {
        status = error.status
        stderr = String(error.stderr)
      }
      expect(status).toBe(2)
      expect(stderr).toMatch(/--since-days|usage/)
    }
  })

  async function withProject(fn, overrides = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'inspect-test-'))
    try {
      writeFileSync(path.join(dir, 'steward.config.json'), JSON.stringify(fixtureSettings(overrides)))
      return await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it("ST-29/AC-1: --repo defaults to the settings' repo and can be given; --since-days defaults to 7", async () => {
    await withProject(async (dir) => {
      const w = world()
      const lines = []
      expect(await main([], { cwd: dir, fetch: w.fetch, now: NOW, getToken: async () => 'tok', out: (l) => lines.push(l) })).toBe(0)
      const sinceOf = (r) => decodeURIComponent(r.url.match(/since=([^&]+)/)[1])
      expect(w.requests.every((r) => r.url.startsWith(`${BASE}/`))).toBe(true)
      const mainCommits = w.requests.find((r) => r.url.includes('/commits?'))
      expect(mainCommits.url.startsWith(`${BASE}/commits?sha=main&since=`)).toBe(true)
      expect(sinceOf(mainCommits)).toBe(iso(NOW - 7 * 24 * HOUR))

      const other = world()
      other.fetch = async (url) => {
        expect(url.startsWith('https://api.github.com/repos/someone/else/')).toBe(true)
        return { ok: true, status: 200, json: async () => [] }
      }
      expect(
        await main(['--repo', 'someone/else', '--since-days', '3'], { cwd: dir, fetch: other.fetch, now: NOW, getToken: async () => 'tok', out: () => {} }),
      ).toBe(0)
    })
  })

  it('ST-29/AC-1: --since-days takes a positive integer and sets the window', async () => {
    await withProject(async (dir) => {
      const w = world()
      await main(['--since-days', '3'], { cwd: dir, fetch: w.fetch, now: NOW, getToken: async () => 'tok', out: () => {} })
      const mainCommits = w.requests.find((r) => r.url.includes('/commits?'))
      expect(decodeURIComponent(mainCommits.url.match(/since=([^&]+)/)[1])).toBe(iso(NOW - 3 * 24 * HOUR))
      for (const bad of ['0', '-1', '2.5', 'abc']) {
        const v = world()
        const errors = []
        const code = await main(['--since-days', bad], { cwd: dir, fetch: v.fetch, now: NOW, getToken: async () => 'tok', out: () => {}, err: (e) => errors.push(e) })
        expect(code).toBe(2)
        expect(v.requests).toEqual([])
        expect(errors.join()).toMatch(/--since-days/)
      }
    })
  })

  it('ST-29/AC-1: the token is GH_TOKEN when set and not empty, otherwise the output of gh auth token', async () => {
    const calls = []
    const authToken = async () => (calls.push('gh'), 'from-gh')
    expect(await resolveToken({ GH_TOKEN: 'from-env' }, authToken)).toBe('from-env')
    expect(calls).toEqual([])
    expect(await resolveToken({ GH_TOKEN: '' }, authToken)).toBe('from-gh')
    expect(await resolveToken({}, authToken)).toBe('from-gh')
    expect(calls).toEqual(['gh', 'gh'])
  })

  it('ST-29/AC-1: main sends GH_TOKEN as the bearer token', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'inspect-test-'))
    try {
      writeFileSync(path.join(dir, 'steward.config.json'), JSON.stringify(fixtureSettings()))
      const seen = []
      const fetch = async (url, init) => (seen.push(init.headers.Authorization), { ok: true, status: 200, json: async () => [] })
      await main([], { cwd: dir, env: { GH_TOKEN: 'workflow-token' }, fetch, now: NOW, out: () => {} })
      expect(seen.length).toBeGreaterThan(0)
      expect(new Set(seen)).toEqual(new Set(['Bearer workflow-token']))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('ST-29/AC-2: merges', () => {
  it('ST-29/AC-2 and AC-9: a squash merge with a gate-posted success before merged_at is no finding', async () => {
    const w = mergeWorld([
      reviewStatus('pending', hoursAgo(5)),
      reviewStatus('success', hoursAgo(3)),
    ])
    const { results } = await w.run()
    expect(results).toEqual([])
    expect(w.posts).toEqual([])
  })

  it('ST-29/AC-2 and AC-9: the latest review/agent status before merged_at decides, not an earlier success', async () => {
    const w = mergeWorld([reviewStatus('success', hoursAgo(5)), reviewStatus('failure', hoursAgo(3))])
    expect(titlesOpened(w)).toEqual([])
    await w.run()
    expect(titlesOpened(w)).toEqual(['Inspection: #7 merged without a passing verdict'])
  })

  it('ST-29/AC-2 and AC-9: a pending latest status is a finding', async () => {
    const w = mergeWorld([reviewStatus('pending', hoursAgo(3))])
    await w.run()
    expect(titlesOpened(w)).toEqual(['Inspection: #7 merged without a passing verdict'])
  })

  it('ST-29/AC-2 and AC-9: a success created by another account is a finding', async () => {
    const w = mergeWorld([reviewStatus('pending', hoursAgo(5)), reviewStatus('success', hoursAgo(3), 'some-user')])
    await w.run()
    expect(titlesOpened(w)).toEqual(['Inspection: #7 merged without a passing verdict'])
  })

  it('ST-29/AC-2 and AC-9: a success created after merged_at does not count', async () => {
    const w = mergeWorld(
      [reviewStatus('pending', hoursAgo(5)), reviewStatus('success', hoursAgo(0.5))],
      { mergedAt: hoursAgo(1) },
    )
    await w.run()
    expect(titlesOpened(w)).toEqual(['Inspection: #7 merged without a passing verdict'])
  })

  it('ST-29/AC-2: a success created at exactly merged_at counts, and a status of another context does not', async () => {
    const at = hoursAgo(1)
    const passing = mergeWorld([reviewStatus('success', at)], { mergedAt: at })
    expect((await passing.run()).results).toEqual([])
    const other = mergeWorld([reviewStatus('success', hoursAgo(3), GATE, 'ci/test')], { mergedAt: at })
    expect((await other.run()).results).toHaveLength(1)
    const none = mergeWorld([], { mergedAt: at })
    expect((await none.run()).results).toHaveLength(1)
  })

  it('ST-29/AC-2 and AC-9: a commit on main with no pull request is a finding', async () => {
    const w = world({ commits: [commit(sha('c'))] })
    await w.run()
    expect(titlesOpened(w)).toEqual([`Inspection: ${sha('c').slice(0, 7)} on main without a pull request`])
  })

  it('ST-29/AC-2: a pull request that is not merged, or whose base is not main, does not count as the commit\'s', async () => {
    const w = world({
      commits: [commit(sha('c'))],
      pulls: {
        [sha('c')]: [
          mergedPull(1, sha('d'), null),
          mergedPull(2, sha('e'), hoursAgo(1), { base: { ref: 'release' } }),
        ],
      },
    })
    await w.run()
    expect(titlesOpened(w)).toEqual([`Inspection: ${sha('c').slice(0, 7)} on main without a pull request`])
  })

  it('ST-29/AC-2: only commits committed within the window are looked at', async () => {
    const w = world({ commits: [commit(sha('c'), iso(NOW - 8 * 24 * HOUR))] })
    await w.run()
    expect(w.requests.filter((r) => /\/commits\/[0-9a-f]{40}\/pulls/.test(r.url))).toEqual([])
    expect(w.posts).toEqual([])
  })

  it('ST-29/AC-2 and AC-9: a pull request with several commits on main is judged once', async () => {
    const head = sha('b')
    const pr = mergedPull(7, head, hoursAgo(1))
    const w = world({
      commits: [commit(sha('1')), commit(sha('2')), commit(sha('3'))],
      pulls: { [sha('1')]: [pr], [sha('2')]: [pr], [sha('3')]: [pr] },
      statuses: { [head]: [reviewStatus('failure', hoursAgo(3))] },
    })
    const { results } = await w.run()
    expect(results).toHaveLength(1)
    expect(titlesOpened(w)).toEqual(['Inspection: #7 merged without a passing verdict'])
    expect(w.requests.filter((r) => r.url.includes(`/commits/${head}/statuses`))).toHaveLength(1)
  })
})

describe('ST-29/AC-3: stalls', () => {
  const stallWorld = (pull, statusList, over = {}) =>
    world({ open: [pull], statuses: { [pull.head.sha]: statusList }, ...over })

  it('ST-29/AC-3 and AC-9: pending just over inspectAfterHours is a finding, just under is not', async () => {
    const over = stallWorld(openPull(5, sha('f')), [reviewStatus('pending', iso(NOW - AFTER_HOURS * HOUR - 1000))])
    await over.run()
    expect(titlesOpened(over)).toEqual([`Inspection: #5 pending at ${sha('f').slice(0, 7)}`])
    const under = stallWorld(openPull(5, sha('f')), [reviewStatus('pending', iso(NOW - AFTER_HOURS * HOUR + 1000))])
    await under.run()
    expect(under.posts).toEqual([])
  })

  it('ST-29/AC-3 and AC-9: a gate-posted success just over inspectAfterHours is holding, just under is not', async () => {
    const over = stallWorld(openPull(5, sha('f')), [reviewStatus('success', iso(NOW - AFTER_HOURS * HOUR - 1000))])
    await over.run()
    expect(titlesOpened(over)).toEqual([`Inspection: #5 holding at ${sha('f').slice(0, 7)}`])
    const under = stallWorld(openPull(5, sha('f')), [reviewStatus('success', iso(NOW - AFTER_HOURS * HOUR + 1000))])
    await under.run()
    expect(under.posts).toEqual([])
  })

  it('ST-29/AC-3 and AC-9: a draft is not a finding', async () => {
    const w = stallWorld(openPull(5, sha('f'), { draft: true }), [reviewStatus('pending', hoursAgo(100))])
    await w.run()
    expect(w.posts).toEqual([])
  })

  it('ST-29/AC-3 and AC-9: a pull request from an author the gate does not honour is not a finding', async () => {
    for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', undefined]) {
      const w = stallWorld(openPull(5, sha('f'), { author_association: association }), [reviewStatus('pending', hoursAgo(100))])
      await w.run()
      expect(w.posts).toEqual([])
    }
    for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      const w = stallWorld(openPull(5, sha('f'), { author_association: association }), [reviewStatus('pending', hoursAgo(100))])
      await w.run()
      expect(titlesOpened(w)).toHaveLength(1)
    }
  })

  it('ST-29/AC-3 and AC-9: a failure head, an old pass that is not the latest, a success from another account, and no status are not findings', async () => {
    const failure = stallWorld(openPull(5, sha('f')), [reviewStatus('failure', hoursAgo(100))])
    await failure.run()
    expect(failure.posts).toEqual([])
    const superseded = stallWorld(openPull(5, sha('f')), [reviewStatus('success', hoursAgo(100)), reviewStatus('pending', hoursAgo(1))])
    await superseded.run()
    expect(superseded.posts).toEqual([])
    const other = stallWorld(openPull(5, sha('f')), [reviewStatus('success', hoursAgo(100), 'some-user')])
    await other.run()
    expect(other.posts).toEqual([])
    const none = stallWorld(openPull(5, sha('f')), [])
    await none.run()
    expect(none.posts).toEqual([])
  })

  it('ST-29/AC-3: the age is measured from the status, against the settings\' inspectAfterHours', async () => {
    const w = stallWorld(openPull(5, sha('f')), [reviewStatus('pending', hoursAgo(10))])
    await w.run({ afterHours: 9 })
    expect(titlesOpened(w)).toHaveLength(1)
    const v = stallWorld(openPull(5, sha('f')), [reviewStatus('pending', hoursAgo(10))])
    await v.run({ afterHours: 11 })
    expect(v.posts).toEqual([])
  })
})

describe('ST-29/AC-4: raising', () => {
  it('ST-29/AC-4: the four titles name the finding and nothing that changes between runs', async () => {
    const w = world({
      commits: [commit(sha('1')), commit(sha('2'))],
      pulls: { [sha('2')]: [mergedPull(7, sha('b'), hoursAgo(1))] },
      statuses: { [sha('b')]: [], [sha('d')]: [reviewStatus('pending', hoursAgo(30))], [sha('e')]: [reviewStatus('success', hoursAgo(30))] },
      open: [openPull(8, sha('d')), openPull(9, sha('e'))],
    })
    await w.run()
    expect(titlesOpened(w)).toEqual([
      `Inspection: ${sha('1').slice(0, 7)} on main without a pull request`,
      'Inspection: #7 merged without a passing verdict',
      `Inspection: #8 pending at ${sha('d').slice(0, 7)}`,
      `Inspection: #9 holding at ${sha('e').slice(0, 7)}`,
    ])
  })

  it('ST-29/AC-4 and AC-9: a new finding opens one issue, labelled inspection, whose body links the pull request', async () => {
    const w = mergeWorld([reviewStatus('failure', hoursAgo(3))])
    await w.run()
    const issues = w.posts.filter((r) => r.url === `${BASE}/issues`)
    expect(issues).toHaveLength(1)
    expect(issues[0].body.labels).toEqual(['inspection'])
    expect(issues[0].body.title).toBe('Inspection: #7 merged without a passing verdict')
    expect(issues[0].body.body).toContain('https://github.com/owner/repo/pull/7')
  })

  it('ST-29/AC-4: the body of a commit finding links the commit', async () => {
    const w = world({ commits: [commit(sha('c'))] })
    await w.run()
    expect(w.posts.find((r) => r.url === `${BASE}/issues`).body.body).toContain(`https://github.com/owner/repo/commit/${sha('c')}`)
  })

  it('ST-29/AC-4 and AC-9: a finding whose title is on an open issue opens nothing', async () => {
    const w = mergeWorld([reviewStatus('failure', hoursAgo(3))], {
      issues: [issue('Inspection: #7 merged without a passing verdict', 'open')],
    })
    const { results } = await w.run()
    expect(results.map((r) => r.opened)).toEqual([false])
    expect(w.posts).toEqual([])
  })

  it('ST-29/AC-4 and AC-9: a finding whose title is on a closed issue opens nothing', async () => {
    const w = mergeWorld([reviewStatus('failure', hoursAgo(3))], {
      issues: [issue('Inspection: #7 merged without a passing verdict', 'closed')],
    })
    const { results } = await w.run()
    expect(results.map((r) => r.opened)).toEqual([false])
    expect(w.posts).toEqual([])
  })

  it('ST-29/AC-4: the issues are listed with the inspection label, open and closed, before any is opened', async () => {
    const w = mergeWorld([reviewStatus('failure', hoursAgo(3))])
    await w.run()
    const list = w.requests.findIndex((r) => r.url === `${BASE}/issues?labels=inspection&state=all&per_page=100&page=1`)
    const open = w.requests.findIndex((r) => r.method === 'POST' && r.url === `${BASE}/issues`)
    expect(list).toBeGreaterThanOrEqual(0)
    expect(list).toBeLessThan(open)
  })

  it('ST-29/AC-4: the inspection label is created before the first issue, once, and a 422 means it exists', async () => {
    const w = world({ commits: [commit(sha('1')), commit(sha('2'))] })
    await w.run()
    const kinds = w.posts.map((r) => r.url.slice(BASE.length))
    expect(kinds).toEqual(['/labels', '/issues', '/issues'])
    expect(w.posts[0].body.name).toBe('inspection')

    const exists = world({ commits: [commit(sha('1'))], labelExists: true })
    const { results } = await exists.run()
    expect(results.map((r) => r.opened)).toEqual([true])
    expect(exists.posts.map((r) => r.url.slice(BASE.length))).toEqual(['/labels', '/issues'])
  })

  it('ST-29/AC-4: no label is created when no issue is opened', async () => {
    const w = world()
    await w.run()
    expect(w.posts).toEqual([])
  })

  it('ST-29/AC-4: a pull request that carries the label is not an issue with that title', async () => {
    const w = mergeWorld([reviewStatus('failure', hoursAgo(3))], {
      issues: [{ ...issue('Inspection: #7 merged without a passing verdict'), pull_request: {} }],
    })
    await w.run()
    expect(titlesOpened(w)).toEqual(['Inspection: #7 merged without a passing verdict'])
  })
})

describe('ST-29/AC-5: output and exit codes', () => {
  function project(fn) {
    const dir = mkdtempSync(path.join(tmpdir(), 'inspect-test-'))
    return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
  }
  const run = (dir, w) => {
    const lines = []
    const errors = []
    return main([], { cwd: dir, fetch: w.fetch, now: NOW, getToken: async () => 'tok', out: (l) => lines.push(l), err: (e) => errors.push(e) }).then(
      (code) => ({ code, lines, errors }),
    )
  }
  const writeSettings = (dir, over = {}) => writeFileSync(path.join(dir, 'steward.config.json'), JSON.stringify(fixtureSettings(over)))

  it('ST-29/AC-5: no finding: one line of counts, exit 0', async () => {
    await project(async (dir) => {
      writeSettings(dir)
      const { code, lines } = await run(dir, world())
      expect(lines).toEqual(['0 findings: 0 opened, 0 already raised'])
      expect(code).toBe(0)
    })
  })

  it('ST-29/AC-5: findings already raised: a line each, saying so, and exit 0', async () => {
    await project(async (dir) => {
      writeSettings(dir)
      const title = 'Inspection: #7 merged without a passing verdict'
      const w = mergeWorld([reviewStatus('failure', hoursAgo(3))], { issues: [issue(title, 'closed')] })
      const { code, lines } = await run(dir, w)
      expect(lines).toEqual([`already raised: ${title}`, '1 findings: 0 opened, 1 already raised'])
      expect(code).toBe(0)
    })
  })

  it('ST-29/AC-5: an issue opened: a line saying so, the counts, and exit 1', async () => {
    await project(async (dir) => {
      writeSettings(dir)
      const w = mergeWorld([reviewStatus('failure', hoursAgo(3))], {
        issues: [issue(`Inspection: ${sha('c').slice(0, 7)} on main without a pull request`)],
      })
      w.nextIssue = 1234
      const { code, lines } = await run(dir, w)
      expect(lines).toEqual(['opened #1234: Inspection: #7 merged without a passing verdict', '1 findings: 1 opened, 0 already raised'])
      expect(code).toBe(1)
    })
  })

  it('ST-29/AC-5: a mix of opened and already raised prints each and exits 1', async () => {
    await project(async (dir) => {
      writeSettings(dir)
      const w = world({
        commits: [commit(sha('1')), commit(sha('2'))],
        issues: [issue(`Inspection: ${sha('1').slice(0, 7)} on main without a pull request`)],
      })
      const { code, lines } = await run(dir, w)
      expect(lines).toEqual([
        `already raised: Inspection: ${sha('1').slice(0, 7)} on main without a pull request`,
        `opened #1000: Inspection: ${sha('2').slice(0, 7)} on main without a pull request`,
        '2 findings: 1 opened, 1 already raised',
      ])
      expect(code).toBe(1)
    })
  })

  it('ST-29/AC-5: a failed request exits 2 and opens nothing more', async () => {
    await project(async (dir) => {
      writeSettings(dir)
      const w = world({
        commits: [commit(sha('1')), commit(sha('2'))],
        failOn: (r) => r.method === 'GET' && r.url.includes('/commits/') && r.url.includes(sha('2')),
      })
      const { code, errors } = await run(dir, w)
      expect(code).toBe(2)
      expect(errors.join()).toMatch(/failed: 500/)
      expect(w.posts).toEqual([])
    })
  })

  it('ST-29/AC-5: a failure while raising exits 2 and opens no further issue', async () => {
    await project(async (dir) => {
      writeSettings(dir)
      const w = world({
        commits: [commit(sha('1')), commit(sha('2'))],
        failOn: (r) => r.method === 'POST' && r.url.endsWith('/issues'),
      })
      const { code } = await run(dir, w)
      expect(code).toBe(2)
      expect(w.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/issues'))).toHaveLength(1)
    })
  })

  it('ST-29/AC-4 and AC-5: a 422 that is not already_exists, or has no JSON body, exits 2 and opens no issue', async () => {
    const bodies = [
      JSON.stringify({ message: 'Validation Failed', errors: [{ resource: 'Label', code: 'invalid', field: 'color' }] }),
      JSON.stringify({ message: 'Validation Failed' }),
      JSON.stringify({ message: 'Validation Failed', errors: [] }),
      JSON.stringify({ errors: 'already_exists' }),
      'already_exists',
      '',
    ]
    for (const labelText of bodies) {
      await project(async (dir) => {
        writeSettings(dir)
        const w = world({ commits: [commit(sha('1'))], labelText })
        const { code, errors } = await run(dir, w)
        expect(code, labelText).toBe(2)
        expect(errors.join()).toMatch(/failed: 422/)
        expect(w.posts.filter((r) => r.url.endsWith('/issues'))).toEqual([])
      })
    }
  })

  it('ST-29/AC-4 and AC-5: a 422 for a duplicate label, among other errors, still lets the issue open', async () => {
    await project(async (dir) => {
      writeSettings(dir)
      const labelText = JSON.stringify({ errors: [{ code: 'custom' }, { code: 'already_exists' }] })
      const w = world({ commits: [commit(sha('1'))], labelText })
      expect((await run(dir, w)).code).toBe(1)
      expect(w.posts.filter((r) => r.url.endsWith('/issues'))).toHaveLength(1)
    })
  })

  it('ST-29/AC-5: settings that do not read exit 2 with nothing sent', async () => {
    await project(async (dir) => {
      const missing = world()
      const a = await run(dir, missing)
      expect(a.code).toBe(2)
      expect(a.errors.join()).toMatch(/file not found/)
      expect(missing.requests).toEqual([])

      const bad = fixtureSettings()
      delete bad.inspectAfterHours
      writeFileSync(path.join(dir, 'steward.config.json'), JSON.stringify(bad))
      const without = world()
      const b = await run(dir, without)
      expect(b.code).toBe(2)
      expect(b.errors.join()).toMatch(/inspectAfterHours/)
      expect(without.requests).toEqual([])
    })
  })

  it("ST-29/AC-5: main reads the settings' inspectAfterHours", async () => {
    await project(async (dir) => {
      const pull = openPull(5, sha('f'))
      const make = () => world({ open: [pull], statuses: { [pull.head.sha]: [reviewStatus('pending', hoursAgo(10))] } })
      writeSettings(dir, { inspectAfterHours: 9 })
      expect((await run(dir, make())).code).toBe(1)
      writeSettings(dir, { inspectAfterHours: 11 })
      expect((await run(dir, make())).code).toBe(0)
    })
  })
})

describe('ST-29/AC-6: the request allowlist', () => {
  const ok = [
    buildListMainCommits(REPO, iso(NOW), 1),
    buildListBranchCommits(REPO, 'release/v1.2.3', iso(NOW), 2),
    buildListReleaseBranchRefs(REPO),
    buildListOpenPullRequests(REPO, 1, 'release/v1.2.3'),
    buildListCommitPullRequests(REPO, sha('a'), 2),
    buildListCommitStatuses(REPO, sha('a'), 1),
    buildListOpenPullRequests(REPO, 1),
    buildListInspectionIssues(REPO, 3),
    buildCreateInspectionIssue(REPO, { title: 't', body: 'b' }),
    buildCreateInspectionLabel(REPO),
  ]

  it('ST-29/AC-6: admits the requests its builders produce', () => {
    for (const request of ok) expect(() => assertAllowedRequest(REPO, request)).not.toThrow()
  })

  const refused = [
    { method: 'POST', url: `${BASE}/issues/7/comments`, body: { body: 'x' } },
    { method: 'POST', url: `${BASE}/issues/7/labels`, body: { labels: ['inspection'] } },
    { method: 'PATCH', url: `${BASE}/issues/7`, body: { state: 'closed' } },
    { method: 'PATCH', url: `${BASE}/pulls/7`, body: { title: 'x' } },
    { method: 'PUT', url: `${BASE}/pulls/7/merge` },
    { method: 'DELETE', url: `${BASE}/git/refs/heads/main` },
    { method: 'POST', url: `${BASE}/actions/workflows/land-approved.yml/dispatches`, body: { ref: 'main' } },
    { method: 'POST', url: `${BASE}/statuses/${sha('a')}`, body: { state: 'success' } },
    { method: 'GET', url: `${BASE}/pulls/7` },
    { method: 'GET', url: `${BASE}/issues/7` },
    { method: 'GET', url: `${BASE}/branches/main/protection` },
    { method: 'GET', url: `${BASE}/commits/${sha('a')}/check-runs?per_page=100` },
    { method: 'GET', url: `${BASE}/issues?labels=inspection&state=open&per_page=100&page=1` },
    { method: 'GET', url: `${BASE}/issues?labels=other&state=all&per_page=100&page=1` },
    { method: 'GET', url: `${BASE}/commits?sha=other&since=2026-01-01&per_page=100&page=1` },
    { method: 'GET', url: `${BASE}/commits?sha=release%2Fnext&since=2026-01-01&per_page=100&page=1` },
    { method: 'GET', url: `${BASE}/commits?sha=release%2Fv1.2&since=2026-01-01&per_page=100&page=1` },
    { method: 'GET', url: `${BASE}/commits?sha=%E0%A4%A&since=2026-01-01&per_page=100&page=1` },
    { method: 'GET', url: `${BASE}/pulls?base=other&state=open&per_page=100&page=1` },
    { method: 'GET', url: `${BASE}/pulls?base=release%2Fnext&state=open&per_page=100&page=1` },
    { method: 'GET', url: `${BASE}/git/matching-refs/heads/other?per_page=100&page=1` },
    { method: 'GET', url: `${BASE}/git/matching-refs/heads/release/v?per_page=100&page=1` },
    { method: 'GET', url: `${BASE}/git/refs/heads/main` },
    { method: 'GET', url: `${BASE}/pulls?base=main&state=open&per_page=100&page=1`, body: { x: 1 } },
    { method: 'POST', url: `${BASE}/issues`, body: { title: 't', body: 'b', labels: ['bug'] } },
    { method: 'POST', url: `${BASE}/issues`, body: { title: 't', body: 'b', labels: ['inspection'], assignees: ['x'] } },
    { method: 'POST', url: `${BASE}/issues`, body: { title: 't', body: 'b', labels: ['inspection', 'bug'] } },
    { method: 'POST', url: `${BASE}/labels`, body: { name: 'bug', color: 'ffffff', description: 'd' } },
    { method: 'POST', url: 'https://api.github.com/graphql', body: { query: 'mutation {}' } },
    { method: 'GET', url: 'https://api.github.com/repos/other/repo/pulls?base=main&state=open&per_page=100&page=1' },
    { method: 'GET', url: 'https://example.com/' },
  ]

  it('ST-29/AC-6: refuses any other request, and createInspectContext sends nothing for it', async () => {
    let sent = 0
    let tokenReads = 0
    const ctx = createInspectContext({
      repo: REPO,
      fetch: async () => (sent++, { ok: true, status: 200, json: async () => ({}) }),
      getToken: async () => (tokenReads++, 'tok'),
    })
    for (const request of refused) {
      expect(() => assertAllowedRequest(REPO, request), `${request.method} ${request.url}`).toThrow(/refusing/)
      await expect(ctx.send(request)).rejects.toThrow(/refusing/)
    }
    expect(sent).toBe(0)
    expect(tokenReads).toBe(0)
  })
})

describe('ST-29/AC-8: the workflow', () => {
  const text = readFileSync(path.join(ROOT, '.github', 'workflows', 'inspection.yml'), 'utf8')

  it('ST-29/AC-8: is named Inspection and runs the command after checking out the repository', () => {
    expect(text).toMatch(/^name: Inspection$/m)
    expect(text).toMatch(/uses: actions\/checkout@/)
    expect(text).toMatch(/run: node scripts\/dispatch\/cli\.mjs inspect$/m)
    expect(text.indexOf('actions/checkout')).toBeLessThan(text.indexOf('cli.mjs inspect'))
    expect(text).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/)
  })

  it('ST-29/AC-8: runs on workflow_dispatch and once a day', () => {
    const on = text.match(/^on:\n([\s\S]*?)\npermissions:/m)[1]
    expect(on).toMatch(/workflow_dispatch:/)
    const crons = [...on.matchAll(/cron: '([^']+)'/g)].map((m) => m[1])
    expect(crons).toHaveLength(1)
    expect(crons[0]).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/)
  })

  it('ST-29/AC-8: its permissions are exactly the four, each with a comment', () => {
    const block = text.match(/^permissions:\n([\s\S]*?)\n\njobs:/m)[1]
    const lines = block.split('\n')
    const keys = lines.filter((l) => !l.trim().startsWith('#')).map((l) => l.trim())
    expect(keys).toEqual(['contents: read', 'pull-requests: read', 'statuses: read', 'issues: write'])
    lines.forEach((line, i) => {
      if (!line.trim().startsWith('#')) expect(lines[i - 1]?.trim().startsWith('#'), line).toBe(true)
    })
  })

  it('ST-29/AC-8: a comment at the top says a project sets the schedule or drops the file, and the minutes cost', () => {
    const header = text.slice(0, text.indexOf('\non:'))
    expect(header).toMatch(/editing the schedule/)
    expect(header).toMatch(/deleting this\n# file|drops it by deleting this file|deleting this file/)
    expect(header).toMatch(/private repository each run costs Actions minutes/)
  })
})

describe('ST-29/AC-10 and AC-11: the documents', () => {
  const read = (...p) => readFileSync(path.join(ROOT, ...p), 'utf8')

  // ST-25/AC-8: the rotation command runs inspect itself, so the controller no longer runs it by hand.
  it('ST-29/AC-10: the controller reports inspect\'s output and exit code, which does not stop the rotation', () => {
    const controller = read('docs', 'controller.md')
    const rotation = controller.slice(controller.indexOf('## A rotation'), controller.indexOf('## Reporting and stopping'))
    expect(rotation).toMatch(/and runs\s+`inspect`/)
    const reporting = controller.slice(controller.indexOf('## Reporting and stopping'), controller.indexOf('## Re-review'))
    expect(reporting).toMatch(/output of inspection with\s+its\s+exit\s+code/)
    expect(reporting).toMatch(/does not stop the rotation/)
    const what = controller.slice(controller.indexOf('## What you are'), controller.indexOf('## Where you run'))
    expect(what).toMatch(/`inspect\.mjs`/)
  })

  it('ST-29/AC-11: no marker names ST-29, and the glossary and outline no longer call inspection planned or unbuilt', () => {
    expect(read('docs', 'agent-workflow-design.md')).not.toMatch(/Planned \([^)]*ST-29/)
    expect(read('docs', 'glossary.md')).not.toMatch(/planned: ST-29/)
    expect(read('docs', 'outline.md')).not.toMatch(/describes it and is not built/)
  })
})

describe('ST-46: release branches', () => {
  const R1 = 'release/v1.2.3'
  const R2 = 'release/v2.0.0'
  const into = (ref, over = {}) => ({ base: { ref }, ...over })
  const mainTitle = (c) => `Inspection: ${sha(c).slice(0, 7)} on main without a pull request`
  const relTitle = (c, branch) => `Inspection: ${sha(c).slice(0, 7)} on ${branch} without a pull request`
  const issueBodies = (w) => w.posts.filter((r) => r.url.endsWith('/issues')).map((r) => r.body.body)
  const param = (request, name) => decodeURIComponent(request.url.match(new RegExp(`${name}=([^&]+)`))[1])

  it('ST-46/AC-1: a repository with no release branch is inspected as before', async () => {
    const w = world({ commits: [commit(sha('1'))] })
    await w.run()
    expect(titlesOpened(w)).toEqual([mainTitle('1')])
    expect(w.requests.map((r) => r.url.slice(BASE.length).split('?')[0])).toEqual([
      '/git/matching-refs/heads/release/v',
      '/commits',
      `/commits/${sha('1')}/pulls`,
      '/pulls',
      '/issues',
      '/labels',
      '/issues',
    ])
    expect(w.requests.filter((r) => r.url.includes('/pulls?base=')).map((r) => r.url)).toEqual([
      `${BASE}/pulls?base=main&state=open&per_page=100&page=1`,
    ])
  })

  it('ST-46/AC-1: the refs listing is read once, however many refs it answers, and inspection finishes', async () => {
    const branches = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`release/v1.0.${i}`, []]))
    const w = world({ branches })
    await w.run()
    expect(w.requests.filter((r) => r.url.includes('/git/matching-refs/'))).toEqual([
      { method: 'GET', url: `${BASE}/git/matching-refs/heads/release/v`, body: undefined },
    ])
    expect(w.requests.filter((r) => r.url.includes('/commits?'))).toHaveLength(121)
  })

  it('ST-46/AC-1: two release branches are each inspected, in name order, after main', async () => {
    const w = world({ branches: { [R2]: [], [R1]: [] } })
    await w.run()
    expect(w.requests.filter((r) => r.url.includes('/commits?')).map((r) => param(r, 'sha'))).toEqual(['main', R1, R2])
    expect(w.requests.filter((r) => r.url.includes('/pulls?base=')).map((r) => param(r, 'base'))).toEqual(['main', R1, R2])
  })

  it('ST-46/AC-1: a branch named release/v1.2 or release/next is not inspected', async () => {
    const w = world({
      branches: { 'release/v1.2': [commit(sha('7'))], 'release/v1.2.3-rc1': [commit(sha('8'))], 'release/v01.2.3': [commit(sha('9'))], [R1]: [] },
      open: [openPull(5, sha('f'), { base: { ref: 'release/v1.2' } }), openPull(6, sha('e'), { base: { ref: 'release/next' } })],
      statuses: { [sha('f')]: [reviewStatus('pending', hoursAgo(100))], [sha('e')]: [reviewStatus('pending', hoursAgo(100))] },
    })
    await w.run()
    expect(w.posts).toEqual([])
    const named = w.requests.filter((r) => /sha=|base=/.test(r.url)).map((r) => param(r, r.url.includes('sha=') ? 'sha' : 'base'))
    expect(new Set(named)).toEqual(new Set(['main', R1]))
  })

  it("ST-46/AC-1: inspect.mjs imports the release branch's name from release-branch.mjs and defines none", () => {
    const source = readFileSync(path.join(here, 'inspect.mjs'), 'utf8')
    expect(source).toMatch(/import \{[^}]*isReleaseBranch[^}]*\} from '\.\.\/land\/release-branch\.mjs'/)
    expect(source).not.toContain('(0|[1-9]')
  })

  it('ST-46/AC-2: a commit on a release branch whose pull request into it passed raises nothing', async () => {
    const head = sha('b')
    const w = world({
      branches: { [R1]: [commit(sha('a'))] },
      pulls: { [sha('a')]: [mergedPull(7, head, hoursAgo(1), into(R1))] },
      statuses: { [head]: [reviewStatus('success', hoursAgo(3))] },
    })
    const { results } = await w.run()
    expect(results).toEqual([])
  })

  it('ST-46/AC-2: a commit on a release branch with no pull request is a finding', async () => {
    const w = world({ branches: { [R1]: [commit(sha('c'))] } })
    await w.run()
    expect(titlesOpened(w)).toEqual([relTitle('c', R1)])
  })

  it('ST-46/AC-2: a commit on a release branch whose pull request into it had no passing verdict is a finding', async () => {
    const head = sha('b')
    const w = world({
      branches: { [R1]: [commit(sha('a'))] },
      pulls: { [sha('a')]: [mergedPull(7, head, hoursAgo(1), into(R1))] },
      statuses: { [head]: [reviewStatus('failure', hoursAgo(3))] },
    })
    await w.run()
    expect(titlesOpened(w)).toEqual(['Inspection: #7 merged without a passing verdict'])
  })

  it("ST-46/AC-2: a pull request into another release branch, or not merged, is not the commit's", async () => {
    const w = world({
      branches: { [R1]: [commit(sha('c'))], [R2]: [] },
      pulls: { [sha('c')]: [mergedPull(1, sha('d'), hoursAgo(1), into(R2)), mergedPull(2, sha('e'), null, into(R1))] },
    })
    await w.run()
    expect(titlesOpened(w)).toEqual([relTitle('c', R1)])
  })

  it("ST-46/AC-2: a commit of main's within the window that is also on a release branch is raised once at most", async () => {
    const orphan = world({ commits: [commit(sha('c'))], branches: { [R1]: [commit(sha('c'))], [R2]: [commit(sha('c'))] } })
    await orphan.run()
    expect(titlesOpened(orphan)).toEqual([mainTitle('c')])
    expect(orphan.requests.filter((r) => r.url.includes(`/commits/${sha('c')}/pulls`))).toHaveLength(1)

    const head = sha('b')
    const failed = world({
      commits: [commit(sha('a'))],
      branches: { [R1]: [commit(sha('a'))] },
      pulls: { [sha('a')]: [mergedPull(7, head, hoursAgo(1))] },
      statuses: { [head]: [reviewStatus('failure', hoursAgo(3))] },
    })
    await failed.run()
    expect(titlesOpened(failed)).toEqual(['Inspection: #7 merged without a passing verdict'])
  })

  it('ST-46/AC-2: a commit not on main, merged into one release branch and pushed onto another, is raised on the other', async () => {
    const head = sha('b')
    const w = world({
      branches: { [R1]: [commit(sha('a'))], [R2]: [commit(sha('a'))] },
      pulls: { [sha('a')]: [mergedPull(7, head, hoursAgo(1), into(R1))] },
      statuses: { [head]: [reviewStatus('success', hoursAgo(3))] },
    })
    await w.run()
    expect(titlesOpened(w)).toEqual([relTitle('a', R2)])
    expect(w.requests.filter((r) => r.url.includes(`/commits/${sha('a')}/pulls`))).toHaveLength(1)
  })

  it('ST-46/AC-2: a commit on a release branch whose pull request merged into main is not raised for being there', async () => {
    const head = sha('b')
    const w = world({
      branches: { [R1]: [commit(sha('a'))] },
      pulls: { [sha('a')]: [mergedPull(7, head, hoursAgo(1))] },
      statuses: { [head]: [reviewStatus('success', hoursAgo(3))] },
    })
    const { results } = await w.run()
    expect(results).toEqual([])
  })

  it('ST-46/AC-2: only commits of a release branch within the window are looked at', async () => {
    const w = world({ branches: { [R1]: [commit(sha('c'), iso(NOW - 8 * 24 * HOUR))] } })
    await w.run()
    expect(w.posts).toEqual([])
    expect(w.requests.filter((r) => /\/commits\/[0-9a-f]{40}\/pulls/.test(r.url))).toEqual([])
  })

  it('ST-46/AC-3: a pull request into a release branch left pending is a finding', async () => {
    const w = world({
      branches: { [R1]: [] },
      open: [openPull(5, sha('f'), into(R1))],
      statuses: { [sha('f')]: [reviewStatus('pending', hoursAgo(30))] },
    })
    await w.run()
    expect(titlesOpened(w)).toEqual([`Inspection: #5 pending at ${sha('f').slice(0, 7)}`])
  })

  it('ST-46/AC-3: a pull request into a release branch left holding is a finding', async () => {
    const w = world({
      branches: { [R1]: [] },
      open: [openPull(5, sha('f'), into(R1))],
      statuses: { [sha('f')]: [reviewStatus('success', hoursAgo(30))] },
    })
    await w.run()
    expect(titlesOpened(w)).toEqual([`Inspection: #5 holding at ${sha('f').slice(0, 7)}`])
  })

  it("ST-46/AC-3: a pull request into a release branch keeps today's rules", async () => {
    const make = (over, statusList) =>
      world({ branches: { [R1]: [] }, open: [openPull(5, sha('f'), into(R1, over))], statuses: { [sha('f')]: statusList } })
    for (const w of [
      make({ draft: true }, [reviewStatus('pending', hoursAgo(100))]),
      make({ author_association: 'NONE' }, [reviewStatus('pending', hoursAgo(100))]),
      make({}, [reviewStatus('pending', hoursAgo(1))]),
      make({}, [reviewStatus('failure', hoursAgo(100))]),
    ]) {
      await w.run()
      expect(w.posts).toEqual([])
    }
  })

  it('ST-46/AC-3: a pull request into release/next, or any base but main and a release branch, is not checked', async () => {
    const w = world({
      branches: { [R1]: [] },
      open: [openPull(5, sha('f'), into('release/next')), openPull(6, sha('e'), into('feature/x')), openPull(7, sha('d'), into('release/v1.2'))],
      statuses: Object.fromEntries(['f', 'e', 'd'].map((c) => [sha(c), [reviewStatus('pending', hoursAgo(100))]])),
    })
    await w.run()
    expect(w.posts).toEqual([])
    expect(w.requests.filter((r) => r.url.includes('/statuses'))).toEqual([])
  })

  it("ST-46/AC-4: a finding on main keeps today's title; one on a release branch names the branch", async () => {
    const w = world({
      commits: [commit(sha('1'))],
      branches: { [R1]: [commit(sha('2'))] },
    })
    await w.run()
    expect(titlesOpened(w)).toEqual([
      `Inspection: ${sha('1').slice(0, 7)} on main without a pull request`,
      `Inspection: ${sha('2').slice(0, 7)} on ${R1} without a pull request`,
    ])
  })

  it("ST-46/AC-4: every finding's body names the branch it is about", async () => {
    const w = world({
      commits: [commit(sha('1'))],
      branches: { [R1]: [commit(sha('2')), commit(sha('3'))], [R2]: [] },
      pulls: { [sha('3')]: [mergedPull(7, sha('b'), hoursAgo(1), into(R1))] },
      statuses: { [sha('b')]: [], [sha('d')]: [reviewStatus('pending', hoursAgo(30))], [sha('e')]: [reviewStatus('success', hoursAgo(30))] },
      open: [openPull(8, sha('d'), into(R1)), openPull(9, sha('e'), into(R2))],
    })
    await w.run()
    expect(titlesOpened(w)).toEqual([
      mainTitle('1'),
      relTitle('2', R1),
      'Inspection: #7 merged without a passing verdict',
      `Inspection: #8 pending at ${sha('d').slice(0, 7)}`,
      `Inspection: #9 holding at ${sha('e').slice(0, 7)}`,
    ])
    const bodies = issueBodies(w)
    expect(bodies[0]).toContain('is on `main`')
    expect(bodies[0]).not.toContain('release/')
    expect(bodies[1]).toContain(`is on \`${R1}\``)
    expect(bodies[1]).toContain(`\`main\` or \`${R1}\``)
    expect(bodies[2]).toContain(`merged into \`${R1}\``)
    expect(bodies[3]).toContain(`into \`${R1}\``)
    expect(bodies[4]).toContain(`into \`${R2}\``)
  })

  it('ST-46/AC-4: a body about main still names main', async () => {
    const merge = mergeWorld([reviewStatus('failure', hoursAgo(3))])
    await merge.run()
    expect(issueBodies(merge)[0]).toContain('merged into `main`')
    const stall = world({ open: [openPull(5, sha('f'))], statuses: { [sha('f')]: [reviewStatus('pending', hoursAgo(30))] } })
    await stall.run()
    expect(issueBodies(stall)[0]).toContain('into `main`')
  })

  it('ST-46/AC-5: the builders refuse a branch that is not main or a release branch', () => {
    for (const bad of ['other', 'release/next', 'release/v1.2', '']) {
      expect(() => buildListBranchCommits(REPO, bad, iso(NOW))).toThrow(/branch must be/)
      expect(() => buildListOpenPullRequests(REPO, 1, bad)).toThrow(/branch must be/)
    }
  })

  it('ST-46/AC-5: every request a run makes over release branches is allowed by assertAllowedRequest', async () => {
    const w = world({
      commits: [commit(sha('1'))],
      branches: { [R1]: [commit(sha('2'))], 'release/v1.2': [] },
      open: [openPull(8, sha('d'), into(R1))],
      statuses: { [sha('d')]: [reviewStatus('pending', hoursAgo(30))] },
    })
    await w.run()
    expect(w.requests.some((r) => r.url.includes('release%2Fv1.2.3'))).toBe(true)
    for (const request of w.requests) expect(() => assertAllowedRequest(REPO, request), request.url).not.toThrow()
  })

  it("ST-46/AC-5: inspection.yml's permissions are the four they were", () => {
    const text = readFileSync(path.join(ROOT, '.github', 'workflows', 'inspection.yml'), 'utf8')
    const block = text.match(/^permissions:\n([\s\S]*?)\n\njobs:/m)[1]
    expect(block.split('\n').filter((l) => !l.trim().startsWith('#')).map((l) => l.trim())).toEqual([
      'contents: read',
      'pull-requests: read',
      'statuses: read',
      'issues: write',
    ])
  })

  it('ST-46/AC-6: the words say inspection checks release branches as it checks main', () => {
    const read = (...p) => readFileSync(path.join(ROOT, ...p), 'utf8')
    expect(read('scripts', 'dispatch', 'inspect.mjs').slice(0, 2500)).toMatch(/release branch/)
    expect(read('.github', 'workflows', 'inspection.yml').slice(0, 800)).toMatch(/release branch/)
    expect(read('docs', 'glossary.md').match(/- \*\*inspection\*\*[\s\S]*?\n- \*\*flight log/)[0]).toMatch(/release branch/)
    const outline = read('docs', 'outline.md')
    const offers = outline.slice(outline.indexOf('It offers inspection'), outline.indexOf('Where GitHub offers no branch protection'))
    expect(offers).toMatch(/release branch/)
    expect(read('README.md')).toMatch(/inspect[^\n]*release branch/)
  })

  it('ST-46/AC-7: no marker names ST-46', () => {
    const text = readFileSync(path.join(ROOT, 'docs', 'agent-workflow-design.md'), 'utf8')
    expect(text.replace(/\s+/g, ' ')).not.toMatch(/Planned \([^)]*ST-46/)
  })
})
