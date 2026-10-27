// The fixtures of init's tests: temporary git repositories with a bare repository standing in for
// each one's `origin`, GitHub's answers, a terminal, and the runner of git commands, all injected,
// so that no test touches a real repository or GitHub.
import { afterAll, beforeAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main, repoFromRemoteUrl } from './init.mjs'
import { defaultGit } from './init-install.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const CLI = path.join(ROOT, 'scripts', 'dispatch', 'cli.mjs')
export const SHA = '0123456789abcdef0123456789abcdef01234567'
export const REPO = 'acme/widgets'

// Every test runs init in a temporary repository whose `origin` is a temporary bare repository
// (the GitHub address it names is routed there by `url.<bare>.insteadOf`, and `GIT_ALLOW_PROTOCOL`
// lets git use nothing but the file transport, so a fetch or push that was not routed there fails
// instead of reaching github.com), with GitHub's answers injected, the machine's settings in a
// temporary file and the terminal injected: nothing for real.
let base
const savedEnv = {}

/**
 * Registers the hooks that make the temporary folder and confine git to the file transport. Call it
 * once per test file.
 */
export function setUpInitFixture() {
  // An installation runs some twenty git commands on real repositories, a few seconds on a slow
  // machine.
  vi.setConfig({ testTimeout: 180000 })
  beforeAll(() => {
    base = mkdtempSync(path.join(tmpdir(), 'steward-init-'))
    for (const [key, value] of [['GIT_ALLOW_PROTOCOL', 'file'], ['GIT_TERMINAL_PROMPT', '0']]) {
      savedEnv[key] = process.env[key]
      process.env[key] = value
    }
  })
  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(base, { recursive: true, force: true })
  })
}

let counter = 0
export const fresh = (name) => {
  const dir = path.join(base, `${name}-${++counter}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

export const GITHUB_URL = `https://github.com/${REPO}.git`
/** The bare repository standing in for each checkout's `origin`. */
export const REMOTES = new Map()
export const remoteOf = (cwd) => REMOTES.get(cwd)
export const slashes = (p) => p.replaceAll('\\', '/')

/**
 * A temporary repository with one commit (a `package.json`) on `main`, and `origin` when given. An
 * `origin` that is a GitHub address is routed to a temporary bare repository
 * (`url.<bare>.insteadOf`), which `main` is pushed to unless `push` is false.
 */
export function makeRepo({ origin = GITHUB_URL, files = {}, push = true } = {}) {
  const dir = fresh('repo')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'crew@example.com')
  git(dir, 'config', 'user.name', 'Crew')
  git(dir, 'config', 'commit.gpgsign', 'false')
  if (origin !== null) git(dir, 'remote', 'add', 'origin', origin)
  if (origin !== null && repoFromRemoteUrl(origin) !== null) {
    const bare = fresh('remote')
    git(bare, 'init', '-q', '--bare', '-b', 'main')
    git(dir, 'config', `url.${slashes(bare)}.insteadOf`, origin)
    REMOTES.set(dir, bare)
  }
  writeFileSync(path.join(dir, 'package.json'), '{"name":"widgets","version":"1.0.0"}\n')
  put(dir, files)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'start')
  if (REMOTES.has(dir) && push) git(dir, 'push', '-q', '-u', 'origin', 'main')
  return dir
}

/**
 * Commits `files` to `main` of the bare repository standing behind `cwd`'s `origin`, from a clone
 * of its own.
 */
