// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { coderLineNames, coderModelToken } from './choices.mjs'
import { handoffBranch } from './handoff-coder.mjs'
import { composeHandoffBody, neutralizeClosing, publishHandoff, PUBLISH_FAILURES } from './handoff-publish.mjs'
import { handoffsPath, main as handoff } from './handoff.mjs'
import { main as project } from './project.mjs'
import { chooseReviewer, coderModelsRan, reviewerCandidates } from './review.mjs'
import { fixtureSettings, fixtureUserConfig } from './settings-fixture.mjs'
import { findUnitLink } from './unit.mjs'

const REPO = 'acme/widgets'
const PLAN = 'docs/plan.md'

// Each activation clones a real repository.
vi.setConfig({ testTimeout: 60_000 })

// Every test runs in a temporary home and in temporary repositories whose `origin` is a local bare
// repository, with a stand-in for GitHub that answers an Issue from a table and records each
// request it is sent: the real `~/.steward/` is never read or written, no model starts and nothing
// reaches GitHub.
let base
const GIT_ENV = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']
const savedEnv = {}
beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 'steward-publish-'))
  for (const name of GIT_ENV) savedEnv[name] = process.env[name]
  const globalConfig = path.join(base, 'gitconfig')
  writeFileSync(globalConfig, '[user]\n\tname = Crew\n\temail = crew@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = globalConfig
  process.env.GIT_CONFIG_NOSYSTEM = '1'
})
afterAll(() => {
  for (const name of GIT_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedEnv[name]
  }
  rmSync(base, { recursive: true, force: true })
})

let counter = 0
const fresh = (name) => {
  const dir = path.join(base, `${name}-${++counter}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const put = (dir, files) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), text)
  }
}

/** A world: a home with `REPO` activated, its bare origin, and a stand-in for GitHub. */
async function makeWorld({ unitLinks = ['file', 'issue'] } = {}) {
  const dir = fresh('repo')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'remote', 'add', 'origin', `https://github.com/${REPO}.git`)
  put(dir, {
    'steward.config.json': `${JSON.stringify(fixtureSettings({ repo: REPO, unitLinks }), null, 2)}\n`,
    'REVIEW.md': '# Checklist\n\n## Every pull request\n\n1. The diff matches its description.\n',
    '.github/workflows/review-gate.yml': 'name: review-gate\n',
    [PLAN]: '# Plan\n\nAdd a greeting.\n',
  })
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'start')
  const bare = fresh('origin')
  git(bare, 'init', '-q', '--bare', '-b', 'main')
  git(dir, 'push', '-q', bare, 'main')
  const home = fresh('home')
  const code = await project(['activate', dir], { cwd: base, homedir: home, cloneUrl: () => bare, out: () => {}, err: () => {} })
  expect(code).toBe(0)
  const world = { home, bare, issues: new Map(), requests: [], failPr: null, clock: 0 }
  world.createContext = ({ repo }) => ({
    repo,
    async send(request) {
      world.requests.push(request)
      if (request.method === 'POST' && request.url.endsWith('/pulls')) {
        if (world.failPr !== null) throw new Error(world.failPr)
        return { number: 41, html_url: `https://github.com/${repo}/pull/41`, head: { sha: 'f'.repeat(40) } }
      }
      const found = world.issues.get(Number(/\/issues\/(\d+)$/.exec(request.url)?.[1]))
      if (request.method !== 'GET' || found === undefined) throw new Error(`${request.method} ${request.url} failed: 404 Not Found`)
      return found
    },
  })
  return world
}

const approve = async (world, args) => {
  const err = []
  const code = await handoff(['add', '--repo', REPO, ...args], {
    homedir: world.home, now: () => new Date(Date.UTC(2026, 10, 10, 12, 0, ++world.clock)),
    createContext: world.createContext, out: () => {}, err: (l) => err.push(l),
  })
  expect(err.join('\n')).toBe('')
  expect(code).toBe(0)
  return JSON.parse(readFileSync(handoffsPath(world.home), 'utf8')).handoffs.at(-1)
}
const issueJson = (number, title, body) => ({ number, title, body })

/** Commits on `origin`'s `main` (a null text deletes the file). */
function commitOnMain(world, files) {
  const scratch = fresh('scratch')
  git(scratch, 'clone', '-q', world.bare, '.')
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) rmSync(path.join(scratch, rel))
    else put(scratch, { [rel]: text })
  }
  git(scratch, 'add', '-A')
  git(scratch, 'commit', '-q', '-m', 'more')
  git(scratch, 'push', '-q', 'origin', 'main')
}

