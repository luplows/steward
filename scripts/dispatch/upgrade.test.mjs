// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fillPin, GATE_WORKFLOWS, INSPECTION_WORKFLOW } from './init.mjs'
import { describePin, main, MIGRATIONS, parseFlags, planConfig, pullTitle, STEWARD_REPO } from './upgrade.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO = 'acme/widgets'
const ORIGIN_URL = `https://github.com/${REPO}.git`
const TEMPLATES = path.join(ROOT, 'templates')

// steward's own history, as GitHub answers for it in these tests: oldest first.
const C_0B1D = '0b1d8b3ae9fd295506fa0af39b7e19bab207e430' // v0.1.0's commit
const C_935F = '935fb5b81398420acd5e7476d2b94bec94bbad02' // the commit the first clients pin
const C_CAND = 'c0ffee0000000000000000000000000000000001' // a candidate of 0.2.0
const C_LATER = 'c0ffee0000000000000000000000000000000002' // a later commit, tagged v0.2.0
const C_BRANCH = 'c0ffee0000000000000000000000000000000003' // on a release branch, diverged from the line above
const C_DEV = 'c0ffee0000000000000000000000000000000004' // main, version 0.0.0
const LINE = [C_935F, C_0B1D, C_CAND, C_DEV, C_LATER]

vi.setConfig({ testTimeout: 60_000 })

let base
const GIT_ENV = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']
const savedEnv = {}
beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 'steward-upgrade-'))
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
const template = (file) => readFileSync(path.join(TEMPLATES, 'workflows', file), 'utf8')
const settings = (overrides = {}) =>
  `${JSON.stringify({ repo: REPO, setup: null, check: null, landWhen: 'all-checks', land: false, unitLinks: ['file', 'issue'], rulesFile: 'REVIEW.md', inspectAfterHours: 24, ...overrides }, null, 2)}\n`
const workflowsAt = (pin, files = [...GATE_WORKFLOWS]) =>
  Object.fromEntries(files.map((file) => [`.github/workflows/${file}`, fillPin(template(file), pin)]))

/**
 * A project whose `origin` is a local bare repository holding `main` with `files`, and GitHub's
 * answers for it and for steward, injected as `fetch`. `steward` describes steward's history:
 * `versions` (commit to package.json version), `tags` (tag to commit, `annotated` ones through a tag
 * object), `templates` (commit to files overriding the real templates; `null` removes one),
 * `order` (the line of history; any commit outside it is diverged from it). Records every request.
 */
