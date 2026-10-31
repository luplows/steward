// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
  DEFAULT_BRANCH,
  findOnPath,
  GATE_WORKFLOWS,
  INSPECTION_WORKFLOW,
  LABELS,
  main,
  QUESTIONS,
  repoFromRemoteUrl,
} from './init.mjs'
import { readUserConfig } from './user-config.mjs'
import { createLandContext, landPullRequest } from './land.mjs'
import { readSettings } from './settings.mjs'
import { runRunway } from '../land/runway.mjs'
import { fakeGitHub as fakeRunwayGitHub, pull as runwayPull } from '../land/runway-fake.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLI = path.join(ROOT, 'scripts', 'dispatch', 'cli.mjs')
const SHA = '0123456789abcdef0123456789abcdef01234567'
const REPO = 'acme/widgets'

// Each run of init clones a real origin, commits and pushes, and some tests run it several times.
vi.setConfig({ testTimeout: 60_000 })

// Every test runs init in a temporary repository whose `origin` is a local bare repository,
// reached through the URL mapping only tests pass, with GitHub's answers injected, user config in
// a temporary file and the terminal injected: nothing for real. Git reads a global config of the
// tests' own, with an identity and no signing, and no system config, so that the machine's own
// settings change nothing here.
let base
const GIT_ENV = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']
const savedEnv = {}
let globalConfig
beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 'steward-init-'))
  for (const name of GIT_ENV) savedEnv[name] = process.env[name]
  globalConfig = path.join(base, 'gitconfig')
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

/** For each checkout `makeRepo` made, its `origin` URL and the bare repository standing in for it. */
const ORIGINS = new Map()
/** For each checkout, the clone the last run of `init` in it made. */
const LAST_CLONE = new Map()

/**
 * A temporary repository with one commit (a `package.json`), and `origin` when given. Its `main`
 * is pushed to a new bare repository, which a run of `init` reaches for `origin`'s URL.
 */
function makeRepo({ origin = `https://github.com/${REPO}.git`, files = {} } = {}) {
  const dir = fresh('repo')
  git(dir, 'init', '-q', '-b', 'main')
  if (origin !== null) git(dir, 'remote', 'add', 'origin', origin)
  writeFileSync(path.join(dir, 'package.json'), '{"name":"widgets","version":"1.0.0"}\n')
  put(dir, files)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'start')
  const bare = fresh('origin')
  git(bare, 'init', '-q', '--bare', '-b', 'main')
  git(dir, 'push', '-q', bare, 'main')
  ORIGINS.set(dir, { url: origin, bare })
  return dir
}

/** The clone the last run of `init` in `cwd` made, where the installation's files are. */
const installed = (cwd) => LAST_CLONE.get(cwd)