export function pushToRemote(cwd, files, { remove = [], branch = 'main', message = 'upstream' } = {}) {
  const clone = fresh('clone')
  git(clone, 'init', '-q', '-b', 'main')
  git(clone, 'config', 'user.email', 'other@example.com')
  git(clone, 'config', 'user.name', 'Other')
  git(clone, 'config', 'commit.gpgsign', 'false')
  git(clone, 'remote', 'add', 'origin', slashes(remoteOf(cwd)))
  git(clone, 'pull', '-q', 'origin', 'main')
  put(clone, files)
  for (const rel of remove) rmSync(path.join(clone, rel))
  git(clone, 'add', '-A')
  git(clone, 'commit', '-q', '-m', message)
  git(clone, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`)
  return git(clone, 'rev-parse', 'HEAD')
}

/** The files of the installation branch (or `ref`) of `cwd`'s repository, sorted. */
export const branchFiles = (cwd, ref = 'steward/install') =>
  execFileSync('git', ['ls-tree', '-r', '--name-only', ref], { cwd, encoding: 'utf8' }).split('\n').filter((l) => l !== '').sort()
export const bytesOn = (cwd, rel, ref = 'steward/install') => execFileSync('git', ['show', `${ref}:${rel}`], { cwd })
export const readOn = (cwd, rel, ref) => bytesOn(cwd, rel, ref).toString('utf8')
export const hasOn = (cwd, rel, ref) => branchFiles(cwd, ref).includes(rel)

/**
 * A folder holding the files of the installation branch (or `ref`), so that a reader of a project's
 * folder can read them.
 */
export function snapshot(cwd, ref = 'steward/install') {
  const dir = fresh('view')
  for (const rel of branchFiles(cwd, ref)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), bytesOn(cwd, rel, ref))
  }
  return dir
}

/** Merges the installation branch into `main` and pushes it, as the crew's merge would. */
export function mergeInstall(cwd, ref = 'steward/install') {
  git(cwd, 'merge', '-q', '--ff-only', ref)
  git(cwd, 'push', '-q', 'origin', 'main')
}

export function put(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), text)
  }
}

/** A copy of steward's `templates/`, with a `package.json` whose version is `version`. */
export function makePackage(version = '9.8.7') {
  const dir = fresh('package')
  cpSync(path.join(ROOT, 'templates'), path.join(dir, 'templates'), { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'steward', version }))
  return dir
}

/**
 * GitHub's answers, injected as `fetch`. `noMain` answers every request about `main`'s protection
 * `404 Branch not found`, as GitHub does for a repository with no `main`; otherwise `main` has none
 * (`404 Branch not protected`). `labelCreate` is `already_exists` or `other` (a 422 for each).
 * Records every request.
 */
export function fakeGitHub({
  labels = [],
  labelStatus = null,
  labelCreate = null,
  noMain = false,
  pulls = [],
  pullListStatus = null,
  pullCreate = null,
  throwOn = null,
} = {}) {
  const have = new Set(labels)
  const requests = []
  const created = []
  const fetch = async (url, init) => {
    const rest = /\/repos\/[^/]+\/[^/]+(\/.*)$/.exec(url)[1]
    const body = init.body === undefined ? undefined : JSON.parse(init.body)
    requests.push({ method: init.method, rest, body })
    if (throwOn !== null && throwOn(init.method, rest)) throw new TypeError('fetch failed')
    const reply = (status, content) => ({ status, text: async () => (content === undefined ? '' : JSON.stringify(content)) })
    if (rest.startsWith('/pulls?') && init.method === 'GET') {
      if (pullListStatus !== null) return reply(pullListStatus, { message: 'boom' })
      const head = decodeURIComponent(/[?&]head=([^&]+)/.exec(rest)[1])
      return reply(200, pulls.filter((p) => `${p.head.repo.full_name.split('/')[0]}:${p.head.ref}` === head && p.base.ref === 'main'))
    }
    if (rest === '/pulls' && init.method === 'POST') {
      if (pullCreate !== null && typeof pullCreate === 'number') return reply(pullCreate, { message: 'Validation Failed', errors: [{ message: 'no commits between main and the branch' }] })
      const number = 40 + created.length + 1
      const pr = {
        number,
        html_url: `https://github.com/${REPO}/pull/${number}`,
        state: 'open',
        draft: pullCreate === 'notDraft' ? false : body.draft,
        head: { ref: body.head, repo: { full_name: REPO } },
        base: { ref: body.base },
      }
      created.push(pr)
      return reply(pullCreate === 'ok200' ? 200 : 201, pr)
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
  return { fetch, requests, have, created }
}

export const writes = (gh) => gh.requests.filter((r) => r.method !== 'GET')
export const labelWrites = (gh) => writes(gh).filter((r) => r.rest === '/labels')
export const pullWrites = (gh) => writes(gh).filter((r) => r.rest === '/pulls')