function world({ pin = 'v0.1.0', files = {}, inspection = false, config = settings(), rules, pullStatus = 201, openPulls = [], steward = {}, withoutDefaults = [] } = {}) {
  const dir = fresh('project')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'remote', 'add', 'origin', ORIGIN_URL)
  const all = {
    ...workflowsAt(pin, inspection ? [...GATE_WORKFLOWS, INSPECTION_WORKFLOW] : [...GATE_WORKFLOWS]),
    'steward.config.json': config,
    'REVIEW.md': rules ?? readFileSync(path.join(TEMPLATES, 'review-checklist.md'), 'utf8'),
    'README.md': 'widgets\n',
    ...files,
  }
  for (const rel of withoutDefaults) delete all[rel]
  for (const [rel, text] of Object.entries(all)) {
    if (text === null) continue
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), text)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'start')
  const bare = fresh('origin')
  git(bare, 'init', '-q', '--bare', '-b', 'main')
  git(dir, 'push', '-q', bare, 'main')
  const versions = { [C_935F]: '0.0.0', [C_0B1D]: '0.1.0', [C_CAND]: '0.2.0', [C_LATER]: '0.2.0', [C_BRANCH]: '0.2.0', [C_DEV]: '0.0.0', ...steward.versions }
  const tags = { 'v0.1.0': { sha: C_0B1D }, 'v0.2.0': { sha: C_LATER }, 'v0.2.1': { sha: C_LATER, annotated: true }, ...steward.tags }
  const overrides = steward.templates ?? {}
  const order = steward.order ?? LINE
  const requests = []
  const reply = (status, content) => ({ status, text: async () => (content === undefined ? '' : JSON.stringify(content)) })
  const encode = (text) => ({ type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') })
  const fetch = async (url, init) => {
    const match = /\/repos\/([^/]+\/[^/?]+)(\/[^?]*)?(\?.*)?$/.exec(url)
    const [, repo, rest = '', query = ''] = match
    requests.push({ method: init.method, repo, rest, query, body: init.body === undefined ? undefined : JSON.parse(init.body) })
    if (repo === STEWARD_REPO) {
      if (init.method !== 'GET') return reply(405, { message: 'no' })
      let m
      if ((m = /^\/git\/ref\/tags\/(.+)$/.exec(rest))) {
        const tag = tags[m[1]]
        if (!tag) return reply(404, { message: 'Not Found' })
        return reply(200, { object: tag.annotated ? { type: 'tag', sha: `a${tag.sha.slice(1)}` } : { type: 'commit', sha: tag.sha } })
      }
      if ((m = /^\/git\/tags\/(.+)$/.exec(rest))) {
        const tag = Object.values(tags).find((t) => `a${t.sha.slice(1)}` === m[1])
        return tag ? reply(200, { object: { type: 'commit', sha: tag.sha } }) : reply(404, { message: 'Not Found' })
      }
      if ((m = /^\/commits\/(.+)$/.exec(rest))) return versions[m[1]] === undefined ? reply(422, { message: 'No commit found' }) : reply(200, { sha: m[1] })
      if ((m = /^\/compare\/(.+)\.\.\.(.+)$/.exec(rest))) {
        const [a, b] = [order.indexOf(m[1]), order.indexOf(m[2])]
        const status = m[1] === m[2] ? 'identical' : a === -1 || b === -1 ? 'diverged' : a < b ? 'ahead' : 'behind'
        return reply(200, { status })
      }
      if ((m = /^\/contents\/(.+)$/.exec(rest))) {
        const ref = /ref=(.+)$/.exec(query)[1]
        if (m[1] === 'package.json') return versions[ref] === undefined ? reply(404, {}) : reply(200, encode(JSON.stringify({ name: 'steward', version: versions[ref] })))
        const file = path.posix.basename(m[1])
        const over = overrides[ref]?.[file]
        if (over === null) return reply(404, { message: 'Not Found' })
        return reply(200, encode(over ?? template(file)))
      }
      return reply(404, { message: 'Not Found' })
    }
    if (rest === '') return reply(200, { full_name: REPO })
    if (rest.startsWith('/contents/') && init.method === 'GET') {
      try {
        const text = execFileSync('git', ['show', `main:${decodeURIComponent(rest.slice('/contents/'.length))}`], { cwd: bare, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        return reply(200, encode(text))
      } catch {
        return reply(404, { message: 'Not Found' })
      }
    }
    if (rest === '/pulls' && init.method === 'GET') return reply(200, openPulls)
    if (rest === '/pulls' && init.method === 'POST') {
      return pullStatus === 201 ? reply(201, { number: 7, html_url: `https://github.com/${REPO}/pull/7` }) : reply(pullStatus, { message: 'Validation Failed' })
    }
    return reply(404, { message: 'Not Found' })
  }
  return { dir, bare, fetch, requests }
}

const writes = (w) => w.requests.filter((r) => r.method !== 'GET')
const heads = (w) => git(w.bare, 'for-each-ref', '--format=%(refname) %(objectname)')

/** Runs `upgrade` in the project; resolves `{ code, out, err, clone, tmpRoot, opened, w }`. */
async function runUpgrade(args, w, { migrations, cloneUrl, getToken = async () => 'token' } = {}) {
  const out = []
  const err = []
  const tmpRoot = fresh('tmp')
  const code = await main(args, {
    cwd: w.dir,
    fetch: w.fetch,
    getToken,
    tmpRoot,
    cloneUrl: cloneUrl ?? ((url) => {
      if (url !== ORIGIN_URL) throw new Error(`no test mapping for ${url}`)
      return w.bare
    }),
    ...(migrations ? { migrations } : {}),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  })
  const made = readdirSync(tmpRoot).filter((name) => name.startsWith('steward-upgrade-'))
  const clone = made.length === 1 ? path.join(tmpRoot, made[0]) : undefined
  const opened = writes(w).find((r) => r.rest === '/pulls')?.body
  return { code, out: out.join('\n'), err: err.join('\n'), clone, tmpRoot, opened, w }
}

/** Nothing cloned, branched, pushed or opened. */
function expectUntouched(result, refsBefore) {
  expect(result.clone).toBeUndefined()
  expect(readdirSync(result.tmpRoot)).toEqual([])
  expect(writes(result.w)).toEqual([])
  expect(heads(result.w)).toBe(refsBefore)
}

/** The text of `rel` on the pushed branch. */
const onBranch = (w, branch, rel) => git(w.bare, 'show', `${branch}:${rel}`)
const changedFiles = (w, branch) => git(w.bare, 'diff', '--name-only', `main..${branch}`).split('\n').filter((l) => l !== '')

describe('ST-69/AC-1: one draft pull request against main, and nothing else', () => {
  it('ST-69/AC-1: --to prepares a draft pull request against main, reports its URL, and its only write is that pull request', async () => {
    const w = world()
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(0)
    expect(r.out).toContain(`https://github.com/${REPO}/pull/7`)
    expect(writes(w)).toHaveLength(1)
    expect(r.opened).toMatchObject({ base: 'main', draft: true, head: 'steward/upgrade-v0.2.0' })
    expect(r.out).toMatch(/did not merge it, mark it ready, change protection, activate the project or touch any coordinator/)
    expect(git(w.bare, 'rev-parse', 'main')).toBe(git(w.dir, 'rev-parse', 'main'))
    expect(git(w.bare, 'rev-parse', 'refs/heads/steward/upgrade-v0.2.0')).not.toBe(git(w.bare, 'rev-parse', 'main'))
  })

  it('ST-69/AC-1: --ref prepares one too', async () => {
    const w = world()
    const r = await runUpgrade(['--ref', C_CAND], w)
    expect(r.code).toBe(0)
    expect(r.opened).toMatchObject({ base: 'main', draft: true, head: `steward/upgrade-${C_CAND.slice(0, 12)}` })
  })

  it('ST-69/AC-1: it is registered as steward upgrade, and writes nothing in the checkout it ran in', async () => {
    const w = world()
    const before = git(w.dir, 'status', '--porcelain')
    expect((await runUpgrade(['--to', 'v0.2.0'], w)).code).toBe(0)
    expect(git(w.dir, 'status', '--porcelain')).toBe(before)
    expect(git(w.dir, 'branch', '--list')).not.toContain('upgrade')
    const { COMMANDS } = await import('./cli.mjs')
    expect(COMMANDS.upgrade.endsWith(path.join('scripts', 'dispatch', 'upgrade.mjs'))).toBe(true)
  })
})

describe('ST-69/AC-2: the target is checked against steward before anything is cloned', () => {
  async function refused(args, pattern) {
    const w = world()
    const refs = heads(w)
    const r = await runUpgrade(args, w)
    expect(r.code).toBe(2)
    expect(r.err).toMatch(pattern)
    expectUntouched(r, refs)
    return r
  }

  it('ST-69/AC-2: giving both, or neither, is refused', async () => {
    await refused(['--to', 'v0.2.0', '--ref', C_CAND], /exactly one of --to and --ref: both were given \(--to v0\.2\.0, --ref c0ffee/)
    await refused([], /exactly one of --to vX\.Y\.Z and --ref <full SHA>: neither was given/)
  })

  it('ST-69/AC-2: --to must be a tag of the form vX.Y.Z', async () => {
    await refused(['--to', '0.2.0'], /--to 0\.2\.0: must be a tag of the form vX\.Y\.Z/)
    await refused(['--to', 'v0.2'], /--to v0\.2: must be a tag of the form vX\.Y\.Z/)
    await refused(['--to', 'main'], /--to main: must be a tag/)
  })

  it('ST-69/AC-2: --to must name a tag that exists in luplows/steward', async () => {
    await refused(['--to', 'v9.9.9'], /--to v9\.9\.9: there is no tag v9\.9\.9 in luplows\/steward/)
  })

  it('ST-69/AC-2: --ref must be a full SHA: a tag or a short SHA is refused', async () => {
    await refused(['--ref', 'v0.1.0'], /--ref v0\.1\.0: must be a commit's full SHA/)
    await refused(['--ref', C_CAND.slice(0, 7)], new RegExp(`--ref ${C_CAND.slice(0, 7)}: must be a commit's full SHA`))
  })

  it('ST-69/AC-2: --ref must be a commit that exists in luplows/steward', async () => {
    const missing = 'd'.repeat(40)
    await refused(['--ref', missing], new RegExp(`--ref ${missing}: there is no commit ${missing} in luplows/steward`))
  })

  it('ST-69/AC-2: the checks of steward come before the clone: the project is read, not cloned, and no request is a write', async () => {
    const w = world()
    const r = await runUpgrade(['--to', 'v9.9.9'], w)
    expect(r.code).toBe(2)
    expect(w.requests.every((q) => q.method === 'GET')).toBe(true)
  })

  it('ST-69/AC-2: a tag that is annotated is followed to its commit', async () => {
    const w = world({ pin: C_CAND })
    const r = await runUpgrade(['--to', 'v0.2.1'], w)
    expect(r.code).toBe(0)
    expect(w.requests.some((q) => q.rest.startsWith('/git/tags/'))).toBe(true)
    expect(onBranch(w, 'steward/upgrade-v0.2.1', '.github/workflows/review-gate.yml')).toContain('github:luplows/steward#v0.2.1')
  })
})

describe('ST-69/AC-3: the pin written, and what the pull request calls it', () => {
  it('ST-69/AC-3: a tag is written as the tag, and called a release with its version', async () => {
    const w = world()
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    const gate = onBranch(w, 'steward/upgrade-v0.2.0', '.github/workflows/review-gate.yml')
    expect(gate).toContain('github:luplows/steward#v0.2.0 steward')
    expect(r.opened.title).toBe('Upgrade steward to release v0.2.0')
    expect(r.opened.body).toMatch(/- Target: release v0\.2\.0 \(package\.json version 0\.2\.0\)/)
  })

  it('ST-69/AC-3: a commit is written in lower case, and called a candidate of its version, never a release', async () => {
    const w = world()
    const r = await runUpgrade(['--ref', C_CAND.toUpperCase()], w)
    expect(r.code).toBe(0)
    expect(onBranch(w, r.opened.head, '.github/workflows/review-gate.yml')).toContain(`github:luplows/steward#${C_CAND} steward`)
    expect(r.opened.title).toBe(`Upgrade steward to a candidate of 0.2.0 (commit ${C_CAND.slice(0, 12)})`)
    expect(r.opened.title).not.toMatch(/release/i)
    expect(r.opened.body).toMatch(new RegExp(`- Target: commit ${C_CAND}, a candidate of version 0\\.2\\.0`))
    expect(r.opened.body.split('\n').filter((l) => l.startsWith('- Target:')).join('')).not.toMatch(/release/i)
  })

  it('ST-69/AC-3: a commit whose package.json gives 0.0.0 is called a development commit', async () => {
    const w = world()
    const r = await runUpgrade(['--ref', C_DEV], w)
    expect(r.code).toBe(0)
    expect(r.opened.title).toBe(`Upgrade steward to a development commit (${C_DEV.slice(0, 12)})`)
    expect(r.opened.body).toMatch(new RegExp(`- Target: development commit ${C_DEV} \\(package\\.json version 0\\.0\\.0\\)`))
    expect(r.opened.title + r.opened.body.split('\n').filter((l) => l.startsWith('- Target:')).join('')).not.toMatch(/release/i)
  })

  it('ST-69/AC-3: describePin and pullTitle say the same without GitHub', () => {
    expect(describePin({ kind: 'commit', pin: C_CAND, version: '0.3.0' })).toBe(`commit ${C_CAND}, a candidate of version 0.3.0`)
    expect(pullTitle({ kind: 'tag', pin: 'v1.2.3', version: '1.2.3' })).toBe('Upgrade steward to release v1.2.3')
  })
})

describe('ST-69/AC-4: identifying what is installed', () => {
  it('ST-69/AC-4: the same pin is a reported no-op, with no clone, branch or pull request', async () => {
    const w = world({ pin: 'v0.2.0' })
    const refs = heads(w)
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/already on release v0\.2\.0 .*nothing to upgrade/)
    expectUntouched(r, refs)
    const c = world({ pin: C_CAND })
    const again = await runUpgrade(['--ref', C_CAND.toUpperCase()], c)
    expect(again.code).toBe(0)
    expect(again.out).toMatch(/nothing to upgrade/)
    expectUntouched(again, heads(c))
  })

  it('ST-69/AC-4: a tag installed and its own commit given as --ref is a no-op, reported as already on that release', async () => {
    const w = world({ pin: 'v0.1.0' })
    const refs = heads(w)
    const r = await runUpgrade(['--ref', C_0B1D], w)
    expect(r.code).toBe(0)
    expect(r.out).toMatch(new RegExp(`already on release v0\\.1\\.0, whose commit is ${C_0B1D}`))
    expectUntouched(r, refs)
  })

  it('ST-69/AC-4: a commit installed and --to a tag on that same commit changes only the pin', async () => {
    const w = world({ pin: C_LATER, inspection: true })
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(0)
    expect(r.opened.body).toMatch(/Only the pin changes/)
    expect(changedFiles(w, r.opened.head).sort()).toEqual(['.github/workflows/inspection.yml', '.github/workflows/land-approved.yml', '.github/workflows/review-gate.yml'])
    for (const file of [...GATE_WORKFLOWS, INSPECTION_WORKFLOW]) {
      const was = fillPin(template(file), C_LATER)
      expect(onBranch(w, r.opened.head, `.github/workflows/${file}`)).toBe(was.replaceAll(`#${C_LATER}`, '#v0.2.0').trimEnd())
    }
    expect(w.requests.some((q) => q.repo === STEWARD_REPO && q.rest.startsWith('/compare/'))).toBe(false)
  })

  it('ST-69/AC-4: a commit installed and a tag on that same commit leaves the configuration alone even when a migration applies', async () => {
    const migrate = { id: 'M1', explanation: 'adds a key', applies: () => true, migrate: (c) => ({ ...c, extra: 1 }) }
    const w = world({ pin: C_LATER })
    const r = await runUpgrade(['--to', 'v0.2.0'], w, { migrations: [migrate] })
    expect(r.code).toBe(0)
    expect(changedFiles(w, r.opened.head)).not.toContain('steward.config.json')
  })

  it('ST-69/AC-4: a target behind the installed commit is refused as a downgrade', async () => {
    const w = world({ pin: C_LATER })
    const refs = heads(w)
    const r = await runUpgrade(['--ref', C_CAND], w)
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/is behind the installed .*downgrade/)
    expectUntouched(r, refs)
    const t = world({ pin: C_LATER })
    const tag = await runUpgrade(['--to', 'v0.1.0'], t)
    expect(tag.code).toBe(2)
    expect(tag.err).toMatch(/downgrade/)
  })

  it('ST-69/AC-4: a diverged target is upgraded', async () => {
    const w = world({ pin: C_CAND })
    const r = await runUpgrade(['--ref', C_BRANCH], w)
    expect(r.code).toBe(0)
    expect(onBranch(w, r.opened.head, '.github/workflows/review-gate.yml')).toContain(`#${C_BRANCH} steward`)
  })

  it('ST-69/AC-4: a missing managed workflow is refused, naming it', async () => {
    const w = world({ withoutDefaults: ['.github/workflows/land-approved.yml'] })
    const refs = heads(w)
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(2)
    expect(r.err).toContain('.github/workflows/land-approved.yml: missing on main')
    expectUntouched(r, refs)
  })

  it('ST-69/AC-4: a workflow with no reference is refused, naming it', async () => {
    const w = world({ files: { '.github/workflows/review-gate.yml': 'name: gate\n' } })
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(2)
    expect(r.err).toContain('.github/workflows/review-gate.yml: carries no reference to github:luplows/steward#<pin>')
  })

  it('ST-69/AC-4: inconsistent pins are refused, naming each file and its pins', async () => {
    const w = world({ files: { '.github/workflows/land-approved.yml': fillPin(template('land-approved.yml'), C_935F) } })
    const refs = heads(w)
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/carry different pins/)
    expect(r.err).toContain(`land-approved.yml has ${C_935F}`)
    expect(r.err).toContain('review-gate.yml has v0.1.0')
    expectUntouched(r, refs)
  })

  it('ST-69/AC-4: inspection.yml counts when present, and its pin must agree', async () => {
    const w = world({ inspection: true, files: { '.github/workflows/inspection.yml': fillPin(template('inspection.yml'), C_935F) } })
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(2)
    expect(r.err).toContain(`inspection.yml has ${C_935F}`)
  })

  it('ST-69/AC-4: a pin that is not a tag or a commit of steward is refused as unresolvable', async () => {
    for (const pin of ['v9.9.9', 'e'.repeat(40), 'main', 'abc1234']) {
      const w = world({ pin })
      const refs = heads(w)
      const r = await runUpgrade(['--to', 'v0.2.0'], w)
      expect(r.code, pin).toBe(2)
      expect(r.err, pin).toContain(`the pin ${pin} is not a tag (vX.Y.Z) or a full commit SHA that exists in luplows/steward`)
      expectUntouched(r, refs)
    }
  })

  it('ST-69/AC-4: all the findings are named together', async () => {
    const w = world({ withoutDefaults: ['.github/workflows/land-approved.yml'], files: { '.github/workflows/review-gate.yml': 'name: gate\n' } })
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.err).toContain('land-approved.yml: missing on main')
    expect(r.err).toContain('review-gate.yml: carries no reference')
  })
})

describe('ST-69/AC-5: the installed workflows are steward\'s own at the installed pin', () => {
  it('ST-69/AC-5: a customized workflow is refused, naming each one and explaining manual reconciliation', async () => {
    const w = world({
      files: {
        '.github/workflows/review-gate.yml': `${fillPin(template('review-gate.yml'), 'v0.1.0')}# ours\n`,
        '.github/workflows/land-approved.yml': `${fillPin(template('land-approved.yml'), 'v0.1.0')}# ours too\n`,
      },
    })
    const refs = heads(w)
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(2)
    expect(r.err).toContain('.github/workflows/review-gate.yml: differs from')
    expect(r.err).toContain('.github/workflows/land-approved.yml: differs from')
    expect(r.err).toMatch(/Reconcile each by hand/)
    expect(r.err).toMatch(/does not merge them/)
    expectUntouched(r, refs)
  })

  it('ST-69/AC-5: only one customized workflow is named, and a pin or line-ending difference alone is not customization', async () => {
    const w = world({
      files: {
        '.github/workflows/land-approved.yml': `${fillPin(template('land-approved.yml'), 'v0.1.0')}# ours\n`,
        '.github/workflows/review-gate.yml': fillPin(template('review-gate.yml'), 'v0.1.0').replaceAll('\n', '\r\n'),
      },
    })
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(2)
    expect(r.err).toContain('land-approved.yml: differs')
    expect(r.err).not.toContain('review-gate.yml: differs')
  })

  it('ST-69/AC-5: a workflow with no template at the installed pin is refused, naming it', async () => {
    const w = world({ steward: { templates: { [C_0B1D]: { 'land-approved.yml': null } } } })
    const refs = heads(w)
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(2)
    expect(r.err).toContain('.github/workflows/land-approved.yml: steward has no template of that name at v0.1.0')
    expectUntouched(r, refs)
  })

  it('ST-69/AC-5: the template compared is the one at the installed pin, not the target\'s', async () => {
    const w = world({ steward: { templates: { [C_LATER]: { 'review-gate.yml': `${template('review-gate.yml')}# new at the target\n` } } } })
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(0)
    expect(w.requests.filter((q) => q.rest.startsWith('/contents/templates/') && q.query === `?ref=${C_0B1D}`)).toHaveLength(2)
  })
})

describe('ST-69/AC-6: the proposal is the templates at the target pin', () => {
  it('ST-69/AC-6: each workflow is the target\'s template with the target pin filled, and no other file changes', async () => {
    const newGate = `${template('review-gate.yml')}# new at the target\n`
    const w = world({ steward: { templates: { [C_LATER]: { 'review-gate.yml': newGate } } } })
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(0)
    expect(onBranch(w, r.opened.head, '.github/workflows/review-gate.yml')).toBe(`${fillPin(newGate, 'v0.2.0')}`.trimEnd())
    expect(onBranch(w, r.opened.head, '.github/workflows/land-approved.yml')).toBe(fillPin(template('land-approved.yml'), 'v0.2.0').trimEnd())
    expect(changedFiles(w, r.opened.head).sort()).toEqual(['.github/workflows/land-approved.yml', '.github/workflows/review-gate.yml'])
    for (const rel of ['README.md', 'steward.config.json', 'REVIEW.md']) {
      expect(onBranch(w, r.opened.head, rel)).toBe(git(w.bare, 'show', `main:${rel}`))
    }
    expect(onBranch(w, r.opened.head, '.github/workflows/review-gate.yml')).not.toContain('v0.1.0')
  })

  it('ST-69/AC-6: the optional workflow is upgraded when installed and not added when not', async () => {
    const without = world()
    const a = await runUpgrade(['--to', 'v0.2.0'], without)
    expect(changedFiles(without, a.opened.head)).not.toContain('.github/workflows/inspection.yml')
    expect(a.err).toBe('')
    const withIt = world({ inspection: true })
    const b = await runUpgrade(['--to', 'v0.2.0'], withIt)
    expect(onBranch(withIt, b.opened.head, '.github/workflows/inspection.yml')).toContain('github:luplows/steward#v0.2.0')
    expect(changedFiles(withIt, b.opened.head)).toContain('.github/workflows/inspection.yml')
  })

  it('ST-69/AC-6: CRLF workflows keep their line endings', async () => {
    const files = Object.fromEntries(GATE_WORKFLOWS.map((f) => [`.github/workflows/${f}`, fillPin(template(f), 'v0.1.0').replaceAll('\n', '\r\n')]))
    const w = world({ files })
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(0)
    expect(git(w.bare, 'show', `${r.opened.head}:.github/workflows/review-gate.yml`)).toContain('\r\n')
  })

  it('ST-69/AC-6: a template missing at the target is refused, naming the workflow', async () => {
    const w = world({ inspection: true, steward: { templates: { [C_LATER]: { 'inspection.yml': null } } } })
    const refs = heads(w)
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/no template at v0\.2\.0 for \.github\/workflows\/inspection\.yml/)
    expectUntouched(r, refs)
  })

  it('ST-69/AC-6: a target template whose placeholder this version cannot fill is refused, not written', async () => {
    const w = world({ steward: { templates: { [C_LATER]: { 'review-gate.yml': 'run: npx github:luplows/steward#{{OTHER}}\n' } } } })
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/review-gate\.yml: steward's template at v0\.2\.0 cannot be filled/)
    expect(r.clone).toBeUndefined()
  })
})