/** Pushes the handoff's branch as the coder's work, with `files` on it; resolves its head SHA. */
function pushBranch(world, record, files = { 'greeting.txt': 'hello\n' }, { move } = {}) {
  const branch = handoffBranch(record)
  const scratch = fresh('work')
  git(scratch, 'clone', '-q', world.bare, '.')
  git(scratch, 'checkout', '-q', '-b', branch)
  put(scratch, files)
  if (move) git(scratch, 'mv', move[0], move[1])
  git(scratch, 'add', '-A')
  git(scratch, 'commit', '-q', '-m', 'work')
  git(scratch, 'push', '-q', 'origin', branch)
  return git(scratch, 'rev-parse', 'HEAD')
}

const CODER_BODY = [
  '### What changed',
  '',
  'It greets.',
  '',
  '### Verification',
  '',
  'npm test -- 12 passing in 3.1s',
].join('\n')

/** What `executeHandoff` resolves for a pushed branch. */
const pushedOf = (record, headSha, extra = {}) => ({
  status: 'pushed', repo: record.repo, handoffId: record.id, version: record.version,
  branch: handoffBranch(record), headSha, pushed: true,
  choice: { name: 'sonnet', tool: 'claude', model: 'claude-sonnet-4-5', effort: 'medium', why: 'default' },
  proposedPr: { title: 'Add a greeting', body: CODER_BODY, draft: false },
  ...extra,
})

const publish = (world, pushed, extra = {}) => publishHandoff({
  pushed, homedir: world.home, now: () => new Date(Date.UTC(2026, 10, 10, 13, 0, 0)), createContext: world.createContext, ...extra,
})
const prRequests = (world) => world.requests.filter((r) => r.method === 'POST')
const sentBody = (world) => prRequests(world).at(-1).body

/** A file handoff of `PLAN` with its branch pushed. */
async function fileCase(options) {
  const world = await makeWorld(options)
  const record = await approve(world, ['--file', PLAN])
  const head = pushBranch(world, record)
  return { world, record, head, pushed: pushedOf(record, head) }
}
/** An Issue handoff of #7 with its branch pushed. */
async function issueCase(options) {
  const world = await makeWorld(options)
  world.issues.set(7, issueJson(7, 'Greet the user', 'Say hello.'))
  const record = await approve(world, ['--issue', '7'])
  const head = pushBranch(world, record)
  return { world, record, head, pushed: pushedOf(record, head) }
}