/** A terminal: `answers` are given in order, one per question; `prompts` records what was asked. */
export function fakeTerminal(answers = null) {
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
 * Runs `init` in `cwd`; resolves `{ code, out, err, machine, gh, terminal, cwd, view }`, `view`
 * being a folder holding the installation branch's files (made when first read). `git` replaces the
 * runner of every git command (see `watchGit`).
 */
export async function runInit(args, { cwd, gh = fakeGitHub(), terminal = fakeTerminal(), pkg = makePackage(), machine = path.join(fresh('home'), 'settings.json'), codex = null, exists, git: runner, getToken = async () => 'token' } = {}) {
  const out = []
  const err = []
  const code = await main(args, {
    cwd,
    env: { STEWARD_SETTINGS: machine },
    homedir: fresh('profile'),
    fetch: gh.fetch,
    getToken,
    terminal,
    findExecutable: () => codex,
    ...(exists ? { exists } : {}),
    ...(runner ? { git: runner } : {}),
    packageRoot: pkg,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  })
  let viewDir = null
  return {
    code,
    out: out.join('\n'),
    err: err.join('\n'),
    machine,
    gh,
    terminal,
    pkg,
    cwd,
    get view() {
      viewDir ??= snapshot(cwd)
      return viewDir
    },
  }
}

/**
 * A git runner that runs the real one and records every call as `{ cwd, args }`. `before(args,
 * cwd)` may return a result to give in place of running the command (`{ status, stdout, stderr }`);
 * `after` is called with the command's real result and may change it by returning another.
 */
export function watchGit({ before = () => undefined, after = () => undefined } = {}) {
  const calls = []
  const runner = (cwd, args, options) => {
    calls.push({ cwd, args })
    const instead = before(args, cwd)
    if (instead !== undefined) return instead
    const real = defaultGit(cwd, args, options)
    return after(args, cwd, real) ?? real
  }
  runner.calls = calls
  return runner
}
export const failing = (stderr = 'simulated failure', status = 1) => ({ status, stdout: '', stderr })
export const isGit = (args, ...words) => words.every((w, i) => args[i] === w)
export const gitWith = (args, ...words) => words.every((w) => args.includes(w))

/** Every file under `dir` except `.git`, as relative paths, sorted. */
export function tree(dir, rel = '') {
  return readdirSync(path.join(dir, rel), { withFileTypes: true })
    .flatMap((e) => {
      const r = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.name === '.git') return []
      return e.isDirectory() ? tree(dir, r) : [r]
    })
    .sort()
}

export const read = (dir, rel) => readFileSync(path.join(dir, rel), 'utf8')

export const ALL_FLAGS = [
  '--unit-links', 'file,issue,other', '--rules-file', 'docs/RULES.md', '--land', 'no', '--inspect-after-hours', '48',
  '--inspection', 'yes', '--coder-session-limit', '60', '--coder-weekly-limit', '65',
  '--reviewer-session-limit', '80', '--reviewer-weekly-limit', '85',
]


// ------------------------------------------------------------------ the installation's own tests

/** What `git` prints for `args` in `cwd`, or '' when it fails. */
export const tryGit = (cwd, ...args) => {
  try {
    return git(cwd, ...args)
  } catch {
    return ''
  }
}

/** The commit `ref` names in the bare repository standing behind `cwd`'s `origin`, or ''. */
export const bareRef = (cwd, ref) => tryGit(remoteOf(cwd), 'rev-parse', '--verify', '--quiet', ref)

/** Writes `text` to `rel` and commits it. */
export function commitFile(cwd, rel, text, message = 'change') {
  put(cwd, { [rel]: text })
  git(cwd, 'add', '--', rel)
  git(cwd, 'commit', '-q', '-m', message)
}

/**
 * Everything of a checkout that init must leave alone: `HEAD`, the branch it is on, every other
 * branch and tag, the index (with its unmerged entries), the status with ignored files, the stash,
 * an unfinished merge or rebase, and the bytes of every file in the working tree. The installation
 * branch `init` adds is left out (`ignoreBranch`).
 */
export function callerState(cwd, { ignoreBranch = 'steward/install' } = {}) {
  const quiet = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim()
  const files = {}
  for (const rel of tree(cwd)) files[rel] = readFileSync(path.join(cwd, ...rel.split('/'))).toString('base64')
  return {
    head: quiet('rev-parse', 'HEAD'),
    branch: tryGit(cwd, 'symbolic-ref', '-q', 'HEAD'),
    refs: quiet('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags', 'refs/stash')
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith(`refs/heads/${ignoreBranch} `)),
    index: quiet('ls-files', '--stage'),
    status: quiet('status', '--porcelain=v1', '--ignored'),
    stash: quiet('stash', 'list'),
    unfinished: ['MERGE_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD'].filter((n) => existsSync(path.join(cwd, '.git', n))),
    files,
  }
}

/** Installs `script` as the hook `name` of the repository of `cwd`. */
export function hook(cwd, name, script) {
  const file = path.join(cwd, '.git', 'hooks', name)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `#!/bin/sh\n${script}\n`)
  chmodSync(file, 0o755)
}

/** The files an installation with the default answers adds, sorted. */
export const EXPECTED_NEW = [
  '.github/pull_request_template.md',
  '.github/workflows/inspection.yml',
  '.github/workflows/land-approved.yml',
  '.github/workflows/review-gate.yml',
  'REVIEW.md',
  'steward.config.json',
]