describe('ST-69/AC-7: the project\'s own configuration', () => {
  it('ST-69/AC-7: land, landWhen, unitLinks and rulesFile are preserved, and the file is not rewritten', async () => {
    const config = settings({ land: true, landWhen: ['ci', 'lint'], unitLinks: ['other'], rulesFile: 'docs/RULES.md', setup: { command: 'npm ci', timeoutMinutes: 3 } })
    const w = world({ config, files: { 'docs/RULES.md': readFileSync(path.join(TEMPLATES, 'review-checklist.md'), 'utf8') } })
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(0)
    expect(onBranch(w, r.opened.head, 'steward.config.json')).toBe(config.trimEnd())
    expect(changedFiles(w, r.opened.head)).not.toContain('steward.config.json')
    expect(r.opened.body).toMatch(/Project-owned changes:\n- none: `steward\.config\.json` and `docs\/RULES\.md` are left as they are\./)
    expect(r.opened.body).toMatch(/`land` is true\); the upgrade did not change it/)
  })

  it('ST-69/AC-7: no migration is registered yet, so a real upgrade proposes no project-owned change', () => {
    expect(MIGRATIONS).toEqual([])
  })

  it('ST-69/AC-7: a migration applies, is explained in the body, and the file is rewritten for it alone', async () => {
    const migration = { id: 'M-example', explanation: 'renames inspectAfterHours to keep its value', applies: (c) => c.inspectAfterHours === 24, migrate: (c) => ({ ...c, inspectAfterHours: 48 }) }
    const w = world()
    const r = await runUpgrade(['--to', 'v0.2.0'], w, { migrations: [migration] })
    expect(r.code).toBe(0)
    expect(JSON.parse(onBranch(w, r.opened.head, 'steward.config.json'))).toMatchObject({ inspectAfterHours: 48, land: false })
    expect(r.opened.body).toContain('- `steward.config.json`: renames inspectAfterHours to keep its value (M-example)')
    expect(changedFiles(w, r.opened.head)).toContain('steward.config.json')
  })

  it('ST-69/AC-7: a decision that belongs to the project is reported, and the config is not guessed at', async () => {
    const migration = { id: 'M-ask', explanation: 'x', applies: () => false, migrate: (c) => c, decision: () => 'Decide whether landWhen should name the new check.' }
    const w = world()
    const r = await runUpgrade(['--to', 'v0.2.0'], w, { migrations: [migration] })
    expect(r.code).toBe(0)
    expect(r.opened.body).toMatch(/Unresolved actions:\n- Decide whether landWhen should name the new check\./)
    expect(changedFiles(w, r.opened.head)).not.toContain('steward.config.json')
  })

  it('ST-69/AC-7: a migration that changes land is refused: an upgrade never changes landing', async () => {
    expect(() => planConfig({ land: false }, [{ id: 'M-land', explanation: 'x', applies: () => true, migrate: (c) => ({ ...c, land: true }) }])).toThrow(/changes land/)
    const w = world()
    const r = await runUpgrade(['--to', 'v0.2.0'], w, { migrations: [{ id: 'M-land', explanation: 'x', applies: () => true, migrate: (c) => ({ ...c, land: true }) }] })
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/M-land changes land/)
    expect(writes(w)).toEqual([])
  })

  it('ST-69/AC-7: the per-user scan interval is not a project key, and the user config is never read', async () => {
    const w = world()
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(0)
    const source = readFileSync(path.join(ROOT, 'scripts', 'dispatch', 'upgrade.mjs'), 'utf8')
    expect(source).not.toMatch(/user-config|\.steward|STEWARD_CONFIG|homedir/)
  })

  it('ST-69/AC-7: a missing steward.config.json is refused', async () => {
    const w = world({ withoutDefaults: ['steward.config.json'] })
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/steward\.config\.json: missing on main/)
  })
})

