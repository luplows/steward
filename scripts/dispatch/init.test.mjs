// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BREAKER_OVERRIDE_LABEL, REVIEW_BLOCKED_LABEL } from '../land/runway.mjs'
import { REVIEW_BLOCKED_LABEL as APPLY_REVIEW_BLOCKED_LABEL } from '../land/apply-review-blocked.mjs'
import { INSPECTION_LABEL } from './inspect.mjs'
import {
  assertAllowedRequest,
  findOnPath,
  GATE_WORKFLOWS,
  INSPECTION_WORKFLOW,
  LABELS,
  main,
  PROTECTION_BODY,
  QUESTIONS,
  repoFromRemoteUrl,
} from './init.mjs'
import { readMachineSettings } from './machine-settings.mjs'
import { readSettings } from './settings.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLI = path.join(ROOT, 'scripts', 'dispatch', 'cli.mjs')
const SHA = '0123456789abcdef0123456789abcdef01234567'
const REPO = 'acme/widgets'

// Every test runs init in a temporary repository, with GitHub's answers injected, the machine's
// settings in a temporary file and the terminal injected: nothing for real.
let base
beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 'steward-init-'))
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

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** A temporary repository with one commit (a `package.json`), and `origin` when given. */
function makeRepo({ origin = `https://github.com/${REPO}.git`, files = {} } = {}) {
  const dir = fresh('repo')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'crew@example.com')
  git(dir, 'config', 'user.name', 'Crew')
  git(dir, 'config', 'commit.gpgsign', 'false')
  if (origin !== null) git(dir, 'remote', 'add', 'origin', origin)
  writeFileSync(path.join(dir, 'package.json'), '{"name":"widgets","version":"1.0.0"}\n')
  put(dir, files)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'start')
  return dir
}

function put(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), text)
  }
}

/** A copy of steward's `templates/`, with a `package.json` whose version is `version`. */
function makePackage(version = '9.8.7') {
  const dir = fresh('package')
  cpSync(path.join(ROOT, 'templates'), path.join(dir, 'templates'), { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'steward', version }))
  return dir
}

const MESSAGES = {
  upgrade: 'Upgrade to GitHub Pro or make this repository public to enable this feature.',
  admin: 'Must have admin rights to Repository.',
}

/**
 * GitHub's answers, injected as `fetch`. `protection` is `none` (not protected, and settable),
 * `existing`, `plan` (every protection request refused for the plan), `admin` (settable only with
 * admin rights the account lacks), `limited` (a rate limit's 403) or `broken` (a 500); `existing` is
 * the body returned for `existing`. `labelCreate` is `already_exists` or `other` (a 422 for each).
 * Records every request.
 */
function fakeGitHub({ labels = [], protection = 'none', labelStatus = null, labelCreate = null, existing = null } = {}) {
  const have = new Set(labels)
  const requests = []
  const fetch = async (url, init) => {
    const rest = /\/repos\/[^/]+\/[^/]+(\/.*)$/.exec(url)[1]
    const body = init.body === undefined ? undefined : JSON.parse(init.body)
    requests.push({ method: init.method, rest, body })
    const reply = (status, content) => ({ status, text: async () => (content === undefined ? '' : JSON.stringify(content)) })
    const label = /^\/labels\/(.+)$/.exec(rest)
    if (label && init.method === 'GET') {
      if (labelStatus !== null) return reply(labelStatus, { message: 'boom' })
      return have.has(decodeURIComponent(label[1])) ? reply(200, { name: label[1] }) : reply(404, { message: 'Not Found' })
    }
    if (rest === '/labels' && init.method === 'POST') {
      if (labelCreate === 'already_exists') return reply(422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] })
      if (labelCreate === 'other') return reply(422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'invalid', field: 'color' }] })
      have.add(body.name)
      return reply(201, body)
    }
    if (rest.startsWith('/branches/main/protection/') && init.method === 'POST') return reply(200, {})
    if (rest === '/branches/main/protection') {
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
  return { fetch, requests, have }
}

const writes = (gh) => gh.requests.filter((r) => r.method !== 'GET')

/** A terminal: `answers` are given in order, one per question; `prompts` records what was asked. */
function fakeTerminal(answers = null) {
  const prompts = []
  return {
    isTTY: answers !== null,
    prompts,
    written: [],
    write(text) {
      this.written.push(text)
    },
    async question(prompt) {
      prompts.push(prompt)
      return answers.shift() ?? ''
    },
  }
}

/** Runs `init` in `cwd`; resolves `{ code, out, err, machine, gh, terminal }`. */
async function runInit(args, { cwd, gh = fakeGitHub(), terminal = fakeTerminal(), pkg = makePackage(), machine = path.join(fresh('home'), 'settings.json'), codex = null, exists } = {}) {
  const out = []
  const err = []
  const code = await main(args, {
    cwd,
    env: { STEWARD_SETTINGS: machine },
    homedir: fresh('profile'),
    fetch: gh.fetch,
    getToken: async () => 'token',
    terminal,
    findExecutable: () => codex,
    ...(exists ? { exists } : {}),
    packageRoot: pkg,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  })
  return { code, out: out.join('\n'), err: err.join('\n'), machine, gh, terminal, pkg }
}

/** Every file under `dir` except `.git`, as relative paths, sorted. */
function tree(dir, rel = '') {
  return readdirSync(path.join(dir, rel), { withFileTypes: true })
    .flatMap((e) => {
      const r = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.name === '.git') return []
      return e.isDirectory() ? tree(dir, r) : [r]
    })
    .sort()
}

const read = (dir, rel) => readFileSync(path.join(dir, rel), 'utf8')

const ALL_FLAGS = [
  '--unit-links', 'file,issue,other', '--rules-file', 'docs/RULES.md', '--land', 'no', '--inspect-after-hours', '48',
  '--inspection', 'yes', '--protect-main', 'no', '--coder-session-limit', '60', '--coder-weekly-limit', '65',
  '--reviewer-session-limit', '80', '--reviewer-weekly-limit', '85',
]

