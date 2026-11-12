// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fillPin, GATE_WORKFLOWS, INSPECTION_WORKFLOW } from './init.mjs'
import { describePin, failureReport, main, MIGRATIONS, parseFlags, planConfig, pullTitle, readTemplate, STEWARD_REPO, templateMapping } from './upgrade.mjs'

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
async function runUpgrade(args, w, { migrations, cloneUrl, packageRoot, getToken = async () => 'token' } = {}) {
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
    ...(packageRoot ? { packageRoot } : {}),
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
    expect(r.opened.title).toBe('Upgrade steward to release v0.2.0 (package.json version 0.2.0)')
    expect(r.opened.body).toMatch(/- Target: release v0\.2\.0 \(package\.json version 0\.2\.0\)/)
  })

  it('ST-69/AC-3: a commit is written in lower case, and called a candidate of its version, never a release', async () => {
    const w = world()
    const r = await runUpgrade(['--ref', C_CAND.toUpperCase()], w)
    expect(r.code).toBe(0)
    expect(onBranch(w, r.opened.head, '.github/workflows/review-gate.yml')).toContain(`github:luplows/steward#${C_CAND} steward`)
    expect(r.opened.title).toBe(`Upgrade steward to a candidate of version 0.2.0 (commit ${C_CAND.slice(0, 12)})`)
    expect(r.opened.title).not.toMatch(/release/i)
    expect(r.opened.body).toMatch(new RegExp(`- Target: commit ${C_CAND}, a candidate of version 0\\.2\\.0`))
    expect(r.opened.body.split('\n').filter((l) => l.startsWith('- Target:')).join('')).not.toMatch(/release/i)
  })

  it('ST-69/AC-3: a commit whose package.json gives 0.0.0 is called a development commit', async () => {
    const w = world()
    const r = await runUpgrade(['--ref', C_DEV], w)
    expect(r.code).toBe(0)
    expect(r.opened.title).toBe(`Upgrade steward to a development commit (${C_DEV.slice(0, 12)}, package.json version 0.0.0)`)
    expect(r.opened.body).toMatch(new RegExp(`- Target: development commit ${C_DEV} \\(package\\.json version 0\\.0\\.0\\)`))
    expect(r.opened.title + r.opened.body.split('\n').filter((l) => l.startsWith('- Target:')).join('')).not.toMatch(/release/i)
  })

  it('ST-69/AC-3: describePin and pullTitle say the same without GitHub', () => {
    expect(describePin({ kind: 'commit', pin: C_CAND, version: '0.3.0' })).toBe(`commit ${C_CAND}, a candidate of version 0.3.0`)
    expect(pullTitle({ kind: 'tag', pin: 'v1.2.3', version: '1.2.3' })).toBe('Upgrade steward to release v1.2.3 (package.json version 1.2.3)')
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

  it('ST-69/AC-5: a customized workflow is refused before a no-op: the target is the installed pin', async () => {
    const files = { '.github/workflows/review-gate.yml': `${fillPin(template('review-gate.yml'), C_CAND)}# ours\n` }
    const w = world({ pin: C_CAND, files })
    const refs = heads(w)
    const r = await runUpgrade(['--ref', C_CAND], w)
    expect(r.code).toBe(2)
    expect(r.err).toContain('.github/workflows/review-gate.yml: differs from')
    expect(r.out).not.toMatch(/nothing to upgrade/)
    expectUntouched(r, refs)
  })

  it('ST-69/AC-5: a customized workflow is refused before a no-op: a tag installed, its own commit given as --ref', async () => {
    const files = { '.github/workflows/land-approved.yml': `${fillPin(template('land-approved.yml'), 'v0.1.0')}# ours\n` }
    const w = world({ files })
    const refs = heads(w)
    const r = await runUpgrade(['--ref', C_0B1D], w)
    expect(r.code).toBe(2)
    expect(r.err).toContain('.github/workflows/land-approved.yml: differs from')
    expectUntouched(r, refs)
  })

  it('ST-69/AC-5: a workflow with no template at the installed pin is refused before a no-op', async () => {
    const w = world({ pin: C_CAND, steward: { templates: { [C_CAND]: { 'land-approved.yml': null } } } })
    const r = await runUpgrade(['--ref', C_CAND], w)
    expect(r.code).toBe(2)
    expect(r.err).toContain('land-approved.yml: steward has no template of that name at')
    expect(r.out).not.toMatch(/nothing to upgrade/)
  })

  it('ST-69/AC-3: the title and body give the package.json version, a release\'s too, even when it is not the tag\'s', async () => {
    const w = world({ steward: { versions: { [C_LATER]: '0.2.5' } } })
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.opened.title).toBe('Upgrade steward to release v0.2.0 (package.json version 0.2.5)')
    expect(r.opened.body).toContain('- Target: release v0.2.0 (package.json version 0.2.5)')
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
    expect(r.opened.body).toMatch(/- Project-owned changes: none in `[0-9a-f]{40}`: `steward\.config\.json`, `docs\/RULES\.md` and every other file not listed above are as they are at `[0-9a-f]{40}`\./)
    expect(r.opened.body).toMatch(/`land` is true\); the upgrade did not change it/)
  })

  it('ST-69/AC-7: a rulesFile with a . segment is read without it and kept as written', async () => {
    const config = settings({ rulesFile: './REVIEW.md' })
    const w = world({ config })
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(0)
    expect(onBranch(w, r.opened.head, 'steward.config.json')).toBe(config.trimEnd())
    expect(r.opened.body).toContain('`steward.config.json`, `./REVIEW.md` and every other file not listed above are as they are at')
    expect(w.requests.some((q) => q.rest === '/contents/REVIEW.md')).toBe(true)
    const bad = await runUpgrade(['--to', 'v0.2.0'], world({ config, rules: ['# R', '', '## S', '', 'no item', ''].join('\n') }))
    expect(bad.code).toBe(2)
    expect(bad.err).toContain('./REVIEW.md: ')
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
    expect(r.opened.body).toContain('- Project-owned change: `steward.config.json`: renames inspectAfterHours to keep its value (M-example).')
    expect(changedFiles(w, r.opened.head)).toContain('steward.config.json')
  })

  it('ST-69/AC-7: a decision that belongs to the project is reported, and the config is not guessed at', async () => {
    const migration = { id: 'M-ask', explanation: 'x', applies: () => false, migrate: (c) => c, decision: () => 'Decide whether landWhen should name the new check.' }
    const w = world()
    const r = await runUpgrade(['--to', 'v0.2.0'], w, { migrations: [migration] })
    expect(r.code).toBe(0)
    expect(r.opened.body).toMatch(/- Configuration decisions left to the project, which `steward upgrade` did not make:\n {2}- Decide whether landWhen should name the new check\./)
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
    expect(r.opened.body).toMatch(/- Settings: `steward\.config\.json`, as `[0-9a-f]{40}` has it and `[0-9a-f]{40}` leaves it, passes `readSettings`\./)
    expect(r.opened.body).toMatch(/- Checklist: `REVIEW\.md`, as `[0-9a-f]{40}` has it and `[0-9a-f]{40}` leaves it, passes `validateRules`, the reviewer's checklist parser\./)
    expect(r.opened.body).toContain('- The workflows: it ran none, the proposed ones included.')
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
    expect(body).toMatch(/- Files the generated commit changes:\n {2}- `\.github\/workflows\/land-approved\.yml`\n {2}- `\.github\/workflows\/review-gate\.yml`/)
    expect(body).toMatch(/- Project-owned changes: none in /)
    expect(body).toMatch(/\*\*Verified\*\* by steward /)
    expect(body).toMatch(/- Configuration: no migration of this upgrade asked the project for a decision\./)
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
    expect(r.err).toMatch(/upgrade's copy of the project is kept at /)
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
    expect(r.err).toContain('perhaps a pull request: opening it failed, and whether GitHub created it is not known')
    expect(r.err).not.toContain('none was opened')
    expect(r.err).toContain('git ls-remote --heads origin steward/upgrade-v0.2.0')
    expect(r.err).toContain('the open pull requests from steward/upgrade-v0.2.0')
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
    expect(r.err).toContain('in that copy, and perhaps on GitHub: the push failed, and whether it changed GitHub is not known')
    expect(r.err).not.toContain('nothing was pushed')
    expect(r.err).toContain('git ls-remote --heads origin steward/upgrade-v0.2.0')
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

describe('ST-69/AC-10: the report asserts a remote outcome only when the attempt was never made', () => {
  it('ST-69/AC-10: before the push, nothing was pushed and no pull request was opened', () => {
    const lines = failureReport(new Error('x'), { clone: '/c', branch: 'b', pushAttempted: false, pushed: false, pullAttempted: false })
    expect(lines).toContain('  the branch b in that copy only: nothing was pushed')
    expect(lines).toContain('  no pull request: none was opened')
  })

  it('ST-69/AC-10: after a push attempt that failed, and before any pull request attempt, the push is uncertain and the pull request was never made', () => {
    const lines = failureReport(new Error('x'), { clone: '/c', branch: 'b', pushAttempted: true, pushed: false, pullAttempted: false })
    expect(lines.join(" ")).toMatch(/perhaps on GitHub/)
    expect(lines).toContain('  no pull request: none was opened')
  })

  it('ST-69/AC-10: after the pull request attempt failed, the push is known and the pull request is uncertain', () => {
    const lines = failureReport(new Error('x'), { clone: '/c', branch: 'b', pushAttempted: true, pushed: true, pullAttempted: true })
    expect(lines).toContain('  the branch b on GitHub')
    expect(lines.join(" ")).toMatch(/perhaps a pull request/)
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
    expect(r.opened.title).toBe('Upgrade steward to release v0.2.0 (package.json version 0.2.0)')
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

// ------------------------------------------------------------------ ST-97: the body's evidence

const STEWARD_PR_TEMPLATE = readFileSync(path.join(TEMPLATES, 'pull_request_template.md'), 'utf8')
const PROJECT_TEMPLATE = `${STEWARD_PR_TEMPLATE}\n## Screenshots\n\n<!-- The project's own instruction: add screenshots of any UI change. -->\n`
const TEMPLATE_PATH = '.github/pull_request_template.md'

/** The generated base and head, read from the project's origin, not from the body. */
const generated = (r) => ({ base: git(r.w.bare, 'rev-parse', 'main'), head: git(r.w.bare, 'rev-parse', `refs/heads/${r.opened.head}`) })

/** The text of the second-level section `title` of `body`, up to the next heading of level one or two. */
function section(body, title) {
  const lines = body.split('\n')
  const start = lines.indexOf(`## ${title}`)
  if (start === -1) return null
  const end = lines.findIndex((line, i) => i > start && /^#{1,2} /.test(line))
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n')
}
const headingCount = (body, title) => body.split('\n').filter((line) => line === `## ${title}`).length

/** Every non-blank line of `template` appears in `body`, in the same order. */
function expectKeptInOrder(body, template) {
  const lines = body.split('\n')
  let at = 0
  for (const line of template.split('\n').filter((l) => l.trim() !== '')) {
    const found = lines.indexOf(line, at)
    expect(found, line).toBeGreaterThanOrEqual(at)
    at = found + 1
  }
}

/** A steward package root whose package.json gives `version`. */
function packageAt(version) {
  const dir = fresh('package')
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'steward', version }))
  return dir
}

describe('ST-97/AC-1: an ordinary template is filled in place', () => {
  it('ST-97/AC-1: What changed, Verification and Docs check are filled, once each, and Unit:, other sections and instructions are kept', async () => {
    const w = world({ files: { [TEMPLATE_PATH]: PROJECT_TEMPLATE } })
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(0)
    const { base, head } = generated(r)
    const body = r.opened.body
    for (const title of ['What changed', 'Verification', 'Docs check', 'Crew action required']) expect(headingCount(body, title), title).toBe(1)
    expect(body).not.toMatch(/^## Steward upgrade$/m)
    expect(body.startsWith('Unit:\n<!-- Complete this line')).toBe(true)
    expectKeptInOrder(body, PROJECT_TEMPLATE)
    expect(section(body, 'What changed')).toContain('<!-- What this PR does and why.')
    expect(section(body, 'What changed')).toContain(`- Generated head: \`${head}\`, one commit on \`${base}\`.`)
    expect(section(body, 'Verification')).toContain('**Verified** by steward ')
    expect(section(body, 'Verification')).toContain('**Not checked** by `steward upgrade`:')
    expect(section(body, 'Docs check')).toContain('**Not checked**: `steward upgrade` did not inspect or edit `README.md`')
    expect(section(body, 'Screenshots')).toBe("\n<!-- The project's own instruction: add screenshots of any UI change. -->\n")
    expect(body.indexOf('## Crew action required')).toBeGreaterThan(body.indexOf('## Screenshots'))
    expect(section(body, 'Crew action required')).toContain(
      "with `steward upgrade`'s text added at the end of its What changed, Verification, Docs check sections, and this Crew action required section added at its end",
    )
  })

  it("ST-97/AC-1: a template's own Crew action required section is filled in place, not repeated", async () => {
    const text = `${STEWARD_PR_TEMPLATE}\n## Crew action required\n\n- Our own item.\n\n## Screenshots\n`
    const w = world({ files: { [TEMPLATE_PATH]: text } })
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(0)
    expect(headingCount(r.opened.body, 'Crew action required')).toBe(1)
    const crew = section(r.opened.body, 'Crew action required')
    expect(crew.indexOf('- Our own item.')).toBeLessThan(crew.indexOf('Suggestions, not requirements'))
    expect(r.opened.body.trimEnd().endsWith('## Screenshots')).toBe(true)
    expectKeptInOrder(r.opened.body, text)
  })

  /** A standard template whose What changed section holds the fenced example `fence`. */
  const withExample = (fence) => ['Unit:', '', '## What changed', '', ...fence, '', '## Verification', '', '## Docs check', ''].join('\n')
  const fenced = {
    // The reviewer's example: an info string after a delimiter of the fence's own character is content.
    'a tilde fence holding a tilde line with text after it': ['~~~text', '~~~example', '## Verification', '~~~'],
    'a backtick fence holding a tilde line, and a backtick line with text after it': ['```', '~~~', '```text', '## Docs check', '```'],
    'a tilde fence holding a backtick line, and a tilde line with text after it': ['~~~', '```', '~~~ more', '## What changed', '~~~'],
  }

  for (const [name, fence] of Object.entries(fenced)) {
    it(`ST-97/AC-1: a fenced example is not a heading: ${name}`, () => {
      const read = readTemplate(withExample(fence))
      expect(read.headings.map((h) => h.title)).toEqual(['What changed', 'Verification', 'Docs check'])
      expect(templateMapping(read.headings).mapped).toBe(true)
    })
  }

  it("ST-97/AC-1: a template with the reviewer's fenced example is filled, and the example is kept as it is", async () => {
    const text = withExample(fenced['a tilde fence holding a tilde line with text after it'])
    const r = await runUpgrade(['--to', 'v0.2.0'], world({ files: { [TEMPLATE_PATH]: text } }))
    expect(r.code).toBe(0)
    expect(r.opened.body).not.toMatch(/^## Steward upgrade$/m)
    expect(r.opened.body).toContain('~~~text\n~~~example\n## Verification\n~~~\n\n`steward upgrade` generated this draft pull request.')
    expect(r.opened.body).toMatch(/^## Verification\n\n\*\*Verified\*\*/m)
    expectKeptInOrder(r.opened.body, text)
  })

  it('ST-97/AC-1: a CRLF template keeps its line endings, and the headings are matched whatever their case', async () => {
    const text = 'Unit:\r\n\r\n## what changed\r\n\r\n## VERIFICATION\r\n\r\n## Docs Check\r\n'
    const w = world({ files: { [TEMPLATE_PATH]: text } })
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(r.code).toBe(0)
    expect(r.opened.body).not.toMatch(/[^\r]\n/)
    expect(r.opened.body).toContain('## VERIFICATION\r\n\r\n**Verified**')
    expect(r.opened.body).not.toMatch(/^## Steward upgrade/m)
  })
})

describe('ST-97/AC-2: What changed says what upgrade generated, scoped to its base and head', () => {
  it('ST-97/AC-2: the pins, the target type and version, the branch, the base, the head and the changed files, all of the generated commit', async () => {
    const w = world({ files: { [TEMPLATE_PATH]: STEWARD_PR_TEMPLATE } })
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    const { base, head } = generated(r)
    const text = section(r.opened.body, 'What changed')
    expect(text).toContain('moving the steward this project installs from `v0.1.0` to `v0.2.0`')
    expect(text).toContain(`- Installed: release v0.1.0 (package.json version 0.1.0); a tag of luplows/steward at commit \`${C_0B1D}\`.`)
    expect(text).toContain(`- Target: release v0.2.0 (package.json version 0.2.0); a tag of luplows/steward at commit \`${C_LATER}\`.`)
    expect(text).toContain('- Branch: `steward/upgrade-v0.2.0`.')
    expect(text).toContain(`- Starting commit: \`main\` at \`${base}\`, as \`steward upgrade\` copied it.`)
    expect(text).toContain(`What \`steward upgrade\` generated: the commit \`${head}\`, and nothing after it.`)
    expect(git(w.bare, 'rev-parse', `${head}^`)).toBe(base)
    const listed = [...text.matchAll(/^ {2}- `([^`]+)`$/gm)].map((m) => m[1])
    expect(listed).toEqual(changedFiles(w, r.opened.head).sort())
    expect(text).toContain(
      `- Project-owned changes: none in \`${head}\`: \`steward.config.json\`, \`REVIEW.md\` and every other file not listed above are as they are at \`${base}\`.`,
    )
    expect(text).toContain(`These facts describe what \`steward upgrade\` generated, \`${base}\` to \`${head}\`. Commits added to this branch after \`${head}\``)
  })

  it('ST-97/AC-2: a commit target is named as a commit with its version, never a release', async () => {
    const r = await runUpgrade(['--ref', C_CAND], world())
    expect(section(r.opened.body, 'What changed')).toContain(`- Target: commit ${C_CAND}, a candidate of version 0.2.0; a commit of luplows/steward.`)
  })
})

describe('ST-97/AC-3: Verification is what upgrade ran and checked, and what it did not', () => {
  it('ST-97/AC-3: the arguments, their result, each validation with its outcome and the version of steward that ran them', async () => {
    const w = world({ files: { [TEMPLATE_PATH]: STEWARD_PR_TEMPLATE } })
    const r = await runUpgrade(['--to=v0.2.0', '--branch', 'crew/upgrade'], w, { packageRoot: packageAt('7.7.7-test') })
    expect(r.code).toBe(0)
    const { base, head } = generated(r)
    const text = section(r.opened.body, 'Verification')
    expect(text).toContain('**Verified** by steward 7.7.7-test (the `package.json` version of the steward that ran the command)')
    expect(text).toContain(
      `- \`steward upgrade --to=v0.2.0 --branch crew/upgrade\` ran in the project's checkout and completed each of its steps before opening this draft pull request: ` +
        `it copied \`main\` at \`${base}\`, committed \`${head}\` on the branch \`crew/upgrade\`, and pushed that branch.`,
    )
    expect(text).toContain(`- Target pin: GitHub answered that \`v0.2.0\` is a tag of luplows/steward at commit \`${C_LATER}\`, whose \`package.json\` gives version \`0.2.0\`.`)
    expect(text).toContain('- Installed pin: each managed workflow on `main` (`.github/workflows/review-gate.yml`, `.github/workflows/land-approved.yml`) carries the one pin `v0.1.0`')
    expect(text).toContain("- Installed workflows: each is steward's template at `v0.1.0` apart from the pin and line endings")
    expect(text).toContain(`- Direction: GitHub's comparison of \`${C_0B1D}\` with \`${C_LATER}\` gave \`ahead\``)
    expect(text).toContain(`- Settings: \`steward.config.json\`, as \`${base}\` has it and \`${head}\` leaves it, passes \`readSettings\`.`)
    expect(text).toContain(`- Checklist: \`REVIEW.md\`, as \`${base}\` has it and \`${head}\` leaves it, passes \`validateRules\``)
    expect(text).toContain(`are the files at \`${base}\`, and \`.github/workflows/inspection.yml\` is absent there too.`)
    expect(text).toContain('Each of these checks passed: had any failed, `steward upgrade` would have stopped and opened no pull request.')
    const verified = text.slice(text.indexOf('**Verified**'), text.indexOf('**Not checked**'))
    expect(verified).not.toMatch(/npm|\bCI\b|a review/)
    expect(text.slice(text.indexOf('**Not checked**'))).toMatch(/tests, builds and other commands, and its CI: `steward upgrade` ran none of them/)
  })

  it('ST-97/AC-3: a validation that fails opens no pull request, so it never appears as a generated one', async () => {
    for (const w of [world({ config: `${JSON.stringify({ repo: REPO, land: false })}\n` }), world({ rules: '# Rules\n\n## A section\n\nno numbered item\n' })]) {
      const r = await runUpgrade(['--to', 'v0.2.0'], w)
      expect(r.code).toBe(2)
      expect(r.opened).toBeUndefined()
      expect(writes(w)).toEqual([])
    }
  })

  it('ST-97/AC-3: when main on GitHub is not what the checks read, no branch is pushed and no pull request is opened', async () => {
    const w = world()
    const fetch = w.fetch
    let moved = false
    w.fetch = async (url, init) => {
      // The last request before the clone is the look for an open pull request from the branch.
      if (!moved && init.method === 'GET' && /\/repos\/acme\/widgets\/pulls\?/.test(url)) {
        moved = true
        writeFileSync(path.join(w.dir, 'steward.config.json'), settings({ inspectAfterHours: 12 }))
        git(w.dir, 'commit', '-q', '-am', 'crew change')
        git(w.dir, 'push', '-q', w.bare, 'main')
      }
      return fetch(url, init)
    }
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expect(moved).toBe(true)
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/main changed on GitHub while upgrade ran: at [0-9a-f]{40}, the commit it copied, steward\.config\.json is not what it checked/)
    expect(r.opened).toBeUndefined()
    expect(heads(w)).not.toContain('steward/upgrade')
  })
})

describe('ST-97/AC-4: Docs check, and what is left to the crew', () => {
  it('ST-97/AC-4: Docs check says what was not inspected and asks the crew; Crew action required names the unit, preparatory work, CI, after the merge and configuration', async () => {
    const w = world({ files: { [TEMPLATE_PATH]: STEWARD_PR_TEMPLATE } })
    const r = await runUpgrade(['--ref', C_CAND], w)
    const { base } = generated(r)
    const docs = section(r.opened.body, 'Docs check')
    expect(docs).toContain(
      "**Not checked**: `steward upgrade` did not inspect or edit `README.md` or the project's other documentation, apart from validating `REVIEW.md` " +
        'and reading its pull request template, `.github/pull_request_template.md`, neither of which it changed.',
    )
    const none = await runUpgrade(['--to', 'v0.2.0'], world())
    expect(section(none.opened.body, 'Docs check')).toContain("or the project's other documentation, apart from validating `REVIEW.md`, which it did not change.")
    expect(docs).toContain("**Crew action required**: confirm whether the project's documentation must change with this upgrade")
    expect(docs).toContain('(this upgrade changes the pin from a tag to a commit)')
    const crew = section(r.opened.body, 'Crew action required')
    expect(crew).toMatch(/^Suggestions, not requirements: the project's own rules decide which apply/m)
    expect(crew).toContain(
      `- Unit: the template's \`Unit:\` line is left empty: \`steward upgrade\` names no unit. \`steward.config.json\` at \`${base}\` gives \`unitLinks\` as \`["file","issue"]\`.`,
    )
    expect(crew).toMatch(/- Preparatory work: .*a unit and pull request of its own/)
    expect(crew).toMatch(/- CI: check what the project's CI reports/)
    expect(crew).toMatch(/- After this pull request merges, by hand:\n {2}- Check the pin in effect/)
    expect(crew).toMatch(/- Configuration: no migration of this upgrade asked the project for a decision\./)
    expect(r.opened.body.split('\n')[0]).toBe('Unit:')
  })

  it('ST-97/AC-4: the same pin form says nothing of a change of form', async () => {
    const r = await runUpgrade(['--to', 'v0.2.0'], world())
    expect(section(r.opened.body, 'Docs check')).not.toContain('changes the pin from')
  })
})

describe('ST-97/AC-5: no template, an empty one and a custom one', () => {
  it("ST-97/AC-5: with no template, the body is steward's Unit: line and three sections, filled, and the empty Unit: is named for the crew", async () => {
    const r = await runUpgrade(['--to', 'v0.2.0'], world())
    expect(r.opened.draft).toBe(true)
    const body = r.opened.body
    expect(body.startsWith('Unit:\n\n## What changed\n\n`steward upgrade` generated this draft pull request.')).toBe(true)
    for (const title of ['What changed', 'Verification', 'Docs check', 'Crew action required']) expect(section(body, title).trim(), title).not.toBe('')
    expect(body).toContain("- Template: the project has no pull request template, so this body uses steward's `Unit:` line and its three sections.")
    expect(body).toContain('- Unit: `steward upgrade` wrote the `Unit:` line empty: it names no unit.')
  })

  it('ST-97/AC-5: an empty template is said to be empty, and gets the same sections', async () => {
    const r = await runUpgrade(['--to', 'v0.2.0'], world({ files: { [TEMPLATE_PATH]: '\n' } }))
    expect(r.opened.draft).toBe(true)
    expect(r.opened.body.startsWith('Unit:\n\n## What changed\n\n')).toBe(true)
    expect(r.opened.body).toContain(
      "- Template: the project's pull request template, `.github/pull_request_template.md`, is empty, so this body uses steward's `Unit:` line and its three sections.",
    )
  })

  it('ST-97/AC-5: a custom template is kept as it is, its sections are named for the crew, and it is never called ready', async () => {
    const custom = 'Unit: \n\n# Notes\n\nOur own text, kept.\n\n## Testing\n\n- [ ] tried it\n'
    const r = await runUpgrade(['--to', 'v0.2.0'], world({ files: { [TEMPLATE_PATH]: custom } }))
    expect(r.opened.draft).toBe(true)
    const body = r.opened.body
    expect(body.endsWith(`---\n\n${custom}`)).toBe(true)
    for (const title of ['What changed', 'Verification', 'Docs check']) expect(headingCount(body, title), title).toBe(0)
    expect(body).toContain('because it has no `## What changed`, `## Verification`, `## Docs check` heading.')
    expect(body).toContain('The crew completes its sections ("Notes", "Testing"); `steward upgrade` did not, and does not say this pull request is ready for review.')
    expect(body).toContain("- Unit: the template's `Unit:` line is left empty: `steward upgrade` names no unit.")
    expect(body).toMatch(/### Upgrade: verification\n\n\*\*Verified\*\*/)
    expect(body).toMatch(/ready for review/)
    expect(body).not.toMatch(/(?<!not say (this pull request|it) is )ready for review/)
  })

  it('ST-97/AC-5: a template with a heading repeated is not filled, and the repeat is named', async () => {
    const text = `${STEWARD_PR_TEMPLATE}\n## Verification\n`
    const r = await runUpgrade(['--to', 'v0.2.0'], world({ files: { [TEMPLATE_PATH]: text } }))
    expect(r.opened.body.endsWith(text)).toBe(true)
    expect(r.opened.body).toContain('because it has more than one `## Verification` heading.')
  })

  it('ST-97/AC-5: a template with no Unit: line gets none', async () => {
    const text = '## What changed\n\n## Verification\n\n## Docs check\n'
    const r = await runUpgrade(['--to', 'v0.2.0'], world({ files: { [TEMPLATE_PATH]: text } }))
    expect(r.opened.body).not.toMatch(/^Unit:/m)
    expect(r.opened.body).toContain('- Unit: the template has no `Unit:` line, and `steward upgrade` added none: it names no unit.')
  })
})

describe('ST-97/AC-6: the body against the generated commit, case by case', () => {
  /** Every full SHA the body names is the base, the head or a commit of steward it read. */
  function expectOnlyGeneratedShas(r) {
    const { base, head } = generated(r)
    const known = new Set([base, head, ...LINE, C_BRANCH])
    for (const [sha] of r.opened.body.matchAll(/[0-9a-f]{40}/g)) expect(known.has(sha), sha).toBe(true)
  }

  it('ST-97/AC-6: a standard template: the claims are of the base and head, and a crew commit added later is not described or validated', async () => {
    const w = world({ files: { [TEMPLATE_PATH]: STEWARD_PR_TEMPLATE } })
    const r = await runUpgrade(['--to', 'v0.2.0'], w)
    expectOnlyGeneratedShas(r)
    const { head } = generated(r)
    const crew = fresh('crew')
    git(crew, 'clone', '-q', '--branch', r.opened.head, w.bare, '.')
    writeFileSync(path.join(crew, 'README.md'), 'widgets, edited by the crew\n')
    git(crew, 'commit', '-q', '-am', 'crew edit')
    git(crew, 'push', '-q', 'origin', r.opened.head)
    const later = git(w.bare, 'rev-parse', `refs/heads/${r.opened.head}`)
    expect(later).not.toBe(head)
    expect(r.opened.body).not.toContain(later)
    expect(section(r.opened.body, 'Verification')).toContain(`- Anything after \`${head}\`: commits added to this branch later, and edits to this description.`)
  })

  it('ST-97/AC-6: no template and a custom template name only the generated commits too', async () => {
    expectOnlyGeneratedShas(await runUpgrade(['--to', 'v0.2.0'], world()))
    expectOnlyGeneratedShas(await runUpgrade(['--to', 'v0.2.0'], world({ files: { [TEMPLATE_PATH]: '# Ours\n' } })))
  })

  it('ST-97/AC-6: project-owned config edits are listed, and validated as the generated commit writes them', async () => {
    const migration = { id: 'M-example', explanation: 'sets inspectAfterHours to 48', applies: () => true, migrate: (c) => ({ ...c, inspectAfterHours: 48 }) }
    const r = await runUpgrade(['--to', 'v0.2.0'], world({ files: { [TEMPLATE_PATH]: STEWARD_PR_TEMPLATE } }), { migrations: [migration] })
    const { head } = generated(r)
    const text = section(r.opened.body, 'What changed')
    expect(text).toContain('  - `steward.config.json`')
    expect(text).toContain('- Project-owned change: `steward.config.json`: sets inspectAfterHours to 48 (M-example).')
    expect(text).toContain(`- No other project-owned file changes in \`${head}\`.`)
    expect(section(r.opened.body, 'Verification')).toContain('- Settings: `steward.config.json`, as the generated commit writes it, passes `readSettings`.')
  })

  it('ST-97/AC-6: a pin-only upgrade says only the pin changes, that no comparison was made and that no migration ran', async () => {
    const r = await runUpgrade(['--to', 'v0.2.0'], world({ pin: C_LATER, files: { [TEMPLATE_PATH]: STEWARD_PR_TEMPLATE } }))
    expect(section(r.opened.body, 'What changed')).toContain(`- Only the pin changes: both pins name the same commit of steward, \`${C_LATER}\``)
    expect(section(r.opened.body, 'Verification')).toContain(`- Direction: both pins name the commit \`${C_LATER}\`, so no comparison was needed.`)
    expect(section(r.opened.body, 'Crew action required')).toContain('- Configuration: no migration ran, since both pins name the same commit of steward.')
    expectOnlyGeneratedShas(r)
  })

  it('ST-97/AC-6: an optional workflow is named as absent when it is, and among those checked and changed when it is installed', async () => {
    const without = await runUpgrade(['--to', 'v0.2.0'], world())
    const { base } = generated(without)
    expect(section(without.opened.body, 'What changed')).toContain(
      `- \`.github/workflows/inspection.yml\` is not on \`main\` at \`${base}\`, and \`steward upgrade\` did not add it.`,
    )
    const withIt = await runUpgrade(['--to', 'v0.2.0'], world({ inspection: true }))
    expect(section(withIt.opened.body, 'What changed')).toContain('  - `.github/workflows/inspection.yml`')
    expect(section(withIt.opened.body, 'What changed')).not.toContain('is not on `main`')
    expect(section(withIt.opened.body, 'Verification')).toContain('(`.github/workflows/review-gate.yml`, `.github/workflows/land-approved.yml`, `.github/workflows/inspection.yml`)')
  })

  it('ST-97/AC-6: land is reported as it is at the base, for each value', async () => {
    for (const land of [false, true]) {
      const r = await runUpgrade(['--to', 'v0.2.0'], world({ config: settings({ land }) }))
      const { base } = generated(r)
      expect(section(r.opened.body, 'What changed')).toContain(`- Landing is as \`steward.config.json\` has it at \`${base}\` (\`land\` is ${land}); the upgrade did not change it.`)
    }
  })
})

describe('ST-97/AC-7: the documents', () => {
  const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

  it('ST-97/AC-7: README names what is left to the crew: the unit, separate units for other work and the docs a pin-form change affects', () => {
    const readme = read('README.md')
    const text = readme.slice(readme.indexOf('### Upgrading steward in a project'), readme.indexOf('### When the checklist does not parse'))
    expect(text).toMatch(/Crew\s+action\s+required/)
    expect(text).toMatch(/names\s+no\s+unit/)
    expect(text).toMatch(/unit\s+and\s+pull\s+request\s+of\s+its\s+own,\s+complete\s+without\s+this\s+one/)
    expect(text).toMatch(/names\s+the\s+old\s+pin,\s+or\s+says\s+whether\s+steward\s+is\s+pinned\s+to\s+a\s+tag\s+or\s+a\s+commit/)
  })

  it('ST-97/AC-7: the Planned (ST-97) marker is gone from the design document', () => {
    expect(read('docs/agent-workflow-design.md')).not.toMatch(/Planned \(ST-97\)/)
  })
})