describe('ST-69/AC-8: the proposed result is validated before it is called ready', () => {
  it('ST-69/AC-8: a configuration the running package does not accept names the file and the reason, and opens nothing', async () => {
    const w = world({ config: `${JSON.stringify({ repo: REPO, land: false })}\n` })
    const refs = heads(w)
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/not reported as validated|is not valid, so it is not reported as validated/)
    expect(r.err).toContain("steward.config.json: missing required key 'setup'")
    expect(r.err).not.toMatch(/steward-upgrade-check/)
    expectUntouched(r, refs)
  })

  it('ST-69/AC-8: invalid rules name the file and each problem', async () => {
    const w = world({ rules: '# Rules\n\n## A section\n\nno numbered item\n' })
    const refs = heads(w)
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(2)
    expect(r.err).toContain('REVIEW.md: ')
    expectUntouched(r, refs)
  })

  it('ST-69/AC-8: the rules file the configuration names must exist on main', async () => {
    const w = world({ config: settings({ rulesFile: 'docs/NOPE.md' }) })
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(2)
    expect(r.err).toContain('docs/NOPE.md: the review rules file is missing on main')
  })

  it('ST-69/AC-8: a result that validates says what was checked, and that the checks do not run the workflows', async () => {
    const w = world()
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.opened.body).toMatch(/Validation:\n- `steward\.config\.json` meets the settings requirements of the steward that ran `steward upgrade`/)
    expect(r.opened.body).toContain("`REVIEW.md` parses with the reviewer's parser")
    expect(r.out).toMatch(/run it from steward installed at the target pin/)
  })
})

