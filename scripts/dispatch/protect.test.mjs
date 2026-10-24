// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as init from './init.mjs'
import { settingsBody } from './init.mjs'
import { assertAllowedRequest, createProtectContext, main, PROTECTION_BODY } from './protect.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLI = path.join(ROOT, 'scripts', 'dispatch', 'cli.mjs')
const REPO = 'acme/widgets'
const PROTECTION = '/branches/main/protection'
const CONTEXTS = '/branches/main/protection/required_status_checks/contexts'
const ENFORCE = '/branches/main/protection/enforce_admins'
const SIGNATURES = '/branches/main/protection/required_signatures'
const GATE_FILES = ['.github/workflows/review-gate.yml', '.github/workflows/land-approved.yml']
const ON_MAIN = ['steward.config.json', 'REVIEW.md', ...GATE_FILES]
// What the person running protect reads: nothing of steward's own source or stories.
const MENTIONS_STEWARD_INTERNALS = /ST-\d|AC-\d|scripts\/|\.mjs/

const MESSAGES = {
  upgrade: 'Upgrade to GitHub Pro or make this repository public to enable this feature.',
  admin: 'Must have admin rights to Repository.',
}

// Every test runs protect in a temporary directory, with GitHub's answers injected: nothing for real.
let base
beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 'steward-protect-'))
})
afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