describe('publishHandoff', () => {
  it('ST-92/AC-1, AC-2, AC-4, AC-6, AC-8: a file handoff is published ready against main, with the original path, no closing reference and the literal model', async () => {
    const { world, record, head, pushed } = await fileCase()
    const result = await publish(world, pushed)
    expect(result).toMatchObject({
      status: 'published', handoffId: record.id, branch: pushed.branch, headSha: head, draft: false, discrepancy: null,
      pr: { number: 41 }, unit: PLAN, coder: { tool: 'claude', choice: 'sonnet', model: 'claude-sonnet-4-5' },
    })
    expect(prRequests(world)).toHaveLength(1)
    const sent = sentBody(world)
    expect(sent).toMatchObject({ base: 'main', head: pushed.branch, draft: false, title: 'Add a greeting' })
    expect(findUnitLink(sent.body, ['file', 'issue'])).toEqual({ kind: 'link', type: 'file', target: PLAN })
    expect(sent.body.startsWith(`Unit: ${PLAN}\n`)).toBe(true)
    expect(sent.body).not.toMatch(/\bcloses?\b/i)
    // The coder's sections and its actual verification statement are kept.
    expect(sent.body).toContain('npm test -- 12 passing in 3.1s')
    // AC-4: the handoff, the approved revision, the path and the approved full main SHA.
    expect(sent.body).toContain(`${record.id}, approved revision 1`)
    expect(sent.body).toContain(`file ${PLAN}, approved as it stood at \`main\` ${record.provenance.commit}`)
    expect(sent.body).toContain(`steward handoff show ${record.id}`)
    expect(sent.body).toMatch(/provenance, not the reviewer's source of truth/)
    // AC-6: the last line, the literal model; the tool and the choice are provenance beside it.
    expect(sent.body.endsWith('\n\nCoder: model=claude-sonnet-4-5')).toBe(true)
    expect(sent.body).toContain('tool claude, choice "sonnet", model claude-sonnet-4-5')
    expect(coderLineNames(sent.body)).toEqual(['model=claude-sonnet-4-5'])
  })

  it('ST-92/AC-2: a file moved on the coder branch is still named by its original path on main', async () => {
    const world = await makeWorld()
    const record = await approve(world, ['--file', PLAN])
    const head = pushBranch(world, record, {}, { move: [PLAN, 'docs/done-plan.md'] })
    const body = `Unit: docs/done-plan.md\n\n${CODER_BODY}`
    const result = await publish(world, pushedOf(record, head, { proposedPr: { title: 'T', body, draft: false } }))
    expect(result.status).toBe('published')
    const sent = sentBody(world).body
    expect(findUnitLink(sent, ['file'])).toEqual({ kind: 'link', type: 'file', target: PLAN })
    expect(sent).not.toContain('done-plan')
  })

  it('ST-92/AC-2, AC-3, AC-8: an Issue handoff gets one Unit: #n and one matching Closes #n, whatever the coder wrote', async () => {
    const { world, record, pushed } = await issueCase()
    const coder = [
      'Unit: #9', 'unit: #8', '  Unit: docs/other.md', '', 'Closes #9', 'fixes #7', 'Resolved: #8', 'Fixes acme/gadgets#3',
      'Closes https://github.com/acme/widgets/issues/5', 'closes GH-4', 'Prefix-closes #5 is still changed', '',
      CODER_BODY, 'Never closes the loop.',
    ].join('\n')
    const result = await publish(world, { ...pushed, proposedPr: { title: 'T', body: coder, draft: false } })
    expect(result.status).toBe('published')
    const sent = sentBody(world).body
    expect(findUnitLink(sent, ['file', 'issue'])).toEqual({ kind: 'link', type: 'issue', target: 7 })
    expect(sent.startsWith('Unit: #7\nCloses #7\n')).toBe(true)
    expect([...sent.matchAll(/(?<!\w)(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\b[ \t:]+(?:\S*#\d+|GH-\d+|https?:\/\/\S+)/gi)].map((m) => m[0])).toEqual(['Closes #7'])
    expect(sent).toContain('Refs #9')
    expect(sent).toContain('Refs acme/gadgets#3')
    expect(sent).toContain('Prefix-Refs #5 is still changed')
    expect(sent).toContain('Never closes the loop.')
    expect(sent).toContain('npm test -- 12 passing in 3.1s')
    expect(sent).not.toMatch(/^ *unit: (#[89]|docs)/im)
    // AC-4: the number and the approved fingerprint, and no second link.
    expect(sent).toContain(`Issue #7, approved with the title and body fingerprint (sha256) ${record.provenance.fingerprint}`)
    // Without the issue kind in unitLinks the reviewer would not read a closing reference at all;
    // the one ATC writes is still the only one.
    expect(findUnitLink(sent, ['issue'])).toEqual({ kind: 'link', type: 'issue', target: 7 })
  })

  it('ST-92/AC-3: a Unit: line in the coder body is dropped even when the body is only that', async () => {
    const { world, pushed } = await fileCase()
    const result = await publish(world, { ...pushed, proposedPr: { title: 'T', body: 'Unit: none\nDone.', draft: false } })
    expect(result.status).toBe('published')
    expect(findUnitLink(sentBody(world).body, ['file'])).toEqual({ kind: 'link', type: 'file', target: PLAN })
  })

  it('ST-92/AC-3: attribution the coder wrote is kept, and none is added', async () => {
    const { world, pushed } = await fileCase()
    const attributed = `${CODER_BODY}\n\nGenerated with SomeTool\nCo-Authored-By: Someone <s@example.com>`
    await publish(world, { ...pushed, proposedPr: { title: 'T', body: attributed, draft: false } })
    const kept = sentBody(world).body
    expect(kept).toContain('\nGenerated with SomeTool\nCo-Authored-By: Someone <s@example.com>\n')
    const none = await fileCase()
    await publish(none.world, none.pushed)
    expect(sentBody(none.world).body).not.toMatch(/generated with|co-authored-by|🤖/i)
  })

  it('ST-92/AC-3, AC-6: the coder\'s own Coder: lines are never trusted', async () => {
    const { world, pushed } = await fileCase()
    const body = `${CODER_BODY}\nCoder: opus\n\nCoder: model=fake`
    await publish(world, { ...pushed, proposedPr: { title: 'T', body, draft: false } })
    const sent = sentBody(world).body
    expect(sent.match(/^Coder:.*$/gm)).toEqual(['Coder: model=claude-sonnet-4-5'])
  })

  it('ST-92/AC-5: the coder\'s draft choice is honoured when the source is unchanged', async () => {
    const { world, pushed } = await fileCase()
    const result = await publish(world, { ...pushed, proposedPr: { title: 'T', body: CODER_BODY, draft: true } })
    expect(result).toMatchObject({ status: 'published', draft: true, discrepancy: null })
    expect(sentBody(world).draft).toBe(true)
    expect(sentBody(world).body).not.toContain('Handoff discrepancy')
  })

  it('ST-92/AC-5, AC-8: a changed file is published as a draft with a discrepancy, even when the coder said ready', async () => {
    const { world, record, pushed } = await fileCase()
    commitOnMain(world, { [PLAN]: '# Plan\n\nAdd a farewell instead.\n' })
    const result = await publish(world, pushed)
    expect(result).toMatchObject({ status: 'published', draft: true, discrepancy: { kind: 'changed' } })
    const sent = sentBody(world)
    expect(sent.draft).toBe(true)
    expect(sent.body).toContain('## Handoff discrepancy')
    expect(sent.body).toContain(`The source of ${record.id} no longer has the text approved as version 1`)
    expect(findUnitLink(sent.body, ['file', 'issue'])).toEqual({ kind: 'link', type: 'file', target: PLAN })
    expect(sent.body).toContain(`file ${PLAN}, approved as it stood at \`main\` ${record.provenance.commit}`)
  })

  it('ST-92/AC-5, AC-8: an unreadable file is a draft with a discrepancy that says it could not be compared', async () => {
    const { world, pushed } = await fileCase()
    commitOnMain(world, { [PLAN]: null })
    const result = await publish(world, pushed)
    expect(result).toMatchObject({ status: 'published', draft: true, discrepancy: { kind: 'unreadable' } })
    expect(sentBody(world).body).toContain('could not be compared with the text approved as version 1')
  })

  it('ST-92/AC-2, AC-5, AC-8: a changed Issue is a draft pull request that still carries the one matching Closes #n', async () => {
    const { world, pushed } = await issueCase()
    world.issues.set(7, issueJson(7, 'Greet the user', 'Say hello, and wave.'))
    const result = await publish(world, pushed)
    expect(result).toMatchObject({ status: 'published', draft: true, discrepancy: { kind: 'changed' } })
    const sent = sentBody(world)
    expect(sent.draft).toBe(true)
    expect(sent.body.startsWith('Unit: #7\nCloses #7\n')).toBe(true)
    expect(findUnitLink(sent.body, ['file', 'issue'])).toEqual({ kind: 'link', type: 'issue', target: 7 })
    expect(sent.body.match(/^Closes #\d+$/gm)).toEqual(['Closes #7'])
  })

  it('ST-92/AC-5, AC-8: an unreadable Issue is a draft with a discrepancy; a reason that names a closing keyword is neutralized', async () => {
    const { world, pushed } = await issueCase()
    world.issues.delete(7)
    const result = await publish(world, pushed)
    expect(result).toMatchObject({ status: 'published', draft: true, discrepancy: { kind: 'unreadable' } })
    expect(findUnitLink(sentBody(world).body, ['file', 'issue'])).toEqual({ kind: 'link', type: 'issue', target: 7 })
    expect(neutralizeClosing('GitHub said: Fixes #3, resolved #4 and closed owner/name#5')).toBe('GitHub said: Refs #3, Refs #4 and Refs owner/name#5')
  })

  it('ST-92/AC-2, AC-8: publication is refused when the project\'s current unitLinks no longer take the unit\'s kind', async () => {
    const { world, record, head, pushed } = await issueCase()
    commitOnMain(world, { 'steward.config.json': `${JSON.stringify(fixtureSettings({ repo: REPO, unitLinks: ['file'] }), null, 2)}\n` })
    const result = await publish(world, pushed)
    expect(result).toMatchObject({ status: 'unit-link-refused', recoverable: true, handoffId: record.id, branch: pushed.branch, headSha: head })
    expect(result.reason).toContain('no longer include "issue"')
    expect(prRequests(world)).toHaveLength(0)
  })

  it('ST-92/AC-3, AC-7: a file path the reviewer would not read as a file link is refused as ambiguous', async () => {
    const world = await makeWorld()
    commitOnMain(world, { 'docs/my plan.md': 'Plan with a space.\n' })
    const record = await approve(world, ['--file', 'docs/my plan.md'])
    const head = pushBranch(world, record)
    const result = await publish(world, pushedOf(record, head))
    expect(result).toMatchObject({ status: 'unit-link-ambiguous', recoverable: true, handoffId: record.id, headSha: head })
    expect(prRequests(world)).toHaveLength(0)
  })

  it('ST-92/AC-1, AC-7, AC-8: a remote branch that moved refuses publication and names the existing branch', async () => {
    const { world, record, head, pushed } = await fileCase()
    const scratch = fresh('moved')
    git(scratch, 'clone', '-q', '--branch', pushed.branch, world.bare, '.')
    put(scratch, { 'more.txt': 'more\n' })
    git(scratch, 'add', '-A')
    git(scratch, 'commit', '-q', '-m', 'someone else')
    git(scratch, 'push', '-q', 'origin', pushed.branch)
    const moved = git(scratch, 'rev-parse', 'HEAD')
    const result = await publish(world, pushed)
    expect(result).toMatchObject({ status: 'head-moved', recoverable: true, handoffId: record.id, branch: pushed.branch, headSha: head, remoteHead: moved })
    expect(result.reason).toContain(pushed.branch)
    expect(world.requests).toHaveLength(0)
  })

  it('ST-92/AC-1, AC-7: a branch that is gone from the remote refuses publication', async () => {
    const { world, pushed } = await fileCase()
    git(world.bare, 'update-ref', '-d', `refs/heads/${pushed.branch}`)
    const result = await publish(world, pushed)
    expect(result).toMatchObject({ status: 'head-moved', remoteHead: null, branch: pushed.branch })
    expect(world.requests).toHaveLength(0)
  })

  it('ST-92/AC-1, AC-7: a remote that cannot be asked refuses publication, recoverably', async () => {
    const { world, pushed } = await fileCase()
    const result = await publish(world, pushed, { remoteTip: async () => { throw new Error('network down') } })
    expect(result).toMatchObject({ status: 'head-unverified', recoverable: true, headSha: pushed.headSha })
    expect(world.requests).toHaveLength(0)
  })

  it('ST-92/AC-1: a result that is not ST-91\'s pushed result, or names another handoff, branch or version, is refused', async () => {
    const { world, record, pushed } = await fileCase()
    for (const bad of [
      { ...pushed, status: 'push-failed' }, { ...pushed, headSha: 'abc' }, { ...pushed, branch: undefined }, undefined,
    ]) {
      expect((await publish(world, bad)).status).toBe('not-a-pushed-result')
    }
    for (const bad of [
      { ...pushed, handoffId: 'H-99' }, { ...pushed, version: 2 }, { ...pushed, repo: 'acme/other' }, { ...pushed, branch: 'handoff/H-1-elsewhere' },
    ]) {
      expect(await publish(world, bad)).toMatchObject({ status: 'handoff-mismatch', recoverable: true })
    }
    expect(record.id).toBe(pushed.handoffId)
    expect(world.requests).toHaveLength(0)
  })

  it('ST-92/AC-1: a records file that cannot be read is a recoverable refusal', async () => {
    const { world, pushed } = await fileCase()
    writeFileSync(handoffsPath(world.home), '{ not json')
    expect(await publish(world, pushed)).toMatchObject({ status: 'records-unreadable', recoverable: true })
    expect(world.requests).toHaveLength(0)
  })

  it('ST-92/AC-6, AC-8: a model identifier that would make the Coder: line ambiguous refuses publication with the work kept', async () => {
    const { world, record, head, pushed } = await fileCase()
    for (const model of ['a,b', 'a\nb', 'a b', 'a\rb', '', ' lead', 'tab\tx', undefined, 7]) {
      const result = await publish(world, { ...pushed, choice: { ...pushed.choice, model } })
      expect(result).toMatchObject({ status: 'bad-model-id', recoverable: true, handoffId: record.id, branch: pushed.branch, headSha: head })
    }
    expect(world.requests).toHaveLength(0)
    expect(git(world.bare, 'rev-parse', `refs/heads/${pushed.branch}`)).toBe(head)
    expect(coderModelToken('claude-opus-4-1[1m]')).toBe('model=claude-opus-4-1[1m]')
    expect(coderModelToken('gpt-6.1-sol')).toBe('model=gpt-6.1-sol')
  })

  it('ST-92/AC-7, AC-8: malformed coder output is a recoverable failure', async () => {
    const { world, record, head, pushed } = await fileCase()
    for (const proposedPr of [
      undefined, { title: '', body: 'b', draft: false }, { title: 'T', body: '   ', draft: false },
      { title: 'T', body: 'b', draft: 'no' }, { title: 7, body: 'b', draft: false }, { title: 'T', body: undefined, draft: false },
    ]) {
      const result = await publish(world, { ...pushed, proposedPr })
      expect(result).toMatchObject({ status: 'pr-invalid', recoverable: true, handoffId: record.id, branch: pushed.branch, headSha: head })
    }
    expect(world.requests).toHaveLength(0)
  })

  it('ST-92/AC-7, AC-8: a GitHub error is a recoverable failure, the branch stays and nothing is retried', async () => {
    const { world, record, head, pushed } = await fileCase()
    world.failPr = 'POST /pulls failed: 422 Validation Failed'
    const result = await publish(world, pushed)
    expect(result).toMatchObject({ status: 'publish-failed', recoverable: true, handoffId: record.id, branch: pushed.branch, headSha: head })
    expect(result.reason).toContain('422')
    expect(prRequests(world)).toHaveLength(1)
    expect(git(world.bare, 'rev-parse', `refs/heads/${pushed.branch}`)).toBe(head)
  })

  it('ST-92/AC-7: every failure status is listed', () => {
    expect(PUBLISH_FAILURES).toContain('head-moved')
    expect(new Set(PUBLISH_FAILURES).size).toBe(PUBLISH_FAILURES.length)
  })

  it('ST-92/AC-3, AC-4: the composed body has one unit link and no second one from its provenance', () => {
    const handoff = { id: 'H-3', version: 2, source: { kind: 'issue', number: 12 }, provenance: { fingerprint: 'ab'.repeat(32) } }
    const body = composeHandoffBody({
      handoff, proposedPr: { body: 'Done.' }, coder: { tool: 'codex', choice: 'gpt', model: 'gpt-6.1-sol' }, discrepancy: null, token: 'model=gpt-6.1-sol',
    })
    expect(findUnitLink(body, ['file', 'issue'])).toEqual({ kind: 'link', type: 'issue', target: 12 })
    expect(body.split('\n').filter((l) => /^ *Unit:/.test(l))).toEqual(['Unit: #12'])
  })
})

describe('the reviewer reads Coder: lines (ST-92/AC-6)', () => {
  const machine = fixtureUserConfig()
  const found = { kind: 'none' }

  it('ST-92/AC-6: a model= token is the literal model, even when roles.coder.available changed since coding', () => {
    const changed = fixtureUserConfig()
    changed.roles.coder.available.opus.model = 'something-else'
    changed.roles.coder.available.sonnet.model = 'claude-opus-4-1'
    const body = 'Done.\n\nCoder: model=opus'
    expect(coderModelsRan(machine, body, found, null)).toEqual(['opus'])
    expect(coderModelsRan(changed, body, found, null)).toEqual(['opus'])
    // The literal model excludes the reviewer choices that have it, however the choices are named.
    expect(reviewerCandidates(changed, coderModelsRan(changed, body, found, null)).map((c) => c.name)).toEqual(['sonnet'])
    expect(chooseReviewer(changed, coderModelsRan(changed, 'x\nCoder: model=sonnet', found, null))?.name).toBe('opus')
  })

  it('ST-92/AC-6: a choice name is still looked up, as before', () => {
    const changed = fixtureUserConfig()
    changed.roles.coder.available.opus.model = 'gpt-6.1-sol'
    expect(coderModelsRan(changed, 'Coder: opus', found, null)).toEqual(['gpt-6.1-sol'])
    expect(coderModelsRan(machine, 'Coder: sonnet, opus', found, null)).toEqual(['sonnet', 'opus'])
    expect(coderModelsRan(machine, 'Coder: not-a-choice', found, null)).toEqual(['not-a-choice'])
    expect(coderModelsRan(machine, 'Coder: sonnet, model=claude-x', found, null)).toEqual(['sonnet', 'claude-x'])
  })
})