describe('ST-69/AC-9: what the pull request names', () => {
  it('ST-69/AC-9: both pins and their kinds, the changed files, the validation, the unresolved actions and the manual steps', async () => {
    const w = world({ pin: C_935F })
    const r = await runUpgrade(['--ref', C_CAND], w)
    const body = r.opened.body
    expect(body).toContain(`from \`${C_935F}\` to \`${C_CAND}\``)
    expect(body).toContain(`- Installed: development commit ${C_935F} (package.json version 0.0.0)`)
    expect(body).toContain(`- Target: commit ${C_CAND}, a candidate of version 0.2.0`)
    expect(body).toMatch(/Managed files changed:\n- `\.github\/workflows\/land-approved\.yml`\n- `\.github\/workflows\/review-gate\.yml`/)
    expect(body).toMatch(/Project-owned changes:\n- none/)
    expect(body).toMatch(/Validation:\n/)
    expect(body).toMatch(/Unresolved actions:\n- none/)
    expect(body).toMatch(/After this pull request merges, by hand:/)
    expect(body).toMatch(/names `c0ffee0000000000000000000000000000000001`/)
    expect(body).toMatch(/stop it, and start it again from steward installed at the target pin/)
  })

  it('ST-69/AC-9: it claims no upgrade has happened, and the project\'s template follows', async () => {
    const w = world({ files: { '.github/pull_request_template.md': 'Unit:\n\n## What changed\n' } })
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.opened.body).toContain('The project is not upgraded until it merges.')
    expect(r.opened.body).not.toMatch(/has been upgraded|was upgraded|already upgraded/)
    expect(r.opened.body.endsWith('Unit:\n\n## What changed\n')).toBe(true)
  })

  it('ST-69/AC-9: several pull request templates need --pr-template, and it must name one of them', async () => {
    const files = { '.github/PULL_REQUEST_TEMPLATE/a.md': 'A\n', '.github/PULL_REQUEST_TEMPLATE/b.md': 'B\n' }
    const w = world({ files })
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/several pull request templates/)
    const ok = await runUpgrade(['--to', 'v0.2.0', '--pr-template', '.github/PULL_REQUEST_TEMPLATE/b.md'], world({ files }))
    expect(ok.code).toBe(0)
    expect(ok.opened.body.endsWith('B\n')).toBe(true)
    const bad = await runUpgrade(['--to', 'v0.2.0', '--pr-template', 'nope.md'], world({ files }))
    expect(bad.code).toBe(2)
    expect(bad.err).toMatch(/--pr-template nope\.md: not one of/)
  })

  it('ST-69/AC-9: the branch is refused when it is main or a release branch, taken on GitHub, or has an open pull request', async () => {
    for (const branch of ['main', 'release/v1.0.0', 'bad..name']) {
      const w = world()
      const r = await runUpgrade(['--to', 'v0.2.0', '--branch', branch], w)
      expect(r.code, branch).toBe(2)
      expect(r.clone, branch).toBeUndefined()
    }
    const taken = world()
    git(taken.dir, 'push', '-q', taken.bare, 'main:refs/heads/steward/upgrade-v0.2.0')
    const t = await runUpgrade(['--to', 'v0.2.0'], taken)
    expect(t.code).toBe(2)
    expect(t.err).toMatch(/already on GitHub/)
    const open = world({ openPulls: [{ html_url: 'https://github.com/acme/widgets/pull/3' }] })
    const o = await runUpgrade(['--to', 'v0.2.0'], open)
    expect(o.code).toBe(2)
    expect(o.err).toContain('already open from steward/upgrade-v0.2.0: https://github.com/acme/widgets/pull/3')
  })
})