/** Merges the installation into `origin`'s `main`, as the crew would, and deletes its branch. */
function adopt(cwd, branch = 'steward/install') {
  const { bare } = ORIGINS.get(cwd)
  git(bare, 'update-ref', 'refs/heads/main', `refs/heads/${branch}`)
  git(bare, 'update-ref', '-d', `refs/heads/${branch}`)
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

/**
 * GitHub's answers, injected as `fetch`. `noMain` answers every request about `main`'s protection
 * `404 Branch not found`, as GitHub does for a repository with no `main`; otherwise `main` has none
 * (`404 Branch not protected`). `labelCreate` is `already_exists` or `other` (a 422 for each).
 * `repoStatus` answers the read of the repository itself; `openPulls` are the open pull requests
 * from any branch; `pullCreate` is the status creating the pull request gets. Records every
 * request.
 */
function fakeGitHub({ labels = [], labelStatus = null, labelCreate = null, noMain = false, repoStatus = 200, openPulls = [], pullCreate = 201 } = {}) {
  const have = new Set(labels)
  const requests = []
  const fetch = async (url, init) => {
    const rest = /\/repos\/[^/]+\/[^/?]+(\/.*)?$/.exec(url)[1] ?? ''
    const body = init.body === undefined ? undefined : JSON.parse(init.body)
    requests.push({ method: init.method, rest, body })
    const reply = (status, content) => ({ status, text: async () => (content === undefined ? '' : JSON.stringify(content)) })
    if (rest === '' && init.method === 'GET') return reply(repoStatus, repoStatus === 200 ? { full_name: REPO } : { message: 'Bad credentials' })
    if (rest.startsWith('/pulls?') && init.method === 'GET') return reply(200, openPulls)
    if (rest === '/pulls' && init.method === 'POST') {
      if (pullCreate !== 201) return reply(pullCreate, { message: 'Validation Failed' })
      return reply(201, { number: 1, html_url: `https://github.com/${REPO}/pull/1` })
    }
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
    if (rest.startsWith('/branches/main')) return reply(404, { message: noMain ? 'Branch not found' : 'Branch not protected' })
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

/**
 * Runs `init` in `cwd`; resolves `{ code, out, err, machine, gh, terminal, pkg, clone }`, `clone`
 * being the clone it made, or `undefined`. Git reaches `origin`'s URL only through the mapping to
 * the checkout's bare repository; any other URL fails.
 */
async function runInit(args, { cwd, gh = fakeGitHub(), terminal = fakeTerminal(), pkg = makePackage(), machine = path.join(fresh('home'), 'config.json'), codex = null, exists, getToken = async () => 'token' } = {}) {
  const out = []
  const err = []
  const tmpRoot = fresh('tmp')
  const origin = ORIGINS.get(cwd)
  const code = await main(args, {
    cwd,
    env: { STEWARD_CONFIG: machine },
    homedir: fresh('profile'),
    fetch: gh.fetch,
    getToken,
    terminal,
    findExecutable: () => codex,
    ...(exists ? { exists } : {}),
    packageRoot: pkg,
    tmpRoot,
    cloneUrl: (url) => {
      if (origin === undefined || url !== origin.url) throw new Error(`no test mapping for ${url}`)
      return origin.bare
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  })
  const made = readdirSync(tmpRoot)
  const clone = made.length === 1 ? path.join(tmpRoot, made[0]) : undefined
  if (clone !== undefined) LAST_CLONE.set(cwd, clone)
  return { code, out: out.join('\n'), err: err.join('\n'), machine, gh, terminal, pkg, clone }
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
  '--inspection', 'yes', '--coder-session-limit', '60', '--coder-weekly-limit', '65',
  '--reviewer-session-limit', '80', '--reviewer-weekly-limit', '85',
]

describe('ST-44/AC-1: init never overwrites, and names what it left', () => {
  it('ST-44/AC-1: a second run, once the first has merged, writes nothing and names every file it wrote the first time', async () => {
    const cwd = makeRepo()
    const gh = fakeGitHub()
    const machine = path.join(fresh('home'), 'config.json')
    const pkg = makePackage()
    const first = await runInit(['--yes'], { cwd, gh, machine, pkg })
    expect(first.code).toBe(0)
    const wrote = [...first.out.matchAll(/^wrote (.+)$/gm)].map((m) => m[1])
    expect(wrote.length).toBeGreaterThanOrEqual(7)
    const before = tree(first.clone).map((rel) => [rel, read(first.clone, rel)])
    const settingsBefore = readFileSync(machine, 'utf8')
    adopt(cwd)

    const second = await runInit(['--yes'], { cwd, gh, machine, pkg })
    expect(second.code).toBe(0)
    expect(second.out).not.toMatch(/^wrote /m)
    for (const rel of wrote.filter((w) => !w.includes("the user config"))) expect(second.out).toContain(`left ${rel}: `)
    expect(second.out).toContain(`left ${machine}`)
    expect(tree(second.clone).map((rel) => [rel, read(second.clone, rel)])).toEqual(before)
    expect(readFileSync(machine, 'utf8')).toBe(settingsBefore)
  })

  it('ST-44/AC-1: a file already there, with other content, keeps it', async () => {
    const cwd = makeRepo({ files: { 'REVIEW.md': 'my rules\n', '.github/workflows/review-gate.yml': 'mine\n', 'steward.config.json': '{}\n' } })
    const { code, out, err } = await runInit(['--yes'], { cwd })
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(read(installed(cwd), 'REVIEW.md')).toBe('my rules\n')
    expect(read(installed(cwd), '.github/workflows/review-gate.yml')).toBe('mine\n')
    expect(read(installed(cwd), 'steward.config.json')).toBe('{}\n')
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
    const settings = await readSettings(installed(cwd))
    expect(settings).toMatchObject({ unitLinks: ['file', 'issue', 'other'], rulesFile: 'docs/RULES.md', land: false, inspectAfterHours: 48 })
  })

  it('ST-44/AC-2: --yes alone takes every default', async () => {
    const cwd = makeRepo()
    const machine = path.join(fresh('home'), 'config.json')
    const gh = fakeGitHub()
    const { code } = await runInit(['--yes'], { cwd, machine, gh })
    expect(code).toBe(0)
    expect(await readSettings(installed(cwd))).toMatchObject({ unitLinks: ['file', 'issue'], rulesFile: 'REVIEW.md', land: false, inspectAfterHours: 24 })
    expect(existsSync(path.join(installed(cwd), '.github/workflows/inspection.yml'))).toBe(true)
    expect(writes(gh).some((r) => r.rest === '/branches/main/protection')).toBe(false)
  })

  it('ST-44/AC-2: with no terminal and no answer it refuses, names each question and its flag, and writes nothing', async () => {
    const cwd = makeRepo()
    const gh = fakeGitHub()
    const machine = path.join(fresh('home'), 'config.json')
    const before = tree(cwd)
    const { code, err } = await runInit([], { cwd, gh, machine })
    expect(code).toBe(2)
    for (const flag of ['--unit-links', '--rules-file', '--land', '--inspect-after-hours', '--inspection', '--coder-session-limit']) {
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
    const terminal = fakeTerminal(['issue', '', 'no', '12', 'no', '', '', '', ''])
    const { code } = await runInit([], { cwd, terminal })
    expect(code).toBe(0)
    expect(terminal.prompts.length).toBe(9)
    expect(terminal.prompts[0]).toContain('[file,issue]')
    expect(terminal.prompts[1]).toContain('[REVIEW.md]')
    expect(terminal.prompts[4]).toContain('[yes]')
    expect(await readSettings(installed(cwd))).toMatchObject({ unitLinks: ['issue'], rulesFile: 'REVIEW.md', land: false, inspectAfterHours: 12 })
    expect(existsSync(path.join(installed(cwd), '.github/workflows/inspection.yml'))).toBe(false)
  })

  it('ST-44/AC-2: a wrong answer at the terminal is asked again; a wrong flag is refused before anything is written', async () => {
    const cwd = makeRepo()
    const terminal = fakeTerminal(['everything', 'none', ...Array(8).fill('')])
    const { code } = await runInit([], { cwd, terminal })
    expect(code).toBe(0)
    expect(terminal.prompts.length).toBe(10)
    expect(terminal.written.join('')).toMatch(/'everything' is not one of/)
    expect((await readSettings(installed(cwd))).unitLinks).toEqual([])

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
    const text = JSON.parse(read(installed(cwd), 'steward.config.json'))
    expect(Object.keys(text).sort()).toEqual(['check', 'inspectAfterHours', 'land', 'landWhen', 'repo', 'rulesFile', 'setup', 'unitLinks'])
    expect(await readSettings(installed(cwd))).toEqual({
      repo: REPO, setup: null, check: null, landWhen: 'all-checks', land: false, unitLinks: ['file', 'issue'], rulesFile: 'REVIEW.md', inspectAfterHours: 24,
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
    expect((await readSettings(installed(cwd))).repo).toBe('acme/gadgets')
  })

  it('ST-44/AC-3 and ST-56/AC-1: with no origin it can read as a GitHub repository, it refuses, saying why, writes nothing and creates no label', async () => {
    for (const origin of [null, 'https://gitlab.com/acme/widgets.git']) {
      const cwd = makeRepo({ origin })
      const gh = fakeGitHub()
      const { code, err, clone } = await runInit(['--yes'], { cwd, gh })
      expect(code).toBe(2)
      expect(err).toMatch(origin === null ? /has no `origin` remote/ : /is not a GitHub repository/)
      expect(err).toContain('Nothing was written.')
      expect(gh.requests).toEqual([])
      expect(clone).toBeUndefined()
      expect(tree(cwd)).toEqual(['package.json'])
    }
  })

  it('ST-44/AC-3: unitLinks none is written as an empty array, and setup, check and landWhen are fixed', async () => {
    const cwd = makeRepo()
    await runInit(['--yes', '--unit-links', 'none'], { cwd })
    expect(await readSettings(installed(cwd))).toMatchObject({ unitLinks: [], setup: null, check: null, landWhen: 'all-checks' })
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
    expect(readFileSync(path.join(installed(cwd), 'docs/rules/CHECKLIST.md'))).toEqual(readFileSync(path.join(ROOT, 'templates', 'review-checklist.md')))
  })

  it('ST-44/AC-4: a file already at the path is left and reported', async () => {
    const cwd = makeRepo({ files: { 'docs/RULES.md': 'mine' } })
    const { out } = await runInit(['--yes', '--rules-file', 'docs/RULES.md'], { cwd })
    expect(read(installed(cwd), 'docs/RULES.md')).toBe('mine')
    expect(out).toContain('left docs/RULES.md: already there')
  })
})

describe('ST-44/AC-5: the thin workflow files', () => {
  it('ST-44/AC-5: from a steward whose version is 9.8.7, each file has v9.8.7 and no placeholder', async () => {
    const cwd = makeRepo()
    await runInit(['--yes'], { cwd, pkg: makePackage('9.8.7') })
    for (const file of [...GATE_WORKFLOWS, INSPECTION_WORKFLOW]) {
      const text = read(installed(cwd), `.github/workflows/${file}`)
      expect(text).toContain('--package=github:luplows/steward#v9.8.7 steward ')
      expect(text).not.toMatch(/\{\{[A-Z_]+\}\}/)
      expect(text).not.toContain('STEWARD_VERSION')
    }
    expect(read(installed(cwd), '.github/workflows/review-gate.yml')).toBe(
      readFileSync(path.join(ROOT, 'templates/workflows/review-gate.yml'), 'utf8').replaceAll('v{{STEWARD_VERSION}}', () => 'v9.8.7'),
    )
  })

  it('ST-44/AC-5a: --ref fills every workflow file with that commit, in place of v<version>', async () => {
    const cwd = makeRepo()
    const { code } = await runInit(['--yes', '--ref', SHA], { cwd, pkg: makePackage('9.8.7') })
    expect(code).toBe(0)
    for (const file of [...GATE_WORKFLOWS, INSPECTION_WORKFLOW]) {
      const text = read(installed(cwd), `.github/workflows/${file}`)
      expect(text).toContain(`--package=github:luplows/steward#${SHA} steward `)
      expect(text).not.toContain('v9.8.7')
      expect(text).not.toMatch(/\{\{[A-Z_]+\}\}/)
    }
  })

  it('ST-44/AC-5a: --ref is not asked by a question, and --yes leaves it unset', async () => {
    expect(QUESTIONS.some((q) => q.flag === '--ref')).toBe(false)
    const cwd = makeRepo()
    await runInit(['--yes'], { cwd, pkg: makePackage('9.8.7') })
    expect(read(installed(cwd), '.github/workflows/land-approved.yml')).toContain('#v9.8.7 steward')
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
    expect(read(installed(cwd), '.github/workflows/inspection.yml')).toContain('run: npx --yes --package=github:luplows/steward#v9.8.7 steward inspect')
    expect(out).toMatch(/first run may raise, as issues, earlier merges and commits on main within its window that had no passing verdict/)
    expect(out).toMatch(/crew closes each once/)
  })

  it('ST-44/AC-6: on a no it writes no inspection workflow and gives no warning, and still creates the inspection label', async () => {
    const cwd = makeRepo()
    const gh = fakeGitHub()
    const { out } = await runInit(['--yes', '--inspection', 'no'], { cwd, gh })
    expect(existsSync(path.join(installed(cwd), '.github/workflows/inspection.yml'))).toBe(false)
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

  it('ST-44/AC-7: init asks GitHub for nothing outside the labels, the repository and its pull requests', () => {
    expect(() => assertAllowedRequest(REPO, { method: 'DELETE', url: `https://api.github.com/repos/${REPO}/labels/inspection` })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'POST', url: `https://api.github.com/repos/${REPO}/issues`, body: {} })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'GET', url: `https://api.github.com/repos/${REPO}/labels/other` })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'GET', url: `https://api.github.com/repos/${REPO}/labels/inspection` })).not.toThrow()
  })
})

describe('ST-44/AC-8: the pull request template', () => {
  const TEMPLATE = path.join(ROOT, 'templates', 'pull_request_template.md')

  it('ST-44/AC-8: with none in the project, it writes the package\'s, which names neither AGENTS.md nor README.md', async () => {
    const cwd = makeRepo()
    await runInit(['--yes'], { cwd })
    const text = read(installed(cwd), '.github/pull_request_template.md')
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
    expect(read(installed(cwd), 'docs/pull_request_template.md')).toBe('## Summary\n')
    expect(existsSync(path.join(installed(cwd), '.github/pull_request_template.md'))).toBe(false)
    expect(out).toContain('docs/pull_request_template.md has no Unit: line')
  })

  it('ST-44/AC-8: a template in .github/ with a Unit: line is left, and nothing is said of the line', async () => {
    const cwd = makeRepo({ files: { '.github/pull_request_template.md': 'Unit:\n\n## Summary\n' } })
    const { out } = await runInit(['--yes'], { cwd })
    expect(read(installed(cwd), '.github/pull_request_template.md')).toBe('Unit:\n\n## Summary\n')
    expect(out).toContain('left .github/pull_request_template.md: the project\'s pull request template')
    expect(out).not.toMatch(/no Unit: line/)
  })

  it('ST-44/AC-8: a template at the root, in any case, or in a PULL_REQUEST_TEMPLATE/ directory counts as one', async () => {
    for (const files of [{ 'PULL_REQUEST_TEMPLATE.md': 'x' }, { '.github/PULL_REQUEST_TEMPLATE/bug.md': 'x' }, { 'docs/PULL_REQUEST_TEMPLATE/a.md': 'Unit:' }]) {
      const cwd = makeRepo({ files })
      await runInit(['--yes'], { cwd })
      expect(existsSync(path.join(installed(cwd), '.github/pull_request_template.md'))).toBe(false)
    }
  })
})

describe('ST-44/AC-9: the user config', () => {
  it('ST-44/AC-9: a missing file is written from the defaults, and readUserConfig reads it', async () => {
    const machine = path.join(fresh('home'), 'sub', 'config.json')
    const { code } = await runInit(['--yes'], { cwd: makeRepo(), machine })
    expect(code).toBe(0)
    const settings = await readUserConfig({ env: { STEWARD_CONFIG: machine }, homedir: '/nowhere' })
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
    const machine = path.join(fresh('home'), 'config.json')
    await runInit(['--yes', '--coder-session-limit', '50', '--reviewer-weekly-limit', '95'], { cwd: makeRepo(), machine })
    const { usageLimits } = await readUserConfig({ env: { STEWARD_CONFIG: machine }, homedir: '/nowhere' })
    expect(usageLimits).toEqual({ coder: { session: 50, weekly: 75 }, reviewer: { session: 90, weekly: 95 } })
  })

  it('ST-44/AC-9: a file that exists is not read, changed or replaced', async () => {
    const machine = path.join(fresh('home'), 'config.json')
    writeFileSync(machine, 'not even json')
    const before = statSync(machine).mtimeMs
    const terminal = fakeTerminal(['file,issue', '', '', '', ''])
    const { code, out } = await runInit([], { cwd: makeRepo(), machine, terminal })
    expect(code).toBe(0)
    expect(readFileSync(machine, 'utf8')).toBe('not even json')
    expect(statSync(machine).mtimeMs).toBe(before)
    expect(out).toContain(`left ${machine}`)
    expect(terminal.prompts.some((p) => /usage/.test(p))).toBe(false)
  })

  it('ST-44/AC-9: a Codex choice is offered only when codex is found or its path given', async () => {
    const withoutCodex = fakeTerminal(['', '', '', '', '', '', '', '', ''])
    await runInit([], { cwd: makeRepo(), terminal: withoutCodex })
    expect(withoutCodex.prompts.some((p) => /codex/i.test(p))).toBe(false)

    const exe = path.join(fresh('bin'), 'codex.exe')
    writeFileSync(exe, '')
    const offered = fakeTerminal(['', '', '', '', '', '', '', '', '', '', ''])
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

    const machine = path.join(fresh('home'), 'config.json')
    const { code } = await runInit(['--yes', '--reviewer', 'codex', '--codex-model', 'gpt-x', '--codex-effort', 'ultra'], { cwd: makeRepo(), machine, codex: exe })
    expect(code).toBe(0)
    const settings = await readUserConfig({ env: { STEWARD_CONFIG: machine }, homedir: '/nowhere' })
    expect(settings.roles.reviewer.default).toBe('codex')
    expect(settings.roles.reviewer.available.codex).toEqual({ tool: 'codex', model: 'gpt-x', effort: 'ultra' })
    expect(settings.tools.codex.executable).toBe(exe)
  })

  it('ST-44/AC-9: --codex-path names the executable when codex is not on the PATH, and must be a file that exists', async () => {
    const exe = path.join(fresh('bin'), 'codex')
    writeFileSync(exe, '')
    const machine = path.join(fresh('home'), 'config.json')
    const ok = await runInit(['--yes', '--reviewer', 'codex', '--codex-path', exe, '--codex-model', 'm', '--codex-effort', 'low'], { cwd: makeRepo(), machine })
    expect(ok.code).toBe(0)
    expect((await readUserConfig({ env: { STEWARD_CONFIG: machine }, homedir: '/nowhere' })).tools.codex.executable).toBe(exe)
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

  it('ST-44/AC-9: a relative PATH entry gives an absolute executable, which readUserConfig reads', async () => {
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
    const machine = path.join(fresh('home'), 'config.json')
    const { code } = await runInit(['--yes', '--reviewer', 'codex', '--codex-model', 'm', '--codex-effort', 'low'], { cwd: makeRepo(), machine, codex: found })
    expect(code).toBe(0)
    expect((await readUserConfig({ env: { STEWARD_CONFIG: machine }, homedir: '/nowhere' })).tools.codex.executable).toBe(found)
  })
})

describe('ST-44/AC-7 and AC-12: a label that fails to create', () => {
  it('ST-44/AC-7: a 422 whose errors say already_exists counts as found', async () => {
    const { code, out } = await runInit(['--yes'], { cwd: makeRepo(), gh: fakeGitHub({ labelCreate: 'already_exists' }) })
    expect(code).toBe(0)
    expect(out).toContain('label review-blocked: found, left as it is')
  })

  it('ST-44/AC-12: a 422 with another error stops init with a non-zero exit, writing no user config', async () => {
    const machine = path.join(fresh('home'), 'config.json')
    const { code, err } = await runInit(['--yes'], { cwd: makeRepo(), gh: fakeGitHub({ labelCreate: 'other' }), machine })
    expect(code).toBe(1)
    expect(err).toMatch(/422/)
    expect(existsSync(machine)).toBe(false)
  })
})

describe('ST-44/AC-11: what it leaves alone', () => {
  it('ST-44/AC-11: HEAD, the index and package.json are unchanged, and nothing under stories/ is read or written', async () => {
    const cwd = makeRepo({ files: { 'stories/stories.json': '{ not json', 'stories/ST-1.md': 'x' } })
    const head = git(cwd, 'rev-parse', 'HEAD')
    const index = git(cwd, 'ls-files', '-s')
    const packageJson = read(cwd, 'package.json')
    const stories = ['stories/stories.json', 'stories/ST-1.md'].map((f) => [f, read(cwd, f), statSync(path.join(cwd, f)).mtimeMs])
    const { code, clone } = await runInit(['--yes'], { cwd })
    expect(code).toBe(0)
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(cwd, 'ls-files', '-s')).toBe(index)
    expect(git(cwd, 'diff', '--cached', '--name-only')).toBe('')
    expect(read(cwd, 'package.json')).toBe(packageJson)
    expect(stories.map(([f]) => [f, read(cwd, f), statSync(path.join(cwd, f)).mtimeMs])).toEqual(stories)
    expect(tree(cwd).filter((f) => f.startsWith('stories/'))).toEqual(['stories/ST-1.md', 'stories/stories.json'])
    expect(git(cwd, 'status', '--porcelain')).toBe('')
    // In the clone, the installation's commit changes neither package.json nor stories/.
    expect(read(clone, 'package.json')).toBe(packageJson)
    expect(git(clone, 'diff', '--name-only', 'HEAD~1', 'HEAD').split('\n').filter((f) => f.startsWith('stories/') || f === 'package.json')).toEqual([])
    const settings = JSON.parse(read(clone, 'steward.config.json'))
    expect(settings).not.toHaveProperty('storyPrefix')
  })

  it('ST-44/AC-11: it writes no after-sweep trigger and touches no workflow of the project\'s', async () => {
    const cwd = makeRepo({ files: { '.github/workflows/ci.yml': 'name: CI\n' } })
    await runInit(['--yes'], { cwd })
    expect(read(installed(cwd), '.github/workflows/ci.yml')).toBe('name: CI\n')
    expect(tree(installed(cwd)).filter((f) => f.startsWith('.github/workflows/')).sort()).toEqual([
      '.github/workflows/ci.yml',
      '.github/workflows/inspection.yml',
      '.github/workflows/land-approved.yml',
      '.github/workflows/review-gate.yml',
    ])
    for (const file of GATE_WORKFLOWS) expect(read(installed(cwd), `.github/workflows/${file}`)).not.toMatch(/workflow_run/)
  })

  it('ST-44/AC-11: its source neither imports the story prefix nor names stories/ outside a comment', () => {
    const source = readFileSync(path.join(ROOT, 'scripts/dispatch/init.mjs'), 'utf8')
    expect(source).not.toMatch(/story-prefix|stories\.json/)
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/stories\//)
    // The only git commands it runs in the caller's checkout read: its root and the origin
    // remote's URL. Every other runs in the clone.
    expect([...code.matchAll(/\bgit\((?:cwd|root), (\[[^\]]*\])/g)].map((m) => m[1])).toEqual([
      "['rev-parse', '--show-toplevel']",
      "['remote', 'get-url', 'origin']",
    ])
    expect(code.match(/execFileSync\(/g)).toHaveLength(1)
  })
})

describe('ST-44/AC-12: exit codes', () => {
  it('ST-44/AC-12: a failed request to GitHub exits 1, writing nothing more', async () => {
    for (const gh of [fakeGitHub({ labelStatus: 500 })]) {
      const machine = path.join(fresh('home'), 'config.json')
      const { code, err } = await runInit(['--yes'], { cwd: makeRepo(), gh, machine })
      expect(code).toBe(1)
      expect(err).toMatch(/init stopped: .*(500|boom)/)
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
    const machine = path.join(fresh('home'), 'config.json')
    const pkg = makePackage()
    await runInit(['--yes'], { cwd, gh, machine, pkg })
    adopt(cwd)
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

// What the person running a command reads: nothing of steward's own source or stories (ST-50/AC-11).
const MENTIONS_STEWARD_INTERNALS = /ST-\d|AC-\d|scripts\/|\.mjs/

describe('ST-50/AC-1: init no longer touches branch protection', () => {
  const PROTECTION_URLS = ['', '/required_signatures', '/required_status_checks/contexts', '/enforce_admins']

  it('ST-50/AC-1: --protect-main is refused as an unknown flag, exit 2, nothing written and nothing asked of GitHub', async () => {
    const cwd = makeRepo()
    const gh = fakeGitHub()
    const machine = path.join(fresh('home'), 'config.json')
    const { code, err } = await runInit(['--yes', '--protect-main', 'yes'], { cwd, gh, machine })
    expect(code).toBe(2)
    expect(err).toMatch(/--protect-main: not a flag of init/)
    expect(tree(cwd)).toEqual(['package.json'])
    expect(existsSync(machine)).toBe(false)
    expect(gh.requests).toEqual([])
    expect(QUESTIONS.some((q) => q.id === 'protectMain' || q.flag === '--protect-main')).toBe(false)
  })

  it('ST-50/AC-1: a run with every question answered, and a --yes run, make no request about protection', async () => {
    for (const args of [ALL_FLAGS, ['--yes']]) {
      const gh = fakeGitHub()
      const { code } = await runInit(args, { cwd: makeRepo(), gh })
      expect(code).toBe(0)
      expect(gh.requests.length).toBeGreaterThan(0)
      expect(gh.requests.filter((r) => /protection|branches/.test(r.rest))).toEqual([])
    }
  })

  it('ST-50/AC-1: where GitHub answers every protection request 404 Branch not found, init exits 0 after writing its files and creating its labels', async () => {
    const cwd = makeRepo()
    const gh = fakeGitHub({ noMain: true })
    const { code, out, err } = await runInit(['--yes'], { cwd, gh })
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(tree(installed(cwd))).toContain('steward.config.json')
    expect(tree(installed(cwd))).toContain('.github/workflows/review-gate.yml')
    expect(writes(gh).filter((r) => r.rest === '/labels').map((r) => r.body.name)).toEqual(['review-blocked', 'breaker-override', 'inspection'])
    expect(out).toContain('label review-blocked: created')
  })

  it('ST-50/AC-1: its allowlist refuses every request about protection', () => {
    const base = `https://api.github.com/repos/${REPO}/branches/main/protection`
    for (const suffix of PROTECTION_URLS) {
      for (const method of ['GET', 'PUT', 'POST', 'DELETE']) {
        expect(() => assertAllowedRequest(REPO, { method, url: `${base}${suffix}` }), `${method} ${suffix}`).toThrow(/refusing/)
      }
    }
    expect(() => assertAllowedRequest(REPO, { method: 'GET', url: `https://api.github.com/repos/${REPO}/branches/main` })).toThrow(/refusing/)
  })

  it('ST-50/AC-1: its source holds no question, flag, request builder or allowlist entry about protection', () => {
    const source = readFileSync(path.join(ROOT, 'scripts/dispatch/init.mjs'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/protection|--protect-main|protectMain|PROTECTION/i)
  })
})

describe('ST-50/AC-2: init\'s closing message', () => {
  const closing = async (args) => {
    const { code, out } = await runInit(args, { cwd: makeRepo(), gh: fakeGitHub() })
    expect(code).toBe(0)
    return out.split('\n')
  }

  it('ST-50/AC-2: its last lines say the crew reviews the draft pull request, merges it as the project normally merges, and recommends steward protect', async () => {
    for (const args of [['--yes'], ALL_FLAGS]) {
      const lines = await closing(args)
      const last = lines.slice(-3).join('\n')
      expect(last).toMatch(/Review it, fill in the project's template in its body, and mark it ready when it is/)
      expect(last).toMatch(/Merge it as the project normally merges: the gate cannot review the pull request that installs it/)
      expect(lines.at(-2)).toMatch(/Steward is then set up\. .*run `steward protect` once it has merged\.$/)
    }
  })

  it('ST-50/AC-2: that recommendation is the only place its output names protection or protect, and it is not a trial', async () => {
    const lines = await closing(['--yes'])
    expect(lines.filter((l) => /protect/i.test(l))).toEqual([lines.at(-2)])
    expect(lines.join('\n')).not.toMatch(/trial|unfinished|incomplete|not yet set up/i)
  })
})

describe('ST-50/AC-11: what init prints is written for the person running it', () => {
  it('ST-50/AC-11: each case of ST-50/AC-1 and AC-2 prints no story or criterion id, script or module file', async () => {
    const cases = [
      ['--yes'],
      ALL_FLAGS,
      ['--yes', '--protect-main', 'yes'],
      ['--nope'],
      [],
    ]
    for (const args of cases) {
      const { out, err } = await runInit(args, { cwd: makeRepo(), gh: fakeGitHub() })
      expect(`${out}\n${err}`, args.join(' ')).not.toMatch(MENTIONS_STEWARD_INTERNALS)
    }
    const noMain = await runInit(['--yes'], { cwd: makeRepo(), gh: fakeGitHub({ noMain: true }) })
    expect(`${noMain.out}\n${noMain.err}`).not.toMatch(MENTIONS_STEWARD_INTERNALS)
    const notRepo = await runInit(['--yes'], { cwd: fresh('plain') })
    expect(`${notRepo.out}\n${notRepo.err}`).not.toMatch(MENTIONS_STEWARD_INTERNALS)
  })

  it('ST-50/AC-11: the allowlist\'s error names no source file of steward\'s own', () => {
    let message = ''
    try {
      assertAllowedRequest(REPO, { method: 'DELETE', url: `https://api.github.com/repos/${REPO}/labels/inspection` })
    } catch (error) {
      message = error.message
    }
    expect(message).toMatch(/refusing/)
    expect(message).not.toMatch(MENTIONS_STEWARD_INTERNALS)
  })
})

// ------------------------------------------------------------------ ST-55: review-only by default

const LAND_ANSWERS = (land) => ['', '', land, '', '', '', '', '', '']
const NEW_FILES = [
  '.github/pull_request_template.md',
  '.github/workflows/inspection.yml',
  '.github/workflows/land-approved.yml',
  '.github/workflows/review-gate.yml',
  'REVIEW.md',
  'package.json',
  'steward.config.json',
]
const bytes = (dir, rel) => readFileSync(path.join(dir, rel))

describe('ST-55/AC-1: the land question defaults to no, and an explicit yes writes true', () => {
  it('ST-55/AC-1: the question describes unattended landing and its default is no', () => {
    const q = QUESTIONS.find((x) => x.id === 'land')
    expect(q.default).toBe('no')
    expect(q.flag).toBe('--land')
    expect(q.prompt).toMatch(/unattended/)
    expect(q.prompt).toMatch(/without anyone asking/)
    expect(q.prompt).toContain('steward land <pr-number>')
  })

  it('ST-55/AC-1: accepting the default at the terminal writes land false, and the other settings keep their defaults', async () => {
    const cwd = makeRepo()
    const terminal = fakeTerminal(LAND_ANSWERS(''))
    const { code } = await runInit([], { cwd, terminal })
    expect(code).toBe(0)
    expect(terminal.prompts[2]).toContain('[no]')
    expect(await readSettings(installed(cwd))).toEqual({
      repo: REPO, setup: null, check: null, landWhen: 'all-checks', land: false, unitLinks: ['file', 'issue'], rulesFile: 'REVIEW.md', inspectAfterHours: 24,
    })
  })

  it('ST-55/AC-1: --yes writes land false, with landWhen and every other setting as before', async () => {
    const cwd = makeRepo()
    expect((await runInit(['--yes'], { cwd })).code).toBe(0)
    expect(JSON.parse(read(installed(cwd), 'steward.config.json'))).toEqual({
      repo: REPO, setup: null, check: null, landWhen: 'all-checks', land: false, unitLinks: ['file', 'issue'], rulesFile: 'REVIEW.md', inspectAfterHours: 24,
    })
  })

  it.each([['yes'], ['y'], ['true']])('ST-55/AC-1: an explicit %s at the terminal writes land true', async (answer) => {
    const cwd = makeRepo()
    const { code } = await runInit([], { cwd, terminal: fakeTerminal(LAND_ANSWERS(answer)) })
    expect(code).toBe(0)
    expect(await readSettings(installed(cwd))).toMatchObject({ land: true, landWhen: 'all-checks' })
  })

  it('ST-55/AC-1: an explicit no at the terminal writes land false', async () => {
    const cwd = makeRepo()
    await runInit([], { cwd, terminal: fakeTerminal(LAND_ANSWERS('no')) })
    expect(await readSettings(installed(cwd))).toMatchObject({ land: false })
  })

  it('ST-55/AC-1: --land yes writes true, with --yes or with every question answered; --land no writes false', async () => {
    const withYes = makeRepo()
    await runInit(['--yes', '--land', 'yes'], { cwd: withYes })
    expect(await readSettings(installed(withYes))).toMatchObject({ land: true, landWhen: 'all-checks', rulesFile: 'REVIEW.md' })

    const allAnswered = makeRepo()
    await runInit(ALL_FLAGS.map((x, i) => (ALL_FLAGS[i - 1] === '--land' ? 'yes' : x)), { cwd: allAnswered })
    expect(await readSettings(installed(allAnswered))).toMatchObject({ land: true, rulesFile: 'docs/RULES.md' })

    const no = makeRepo()
    await runInit(['--yes', '--land', 'no'], { cwd: no })
    expect(await readSettings(installed(no))).toMatchObject({ land: false })

    const equals = makeRepo()
    await runInit(['--yes', '--land=yes'], { cwd: equals })
    expect(await readSettings(installed(equals))).toMatchObject({ land: true })
  })

  it('ST-55/AC-1: readSettings still requires land, and holds no default for it', async () => {
    const cwd = makeRepo()
    await runInit(['--yes'], { cwd })
    const body = JSON.parse(read(installed(cwd), 'steward.config.json'))
    delete body.land
    writeFileSync(path.join(installed(cwd), 'steward.config.json'), JSON.stringify(body))
    await expect(readSettings(installed(cwd))).rejects.toThrow(/missing required key 'land'/)
    writeFileSync(path.join(installed(cwd), 'steward.config.json'), JSON.stringify({ ...body, land: 'no' }))
    await expect(readSettings(installed(cwd))).rejects.toThrow(/land/)
  })
})

describe('ST-55/AC-2: the output tells review-only from unattended landing', () => {
  it('ST-55/AC-2: a new land false says steward reviews and does not land unattended, and shows the manual path', async () => {
    const { out, code } = await runInit(['--yes'], { cwd: makeRepo() })
    expect(code).toBe(0)
    expect(out).toMatch(/land set to false: steward can review pull requests but will not land any unattended/)
    expect(out).toContain('`steward land <pr-number>`')
    expect(out).not.toMatch(/explicitly enabled/)
  })

  it('ST-55/AC-2: a new land true says unattended landing was explicitly enabled', async () => {
    const { out } = await runInit(['--yes', '--land', 'yes'], { cwd: makeRepo() })
    expect(out).toMatch(/land set to true: unattended landing was explicitly enabled/)
    expect(out).not.toMatch(/will not land any unattended/)
  })

  it('ST-55/AC-2: --yes is said not to consent to unattended landing, and is never described as enabling it', async () => {
    const { out } = await runInit(['--yes'], { cwd: makeRepo() })
    expect(out).toMatch(/--yes took the default for the landing question, no: it does not consent to unattended landing/)
    for (const line of out.split('\n').filter((l) => l.includes('--yes'))) expect(line).toMatch(/does not consent/)
    // An explicit --land yes is the person's own answer; --yes is not blamed or credited for it.
    const explicit = await runInit(['--yes', '--land', 'yes'], { cwd: makeRepo() })
    expect(explicit.out).not.toMatch(/--yes took the default/)
    const terminal = await runInit([], { cwd: makeRepo(), terminal: fakeTerminal(LAND_ANSWERS('')) })
    expect(terminal.out).not.toMatch(/--yes/)
  })

  it('ST-55/AC-2: the prompt and the usage text say that --yes and the default do not enable unattended landing', async () => {
    const q = QUESTIONS.find((x) => x.id === 'land')
    expect(q.prompt).toMatch(/\(no: steward reviews, the project merges/)
    const { err } = await runInit(['--nope'], { cwd: makeRepo() })
    expect(err).toMatch(/--yes takes the default of --land, which is no, and only --land yes/)
    expect(err).toContain('steward init --yes --land yes')
  })

  it('ST-55/AC-5: the printed usage shows the manual path, steward land <pr-number>, with land false', async () => {
    const { err } = await runInit(['--nope'], { cwd: makeRepo() })
    expect(err).toMatch(/With land false, `steward land <pr-number>` asks steward to land one pull request that has passed review/)
  })

  it('ST-55/AC-2: both outcomes say merging the installation pull request starts nothing on any machine', async () => {
    for (const args of [['--yes'], ['--yes', '--land', 'yes']]) {
      const { out } = await runInit(args, { cwd: makeRepo() })
      expect(out).toMatch(/Merging it starts nothing on any machine: running steward on a machine is a separate step/)
    }
  })

  it('ST-55/AC-2: what it prints for either outcome names no story or criterion id, script or module file', async () => {
    for (const args of [['--yes'], ['--yes', '--land', 'yes']]) {
      const { out, err } = await runInit(args, { cwd: makeRepo() })
      expect(`${out}\n${err}`).not.toMatch(MENTIONS_STEWARD_INTERNALS)
    }
    expect(QUESTIONS.find((x) => x.id === 'land').prompt).not.toMatch(MENTIONS_STEWARD_INTERNALS)
  })
})

describe('ST-55/AC-3: an existing settings file keeps its authorization', () => {
  const existing = (land) => `${JSON.stringify({
    repo: REPO, setup: null, check: null, landWhen: 'all-checks', land, unitLinks: ['file'], rulesFile: 'REVIEW.md', inspectAfterHours: 6,
  }, null, 4)}\n`

  it.each([
    ['true', true, ['--yes']],
    ['false', false, ['--yes']],
    ['true', true, ['--yes', '--land', 'no']],
    ['false', false, ['--yes', '--land', 'yes']],
    ['false', false, ['--yes', '--land', 'no']],
    ['true', true, ['--yes', '--land', 'yes']],
  ])('ST-55/AC-3: a file with land %s is left byte for byte by %j', async (_name, land, args) => {
    const text = existing(land)
    const cwd = makeRepo({ files: { 'steward.config.json': text } })
    const before = bytes(cwd, 'steward.config.json')
    const { code, out } = await runInit(args, { cwd })
    expect(code).toBe(0)
    expect(bytes(installed(cwd), 'steward.config.json').equals(before)).toBe(true)
    expect(read(installed(cwd), 'steward.config.json')).toBe(text)
    expect(out).toContain('left steward.config.json: already there')
    expect(out).not.toMatch(/wrote steward\.config\.json/)
    // It does not claim its land setting was set, changed or enabled.
    expect(out).not.toMatch(/land set to (true|false)|explicitly enabled|will not land any unattended|took the default/)
    expect(out).toMatch(/An existing steward\.config\.json governs its own landing authorization: init did not read it for that or change its land setting/)
  })

  it('ST-55/AC-3: answering the question at the terminal does not change an existing file either', async () => {
    for (const land of [true, false]) {
      const text = existing(land)
      const cwd = makeRepo({ files: { 'steward.config.json': text } })
      await runInit([], { cwd, terminal: fakeTerminal(LAND_ANSWERS(land ? 'no' : 'yes')) })
      expect(read(installed(cwd), 'steward.config.json')).toBe(text)
    }
  })

  it('ST-55/AC-3: two runs of a new installation: the second leaves every file as the first wrote it', async () => {
    for (const land of ['no', 'yes']) {
      const cwd = makeRepo()
      const machine = path.join(fresh('home'), 'config.json')
      const pkg = makePackage()
      const first = await runInit(['--yes', '--land', land], { cwd, machine, pkg })
      const written = Object.fromEntries(tree(first.clone).map((rel) => [rel, bytes(first.clone, rel)]))
      expect(JSON.parse(read(first.clone, 'steward.config.json')).land).toBe(land === 'yes')
      adopt(cwd)
      const opposite = land === 'yes' ? 'no' : 'yes'
      const second = await runInit(['--yes', '--land', opposite], { cwd, machine, pkg })
      expect(second.code).toBe(0)
      expect(tree(second.clone)).toEqual(Object.keys(written))
      for (const [rel, content] of Object.entries(written)) expect(bytes(second.clone, rel).equals(content), rel).toBe(true)
      expect(first.out).toContain('wrote steward.config.json')
      expect(second.out).toContain('left steward.config.json: already there')
      expect(second.out).not.toMatch(/land set to/)
    }
  })

  it.each([true, false])(
    'ST-55/AC-3 and ST-56/AC-1: an existing file with land %s and no GitHub origin is left byte for byte, since init refuses',
    async (land) => {
      for (const origin of [null, 'https://gitlab.com/acme/widgets.git']) {
        const text = existing(land)
        const cwd = makeRepo({ origin, files: { 'steward.config.json': text } })
        const { code, out, err } = await runInit(['--yes', '--land', land ? 'no' : 'yes'], { cwd })
        expect(code).toBe(2)
        expect(bytes(cwd, 'steward.config.json').equals(Buffer.from(text))).toBe(true)
        expect(err).toMatch(/origin/)
        expect(out).not.toMatch(/land set to/)
      }
    },
  )

  it('ST-55/AC-3 and ST-56/AC-1: with no GitHub origin no settings file is written, since init refuses, so none is left without a landing setting', async () => {
    const cwd = makeRepo({ origin: null })
    const { code, out, clone } = await runInit(['--yes'], { cwd })
    expect(code).toBe(2)
    expect(clone).toBeUndefined()
    expect(existsSync(path.join(cwd, 'steward.config.json'))).toBe(false)
    expect(out).toBe('')
  })
})

describe('ST-55/AC-4: the gate is installed, and review-only installation does not let it merge unattended', () => {
  const alice = { alice: 'write' }
  /** A fake pull request 1 with everything the gate wants, and the settings file `init` wrote. */
  const world = (cwd) => fakeRunwayGitHub({ pulls: [runwayPull(1)], settingsText: read(installed(cwd), 'steward.config.json'), permissions: alice })
  const HEAD = 'c'.repeat(39) + '1'
  const asGate = { repo: 'owner/project', eventName: 'workflow_dispatch', actor: 'alice' }

  it('ST-55/AC-4: a review-only installation writes the same files as one with land true, and nothing else', async () => {
    const off = makeRepo()
    const on = makeRepo()
    const gh = fakeGitHub()
    await runInit(['--yes'], { cwd: off, gh })
    await runInit(['--yes', '--land', 'yes'], { cwd: on })
    expect(tree(installed(off))).toEqual(NEW_FILES)
    expect(tree(installed(on))).toEqual(tree(installed(off)))
    for (const rel of tree(installed(off)).filter((r) => r !== 'steward.config.json')) {
      expect(bytes(installed(off), rel).equals(bytes(installed(on), rel)), rel).toBe(true)
    }
    for (const file of [...GATE_WORKFLOWS, INSPECTION_WORKFLOW]) {
      const text = read(installed(off), `.github/workflows/${file}`)
      expect(text, file).toContain('#v9.8.7 steward')
      expect(text, file).not.toContain('{{STEWARD_VERSION}}')
      // Inspection's workflow has a schedule of its own, from before; the gate's and the runway's
      // have none.
      if (GATE_WORKFLOWS.includes(file)) expect(text, file).not.toMatch(/^\s*schedule:/m)
    }
    // Only labels and the draft pull request are created, and no reviewer, coder, rotation or
    // landing is started.
    expect(writes(gh).map((r) => `${r.method} ${r.rest}`)).toEqual(['POST /labels', 'POST /labels', 'POST /labels', 'POST /pulls'])
    expect(writes(gh).at(-1).body.draft).toBe(true)
  })

  it('ST-55/AC-4: with land false the runway lands nothing unattended, but lands a scoped manual request for an eligible pull request', async () => {
    const cwd = makeRepo()
    await runInit(['--yes'], { cwd })

    for (const inputs of [{}, { prInput: '1' }, { prInput: '1', modeInput: 'unattended' }]) {
      const w = world(cwd)
      const result = runRunway({ ...asGate, ...inputs }, w.deps)
      expect(result.landed).toBeNull()
      expect(result.refused).toMatch(/land is false/)
      expect(w.merges).toEqual([])
    }

    const w = world(cwd)
    expect(runRunway({ ...asGate, prInput: '1', modeInput: 'manual', headInput: HEAD }, w.deps)).toEqual({ landed: 1 })
    expect(w.merges).toEqual([['1', '--repo', 'owner/project', '--squash', '--match-head-commit', HEAD]])
  })

  it('ST-55/AC-4: with land true the runway keeps its unattended eligibility', async () => {
    const cwd = makeRepo()
    await runInit(['--yes', '--land', 'yes'], { cwd })
    for (const inputs of [{}, { prInput: '1' }]) {
      const w = world(cwd)
      expect(runRunway({ ...asGate, ...inputs }, w.deps)).toEqual({ landed: 1 })
      expect(w.merges).toEqual([['1', '--repo', 'owner/project', '--squash', '--match-head-commit', HEAD]])
    }
  })

  /** A GitHub for `landPullRequest`: pull request 7 is open and landable until it is dispatched. */
  function landWorld() {
    const requests = []
    const SHA7 = 'a'.repeat(40)
    const fetch = async (url, init) => {
      requests.push({ method: init.method, url })
      const ok = (json, code = 200) => ({ ok: true, status: code, json: async () => json })
      if (init.method === 'POST') return ok(null, 204)
      if (url.includes('/check-runs')) return ok({ total_count: 1, check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }] })
      if (url.includes('/commits/')) return ok({ statuses: [{ id: 1, context: 'review/agent', state: 'success' }] })
      const dispatched = requests.some((r) => r.method === 'POST')
      return ok({ head: { sha: SHA7 }, state: 'open', merged: dispatched, draft: false, labels: [], mergeable_state: 'clean' })
    }
    return { requests, fetch }
  }
  const land = async (settings, g, mode) => {
    const ctx = createLandContext({ repo: REPO, landing: settings.land, landWhen: settings.landWhen, fetch: g.fetch, getToken: async () => 't' })
    return landPullRequest({ number: 7, ctx, mode, once: true, sleep: async () => {}, latencyLog: path.join(fresh('log'), 'latency.jsonl') })
  }

  it('ST-55/AC-4: with the settings init wrote, the pilot lands nothing unattended and sends no request, and a manual request is dispatched', async () => {
    const cwd = makeRepo()
    await runInit(['--yes'], { cwd })
    const settings = await readSettings(installed(cwd))
    expect(settings.land).toBe(false)

    const unattended = landWorld()
    expect(await land(settings, unattended, 'unattended')).toMatchObject({ status: 'landing-off', triggers: 0 })
    expect(unattended.requests).toEqual([])

    const manual = landWorld()
    expect(await land(settings, manual, 'manual')).toMatchObject({ status: 'merged', mode: 'manual', triggers: 1 })
    const dispatch = manual.requests.filter((r) => r.method === 'POST')
    expect(dispatch.map((r) => r.url)).toEqual([`https://api.github.com/repos/${REPO}/actions/workflows/land-approved.yml/dispatches`])
  })

  it('ST-55/AC-4: with the settings init wrote for an explicit yes, the pilot dispatches an unattended landing', async () => {
    const cwd = makeRepo()
    await runInit(['--yes', '--land', 'yes'], { cwd })
    const settings = await readSettings(installed(cwd))
    expect(settings.land).toBe(true)
    const g = landWorld()
    expect(await land(settings, g, 'unattended')).toMatchObject({ status: 'merged', mode: 'unattended', triggers: 1 })
    expect(g.requests.filter((r) => r.method === 'POST')).toHaveLength(1)
  })
})

// ------------------------------------------------------------------ ST-56: a draft installation pull request

/** `origin`'s branches, as `refs/heads/<name> <sha>` lines, read from the bare repository. */
const originRefs = (cwd) => git(ORIGINS.get(cwd).bare, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads')
const originMain = (cwd) => git(ORIGINS.get(cwd).bare, 'rev-parse', 'refs/heads/main')

/** Makes every push to the checkout's `origin` fail, as a server that refuses it would. */
function refusePushes(cwd) {
  const hook = path.join(ORIGINS.get(cwd).bare, 'hooks', 'pre-receive')
  mkdirSync(path.dirname(hook), { recursive: true })
  writeFileSync(hook, '#!/bin/sh\necho "pushes are closed today" >&2\nexit 1\n')
  chmodSync(hook, 0o755)
}

/** Runs `fn` with Git reading the tests' global config plus `extra` lines. */
async function withGlobalConfig(extra, fn) {
  const file = path.join(fresh('gitconfig'), 'gitconfig')
  writeFileSync(file, `${readFileSync(globalConfig, 'utf8')}${extra}`)
  process.env.GIT_CONFIG_GLOBAL = file
  try {
    return await fn()
  } finally {
    process.env.GIT_CONFIG_GLOBAL = globalConfig
  }
}

/**
 * A checkout on a feature branch with a staged, an unstaged, an untracked and an ignored change,
 * and a local edit to a file the installation adds (`REVIEW.md`, untracked).
 */
function busyCheckout() {
  const cwd = makeRepo({ files: { '.gitignore': 'build/\n', 'src/a.js': 'a\n', 'src/b.js': 'b\n' } })
  git(cwd, 'checkout', '-q', '-b', 'feature/mine')
  put(cwd, { 'src/a.js': 'a staged\n' })
  git(cwd, 'add', 'src/a.js')
  put(cwd, { 'src/b.js': 'b unstaged\n', 'notes.txt': 'untracked\n', 'build/out.txt': 'ignored\n', 'REVIEW.md': 'my local rules\n' })
  return cwd
}

/** What `init` must leave as it is in the caller's checkout. */
const callerState = (cwd) => ({
  files: tree(cwd).map((rel) => [rel, read(cwd, rel)]),
  status: git(cwd, 'status', '--porcelain=v1', '--ignored'),
  refs: git(cwd, 'for-each-ref'),
  head: git(cwd, 'symbolic-ref', 'HEAD'),
  config: read(cwd, '.git/config'),
})

describe('ST-56/AC-1: init reads only the checkout root and origin, and writes nothing there', () => {
  it('ST-56/AC-1: a busy feature-branch checkout is the same after a successful installation, a no-diff run and a failed push', async () => {
    const cwd = busyCheckout()
    const before = callerState(cwd)
    const machine = path.join(fresh('home'), 'config.json')
    const pkg = makePackage()

    const installedRun = await runInit(['--yes'], { cwd, machine, pkg })
    expect(installedRun.code).toBe(0)
    expect(callerState(cwd)).toEqual(before)

    adopt(cwd)
    const noDiff = await runInit(['--yes'], { cwd, machine, pkg })
    expect(noDiff.code).toBe(0)
    expect(noDiff.out).toMatch(/already complete/)
    expect(callerState(cwd)).toEqual(before)

    const other = busyCheckout()
    const otherBefore = callerState(other)
    refusePushes(other)
    const failed = await runInit(['--yes'], { cwd: other })
    expect(failed.code).toBe(1)
    expect(callerState(other)).toEqual(otherBefore)
  })

  it('ST-56/AC-1: a credential GitHub does not accept, or none at all, is refused with exit 2 before any write, saying which', async () => {
    const cases = [
      [{ gh: fakeGitHub({ repoStatus: 401 }) }, /GitHub did not let your credential read acme\/widgets \(401 Bad credentials\)/],
      [{ getToken: async () => { throw new Error('`gh auth token` returned nothing; run `gh auth login`') } }, /could not reach GitHub with your credential: `gh auth token` returned nothing/],
    ]
    for (const [options, said] of cases) {
      const cwd = makeRepo()
      const machine = path.join(fresh('home'), 'config.json')
      const result = await runInit(['--yes'], { cwd, machine, ...options })
      expect(result.code).toBe(2)
      expect(result.err).toMatch(said)
      expect(result.err).toContain('Nothing was written.')
      expect(result.clone).toBeUndefined()
      expect(existsSync(machine)).toBe(false)
      expect(writes(result.gh)).toEqual([])
      expect(tree(cwd)).toEqual(['package.json'])
    }
  })
})

describe('ST-56/AC-1a: the caller\'s own work is not examined', () => {
  it('ST-56/AC-1a: a local edit to an installation target is left, and the installation is made from origin\'s main', async () => {
    const cwd = busyCheckout()
    const { code, clone, err } = await runInit(['--yes'], { cwd })
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(read(cwd, 'REVIEW.md')).toBe('my local rules\n')
    expect(readFileSync(path.join(clone, 'REVIEW.md'))).toEqual(readFileSync(path.join(ROOT, 'templates', 'review-checklist.md')))
    // The clone is origin's main: the caller's branch and changes are not in it.
    expect(git(clone, 'rev-parse', 'HEAD~1')).toBe(originMain(cwd))
    expect(read(clone, 'src/a.js')).toBe('a\n')
    expect(existsSync(path.join(clone, 'notes.txt'))).toBe(false)
  })
})

describe('ST-56/AC-1b: Git runs as configured', () => {
  it('ST-56/AC-1b: a commit hook that rejects the commit is reported as a failed step, with Git\'s own message', async () => {
    const hooks = fresh('hooks')
    writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho "no commits without a ticket" >&2\nexit 1\n')
    chmodSync(path.join(hooks, 'pre-commit'), 0o755)
    const cwd = makeRepo()
    const gh = fakeGitHub()
    const { code, err, clone } = await withGlobalConfig(`[core]\n\thooksPath = ${hooks.replaceAll('\\', '/')}\n`, () => runInit(['--yes'], { cwd, gh }))
    expect(code).toBe(1)
    expect(err).toMatch(/^init stopped: committing the installation failed\. Git said: .*no commits without a ticket/m)
    expect(err).toContain(`init's copy of the project, at ${clone}`)
    expect(err).toContain(`the branch ${DEFAULT_BRANCH} in that copy only: nothing was pushed`)
    expect(originRefs(cwd)).toBe(`refs/heads/main ${originMain(cwd)}`)
    expect(writes(gh).some((r) => r.rest === '/pulls')).toBe(false)
  })

  it('ST-56/AC-1b: its source sets no Git configuration and skips no hook', () => {
    const source = readFileSync(path.join(ROOT, 'scripts/dispatch/init.mjs'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/'config'|'-c'|--no-verify|core\.hooksPath|GIT_[A-Z_]+/)
  })
})

describe('ST-56/AC-2: a fresh clone and a new branch', () => {
  it('ST-56/AC-2: init clones origin\'s main into a new folder, takes its commit as the base, and commits on steward/install', async () => {
    const cwd = makeRepo()
    const base = originMain(cwd)
    const { code, clone, out } = await runInit(['--yes'], { cwd })
    expect(code).toBe(0)
    expect(path.basename(clone)).toMatch(/^steward-install-/)
    expect(git(clone, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${DEFAULT_BRANCH}`)
    expect(git(clone, 'rev-parse', 'HEAD~1')).toBe(base)
    expect(out).toContain(`  base commit: ${base}`)
    expect(git(ORIGINS.get(cwd).bare, 'rev-parse', `refs/heads/${DEFAULT_BRANCH}`)).toBe(git(clone, 'rev-parse', 'HEAD'))
  })

  it('ST-56/AC-2: --branch names the branch', async () => {
    const cwd = makeRepo()
    const gh = fakeGitHub()
    const { code, out } = await runInit(['--yes', '--branch', 'chore/steward'], { cwd, gh })
    expect(code).toBe(0)
    expect(out).toContain('  branch: chore/steward')
    expect(originRefs(cwd)).toMatch(/^refs\/heads\/chore\/steward /m)
    expect(writes(gh).find((r) => r.rest === '/pulls').body.head).toBe('chore/steward')
  })

  it('ST-56/AC-2: a branch already on origin, or one with an open pull request, is refused with exit 2 after the clone and before any other write', async () => {
    const onOrigin = makeRepo()
    git(ORIGINS.get(onOrigin).bare, 'update-ref', `refs/heads/${DEFAULT_BRANCH}`, 'refs/heads/main')
    const open = makeRepo()
    const cases = [
      [onOrigin, fakeGitHub(), /The branch steward\/install is already on GitHub/],
      [open, fakeGitHub({ openPulls: [{ number: 4, html_url: `https://github.com/${REPO}/pull/4` }] }), /A pull request is already open from steward\/install: https:\/\/github\.com\/acme\/widgets\/pull\/4/],
    ]
    for (const [cwd, gh, said] of cases) {
      const refsBefore = originRefs(cwd)
      const machine = path.join(fresh('home'), 'config.json')
      const { code, err, clone } = await runInit(['--yes'], { cwd, gh, machine })
      expect(code).toBe(2)
      expect(err).toMatch(said)
      expect(err).toContain(`init's copy of the project is kept at ${clone}: remove that folder when you are done with it.`)
      expect(git(clone, 'status', '--porcelain')).toBe('')
      expect(git(clone, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main')
      expect(originRefs(cwd)).toBe(refsBefore)
      expect(writes(gh)).toEqual([])
      expect(existsSync(machine)).toBe(false)
    }
  })

  it('ST-56/AC-2: --branch main is refused', async () => {
    const cwd = makeRepo()
    const gh = fakeGitHub()
    const { code, err } = await runInit(['--yes', '--branch', 'main'], { cwd, gh })
    expect(code).toBe(2)
    expect(err).toMatch(/--branch main: .*never on main/)
    expect(writes(gh)).toEqual([])
  })
})

describe('ST-56/AC-3: only the installation\'s files', () => {
  it('ST-56/AC-3: one commit, whose only parent is the base and whose changes are exactly the files written', async () => {
    const cwd = makeRepo({ files: { 'REVIEW.md': 'ours\n' } })
    const base = originMain(cwd)
    const { code, clone, out } = await runInit(['--yes'], { cwd })
    expect(code).toBe(0)
    expect(git(clone, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1)).toEqual([base])
    const changed = git(clone, 'diff', '--name-status', base, 'HEAD').split('\n').sort()
    const wrote = [...out.matchAll(/^wrote (.+)$/gm)].map((m) => m[1]).filter((w) => !w.includes('the user config'))
    expect(changed).toEqual(wrote.map((rel) => `A\t${rel}`).sort())
    expect(wrote).not.toContain('REVIEW.md')
    expect(git(clone, 'status', '--porcelain')).toBe('')
  })
})

describe('ST-56/AC-4: additions only, and nothing when nothing is missing', () => {
  it('ST-56/AC-4: a partial installation adds only what the base lacks, leaves the rest byte for byte, and reads only rulesFile from the existing settings', async () => {
    const settings = `${JSON.stringify({ repo: REPO, setup: null, check: null, landWhen: 'all-checks', land: true, unitLinks: ['file'], rulesFile: 'docs/RULES.md', inspectAfterHours: 6 })}\n`
    const cwd = makeRepo({ files: { 'steward.config.json': settings, 'docs/RULES.md': 'rules\r\n', '.github/workflows/review-gate.yml': 'mine\n' } })
    const { code, clone, out, gh } = await runInit(['--yes', '--land', 'no'], { cwd })
    expect(code).toBe(0)
    expect(read(clone, 'steward.config.json')).toBe(settings)
    expect(read(clone, 'docs/RULES.md')).toBe('rules\r\n')
    expect(read(clone, '.github/workflows/review-gate.yml')).toBe('mine\n')
    expect(existsSync(path.join(clone, 'REVIEW.md'))).toBe(false)
    expect(git(clone, 'diff', '--name-only', 'HEAD~1', 'HEAD').split('\n').sort()).toEqual([
      '.github/pull_request_template.md',
      '.github/workflows/inspection.yml',
      '.github/workflows/land-approved.yml',
    ])
    for (const rel of ['steward.config.json', 'docs/RULES.md', '.github/workflows/review-gate.yml']) expect(out).toContain(`left ${rel}: already there`)
    const body = writes(gh).find((r) => r.rest === '/pulls').body.body
    expect(body).toMatch(/An existing steward\.config\.json governs its own landing authorization: init did not read it for that/)
  })

  it('ST-56/AC-4: when nothing is missing it exits 0, saying so, with no branch, commit, push or pull request, and still provisions labels and user config', async () => {
    const cwd = makeRepo()
    await runInit(['--yes'], { cwd })
    adopt(cwd)
    const refsBefore = originRefs(cwd)
    const gh = fakeGitHub()
    const machine = path.join(fresh('home'), 'config.json')
    const { code, out, clone } = await runInit(['--yes'], { cwd, gh, machine })
    expect(code).toBe(0)
    expect(out).toMatch(/the installation is already complete, so init made no branch, commit, push or pull request/)
    expect(originRefs(cwd)).toBe(refsBefore)
    expect(git(clone, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main')
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(originMain(cwd))
    expect(gh.requests.some((r) => r.rest.startsWith('/pulls'))).toBe(false)
    expect(writes(gh).map((r) => r.body.name)).toEqual(LABELS.map((l) => l.name))
    expect(existsSync(machine)).toBe(true)
  })
})

describe('ST-56/AC-5: one push, one draft pull request', () => {
  it('ST-56/AC-5: it pushes the branch, opens one draft pull request against main, and prints what it made', async () => {
    const cwd = makeRepo()
    const gh = fakeGitHub()
    const { code, out, clone } = await runInit(['--yes'], { cwd, gh })
    expect(code).toBe(0)
    const commit = git(clone, 'rev-parse', 'HEAD')
    expect(originRefs(cwd)).toContain(`refs/heads/${DEFAULT_BRANCH} ${commit}`)
    const pulls = writes(gh).filter((r) => r.rest.startsWith('/pulls'))
    expect(pulls).toHaveLength(1)
    expect(pulls[0].body).toMatchObject({ head: DEFAULT_BRANCH, base: 'main', draft: true })
    // Nothing marks it ready, merges it, requests landing or changes protection.
    expect(writes(gh).map((r) => `${r.method} ${r.rest}`)).toEqual(['POST /labels', 'POST /labels', 'POST /labels', 'POST /pulls'])
    for (const line of [`  repository: ${REPO}`, `  branch: ${DEFAULT_BRANCH}`, `  base commit: ${originMain(cwd)}`, `  installation commit: ${commit}`, `  pull request: https://github.com/${REPO}/pull/1`]) {
      expect(out).toContain(line)
    }
  })

  it('ST-56/AC-5: its allowlist admits only a draft pull request against main from a branch of the same repository', () => {
    const url = `https://api.github.com/repos/${REPO}/pulls`
    const body = { title: 't', head: DEFAULT_BRANCH, base: 'main', body: 'b', draft: true }
    expect(() => assertAllowedRequest(REPO, { method: 'POST', url, body })).not.toThrow()
    for (const wrong of [{ ...body, draft: false }, { ...body, base: 'release/v0.1.0' }, { ...body, head: 'other:branch' }, { ...body, head: 'main' }, { ...body, maintainer_can_modify: true }]) {
      expect(() => assertAllowedRequest(REPO, { method: 'POST', url, body: wrong }), JSON.stringify(wrong)).toThrow(/refusing/)
    }
    expect(() => assertAllowedRequest(REPO, { method: 'PATCH', url: `${url}/1`, body: { draft: false } })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'PUT', url: `${url}/1/merge` })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'GET', url: `${url}?head=${encodeURIComponent('someone:steward/install')}&state=open` })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'GET', url: `https://api.github.com/repos/other/repo` })).toThrow(/refusing/)
  })
})

describe('ST-56/AC-6: the pull request\'s title and body', () => {
  const opened = (gh) => writes(gh).find((r) => r.rest === '/pulls').body

  it('ST-56/AC-6: the title names steward and its version; the body is a generated section, then the project\'s template unchanged', async () => {
    const template = 'Unit:\n\n## Summary\n\n<!-- what and why -->\n'
    const cwd = makeRepo({ files: { '.github/pull_request_template.md': template, 'REVIEW.md': 'ours\n' } })
    const gh = fakeGitHub()
    expect((await runInit(['--yes', '--ref', SHA], { cwd, gh, pkg: makePackage('9.8.7') })).code).toBe(0)
    const { title, body } = opened(gh)
    expect(title).toBe('Install steward 9.8.7')
    expect(body.startsWith('## Steward installation\n')).toBe(true)
    expect(body.endsWith(`\n---\n\n${template}`)).toBe(true)
    const generated = body.slice(0, body.length - template.length)
    expect(generated).toContain(`steward 9.8.7, pinned to \`${SHA}\``)
    expect(generated).toMatch(/Files added:\n- `steward\.config\.json`\n- `\.github\/workflows\/review-gate\.yml`/)
    expect(generated).toMatch(/Files left as they were:\n- `REVIEW\.md`\n/)
    expect(generated).toMatch(/Landing: steward\.config\.json has land set to false/)
    expect(generated).toMatch(/The gate cannot review the pull request that installs it/)
    expect(generated).toMatch(/`steward protect`.* comes after this pull request merges/)
  })

  it('ST-56/AC-6: with no template in the project, the body follows steward\'s own', async () => {
    const gh = fakeGitHub()
    await runInit(['--yes'], { cwd: makeRepo(), gh })
    expect(opened(gh).body.endsWith(`\n---\n\n${readFileSync(path.join(ROOT, 'templates', 'pull_request_template.md'), 'utf8')}`)).toBe(true)
  })

  it('ST-56/AC-6: with several templates, --pr-template chooses, and without it init refuses with exit 2, naming them, before any write', async () => {
    const files = { '.github/PULL_REQUEST_TEMPLATE/bug.md': 'Unit:\nbug\n', '.github/PULL_REQUEST_TEMPLATE/feature.md': 'Unit:\nfeature\n' }
    const cwd = makeRepo({ files })
    const gh = fakeGitHub()
    const machine = path.join(fresh('home'), 'config.json')
    const refused = await runInit(['--yes'], { cwd, gh, machine })
    expect(refused.code).toBe(2)
    expect(refused.err).toMatch(/several pull request templates: \.github\/PULL_REQUEST_TEMPLATE\/bug\.md, \.github\/PULL_REQUEST_TEMPLATE\/feature\.md\. .*--pr-template/)
    expect(git(refused.clone, 'status', '--porcelain')).toBe('')
    expect(writes(gh)).toEqual([])
    expect(existsSync(machine)).toBe(false)

    const chosen = fakeGitHub()
    expect((await runInit(['--yes', '--pr-template', '.github/PULL_REQUEST_TEMPLATE/feature.md'], { cwd, gh: chosen })).code).toBe(0)
    expect(opened(chosen).body.endsWith('\n---\n\nUnit:\nfeature\n')).toBe(true)

    const wrong = await runInit(['--yes', '--pr-template', 'nope.md'], { cwd, gh: fakeGitHub() })
    expect(wrong.code).toBe(2)
    expect(wrong.err).toMatch(/--pr-template nope\.md: not one of the project's pull request templates/)
  })
})

describe('ST-56/AC-7: a failure stops and says what is left', () => {
  it('ST-56/AC-7: a failed push exits 1, with Git\'s message, the clone, no branch on GitHub, and what to do next; labels and user config stay', async () => {
    const cwd = makeRepo()
    refusePushes(cwd)
    const gh = fakeGitHub()
    const machine = path.join(fresh('home'), 'config.json')
    const { code, err, clone } = await runInit(['--yes'], { cwd, gh, machine })
    expect(code).toBe(1)
    const lines = err.split('\n')
    expect(lines[0]).toMatch(/^init stopped: pushing the branch steward\/install to GitHub failed\. Git said: .*pushes are closed today/s)
    expect(err).toContain(`init's copy of the project, at ${clone}`)
    expect(err).toContain('the branch steward/install in that copy only: nothing was pushed')
    expect(err).toContain('no pull request: none was opened')
    expect(err).toMatch(/Labels and the user config that init created before it stopped stay as they are/)
    expect(err).toMatch(/What to do next: fix what Git reported, and run init again/)
    expect(lines.at(-1)).toBe(`Remove ${clone} when you are done with it.`)
    expect(originRefs(cwd)).toBe(`refs/heads/main ${originMain(cwd)}`)
    expect(existsSync(machine)).toBe(true)
    expect(writes(gh).filter((r) => r.rest === '/labels')).toHaveLength(3)
    expect(writes(gh).some((r) => r.rest === '/pulls')).toBe(false)
  })

  it('ST-56/AC-7: a failed pull request request exits 1, says the branch is on GitHub, and says to open it by hand or delete the branch', async () => {
    const cwd = makeRepo()
    const gh = fakeGitHub({ pullCreate: 422 })
    const { code, err, clone } = await runInit(['--yes'], { cwd, gh })
    expect(code).toBe(1)
    expect(err).toMatch(/^init stopped: opening the draft pull request failed\. GitHub said: 422 Validation Failed$/m)
    expect(err).toContain('  the branch steward/install on GitHub')
    expect(err).toContain('git push origin --delete steward/install')
    expect(err).toContain(`Remove ${clone} when you are done with it.`)
    // Nothing is retried, and nothing on origin is deleted.
    expect(writes(gh).filter((r) => r.rest === '/pulls')).toHaveLength(1)
    expect(originRefs(cwd)).toContain(`refs/heads/${DEFAULT_BRANCH} ${git(clone, 'rev-parse', 'HEAD')}`)
  })
})

describe('ST-56/AC-7a: output written for a person', () => {
  it('ST-56/AC-7a: the closing message of a successful installation, a no-diff run and a failed push gives the clone and asks to remove it', async () => {
    const cwd = makeRepo()
    const success = await runInit(['--yes'], { cwd })
    expect(success.out.split('\n').at(-1)).toBe(
      `Your own checkout was not changed. init's copy of the project is kept at ${success.clone}: remove that folder when you are done with it.`,
    )
    adopt(cwd)
    const noDiff = await runInit(['--yes'], { cwd })
    expect(noDiff.out.split('\n').at(-1)).toBe(
      `Your own checkout was not changed. init's copy of the project is kept at ${noDiff.clone}: remove that folder when you are done with it.`,
    )
    const other = makeRepo()
    refusePushes(other)
    const failed = await runInit(['--yes'], { cwd: other })
    expect(failed.err.split('\n').at(-1)).toBe(`Remove ${failed.clone} when you are done with it.`)
    for (const run of [success, noDiff, failed]) expect(`${run.out}\n${run.err}`).not.toMatch(MENTIONS_STEWARD_INTERNALS)
  })
})

describe('ST-56/AC-8: adoption and activation remain separate', () => {
  it('ST-56/AC-8: the only requests are reads, labels and one draft pull request: nothing starts a review, rotation or landing', async () => {
    for (const args of [['--yes'], ['--yes', '--land', 'yes']]) {
      const gh = fakeGitHub()
      expect((await runInit(args, { cwd: makeRepo(), gh })).code).toBe(0)
      for (const r of gh.requests) expect(`${r.method} ${r.rest}`).toMatch(/^(GET |GET \/labels\/|POST \/labels$|GET \/pulls\?|POST \/pulls$)/)
      expect(gh.requests.some((r) => /actions|dispatches|merge|workflows/.test(r.rest))).toBe(false)
    }
  })
})

describe('ST-56/AC-9: documentation', () => {
  it('ST-56/AC-9: no Planned marker in docs/ names ST-56, and the README and help say init opens a draft pull request', async () => {
    for (const file of readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md'))) {
      expect(readFileSync(path.join(ROOT, 'docs', file), 'utf8'), file).not.toMatch(/Planned \([^)]*ST-56\b/)
    }
    const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
    expect(readme).toMatch(/draft pull request/)
    expect(readme).not.toMatch(/It commits, stages and pushes nothing/)
    const { err } = await runInit(['--nope'], { cwd: makeRepo() })
    expect(err).toMatch(/--branch <name>/)
    expect(err).toMatch(/--pr-template <path>/)
    expect(err).toMatch(/opens a draft pull request/)
  })
})