let counter = 0
const fresh = (name) => {
  const dir = path.join(base, `${name}-${++counter}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const base64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64')

/**
 * GitHub's answers, injected as `fetch`. `main` says whether the repository has a `main`; `have` is
 * the files `main` holds, and `config` the content of its `steward.config.json`. `readStatus` maps
 * `'main'` or a file's path to a status that read answers instead (a 500, say). `protection` is
 * `none` (not protected, and settable), `existing`, `plan` (every protection request refused for
 * the plan), `admin` (settable only with admin rights the account lacks), `limited` (a rate
 * limit's 403) or `broken` (a 500); `existing` is the body returned for `existing`. Records every
 * request.
 */
function fakeGitHub({ main = true, have = ON_MAIN, config = { rulesFile: 'REVIEW.md' }, readStatus = {}, protection = 'none', existing = null } = {}) {
  const requests = []
  const urls = []
  const fetch = async (url, init) => {
    const rest = /\/repos\/[^/]+\/[^/]+(\/.*)$/.exec(url)[1]
    const body = init.body === undefined ? undefined : JSON.parse(init.body)
    requests.push({ method: init.method, rest, body })
    urls.push(url)
    const reply = (status, content) => ({ status, text: async () => (content === undefined ? '' : JSON.stringify(content)) })
    if (rest === '/branches/main' && init.method === 'GET') {
      if (readStatus.main) return reply(readStatus.main, { message: 'server error' })
      return main ? reply(200, { name: 'main' }) : reply(404, { message: 'Branch not found' })
    }
    const contents = /^\/contents\/([^?]+)\?ref=main$/.exec(rest)
    if (contents && init.method === 'GET') {
      const file = contents[1].split('/').map(decodeURIComponent).join('/')
      if (readStatus[file]) return reply(readStatus[file], { message: 'server error' })
      if (!have.includes(file)) return reply(404, { message: 'Not Found' })
      return reply(200, { type: 'file', path: file, encoding: 'base64', content: file === 'steward.config.json' ? base64(config) : base64('x') })
    }
    if (rest.startsWith('/branches/main/protection/') && init.method === 'POST') return reply(200, {})
    if (rest === PROTECTION) {
      if (protection === 'limited') return reply(403, { message: 'API rate limit exceeded for user ID 1.' })
      if (protection === 'broken') return reply(500, { message: 'server error' })
      if (init.method === 'GET') {
        if (protection === 'existing') return reply(200, existing ?? { required_status_checks: { contexts: ['test'] }, enforce_admins: { enabled: false } })
        if (protection === 'plan') return reply(403, { message: MESSAGES.upgrade })
        return reply(404, { message: 'Branch not protected' })
      }
      if (protection === 'admin') return reply(403, { message: MESSAGES.admin })
      return reply(200, body)
    }
    return reply(404, { message: 'Not Found' })
  }
  return { fetch, requests, urls }
}

const writes = (gh) => gh.requests.filter((r) => r.method !== 'GET')
const reads = (gh) => gh.requests.filter((r) => r.method === 'GET')

/** A working directory holding a `steward.config.json` for `repo`, or an empty one when `repo` is null. */
function makeCwd(repo = REPO) {
  const dir = fresh('cwd')
  if (repo !== null) {
    const settings = settingsBody(repo, { land: true, unitLinks: ['file'], rulesFile: 'REVIEW.md', inspectAfterHours: 24 })
    writeFileSync(path.join(dir, 'steward.config.json'), `${JSON.stringify(settings, null, 2)}\n`)
  }
  return dir
}

/** Runs `protect`, with no terminal at all; resolves `{ code, out, err, gh }`. */
async function runProtect(args = [], { cwd = makeCwd(), gh = fakeGitHub() } = {}) {
  const out = []
  const err = []
  const code = await main(args, {
    cwd,
    fetch: gh.fetch,
    getToken: async () => 'token',
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  })
  return { code, out: out.join('\n'), err: err.join('\n'), gh }
}

describe('ST-50/AC-3: steward protect is a command', () => {
  it('ST-50/AC-3: with nothing but --repo given, it runs with no terminal and asks nothing', async () => {
    const gh = fakeGitHub()
    const { code, err } = await runProtect(['--repo', REPO], { cwd: makeCwd(null), gh })
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(writes(gh)).toEqual([{ method: 'PUT', rest: PROTECTION, body: PROTECTION_BODY }])
  })

  it('ST-50/AC-3: the repository is the settings\' repo in the working directory, and --repo wins', async () => {
    const fromSettings = fakeGitHub()
    expect((await runProtect([], { cwd: makeCwd('acme/gadgets'), gh: fromSettings })).code).toBe(0)
    expect(fromSettings.urls.every((u) => u.startsWith('https://api.github.com/repos/acme/gadgets/'))).toBe(true)

    const given = fakeGitHub()
    expect((await runProtect(['--repo', REPO], { cwd: makeCwd('acme/gadgets'), gh: given })).code).toBe(0)
    expect(given.urls.every((u) => u.startsWith(`https://api.github.com/repos/${REPO}/`))).toBe(true)
    const equals = fakeGitHub()
    expect((await runProtect([`--repo=${REPO}`], { cwd: makeCwd('acme/gadgets'), gh: equals })).code).toBe(0)
    expect(equals.urls.every((u) => u.startsWith(`https://api.github.com/repos/${REPO}/`))).toBe(true)
  })

  it('ST-50/AC-3: with no settings and no --repo it names neither repository and sends nothing', async () => {
    const gh = fakeGitHub()
    const { code, err } = await runProtect([], { cwd: makeCwd(null), gh })
    expect(code).toBe(1)
    expect(err).toMatch(/--repo owner\/name/)
    expect(gh.requests).toEqual([])
  })

  it('ST-50/AC-3: it takes no flag but --repo: any other is refused, sending nothing', async () => {
    for (const args of [['--yes'], ['--nope'], ['--protect-main', 'yes'], ['--repo'], ['--repo', '--yes'], ['--repo', 'widgets'], ['--repo', REPO, '--repo', REPO], ['extra']]) {
      const gh = fakeGitHub()
      const { code, err } = await runProtect(args, { gh })
      expect(code, args.join(' ')).toBe(1)
      expect(err, args.join(' ')).toMatch(/usage: steward protect \[--repo owner\/name\]|--repo/)
      expect(gh.requests, args.join(' ')).toEqual([])
    }
  })

  it('ST-50/AC-3: cli.mjs runs it as a command of its own, with no terminal, and a flag it does not take is refused', () => {
    let result
    try {
      execFileSync(process.execPath, [CLI, 'protect', '--yes'], { cwd: makeCwd(null), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      result = error
    }
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/--yes: not a flag of protect/)
  })

  it('ST-50/AC-3: each request is checked against the allowlist before any network call', async () => {
    const base = `https://api.github.com/repos/${REPO}`
    const get = (rest) => () => assertAllowedRequest(REPO, { method: 'GET', url: `${base}${rest}` })
    expect(get('/branches/main')).not.toThrow()
    expect(get('/branches/other')).toThrow(/refusing/)
    expect(get('/contents/steward.config.json?ref=main')).not.toThrow()
    expect(get('/contents/.github/workflows/review-gate.yml?ref=main')).not.toThrow()
    expect(get('/contents/.github/workflows/land-approved.yml?ref=main')).not.toThrow()
    expect(get('/contents/docs/RULES.md?ref=main')).not.toThrow()
    expect(get('/contents/docs/my%20rules.md?ref=main')).not.toThrow()
    expect(get('/contents/docs/../secrets?ref=main')).toThrow(/refusing/)
    expect(get('/contents/REVIEW.md?ref=other')).toThrow(/refusing/)
    expect(get('/contents/REVIEW.md')).toThrow(/refusing/)
    expect(get('/contents/%E0%A4%A?ref=main')).toThrow(/refusing/)
    expect(get('/issues')).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'POST', url: `${base}/contents/REVIEW.md?ref=main`, body: {} })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'DELETE', url: `${base}/labels/inspection` })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'POST', url: `${base}/labels`, body: { name: 'inspection' } })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'POST', url: `${base}/issues`, body: {} })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'PUT', url: `${base}${PROTECTION}`, body: { enforce_admins: false } })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'PUT', url: `${base}${PROTECTION}`, body: PROTECTION_BODY })).not.toThrow()
    const contexts = { method: 'POST', url: `${base}${CONTEXTS}`, body: ['review/agent'] }
    expect(() => assertAllowedRequest(REPO, contexts)).not.toThrow()
    expect(() => assertAllowedRequest(REPO, { ...contexts, body: ['review/agent', 'x'] })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { ...contexts, method: 'PUT' })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'POST', url: `${base}${ENFORCE}` })).not.toThrow()
    expect(() => assertAllowedRequest(REPO, { method: 'DELETE', url: `${base}${ENFORCE}` })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'POST', url: `${base}${ENFORCE}`, body: {} })).toThrow(/refusing/)

    // A request the allowlist refuses is not sent: the context throws before the fetch.
    const gh = fakeGitHub()
    const ctx = createProtectContext({ repo: REPO, fetch: gh.fetch, getToken: async () => 'token' })
    await expect(ctx.send({ method: 'DELETE', url: `${base}${PROTECTION}` })).rejects.toThrow(/refusing/)
    expect(gh.requests).toEqual([])
  })
})