describe('ST-69/AC-10: a failed preparation says what is left', () => {
  it('ST-69/AC-10: a pull request that cannot be opened leaves a pushed branch and a clone, and says how to recover', async () => {
    const w = world({ pullStatus: 422 })
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/upgrade stopped: opening the draft pull request failed. GitHub said: 422 Validation Failed/)
    expect(r.err).toContain(`upgrade's copy of the project, at ${r.clone}`)
    expect(r.err).toContain('the branch steward/upgrade-v0.2.0 on GitHub')
    expect(r.err).toContain('no pull request: none was opened')
    expect(r.err).toContain('git push origin --delete steward/upgrade-v0.2.0')
    expect(r.err).toContain('Nothing was rolled back or removed.')
    expect(git(w.bare, 'rev-parse', '--verify', 'refs/heads/steward/upgrade-v0.2.0')).toMatch(/^[0-9a-f]{40}$/)
    expect(existsSync(r.clone)).toBe(true)
  })

  it('ST-69/AC-10: a clone that cannot be made leaves nothing on GitHub, and a failed push leaves the branch in the clone only', async () => {
    const w = world()
    let calls = 0
    const r = await runUpgrade(['--to', 'v0.2.0'], w, {
      cloneUrl: () => {
        if (++calls > 1) throw new Error('boom')
        return w.bare
      },
    })
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/copying the project's main from GitHub failed. Git said: boom/)
    expect(heads(w)).not.toContain('steward/upgrade')
    expect(writes(w)).toEqual([])
  })

  it('ST-69/AC-10: a push that fails leaves the branch in the clone only', async () => {
    const w = world()
    const hook = path.join(w.bare, 'hooks', 'pre-receive')
    mkdirSync(path.dirname(hook), { recursive: true })
    writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/upgrade stopped: pushing the branch steward\/upgrade-v0.2.0 to GitHub failed/)
    expect(r.err).toContain('the branch steward/upgrade-v0.2.0 in that copy only: nothing was pushed')
    expect(r.err).toContain('fix what Git reported, and run upgrade again')
    expect(writes(w)).toEqual([])
  })

  it('ST-69/AC-10: a credential GitHub does not accept is refused before anything', async () => {
    const w = world()
    const failing = { ...w, fetch: async () => ({ status: 401, text: async () => JSON.stringify({ message: 'Bad credentials' }) }) }
    const r = await runUpgrade(['--to', 'v0.2.0'], failing)
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/did not let your credential read acme\/widgets \(401 Bad credentials\)/)
  })
})