describe('ST-44/AC-1: init never overwrites, and names what it left', () => {
  it('ST-44/AC-1: a second run writes nothing and names every file it wrote the first time', async () => {
    const cwd = makeRepo()
    const gh = fakeGitHub()
    const machine = path.join(fresh('home'), 'settings.json')
    const pkg = makePackage()
    const first = await runInit(['--yes'], { cwd, gh, machine, pkg })
    expect(first.code).toBe(0)
    const wrote = [...first.out.matchAll(/^wrote (.+)$/gm)].map((m) => m[1])
    expect(wrote.length).toBeGreaterThanOrEqual(7)
    const before = tree(cwd).map((rel) => [rel, read(cwd, rel)])
    const settingsBefore = readFileSync(machine, 'utf8')

    const second = await runInit(['--yes'], { cwd, gh, machine, pkg })
    expect(second.code).toBe(0)
    expect(second.out).not.toMatch(/^wrote /m)
    for (const rel of wrote.filter((w) => !w.includes("the machine's settings"))) expect(second.out).toContain(`left ${rel}: `)
    expect(second.out).toContain(`left ${machine}`)
    expect(tree(cwd).map((rel) => [rel, read(cwd, rel)])).toEqual(before)
    expect(readFileSync(machine, 'utf8')).toBe(settingsBefore)
  })

  it('ST-44/AC-1: a file already there, with other content, keeps it', async () => {
    const cwd = makeRepo({ files: { 'REVIEW.md': 'my rules\n', '.github/workflows/review-gate.yml': 'mine\n', 'steward.config.json': '{}\n' } })
    const { code, out, err } = await runInit(['--yes'], { cwd })
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(read(cwd, 'REVIEW.md')).toBe('my rules\n')
    expect(read(cwd, '.github/workflows/review-gate.yml')).toBe('mine\n')
    expect(read(cwd, 'steward.config.json')).toBe('{}\n')
    for (const rel of ['REVIEW.md', '.github/workflows/review-gate.yml', 'steward.config.json']) {
      expect(out).toContain(`left ${rel}: already there`)
    }
  })

  it('ST-44/AC-1: is a command of cli.mjs, runs no model, and a checkout that is not a git repository is refused', () => {
    const dir = fresh('not-a-repo')
    let result
    try {
      execFileSync(process.execPath, [CLI, 'init', '--yes'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
    } catch (error) {
      result = error
    }
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/not in a git repository/)
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('ST-44/AC-2: asking', () => {
  it('ST-44/AC-2: every question answered by flags asks nothing, and refuses nothing with no terminal', async () => {
    const cwd = makeRepo()
    const terminal = fakeTerminal()
    const { code, err } = await runInit(ALL_FLAGS, { cwd, terminal })
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(terminal.prompts).toEqual([])
    const settings = await readSettings(cwd)
    expect(settings).toMatchObject({ unitLinks: ['file', 'issue', 'other'], rulesFile: 'docs/RULES.md', land: false, inspectAfterHours: 48 })
  })

  it('ST-44/AC-2: --yes alone takes every default', async () => {
    const cwd = makeRepo()
    const machine = path.join(fresh('home'), 'settings.json')
    const gh = fakeGitHub()
    const { code } = await runInit(['--yes'], { cwd, machine, gh })
    expect(code).toBe(0)
    expect(await readSettings(cwd)).toMatchObject({ unitLinks: ['file', 'issue'], rulesFile: 'REVIEW.md', land: true, inspectAfterHours: 24 })
    expect(existsSync(path.join(cwd, '.github/workflows/inspection.yml'))).toBe(true)
    expect(writes(gh).some((r) => r.rest === '/branches/main/protection')).toBe(false)
  })

  it('ST-44/AC-2: with no terminal and no answer it refuses, names each question and its flag, and writes nothing', async () => {
    const cwd = makeRepo()
    const gh = fakeGitHub()
    const machine = path.join(fresh('home'), 'settings.json')
    const before = tree(cwd)
    const { code, err } = await runInit([], { cwd, gh, machine })
    expect(code).toBe(2)
    for (const flag of ['--unit-links', '--rules-file', '--land', '--inspect-after-hours', '--inspection', '--protect-main', '--coder-session-limit']) {
      expect(err).toContain(flag)
    }
    expect(err).toContain('Nothing was written')
    expect(tree(cwd)).toEqual(before)
    expect(existsSync(machine)).toBe(false)
    expect(gh.requests).toEqual([])
  })

  it('ST-44/AC-2: one question left unanswered is the one named', async () => {
    const cwd = makeRepo()
    const flags = ALL_FLAGS.filter((_, i) => !(i >= 2 && i <= 3))
    const { code, err } = await runInit(flags, { cwd })
    expect(code).toBe(2)
    expect(err).toContain('--rules-file')
    expect(err).not.toContain('--unit-links:')
    expect(tree(cwd)).toEqual(['package.json'])
  })

  it('ST-44/AC-2: an answer at the terminal is used, and the prompt shows its default', async () => {
    const cwd = makeRepo()
    const terminal = fakeTerminal(['issue', '', 'no', '12', 'no', 'no', '', '', '', ''])
    const { code } = await runInit([], { cwd, terminal })
    expect(code).toBe(0)
    expect(terminal.prompts.length).toBe(10)
    expect(terminal.prompts[0]).toContain('[file,issue]')
    expect(terminal.prompts[1]).toContain('[REVIEW.md]')
    expect(terminal.prompts[5]).toContain('[no]')
    expect(await readSettings(cwd)).toMatchObject({ unitLinks: ['issue'], rulesFile: 'REVIEW.md', land: false, inspectAfterHours: 12 })
    expect(existsSync(path.join(cwd, '.github/workflows/inspection.yml'))).toBe(false)
  })

  it('ST-44/AC-2: a wrong answer at the terminal is asked again; a wrong flag is refused before anything is written', async () => {
    const cwd = makeRepo()
    const terminal = fakeTerminal(['everything', 'none', ...Array(9).fill('')])
    const { code } = await runInit([], { cwd, terminal })
    expect(code).toBe(0)
    expect(terminal.prompts.length).toBe(11)
    expect(terminal.written.join('')).toMatch(/'everything' is not one of/)
    expect((await readSettings(cwd)).unitLinks).toEqual([])

    const other = makeRepo()
    const refused = await runInit(ALL_FLAGS.map((x) => (x === 'file,issue,other' ? 'wiki' : x)), { cwd: other })
    expect(refused.code).toBe(2)
    expect(refused.err).toMatch(/--unit-links wiki/)
    expect(tree(other)).toEqual(['package.json'])
  })

  it('ST-44/AC-2: every question has its own flag, and a flag init does not know is refused', async () => {
    expect(new Set(QUESTIONS.map((q) => q.flag)).size).toBe(QUESTIONS.length)
    const cwd = makeRepo()
    const { code, err } = await runInit(['--yes', '--nope'], { cwd })
    expect(code).toBe(2)
    expect(err).toMatch(/--nope/)
    expect(tree(cwd)).toEqual(['package.json'])
  })
})

describe('ST-44/AC-3: steward.config.json', () => {
  it('ST-44/AC-3: it has a value for every key, and readSettings reads it', async () => {
    const cwd = makeRepo()
    await runInit(['--yes'], { cwd })
    const text = JSON.parse(read(cwd, 'steward.config.json'))
    expect(Object.keys(text).sort()).toEqual(['check', 'inspectAfterHours', 'land', 'landWhen', 'repo', 'rulesFile', 'setup', 'unitLinks'])
    expect(await readSettings(cwd)).toEqual({
      repo: REPO, setup: null, check: null, landWhen: 'all-checks', land: true, unitLinks: ['file', 'issue'], rulesFile: 'REVIEW.md', inspectAfterHours: 24,
    })
  })

  it('ST-44/AC-3: repo is read from an https or an ssh URL of origin', async () => {
    expect(repoFromRemoteUrl('https://github.com/acme/widgets.git')).toBe('acme/widgets')
    expect(repoFromRemoteUrl('https://github.com/acme/widgets')).toBe('acme/widgets')
    expect(repoFromRemoteUrl('https://x-token@github.com/acme/widgets.git')).toBe('acme/widgets')
    expect(repoFromRemoteUrl('git@github.com:acme/widgets.git')).toBe('acme/widgets')
    expect(repoFromRemoteUrl('ssh://git@github.com/acme/widgets.git')).toBe('acme/widgets')
    expect(repoFromRemoteUrl('https://gitlab.com/acme/widgets.git')).toBeNull()
    expect(repoFromRemoteUrl('../elsewhere')).toBeNull()
    const cwd = makeRepo({ origin: 'git@github.com:acme/gadgets.git' })
    await runInit(['--yes'], { cwd })
    expect((await readSettings(cwd)).repo).toBe('acme/gadgets')
  })

  it('ST-44/AC-3: with no origin it can read as a GitHub repository, it writes no settings file, says why, and creates no label', async () => {
    for (const origin of [null, 'https://gitlab.com/acme/widgets.git']) {
      const cwd = makeRepo({ origin })
      const gh = fakeGitHub()
      const { code, out } = await runInit(['--yes', '--protect-main', 'yes'], { cwd, gh })
      expect(code).toBe(0)
      expect(existsSync(path.join(cwd, 'steward.config.json'))).toBe(false)
      expect(out).toMatch(/did not write steward\.config\.json: .*origin/)
      expect(gh.requests).toEqual([])
      expect(existsSync(path.join(cwd, 'REVIEW.md'))).toBe(true)
    }
  })

  it('ST-44/AC-3: unitLinks none is written as an empty array, and setup, check and landWhen are fixed', async () => {
    const cwd = makeRepo()
    await runInit(['--yes', '--unit-links', 'none'], { cwd })
    expect(await readSettings(cwd)).toMatchObject({ unitLinks: [], setup: null, check: null, landWhen: 'all-checks' })
  })

  it('ST-44/AC-3: the question about unitLinks says what other covers', () => {
    const q = QUESTIONS.find((x) => x.flag === '--unit-links')
    expect(q.prompt).toMatch(/other.*tracker steward cannot read yet.*passed to the reviewer unread/)
    expect(q.default).toBe('file,issue')
  })
})

describe('ST-44/AC-4: the example checklist', () => {
  it('ST-44/AC-4: is copied byte for byte to the rulesFile path', async () => {
    const cwd = makeRepo()
    await runInit(['--yes', '--rules-file', 'docs/rules/CHECKLIST.md'], { cwd })
    expect(readFileSync(path.join(cwd, 'docs/rules/CHECKLIST.md'))).toEqual(readFileSync(path.join(ROOT, 'templates', 'review-checklist.md')))
  })

  it('ST-44/AC-4: a file already at the path is left and reported', async () => {
    const cwd = makeRepo({ files: { 'docs/RULES.md': 'mine' } })
    const { out } = await runInit(['--yes', '--rules-file', 'docs/RULES.md'], { cwd })
    expect(read(cwd, 'docs/RULES.md')).toBe('mine')
    expect(out).toContain('left docs/RULES.md: already there')
  })
})

describe('ST-44/AC-5: the thin workflow files', () => {
  it('ST-44/AC-5: from a steward whose version is 9.8.7, each file has v9.8.7 and no placeholder', async () => {
    const cwd = makeRepo()
    await runInit(['--yes'], { cwd, pkg: makePackage('9.8.7') })
    for (const file of [...GATE_WORKFLOWS, INSPECTION_WORKFLOW]) {
      const text = read(cwd, `.github/workflows/${file}`)
      expect(text).toContain('--package=github:luplows/steward#v9.8.7 steward ')
      expect(text).not.toMatch(/\{\{[A-Z_]+\}\}/)
      expect(text).not.toContain('STEWARD_VERSION')
    }
    expect(read(cwd, '.github/workflows/review-gate.yml')).toBe(
      readFileSync(path.join(ROOT, 'templates/workflows/review-gate.yml'), 'utf8').replaceAll('v{{STEWARD_VERSION}}', () => 'v9.8.7'),
    )
  })

  it('ST-44/AC-5a: --ref fills every workflow file with that commit, in place of v<version>', async () => {
    const cwd = makeRepo()
    const { code } = await runInit(['--yes', '--ref', SHA], { cwd, pkg: makePackage('9.8.7') })
    expect(code).toBe(0)
    for (const file of [...GATE_WORKFLOWS, INSPECTION_WORKFLOW]) {
      const text = read(cwd, `.github/workflows/${file}`)
      expect(text).toContain(`--package=github:luplows/steward#${SHA} steward `)
      expect(text).not.toContain('v9.8.7')
      expect(text).not.toMatch(/\{\{[A-Z_]+\}\}/)
    }
  })

  it('ST-44/AC-5a: --ref is not asked by a question, and --yes leaves it unset', async () => {
    expect(QUESTIONS.some((q) => q.flag === '--ref')).toBe(false)
    const cwd = makeRepo()
    await runInit(['--yes'], { cwd, pkg: makePackage('9.8.7') })
    expect(read(cwd, '.github/workflows/land-approved.yml')).toContain('#v9.8.7 steward')
  })

  it('ST-44/AC-5a: a tag, a short SHA or a SHA of the wrong length is refused, writing nothing', async () => {
    for (const ref of ['v0.1.0', SHA.slice(0, 12), `${SHA}0`, 'g'.repeat(40), '']) {
      const cwd = makeRepo()
      const gh = fakeGitHub()
      const { code, err } = await runInit(['--yes', '--ref', ref], { cwd, gh })
      expect(code, ref).toBe(2)
      expect(err).toMatch(/--ref/)
      expect(tree(cwd)).toEqual(['package.json'])
      expect(gh.requests).toEqual([])
    }
  })
})

describe('ST-44/AC-6: inspection', () => {
  it('ST-44/AC-6: on a yes it writes the thin inspection workflow, pinned, and warns of the first run', async () => {
    const cwd = makeRepo()
    const { out } = await runInit(['--yes', '--inspection', 'yes'], { cwd })
    expect(read(cwd, '.github/workflows/inspection.yml')).toContain('run: npx --yes --package=github:luplows/steward#v9.8.7 steward inspect')
    expect(out).toMatch(/first run may raise, as issues, earlier merges and commits on main within its window that had no passing verdict/)
    expect(out).toMatch(/crew closes each once/)
  })

  it('ST-44/AC-6: on a no it writes no inspection workflow and gives no warning, and still creates the inspection label', async () => {
    const cwd = makeRepo()
    const gh = fakeGitHub()
    const { out } = await runInit(['--yes', '--inspection', 'no'], { cwd, gh })
    expect(existsSync(path.join(cwd, '.github/workflows/inspection.yml'))).toBe(false)
    expect(out).not.toMatch(/first run may raise/)
    expect(gh.requests.some((r) => r.method === 'POST' && r.body.name === 'inspection')).toBe(true)
  })

  it('ST-44/AC-6: the inspection label is not created again when the repository has it', async () => {
    const gh = fakeGitHub({ labels: ['inspection'] })
    await runInit(['--yes', '--inspection', 'no'], { cwd: makeRepo(), gh })
    expect(gh.requests.some((r) => r.method === 'POST' && r.body.name === 'inspection')).toBe(false)
  })
})

describe('ST-44/AC-7: labels', () => {
  const labelConstants = (file) =>
    [...readFileSync(path.join(ROOT, file), 'utf8').matchAll(/\b[A-Z_]*LABEL\s*=\s*'([^']+)'/g)].map((m) => m[1])

  it('ST-44/AC-7: LABELS holds exactly the labels the gate\'s, the runway\'s and inspection\'s commands apply and read', () => {
    expect(LABELS.map((l) => l.name).sort()).toEqual([BREAKER_OVERRIDE_LABEL, INSPECTION_LABEL, REVIEW_BLOCKED_LABEL].sort())
    expect(APPLY_REVIEW_BLOCKED_LABEL).toBe(REVIEW_BLOCKED_LABEL)
    const named = new Set(
      ['scripts/land/apply-review-blocked.mjs', 'scripts/land/runway.mjs', 'scripts/dispatch/inspect.mjs'].flatMap(labelConstants),
    )
    expect([...named].sort()).toEqual(LABELS.map((l) => l.name).sort())
  })

  it('ST-44/AC-7: creates each missing label, leaves one that exists, and prints each', async () => {
    const gh = fakeGitHub({ labels: ['breaker-override'] })
    const { out, code } = await runInit(['--yes'], { cwd: makeRepo(), gh })
    expect(code).toBe(0)
    expect(writes(gh).filter((r) => r.rest === '/labels').map((r) => r.body.name)).toEqual(['review-blocked', 'inspection'])
    expect(out).toContain('label review-blocked: created')
    expect(out).toContain('label breaker-override: found, left as it is')
    expect(out).toContain('label inspection: created')
  })

  it('ST-44/AC-7: init asks GitHub for nothing outside the labels and main\'s protection', () => {
    expect(() => assertAllowedRequest(REPO, { method: 'DELETE', url: `https://api.github.com/repos/${REPO}/labels/inspection` })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'POST', url: `https://api.github.com/repos/${REPO}/issues`, body: {} })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'GET', url: `https://api.github.com/repos/${REPO}/labels/other` })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'PUT', url: `https://api.github.com/repos/${REPO}/branches/main/protection`, body: { enforce_admins: false } })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'PUT', url: `https://api.github.com/repos/${REPO}/branches/main/protection`, body: PROTECTION_BODY })).not.toThrow()
    const base = `https://api.github.com/repos/${REPO}/branches/main/protection`
    const contexts = { method: 'POST', url: `${base}/required_status_checks/contexts`, body: ['review/agent'] }
    expect(() => assertAllowedRequest(REPO, contexts)).not.toThrow()
    expect(() => assertAllowedRequest(REPO, { ...contexts, body: ['review/agent', 'x'] })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { ...contexts, method: 'PUT' })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'POST', url: `${base}/enforce_admins` })).not.toThrow()
    expect(() => assertAllowedRequest(REPO, { method: 'DELETE', url: `${base}/enforce_admins` })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'POST', url: `${base}/enforce_admins`, body: {} })).toThrow(/refusing/)
  })
})