describe('ST-50/AC-4: it reads main before it sets anything', () => {
  it('ST-50/AC-4: with all four on main, protection is set', async () => {
    const gh = fakeGitHub()
    const { code } = await runProtect([], { gh })
    expect(code).toBe(0)
    expect(reads(gh).map((r) => r.rest)).toEqual([
      '/branches/main',
      '/contents/steward.config.json?ref=main',
      '/contents/REVIEW.md?ref=main',
      '/contents/.github/workflows/review-gate.yml?ref=main',
      '/contents/.github/workflows/land-approved.yml?ref=main',
      PROTECTION,
    ])
    expect(writes(gh)).toEqual([{ method: 'PUT', rest: PROTECTION, body: PROTECTION_BODY }])
  })

  it('ST-50/AC-4: it reads GitHub\'s main and not the working directory', async () => {
    const cwd = makeCwd()
    for (const rel of ON_MAIN.slice(1)) {
      mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true })
      writeFileSync(path.join(cwd, rel), 'here')
    }
    const gh = fakeGitHub({ have: [] })
    const { code, out } = await runProtect([], { cwd, gh })
    expect(code).toBe(1)
    expect(out).toContain('steward.config.json')
    expect(writes(gh)).toEqual([])
  })

  for (const missing of ON_MAIN) {
    it(`ST-50/AC-4: with ${missing} missing alone it refuses, naming exactly that, with exit 1 and no write request`, async () => {
      const gh = fakeGitHub({ have: ON_MAIN.filter((f) => f !== missing) })
      const { code, out } = await runProtect([], { gh })
      expect(code).toBe(1)
      expect(writes(gh)).toEqual([])
      expect(gh.requests.some((r) => r.rest === PROTECTION)).toBe(false)
      for (const file of ON_MAIN) {
        if (missing === 'steward.config.json') continue
        expect(out.includes(file), file).toBe(file === missing)
      }
      if (missing === 'steward.config.json') {
        expect(out).toContain('steward.config.json')
        expect(out).toMatch(/checklist: it cannot be named, since steward\.config\.json is missing/)
        for (const file of GATE_FILES) expect(out).not.toContain(file)
      }
    })
  }

  it('ST-50/AC-4: with all four missing it names all four, the checklist as one that cannot be named', async () => {
    const gh = fakeGitHub({ have: [] })
    const { code, out } = await runProtect([], { gh })
    expect(code).toBe(1)
    expect(writes(gh)).toEqual([])
    expect(out).toContain('steward.config.json')
    expect(out).toMatch(/checklist: it cannot be named/)
    for (const file of GATE_FILES) expect(out).toContain(file)
    expect(gh.requests.some((r) => r.rest.startsWith('/contents/REVIEW.md'))).toBe(false)
  })

  it('ST-50/AC-4: with no main it refuses, saying it found no main, reads no file, and exits 1 with no write request', async () => {
    const gh = fakeGitHub({ main: false })
    const { code, out } = await runProtect([], { gh })
    expect(code).toBe(1)
    expect(out).toMatch(/found no main branch on acme\/widgets/)
    expect(gh.requests).toEqual([{ method: 'GET', rest: '/branches/main', body: undefined }])
  })

  it('ST-50/AC-4: a rulesFile that is not a path means the checklist cannot be named, whatever else the file holds', async () => {
    for (const config of [{ rulesFile: '../outside.md' }, { rulesFile: 7 }, {}, 'not json', { rulesFile: '' }]) {
      const gh = fakeGitHub({ config })
      const { code, out } = await runProtect([], { gh })
      expect(code, JSON.stringify(config)).toBe(1)
      expect(out, JSON.stringify(config)).toMatch(/checklist: it cannot be named, since the rulesFile in steward\.config\.json is not a path/)
      expect(writes(gh)).toEqual([])
    }
  })

  it('ST-50/AC-4: the checklist is the file the rulesFile names, and nothing in the settings but that value is read', async () => {
    const config = { rulesFile: 'docs/my rules.md', repo: 42, land: 'soon', extra: true }
    const gh = fakeGitHub({ config, have: ['steward.config.json', 'docs/my rules.md', ...GATE_FILES] })
    const { code } = await runProtect([], { gh })
    expect(code).toBe(0)
    expect(reads(gh).map((r) => r.rest)).toContain('/contents/docs/my%20rules.md?ref=main')
    expect(writes(gh)).toEqual([{ method: 'PUT', rest: PROTECTION, body: PROTECTION_BODY }])

    const absent = fakeGitHub({ config, have: ['steward.config.json', ...GATE_FILES] })
    const refused = await runProtect([], { gh: absent })
    expect(refused.code).toBe(1)
    expect(refused.out).toContain('docs/my rules.md')
    expect(writes(absent)).toEqual([])
  })

  it('ST-50/AC-4: a folder where a file should be counts as missing', async () => {
    const gh = fakeGitHub()
    const original = gh.fetch
    gh.fetch = async (url, init) =>
      url.endsWith('/contents/REVIEW.md?ref=main') ? { status: 200, text: async () => JSON.stringify([{ name: 'a.md' }]) } : original(url, init)
    const { code, out } = await runProtect([], { gh })
    expect(code).toBe(1)
    expect(out).toContain('REVIEW.md')
  })

  it('ST-50/AC-4: a read that fails any other way than a 404 stops it with exit 1, setting nothing', async () => {
    for (const where of ['main', 'steward.config.json', 'REVIEW.md', ...GATE_FILES]) {
      const gh = fakeGitHub({ readStatus: { [where]: 500 } })
      const { code, err, out } = await runProtect([], { gh })
      expect(code, where).toBe(1)
      expect(err, where).toMatch(/protect stopped: .*500/)
      expect(out, where).not.toMatch(/was set|Missing/)
      expect(writes(gh), where).toEqual([])
    }
  })
})

