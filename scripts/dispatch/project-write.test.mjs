// @vitest-environment node

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fixtureSettings } from './settings-fixture.mjs'
import { main, projectsPath } from './project.mjs'

// A write of `projects.json` that fails, in a file of its own because it replaces these two of
// `node:fs` for what it imports. Each passes through until a test sets its hook, which throws to
// make the call fail.
const hooks = vi.hoisted(() => ({ writeFileSync: null, renameSync: null }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal()
  const hooked = (name) => (...args) => {
    hooks[name]?.(...args)
    return fs[name](...args)
  }
  return { ...fs, writeFileSync: hooked('writeFileSync'), renameSync: hooked('renameSync') }
})
const actual = await vi.importActual('node:fs')

// Each activation clones a real repository.
vi.setConfig({ testTimeout: 60_000 })

// Every test runs in temporary repositories whose `origin` is a local bare repository, reached
// through the URL mapping only tests pass, with a temporary home directory: the real
// `~/.steward/` is never read or written, and nothing reaches GitHub. Git reads a global config of
// the tests' own.
let base
const GIT_ENV = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']
const savedEnv = {}
beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 'steward-project-write-'))
  for (const name of GIT_ENV) savedEnv[name] = process.env[name]
  const globalConfig = path.join(base, 'gitconfig')
  actual.writeFileSync(globalConfig, '[user]\n\tname = Crew\n\temail = crew@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n')
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
afterEach(() => { Object.assign(hooks, { writeFileSync: null, renameSync: null }) })

let counter = 0
const fresh = (name) => {
  const dir = path.join(base, `${name}-${++counter}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
const freshHome = () => fresh('home')
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const BARES = new Map()

/** A checkout of `repo` with steward installed on `main`, whose `origin` is a bare repository. */
function installedCheckout(repo) {
  const url = `https://github.com/${repo}.git`
  const dir = fresh('repo')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'remote', 'add', 'origin', url)
  const files = {
    'steward.config.json': `${JSON.stringify(fixtureSettings({ repo }), null, 2)}\n`,
    'REVIEW.md': '# Checklist\n\n## Every pull request\n\n1. The diff matches its description.\n',
    '.github/workflows/review-gate.yml': 'name: review-gate\n',
  }
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    actual.writeFileSync(path.join(dir, rel), text)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'start')
  const bare = fresh('origin')
  git(bare, 'init', '-q', '--bare', '-b', 'main')
  git(dir, 'push', '-q', bare, 'main')
  BARES.set(url, bare)
  return dir
}

/** Runs `steward project <args>`; resolves `{ code, out, err }`. */
async function run(args, home) {
  const out = []
  const err = []
  const code = await main(args, {
    cwd: base,
    homedir: home,
    cloneUrl: (url) => BARES.get(url),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

/** The way each step fails. A write gets part way first, so that a direct write would be caught. */
const FAILURES = [
  ['the write of the temporary file', 'part way through the write', (file) => {
    hooks.writeFileSync = (target) => {
      if (!String(target).startsWith(file)) return
      actual.writeFileSync(target, '{ "projects": [')
      throw Object.assign(new Error('part way through the write'), { code: 'ENOSPC' })
    }
  }],
  ['the rename', 'the rename failed', (file) => {
    hooks.renameSync = (from) => {
      if (String(from).startsWith(file)) throw Object.assign(new Error('the rename failed'), { code: 'EPERM' })
    }
  }],
]

/** What a state folder holds beside the owned checkouts. */
const stateFiles = (home) => readdirSync(path.dirname(projectsPath(home))).filter((name) => name !== 'checkouts').sort()

describe('ST-66/AC-5: a write of projects.json that fails', () => {
  for (const [name, message, makeItFail] of FAILURES) {
    it(`ST-66/AC-5: when ${name} fails during activate: the existing records are byte for byte unchanged, nothing says it was activated, and the command reports the failure`, async () => {
      const home = freshHome()
      expect((await run(['activate', installedCheckout('acme/first')], home)).code).toBe(0)
      const file = projectsPath(home)
      const before = readFileSync(file, 'utf8')

      const second = installedCheckout('acme/second')
      makeItFail(file)
      const failed = await run(['activate', second], home)
      Object.assign(hooks, { writeFileSync: null, renameSync: null })

      expect(failed.code).toBe(1)
      expect(failed.err).toBe(message)
      expect(failed.out).not.toContain('Activated')
      expect(readFileSync(file, 'utf8')).toBe(before)
      expect(stateFiles(home)).toEqual(['projects.json'])
      expect((await run(['list'], home)).out).not.toContain('acme/second')

      // The attempt cost nothing: running it again records it.
      expect((await run(['activate', second], home)).code).toBe(0)
      expect(JSON.parse(readFileSync(file, 'utf8')).projects.map((p) => p.repo)).toEqual(['acme/first', 'acme/second'])
    })

    it(`ST-66/AC-5: when ${name} fails during deactivate: the existing records are byte for byte unchanged, nothing says it was deactivated, and the command reports the failure`, async () => {
      const home = freshHome()
      expect((await run(['activate', installedCheckout('acme/first')], home)).code).toBe(0)
      const file = projectsPath(home)
      const before = readFileSync(file, 'utf8')

      makeItFail(file)
      const failed = await run(['deactivate', 'acme/first'], home)
      Object.assign(hooks, { writeFileSync: null, renameSync: null })

      expect(failed.code).toBe(1)
      expect(failed.err).toBe(message)
      expect(failed.out).toBe('')
      expect(readFileSync(file, 'utf8')).toBe(before)
      expect(stateFiles(home)).toEqual(['projects.json'])
      expect((await run(['list'], home)).out).toContain('acme/first')
    })
  }
})