describe('ST-69/AC-10: an upgrade from each of v0.1.0\'s pins', () => {
  for (const [name, pin] of [['the tag', 'v0.1.0'], ["the tag's commit", C_0B1D], ['935fb5b', C_935F]]) {
    it(`ST-69/AC-10: from ${name} to a commit`, async () => {
      const w = world({ pin })
      const r = await runUpgrade(['--ref', C_CAND], w)
      expect(r.code).toBe(0)
      for (const file of GATE_WORKFLOWS) {
        expect(onBranch(w, r.opened.head, `.github/workflows/${file}`)).toBe(fillPin(template(file), C_CAND).trimEnd())
      }
      expect(r.opened.body).toContain(`from \`${pin}\` to \`${C_CAND}\``)
    })
  }

  it('ST-69/AC-10: from a commit to a tag on a later commit', async () => {
    const w = world({ pin: C_CAND })
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(0)
    expect(r.opened.title).toBe('Upgrade steward to release v0.2.0')
    expect(w.requests.some((q) => q.repo === STEWARD_REPO && q.rest === `/compare/${C_CAND}...${C_LATER}`)).toBe(true)
  })
})

describe('ST-69: arguments', () => {
  it('ST-69/AC-2: parseFlags takes --flag=value, and refuses an unknown flag, a missing value and a repeated flag', () => {
    expect(parseFlags(['--to=v0.2.0']).to).toBe('v0.2.0')
    expect(() => parseFlags(['--bogus', 'x'])).toThrow(/not a flag of upgrade/)
    expect(() => parseFlags(['--to'])).toThrow(/--to needs a value/)
    expect(() => parseFlags(['--to', 'v0.2.0', '--to', 'v0.2.1'])).toThrow(/given twice/)
  })

  it('ST-69/AC-1: outside a git repository, and with an origin that is not on GitHub, it refuses', async () => {
    const w = world()
    const outside = await main(['--to', 'v0.2.0'], { cwd: fresh('plain'), fetch: w.fetch, getToken: async () => 't', out() {}, err() {} })
    expect(outside).toBe(2)
    git(w.dir, 'remote', 'set-url', 'origin', 'https://example.com/acme/widgets.git')
    const errs = []
    const elsewhere = await main(['--to', 'v0.2.0'], { cwd: w.dir, fetch: w.fetch, getToken: async () => 't', out() {}, err: (l) => errs.push(l) })
    expect(elsewhere).toBe(2)
    expect(errs.join('\n')).toMatch(/not a GitHub repository/)
  })
})

describe('ST-69/AC-11 and AC-12: the documents', () => {
  const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

  it('ST-69/AC-11: README documents the bounded process, approval, the effective pin, the manual coordinator step and where to run it', () => {
    const readme = read('README.md')
    const section = readme.slice(readme.indexOf('## Upgrading steward in a project'))
    expect(section).toMatch(/steward upgrade --to v/)
    expect(section).toMatch(/--ref/)
    expect(section).toMatch(/installed at the target pin/)
    expect(section).toMatch(/coordinator/)
    expect(section).toMatch(/by hand/)
    expect(section).toMatch(/names the target pin|effective/)
  })

  it('ST-69/AC-11: the release review walks the upgrade through, before and after the tag', () => {
    const doc = read('docs/release-review.md')
    expect(doc).toMatch(/steward upgrade --ref <commit>/)
    expect(doc).toMatch(/steward upgrade --to vX\.Y\.Z/)
    expect(doc).toMatch(/last commit/)
  })

  it('ST-69/AC-12: the Planned (ST-69) marker is gone from the design document', () => {
    expect(read('docs/agent-workflow-design.md')).not.toMatch(/Planned \(ST-69\)/)
  })
})