describe('ST-44/AC-8: the pull request template', () => {
  const TEMPLATE = path.join(ROOT, 'templates', 'pull_request_template.md')

  it('ST-44/AC-8: with none in the project, it writes the package\'s, which names neither AGENTS.md nor README.md', async () => {
    const cwd = makeRepo()
    await runInit(['--yes'], { cwd })
    const text = read(cwd, '.github/pull_request_template.md')
    expect(text).toBe(readFileSync(TEMPLATE, 'utf8'))
    expect(text).toMatch(/^Unit:/m)
    expect(text.match(/^## .+$/gm)).toEqual(['## What changed', '## Verification', '## Docs check'])
    expect(text).toMatch(/which documentation this change affects and what you updated, or why\s+none needed it/i)
    expect(text).not.toMatch(/AGENTS\.md|README\.md/)
  })

  it('ST-44/AC-8: steward\'s own template is not the package\'s, and is unchanged', () => {
    expect(readFileSync(path.join(ROOT, '.github', 'pull_request_template.md'), 'utf8')).toMatch(/README\.md/)
  })

  it('ST-44/AC-8: a template in docs/ with no Unit: line is left, edited not, and reported by name', async () => {
    const cwd = makeRepo({ files: { 'docs/pull_request_template.md': '## Summary\n' } })
    const { out } = await runInit(['--yes'], { cwd })
    expect(read(cwd, 'docs/pull_request_template.md')).toBe('## Summary\n')
    expect(existsSync(path.join(cwd, '.github/pull_request_template.md'))).toBe(false)
    expect(out).toContain('docs/pull_request_template.md has no Unit: line')
  })

  it('ST-44/AC-8: a template in .github/ with a Unit: line is left, and nothing is said of the line', async () => {
    const cwd = makeRepo({ files: { '.github/pull_request_template.md': 'Unit:\n\n## Summary\n' } })
    const { out } = await runInit(['--yes'], { cwd })
    expect(read(cwd, '.github/pull_request_template.md')).toBe('Unit:\n\n## Summary\n')
    expect(out).toContain('left .github/pull_request_template.md: the project\'s pull request template')
    expect(out).not.toMatch(/no Unit: line/)
  })

  it('ST-44/AC-8: a template at the root, in any case, or in a PULL_REQUEST_TEMPLATE/ directory counts as one', async () => {
    for (const files of [{ 'PULL_REQUEST_TEMPLATE.md': 'x' }, { '.github/PULL_REQUEST_TEMPLATE/bug.md': 'x' }, { 'docs/PULL_REQUEST_TEMPLATE/a.md': 'Unit:' }]) {
      const cwd = makeRepo({ files })
      await runInit(['--yes'], { cwd })
      expect(existsSync(path.join(cwd, '.github/pull_request_template.md'))).toBe(false)
    }
  })
})

describe('ST-44/AC-9: the machine\'s settings', () => {
  it('ST-44/AC-9: a missing file is written from the defaults, and readMachineSettings reads it', async () => {
    const machine = path.join(fresh('home'), 'sub', 'settings.json')
    const { code } = await runInit(['--yes'], { cwd: makeRepo(), machine })
    expect(code).toBe(0)
    const settings = await readMachineSettings({ env: { STEWARD_SETTINGS: machine }, homedir: '/nowhere' })
    expect(settings.roles.reviewer.default).toBe('opus')
    expect(settings.roles.coder.default).toBe('sonnet')
    expect(settings.roles.coder.available).toMatchObject({
      sonnet: { tool: 'claude', model: 'sonnet', strength: 1 },
      opus: { tool: 'claude', model: 'opus', strength: 2 },
    })
    expect(settings.usageLimits).toEqual({ coder: { session: 70, weekly: 75 }, reviewer: { session: 90, weekly: 90 } })
    expect(settings.tools).toBeUndefined()
  })

  it('ST-44/AC-9: a limit given by flag is written', async () => {
    const machine = path.join(fresh('home'), 'settings.json')
    await runInit(['--yes', '--coder-session-limit', '50', '--reviewer-weekly-limit', '95'], { cwd: makeRepo(), machine })
    const { usageLimits } = await readMachineSettings({ env: { STEWARD_SETTINGS: machine }, homedir: '/nowhere' })
    expect(usageLimits).toEqual({ coder: { session: 50, weekly: 75 }, reviewer: { session: 90, weekly: 95 } })
  })

  it('ST-44/AC-9: a file that exists is not read, changed or replaced', async () => {
    const machine = path.join(fresh('home'), 'settings.json')
    writeFileSync(machine, 'not even json')
    const before = statSync(machine).mtimeMs
    const terminal = fakeTerminal(['file,issue', '', '', '', '', ''])
    const { code, out } = await runInit([], { cwd: makeRepo(), machine, terminal })
    expect(code).toBe(0)
    expect(readFileSync(machine, 'utf8')).toBe('not even json')
    expect(statSync(machine).mtimeMs).toBe(before)
    expect(out).toContain(`left ${machine}`)
    expect(terminal.prompts.some((p) => /usage/.test(p))).toBe(false)
  })

  it('ST-44/AC-9: a Codex choice is offered only when codex is found or its path given', async () => {
    const withoutCodex = fakeTerminal(['', '', '', '', '', '', '', '', '', ''])
    await runInit([], { cwd: makeRepo(), terminal: withoutCodex })
    expect(withoutCodex.prompts.some((p) => /codex/i.test(p))).toBe(false)

    const exe = path.join(fresh('bin'), 'codex.exe')
    writeFileSync(exe, '')
    const offered = fakeTerminal(['', '', '', '', '', '', '', '', '', '', '', ''])
    await runInit([], { cwd: makeRepo(), terminal: offered, codex: exe })
    expect(offered.prompts.some((p) => /codex/i.test(p))).toBe(true)

    const refused = await runInit(['--yes', '--reviewer', 'codex', '--codex-model', 'm', '--codex-effort', 'high'], { cwd: makeRepo() })
    expect(refused.code).toBe(2)
    expect(refused.err).toMatch(/--reviewer codex.*--codex-path/)
  })

  it('ST-44/AC-9: when the crew takes Codex, its model and effort have no default, and the path is written as tools.codex.executable', async () => {
    const exe = path.join(fresh('bin'), 'codex.exe')
    writeFileSync(exe, '')
    const missing = await runInit(['--yes', '--reviewer', 'codex'], { cwd: makeRepo(), codex: exe })
    expect(missing.code).toBe(2)
    expect(missing.err).toContain('--codex-model')
    expect(missing.err).toContain('--codex-effort')
    expect(existsSync(missing.machine)).toBe(false)

    const machine = path.join(fresh('home'), 'settings.json')
    const { code } = await runInit(['--yes', '--reviewer', 'codex', '--codex-model', 'gpt-x', '--codex-effort', 'ultra'], { cwd: makeRepo(), machine, codex: exe })
    expect(code).toBe(0)
    const settings = await readMachineSettings({ env: { STEWARD_SETTINGS: machine }, homedir: '/nowhere' })
    expect(settings.roles.reviewer.default).toBe('codex')
    expect(settings.roles.reviewer.available.codex).toEqual({ tool: 'codex', model: 'gpt-x', effort: 'ultra' })
    expect(settings.tools.codex.executable).toBe(exe)
  })

  it('ST-44/AC-9: --codex-path names the executable when codex is not on the PATH, and must be a file that exists', async () => {
    const exe = path.join(fresh('bin'), 'codex')
    writeFileSync(exe, '')
    const machine = path.join(fresh('home'), 'settings.json')
    const ok = await runInit(['--yes', '--reviewer', 'codex', '--codex-path', exe, '--codex-model', 'm', '--codex-effort', 'low'], { cwd: makeRepo(), machine })
    expect(ok.code).toBe(0)
    expect((await readMachineSettings({ env: { STEWARD_SETTINGS: machine }, homedir: '/nowhere' })).tools.codex.executable).toBe(exe)
    const bad = await runInit(['--yes', '--codex-path', path.join(base, 'no-such-codex')], { cwd: makeRepo() })
    expect(bad.code).toBe(2)
    expect(bad.err).toMatch(/--codex-path/)
  })

  it('ST-44/AC-9: findOnPath, as on Windows, tries each of PATHEXT\'s extensions as written', () => {
    const dir = fresh('bin')
    // Named as PATHEXT writes it, so that the file is found on a case-sensitive file system too.
    writeFileSync(path.join(dir, 'codex.CMD'), '')
    expect(findOnPath('codex', { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32')).toBe(path.join(dir, 'codex.CMD'))
    expect(findOnPath('codex', { PATH: dir, PATHEXT: '.EXE' }, 'win32')).toBeNull()
    expect(findOnPath('codex', { PATH: '' }, 'win32')).toBeNull()
  })

  it('ST-44/AC-9: findOnPath, as on POSIX, tries the bare name and wants an executable bit', () => {
    const dir = fresh('bin')
    writeFileSync(path.join(dir, 'codex.cmd'), '')
    chmodSync(path.join(dir, 'codex.cmd'), 0o755)
    expect(findOnPath('codex', { PATH: dir }, 'linux')).toBeNull()
    expect(findOnPath('codex', { PATH: '' }, 'linux')).toBeNull()
    writeFileSync(path.join(dir, 'codex'), '')
    chmodSync(path.join(dir, 'codex'), 0o755)
    expect(findOnPath('codex', { PATH: dir }, 'linux')).toBe(path.join(dir, 'codex'))
  })

  it.skipIf(process.platform === 'win32')('ST-44/AC-9: on a POSIX host a file without an executable bit is not found', () => {
    const dir = fresh('bin')
    writeFileSync(path.join(dir, 'codex'), '')
    chmodSync(path.join(dir, 'codex'), 0o644)
    expect(findOnPath('codex', { PATH: dir }, 'linux')).toBeNull()
  })

  it('ST-44/AC-9: a relative PATH entry gives an absolute executable, which readMachineSettings reads', async () => {
    const dir = fresh('rel')
    mkdirSync(path.join(dir, 'bin'))
    writeFileSync(path.join(dir, 'bin', 'codex'), '')
    chmodSync(path.join(dir, 'bin', 'codex'), 0o755)
    const before = process.cwd()
    process.chdir(dir)
    let found
    try {
      found = findOnPath('codex', { PATH: './bin' }, 'linux')
    } finally {
      process.chdir(before)
    }
    expect(path.isAbsolute(found)).toBe(true)
    const machine = path.join(fresh('home'), 'settings.json')
    const { code } = await runInit(['--yes', '--reviewer', 'codex', '--codex-model', 'm', '--codex-effort', 'low'], { cwd: makeRepo(), machine, codex: found })
    expect(code).toBe(0)
    expect((await readMachineSettings({ env: { STEWARD_SETTINGS: machine }, homedir: '/nowhere' })).tools.codex.executable).toBe(found)
  })
})

describe('ST-44/AC-10: branch protection', () => {
  const PROTECTION = '/branches/main/protection'

  it('ST-44/AC-10: a yes sets it, requiring review/agent with enforce_admins on, and says the crew adds its own checks', async () => {
    const gh = fakeGitHub()
    const { code, out } = await runInit(['--yes', '--protect-main', 'yes'], { cwd: makeRepo(), gh })
    expect(code).toBe(0)
    const put = gh.requests.filter((r) => r.method === 'PUT')
    expect(put).toEqual([{ method: 'PUT', rest: PROTECTION, body: PROTECTION_BODY }])
    expect(PROTECTION_BODY.required_status_checks.contexts).toEqual(['review/agent'])
    expect(PROTECTION_BODY.enforce_admins).toBe(true)
    expect(out).toMatch(/branch protection on main: set\. It requires review\/agent, with enforce_admins on/)
    expect(out).toMatch(/project's own CI checks are the crew's to add/)
  })

  it('ST-44/AC-10: a no, and --yes alone, set nothing and make no protection request', async () => {
    for (const args of [['--yes', '--protect-main', 'no'], ['--yes']]) {
      const gh = fakeGitHub()
      const { code } = await runInit(args, { cwd: makeRepo(), gh })
      expect(code).toBe(0)
      expect(gh.requests.filter((r) => r.rest === PROTECTION)).toEqual([])
    }
  })

  it('ST-44/AC-10: a yes at the terminal sets it, and its default there is no', async () => {
    const gh = fakeGitHub()
    const terminal = fakeTerminal(['', '', '', '', '', 'yes', '', '', '', ''])
    await runInit([], { cwd: makeRepo(), gh, terminal })
    expect(terminal.prompts[5]).toMatch(/branch protection.*\[no\]/i)
    expect(gh.requests.some((r) => r.method === 'PUT')).toBe(true)
  })

  it('ST-44/AC-10: where the plan offers none, it says so plainly, says nothing enforces the gate, goes on, and exits 0', async () => {
    for (const mode of ['plan']) {
      const gh = fakeGitHub({ protection: mode })
      const machine = path.join(fresh('home'), 'settings.json')
      const { code, out } = await runInit(['--yes', '--protect-main', 'yes'], { cwd: makeRepo(), gh, machine })
      expect(code).toBe(0)
      expect(out).toMatch(/not set\. GitHub offers none for this repository on its plan/)
      expect(out).toMatch(/Nothing on GitHub then enforces the gate/)
      expect(out).toMatch(/Nothing was committed, staged or pushed/)
      expect(existsSync(machine)).toBe(true)
    }
  })

  it('ST-44/AC-10: a refusal of the PUT for the plan reads the same', async () => {
    const gh = fakeGitHub()
    const original = gh.fetch
    gh.fetch = async (url, init) =>
      init.method === 'PUT' ? { status: 403, text: async () => JSON.stringify({ message: MESSAGES.upgrade }) } : original(url, init)
    const { code, out } = await runInit(['--yes', '--protect-main', 'yes'], { cwd: makeRepo(), gh })
    expect(code).toBe(0)
    expect(out).toMatch(/GitHub offers none for this repository on its plan/)
  })

  it('ST-44/AC-10: for want of admin access it says so plainly, says nothing enforces the gate, goes on, and exits 0', async () => {
    const gh = fakeGitHub({ protection: 'admin' })
    const machine = path.join(fresh('home'), 'settings.json')
    const { code, out } = await runInit(['--yes', '--protect-main', 'yes'], { cwd: makeRepo(), gh, machine })
    expect(code).toBe(0)
    expect(out).toMatch(/not set\. This account cannot set it on this repository \(it needs admin access\)/)
    expect(out).toMatch(/Nothing on GitHub then enforces the gate/)
    expect(existsSync(machine)).toBe(true)
  })

  const CONTEXTS = '/branches/main/protection/required_status_checks/contexts'
  const ENFORCE = '/branches/main/protection/enforce_admins'

  it('ST-44/AC-10: on a yes with protection already there lacking review/agent and enforce_admins, it adds both and sends nothing else', async () => {
    const gh = fakeGitHub({ protection: 'existing' })
    const { code, out } = await runInit(['--yes', '--protect-main', 'yes'], { cwd: makeRepo(), gh })
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

  it('ST-44/AC-10: with only one of the two missing it adds only that one', async () => {
    const noAdmins = fakeGitHub({ protection: 'existing', existing: { required_status_checks: { contexts: ['test'] }, enforce_admins: { enabled: true } } })
    await runInit(['--yes', '--protect-main', 'yes'], { cwd: makeRepo(), gh: noAdmins })
    expect(writes(noAdmins).map((r) => r.rest)).toEqual(['/labels', '/labels', '/labels', CONTEXTS])
    const noCheck = fakeGitHub({ protection: 'existing', existing: { required_status_checks: { checks: [{ context: 'review/agent' }] }, enforce_admins: { enabled: false } } })
    const { out } = await runInit(['--yes', '--protect-main', 'yes'], { cwd: makeRepo(), gh: noCheck })
    expect(writes(noCheck).map((r) => r.rest)).toEqual(['/labels', '/labels', '/labels', ENFORCE])
    expect(out).toMatch(/review\/agent is already required/)
  })

  it('ST-44/AC-10: with protection already there with both, it sends nothing', async () => {
    const gh = fakeGitHub({ protection: 'existing', existing: { required_status_checks: { contexts: ['test', 'review/agent'] }, enforce_admins: { enabled: true } } })
    const { code, out } = await runInit(['--yes', '--protect-main', 'yes'], { cwd: makeRepo(), gh })
    expect(code).toBe(0)
    expect(writes(gh).filter((r) => r.rest.startsWith(PROTECTION))).toEqual([])
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

  it('ST-44/AC-10: protection with no status checks is rebuilt by one PUT keeping every setting, plus review/agent and enforce_admins', async () => {
    const gh = fakeGitHub({ protection: 'existing', existing: NO_CHECKS })
    const { code, out } = await runInit(['--yes', '--protect-main', 'yes'], { cwd: makeRepo(), gh })
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

  it('ST-44/AC-10: a rebuild with no reviews or restrictions sends them null, and turns required signatures on again when they were on', async () => {
    const gh = fakeGitHub({ protection: 'existing', existing: { enforce_admins: { enabled: true }, required_signatures: { enabled: true } } })
    const { code } = await runInit(['--yes', '--protect-main', 'yes'], { cwd: makeRepo(), gh })
    expect(code).toBe(0)
    expect(gh.requests.filter((r) => r.rest.startsWith(PROTECTION) && r.method !== 'GET')).toEqual([
      { method: 'PUT', rest: PROTECTION, body: PROTECTION_BODY },
      { method: 'POST', rest: '/branches/main/protection/required_signatures', body: undefined },
    ])
  })

  it('ST-44/AC-10: the allowlist admits a rebuild PUT exactly: review/agent with strict off, enforce_admins true, the PUT\'s own shape', () => {
    const url = `https://api.github.com/repos/${REPO}/branches/main/protection`
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

  it('ST-44/AC-12: a rate limit 403 on protection stops init with a non-zero exit, and writes no machine settings', async () => {
    const machine = path.join(fresh('home'), 'settings.json')
    const { code, err } = await runInit(['--yes', '--protect-main', 'yes'], { cwd: makeRepo(), gh: fakeGitHub({ protection: 'limited' }), machine })
    expect(code).toBe(1)
    expect(err).toMatch(/rate limit/)
    expect(existsSync(machine)).toBe(false)
  })

  it('ST-44/AC-12: a 403 or 404 that says neither the plan nor admin rights stops init', async () => {
    for (const status of [403, 404]) {
      const gh = fakeGitHub()
      const original = gh.fetch
      gh.fetch = async (url, init) => (init.method === 'PUT' ? { status, text: async () => JSON.stringify({ message: 'Not Found' }) } : original(url, init))
      expect((await runInit(['--yes', '--protect-main', 'yes'], { cwd: makeRepo(), gh })).code, String(status)).toBe(1)
    }
  })

  it('ST-44/AC-12: a refusal in the middle of adding to existing protection ends it as the plan or admin refusal does', async () => {
    const gh = fakeGitHub({ protection: 'existing' })
    const original = gh.fetch
    gh.fetch = async (url, init) =>
      init.method === 'POST' && url.endsWith('enforce_admins') ? { status: 403, text: async () => JSON.stringify({ message: MESSAGES.admin }) } : original(url, init)
    const { code, out } = await runInit(['--yes', '--protect-main', 'yes'], { cwd: makeRepo(), gh })
    expect(code).toBe(0)
    expect(out).toMatch(/cannot set it/)
  })
})

describe('ST-44/AC-7 and AC-12: a label that fails to create', () => {
  it('ST-44/AC-7: a 422 whose errors say already_exists counts as found', async () => {
    const { code, out } = await runInit(['--yes'], { cwd: makeRepo(), gh: fakeGitHub({ labelCreate: 'already_exists' }) })
    expect(code).toBe(0)
    expect(out).toContain('label review-blocked: found, left as it is')
  })

  it('ST-44/AC-12: a 422 with another error stops init with a non-zero exit, writing no machine settings', async () => {
    const machine = path.join(fresh('home'), 'settings.json')
    const { code, err } = await runInit(['--yes'], { cwd: makeRepo(), gh: fakeGitHub({ labelCreate: 'other' }), machine })
    expect(code).toBe(1)
    expect(err).toMatch(/422/)
    expect(existsSync(machine)).toBe(false)
  })
})

describe('ST-44/AC-11: what it leaves alone', () => {
  it('ST-44/AC-11: HEAD, the index and package.json are unchanged, and nothing under stories/ is read or written', async () => {
    const cwd = makeRepo({ files: { 'stories/stories.json': '{ not json', 'stories/ST-1.md': 'x' } })
    git(cwd, 'config', 'user.name', 'Crew')
    const head = git(cwd, 'rev-parse', 'HEAD')
    const index = git(cwd, 'ls-files', '-s')
    const packageJson = read(cwd, 'package.json')
    const stories = ['stories/stories.json', 'stories/ST-1.md'].map((f) => [f, read(cwd, f), statSync(path.join(cwd, f)).mtimeMs])
    const { code, out } = await runInit(['--yes'], { cwd })
    expect(code).toBe(0)
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(cwd, 'ls-files', '-s')).toBe(index)
    expect(git(cwd, 'diff', '--cached', '--name-only')).toBe('')
    expect(read(cwd, 'package.json')).toBe(packageJson)
    expect(stories.map(([f]) => [f, read(cwd, f), statSync(path.join(cwd, f)).mtimeMs])).toEqual(stories)
    expect(tree(cwd).filter((f) => f.startsWith('stories/'))).toEqual(['stories/ST-1.md', 'stories/stories.json'])
    expect(git(cwd, 'status', '--porcelain')).toMatch(/\?\? steward\.config\.json/)
    const settings = JSON.parse(read(cwd, 'steward.config.json'))
    expect(settings).not.toHaveProperty('storyPrefix')
    expect(out.split('\n').at(-1)).toMatch(/Commit what was written through a pull request of the project's own\.$/)
  })

  it('ST-44/AC-11: it writes no after-sweep trigger and touches no workflow of the project\'s', async () => {
    const cwd = makeRepo({ files: { '.github/workflows/ci.yml': 'name: CI\n' } })
    await runInit(['--yes'], { cwd })
    expect(read(cwd, '.github/workflows/ci.yml')).toBe('name: CI\n')
    expect(tree(cwd).filter((f) => f.startsWith('.github/workflows/')).sort()).toEqual([
      '.github/workflows/ci.yml',
      '.github/workflows/inspection.yml',
      '.github/workflows/land-approved.yml',
      '.github/workflows/review-gate.yml',
    ])
    for (const file of GATE_WORKFLOWS) expect(read(cwd, `.github/workflows/${file}`)).not.toMatch(/workflow_run/)
  })

  it('ST-44/AC-11: its source neither imports the story prefix nor names stories/ outside a comment', () => {
    const source = readFileSync(path.join(ROOT, 'scripts/dispatch/init.mjs'), 'utf8')
    expect(source).not.toMatch(/story-prefix|stories\.json/)
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/stories\//)
    // The only git commands it runs read: the checkout's root and the origin remote's URL.
    expect([...code.matchAll(/\bgit\((?:cwd|root), (\[[^\]]*\])/g)].map((m) => m[1])).toEqual([
      "['rev-parse', '--show-toplevel']",
      "['remote', 'get-url', 'origin']",
    ])
    expect(code.match(/execFileSync\(/g)).toHaveLength(1)
  })
})

describe('ST-44/AC-12: exit codes', () => {
  it('ST-44/AC-12: a failed request to GitHub other than the protection refusals exits 1, writing nothing more', async () => {
    for (const gh of [fakeGitHub({ labelStatus: 500 }), fakeGitHub({ protection: 'broken' })]) {
      const machine = path.join(fresh('home'), 'settings.json')
      const { code, err } = await runInit(['--yes', '--protect-main', 'yes'], { cwd: makeRepo(), gh, machine })
      expect(code).toBe(1)
      expect(err).toMatch(/init stopped: .*(500|boom|server error)/)
      expect(existsSync(machine)).toBe(false)
    }
  })

  it('ST-44/AC-12: a refusal for want of an answer exits 2, and a checkout that is not a git repository exits 2', async () => {
    expect((await runInit([], { cwd: makeRepo() })).code).toBe(2)
    expect((await runInit(['--yes'], { cwd: fresh('plain') })).code).toBe(2)
  })

  it('ST-44/AC-12: it exits 0 when it finished with everything left alone', async () => {
    const cwd = makeRepo()
    const gh = fakeGitHub({ labels: LABELS.map((l) => l.name) })
    const machine = path.join(fresh('home'), 'settings.json')
    const pkg = makePackage()
    await runInit(['--yes'], { cwd, gh, machine, pkg })
    expect((await runInit(['--yes'], { cwd, gh, machine, pkg })).code).toBe(0)
  })
})

describe('ST-44/AC-13: the README and settings.md', () => {
  it('ST-44/AC-13: the README says how to set up another project with init, and how the crew runs steward in one', () => {
    const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
    expect(readme).not.toMatch(/Steward runs on this repository only/)
    expect(readme).toMatch(/steward init/)
    expect(readme).toContain('npx --yes --package=github:luplows/steward#v<version> steward <command>')
  })

  it('ST-44/AC-13: settings.md no longer says init is not built, and says what init writes for each key', () => {
    const settings = readFileSync(path.join(ROOT, 'docs', 'settings.md'), 'utf8')
    expect(settings).not.toMatch(/not built yet/)
    expect(settings).not.toMatch(/Planned \(ST-44\)/)
    expect(settings).toMatch(/What `init` writes/)
  })
})