describe('ST-50/AC-5: what it sets, once those are on main', () => {
  it('ST-50/AC-5: it sets protection requiring review/agent with enforce_admins on, and says the crew adds its own checks', async () => {
    const gh = fakeGitHub()
    const { code, out } = await runProtect([], { gh })
    expect(code).toBe(0)
    const put = gh.requests.filter((r) => r.method === 'PUT')
    expect(put).toEqual([{ method: 'PUT', rest: PROTECTION, body: PROTECTION_BODY }])
    expect(PROTECTION_BODY.required_status_checks.contexts).toEqual(['review/agent'])
    expect(PROTECTION_BODY.enforce_admins).toBe(true)
    expect(out).toMatch(/branch protection on main: set\. It requires review\/agent, with enforce_admins on/)
    expect(out).toMatch(/project's own CI checks are the crew's to add/)
  })

  it('ST-50/AC-5: where the plan offers none, it says so plainly, says nothing enforces the gate, and exits 1', async () => {
    const gh = fakeGitHub({ protection: 'plan' })
    const { code, out } = await runProtect([], { gh })
    expect(code).toBe(1)
    expect(out).toMatch(/not set\. GitHub offers none for this repository on its plan/)
    expect(out).toMatch(/Nothing on GitHub then enforces the gate/)
    expect(writes(gh)).toEqual([])
  })

  it('ST-50/AC-5: a refusal of the PUT for the plan reads the same, and exits 1', async () => {
    const gh = fakeGitHub()
    const original = gh.fetch
    gh.fetch = async (url, init) =>
      init.method === 'PUT' ? { status: 403, text: async () => JSON.stringify({ message: MESSAGES.upgrade }) } : original(url, init)
    const { code, out } = await runProtect([], { gh })
    expect(code).toBe(1)
    expect(out).toMatch(/GitHub offers none for this repository on its plan/)
  })

  it('ST-50/AC-5: for want of admin access it says so plainly, says nothing enforces the gate, and exits 1', async () => {
    const gh = fakeGitHub({ protection: 'admin' })
    const { code, out } = await runProtect([], { gh })
    expect(code).toBe(1)
    expect(out).toMatch(/not set\. This account cannot set it on this repository \(it needs admin access\)/)
    expect(out).toMatch(/Nothing on GitHub then enforces the gate/)
  })

  it('ST-50/AC-5: with protection already there lacking review/agent and enforce_admins, it adds both and sends nothing else', async () => {
    const gh = fakeGitHub({ protection: 'existing' })
    const { code, out } = await runProtect([], { gh })
    expect(code).toBe(0)
    expect(gh.requests.filter((r) => r.rest.startsWith(PROTECTION))).toEqual([
      { method: 'GET', rest: PROTECTION, body: undefined },
      { method: 'POST', rest: CONTEXTS, body: ['review/agent'] },
      { method: 'POST', rest: ENFORCE, body: undefined },
    ])
    expect(out).toMatch(/already there, so the project's own is kept/)
    expect(out).toMatch(/added review\/agent to its required status checks/)
    expect(out).toMatch(/turned enforce_admins on/)
    expect(out).toMatch(/Everything else in it is as it was/)
  })

  it('ST-50/AC-5: with only one of the two missing it adds only that one', async () => {
    const noAdmins = fakeGitHub({ protection: 'existing', existing: { required_status_checks: { contexts: ['test'] }, enforce_admins: { enabled: true } } })
    await runProtect([], { gh: noAdmins })
    expect(writes(noAdmins).map((r) => r.rest)).toEqual([CONTEXTS])
    const noCheck = fakeGitHub({ protection: 'existing', existing: { required_status_checks: { checks: [{ context: 'review/agent' }] }, enforce_admins: { enabled: false } } })
    const { out } = await runProtect([], { gh: noCheck })
    expect(writes(noCheck).map((r) => r.rest)).toEqual([ENFORCE])
    expect(out).toMatch(/review\/agent is already required/)
  })

  it('ST-50/AC-5: with protection already there with both, it sends nothing and exits 0', async () => {
    const gh = fakeGitHub({ protection: 'existing', existing: { required_status_checks: { contexts: ['test', 'review/agent'] }, enforce_admins: { enabled: true } } })
    const { code, out } = await runProtect([], { gh })
    expect(code).toBe(0)
    expect(writes(gh)).toEqual([])
    expect(out).toMatch(/review\/agent is already required/)
    expect(out).toMatch(/enforce_admins is already on/)
  })

  // GitHub's GET shape: objects with `enabled` and `url`, and actors as objects with login or slug.
  const ACTORS = { users: [{ login: 'ann', id: 1 }], teams: [{ slug: 'core', id: 2 }], apps: [{ slug: 'bot', id: 3 }] }
  const NO_CHECKS = {
    url: 'https://api.github.com/x',
    required_pull_request_reviews: {
      url: 'u',
      dismissal_restrictions: { url: 'u', users_url: 'u', teams_url: 'u', ...ACTORS },
      bypass_pull_request_allowances: { users: [{ login: 'bob' }], teams: [], apps: [{ slug: 'ci' }] },
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      required_approving_review_count: 2,
      require_last_push_approval: true,
    },
    restrictions: { url: 'u', users_url: 'u', teams_url: 'u', apps_url: 'u', ...ACTORS },
    enforce_admins: { url: 'u', enabled: false },
    required_linear_history: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    block_creations: { enabled: true },
    required_conversation_resolution: { enabled: true },
    lock_branch: { enabled: false },
    allow_fork_syncing: { enabled: true },
  }

  it('ST-50/AC-5: protection with no status checks is rebuilt by one PUT keeping every setting, plus review/agent and enforce_admins', async () => {
    const gh = fakeGitHub({ protection: 'existing', existing: NO_CHECKS })
    const { code, out } = await runProtect([], { gh })
    expect(code).toBe(0)
    expect(gh.requests.filter((r) => r.rest.startsWith(PROTECTION))).toEqual([
      { method: 'GET', rest: PROTECTION, body: undefined },
      {
        method: 'PUT',
        rest: PROTECTION,
        body: {
          required_status_checks: { strict: false, contexts: ['review/agent'] },
          enforce_admins: true,
          required_pull_request_reviews: {
            dismissal_restrictions: { users: ['ann'], teams: ['core'], apps: ['bot'] },
            bypass_pull_request_allowances: { users: ['bob'], teams: [], apps: ['ci'] },
            dismiss_stale_reviews: true,
            require_code_owner_reviews: false,
            required_approving_review_count: 2,
            require_last_push_approval: true,
          },
          restrictions: { users: ['ann'], teams: ['core'], apps: ['bot'] },
          required_linear_history: true,
          allow_force_pushes: false,
          allow_deletions: false,
          block_creations: true,
          required_conversation_resolution: true,
          lock_branch: false,
          allow_fork_syncing: true,
        },
      },
    ])
    expect(out).toMatch(/required no status checks, so rebuilt it with every setting it had/)
  })

  it('ST-50/AC-5: a rebuild with no reviews or restrictions sends them null, and turns required signatures on again when they were on', async () => {
    const gh = fakeGitHub({ protection: 'existing', existing: { enforce_admins: { enabled: true }, required_signatures: { enabled: true } } })
    const { code } = await runProtect([], { gh })
    expect(code).toBe(0)
    expect(gh.requests.filter((r) => r.rest.startsWith(PROTECTION) && r.method !== 'GET')).toEqual([
      { method: 'PUT', rest: PROTECTION, body: PROTECTION_BODY },
      { method: 'POST', rest: SIGNATURES, body: undefined },
    ])
  })

  it('ST-50/AC-3: the allowlist admits a rebuild PUT exactly: review/agent with strict off, enforce_admins true, the PUT\'s own shape', () => {
    const url = `https://api.github.com/repos/${REPO}${PROTECTION}`
    const put = (body) => () => assertAllowedRequest(REPO, { method: 'PUT', url, body })
    const good = { ...PROTECTION_BODY, required_pull_request_reviews: { required_approving_review_count: 1 }, restrictions: { users: [], teams: [], apps: [] }, required_linear_history: true }
    expect(put(good)).not.toThrow()
    for (const bad of [
      { ...good, enforce_admins: false },
      { ...good, required_status_checks: { strict: true, contexts: ['review/agent'] } },
      { ...good, required_status_checks: { strict: false, contexts: ['review/agent', 'test'] } },
      { ...good, required_status_checks: null },
      { ...good, extra: true },
      { ...good, required_linear_history: { enabled: true } },
      { ...good, required_pull_request_reviews: { dismiss_stale_reviews: 'yes' } },
      { ...good, required_pull_request_reviews: { dismissal_restrictions: { users: [{ login: 'ann' }] } } },
      { ...good, restrictions: { users: ['ann'] } },
      { enforce_admins: true, required_status_checks: PROTECTION_BODY.required_status_checks },
    ]) {
      expect(put(bad), JSON.stringify(bad)).toThrow(/refusing/)
    }
  })

  it('ST-50/AC-5: a rate limit 403 on protection stops it with exit 1', async () => {
    const { code, err } = await runProtect([], { gh: fakeGitHub({ protection: 'limited' }) })
    expect(code).toBe(1)
    expect(err).toMatch(/rate limit/)
  })

  it('ST-50/AC-5: a 403 or 404 that says neither the plan nor admin rights stops it', async () => {
    for (const status of [403, 404]) {
      const gh = fakeGitHub()
      const original = gh.fetch
      gh.fetch = async (url, init) => (init.method === 'PUT' ? { status, text: async () => JSON.stringify({ message: 'Not Found' }) } : original(url, init))
      const { code, err } = await runProtect([], { gh })
      expect(code, String(status)).toBe(1)
      expect(err, String(status)).toMatch(/protect stopped: .*Not Found/)
    }
  })

  it('ST-50/AC-5: a refusal in the middle of adding to existing protection ends it as the plan or admin refusal does, with exit 1', async () => {
    const gh = fakeGitHub({ protection: 'existing' })
    const original = gh.fetch
    gh.fetch = async (url, init) =>
      init.method === 'POST' && url.endsWith('enforce_admins') ? { status: 403, text: async () => JSON.stringify({ message: MESSAGES.admin }) } : original(url, init)
    const { code, out } = await runProtect([], { gh })
    expect(code).toBe(1)
    expect(out).toMatch(/cannot set it/)
  })

  it('ST-50/AC-5: any other failed request exits 1', async () => {
    const { code, err } = await runProtect([], { gh: fakeGitHub({ protection: 'broken' }) })
    expect(code).toBe(1)
    expect(err).toMatch(/protect stopped: .*(500|server error)/)
  })
})

describe('ST-50/AC-6: the protection code moved to protect.mjs', () => {
  it('ST-50/AC-6: init.mjs no longer exports the protection code, and protect.mjs does', async () => {
    const moved = ['PROTECTION_BODY', 'buildGetProtection', 'buildSetProtection', 'buildAddRequiredCheck', 'buildEnableEnforceAdmins', 'buildRebuildProtection', 'buildEnableRequiredSignatures', 'isProtectionPut', 'rebuildProtectionBody', 'protectMain']
    const protect = await import('./protect.mjs')
    for (const name of moved) {
      expect(protect[name], name).toBeDefined()
      expect(init[name], name).toBeUndefined()
    }
  })
})

describe('ST-50/AC-11: what protect prints is written for the person running it', () => {
  it('ST-50/AC-11: each case of ST-50/AC-3 to AC-5 prints no story or criterion id, script or module file', async () => {
    const cases = [
      { args: [] },
      { args: ['--repo', REPO] },
      { args: ['--nope'] },
      { args: [], cwd: makeCwd(null) },
      { args: [], gh: fakeGitHub({ main: false }) },
      { args: [], gh: fakeGitHub({ have: [] }) },
      ...ON_MAIN.map((missing) => ({ args: [], gh: fakeGitHub({ have: ON_MAIN.filter((f) => f !== missing) }) })),
      { args: [], gh: fakeGitHub({ config: { rulesFile: '../x' } }) },
      { args: [], gh: fakeGitHub({ readStatus: { main: 500 } }) },
      { args: [], gh: fakeGitHub({ readStatus: { 'REVIEW.md': 500 } }) },
      { args: [], gh: fakeGitHub({ protection: 'plan' }) },
      { args: [], gh: fakeGitHub({ protection: 'admin' }) },
      { args: [], gh: fakeGitHub({ protection: 'existing' }) },
      { args: [], gh: fakeGitHub({ protection: 'existing', existing: { enforce_admins: { enabled: true }, required_signatures: { enabled: true } } }) },
      { args: [], gh: fakeGitHub({ protection: 'limited' }) },
      { args: [], gh: fakeGitHub({ protection: 'broken' }) },
    ]
    for (const [i, one] of cases.entries()) {
      const { out, err } = await runProtect(one.args, { gh: one.gh, cwd: one.cwd })
      expect(`${out}\n${err}`, `case ${i}`).not.toMatch(MENTIONS_STEWARD_INTERNALS)
    }
    const message = (() => {
      try {
        assertAllowedRequest(REPO, { method: 'DELETE', url: `https://api.github.com/repos/${REPO}/labels/inspection` })
      } catch (error) {
        return error.message
      }
      return ''
    })()
    expect(message).toMatch(/refusing/)
    expect(message).not.toMatch(MENTIONS_STEWARD_INTERNALS)
  })

  it('ST-50/AC-11: a refusal says what was left as it was and what to do next', async () => {
    const { out } = await runProtect([], { gh: fakeGitHub({ have: ON_MAIN.slice(0, 2) }) })
    expect(out).toMatch(/Branch protection was not set, and nothing on GitHub was changed/)
    expect(out).toMatch(/then run steward protect again/)
  })
})
