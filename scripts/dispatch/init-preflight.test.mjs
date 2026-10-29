// @vitest-environment node
// Fourth-review regressions: real Git, temporary bare remotes, injected GitHub and user config.
import { expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fixtureUserConfig } from './settings-fixture.mjs'
import {
  callerState, fresh, git, GITHUB_URL, isGit, makeRepo, remoteOf, runInit,
  setUpInitFixture, slashes, watchGit, writes,
} from './init-fixture.mjs'

setUpInitFixture()

const refs = (repo) => git(repo, 'for-each-ref', '--format=%(refname) %(objectname)')
const indexBytes = (cwd) => readFileSync(path.resolve(cwd, git(cwd, 'rev-parse', '--git-path', 'index')))
const before = (cwd) => ({
  caller: callerState(cwd), index: indexBytes(cwd), config: readFileSync(path.join(cwd, '.git', 'config')),
  remote: refs(remoteOf(cwd)),
})

function expectRefusal(cwd, previous, result, runner) {
  expect(result.code, result.err).toBe(2)
  expect(writes(result.gh)).toEqual([])
  expect(runner.calls.some(({ args }) => isGit(args, 'worktree', 'add') ||
    ['add', 'commit', 'push'].includes(args[0]))).toBe(false)
  expect(existsSync(`${cwd}.worktrees`)).toBe(false)
  expect(callerState(cwd)).toEqual(previous.caller)
  expect(indexBytes(cwd)).toEqual(previous.index)
  expect(readFileSync(path.join(cwd, '.git', 'config'))).toEqual(previous.config)
  expect(refs(remoteOf(cwd))).toBe(previous.remote)
}

it.each([
  GITHUB_URL,
  'ssh://git@github.com/acme/widgets.git',
  'git@github.com:acme/widgets.git',
])('ST-56/AC-1b: URL-shaped remote name %s refuses before fetch and cannot redirect publication', async (url) => {
  const cwd = makeRepo({ origin: url })
  const foreign = remoteOf(makeRepo({ files: { 'foreign-only.md': 'another repository\n' } }))
  const source = path.join(fresh('included-remote'), 'remote.gitconfig')
  writeFileSync(source, `[remote "${url}"]\n\turl = ${slashes(foreign)}\n`)
  git(cwd, 'config', 'include.path', slashes(source))
  // Git really treats this otherwise validated URL as a remote name. Only a local temporary
  // repository can be reached; the fixture disallows every transport except file.
  expect(git(cwd, 'remote', 'get-url', 'origin')).toBe(url)
  expect(git(cwd, 'ls-remote', '--get-url', url)).toBe(slashes(foreign))
  const previous = before(cwd)
  const foreignRefs = refs(foreign)
  const runner = watchGit()
  // Identity transport makes Git perform its real name lookup, rather than the usual fixture
  // mapping of a GitHub URL to the intended bare remote. The configured alias reaches `foreign`.
  const r = await runInit(['--yes'], { cwd, git: runner, transport: (destination) => destination })
  expectRefusal(cwd, previous, r, runner)
  expect(r.err).toContain(`remote.${url.toLowerCase()}.url`)
  expect(r.err).toContain('remote.gitconfig')
  expect(r.err).toContain('URL-shaped remote name')
  expect(runner.calls.some(({ args }) => args[0] === 'fetch')).toBe(false)
  expect(r.gh.requests).toEqual([])
  expect(existsSync(r.machine)).toBe(false)
  expect(readFileSync(source, 'utf8')).toContain(slashes(foreign))
  expect(refs(foreign)).toBe(foreignRefs)
})

it('ST-56/AC-1b: an ordinary additional remote is permitted without changing its destination', async () => {
  const cwd = makeRepo()
  const foreign = remoteOf(makeRepo({ files: { 'foreign-only.md': 'another repository\n' } }))
  git(cwd, 'remote', 'add', 'upstream', slashes(foreign))
  const previous = before(cwd)
  const foreignRefs = refs(foreign)
  const r = await runInit(['--yes'], { cwd })
  expect(r.code, r.err).toBe(0)
  expect(callerState(cwd)).toEqual(previous.caller)
  expect(indexBytes(cwd)).toEqual(previous.index)
  expect(readFileSync(path.join(cwd, '.git', 'config'))).toEqual(previous.config)
  expect(refs(foreign)).toBe(foreignRefs)
  expect(git(remoteOf(cwd), 'rev-parse', 'refs/heads/steward/install')).toBe(git(cwd, 'rev-parse', 'steward/install'))
})

const INVALID_CONDITIONAL_FLAGS = [
  ['--coder-session-limit', '0'], ['--coder-weekly-limit', '101'],
  ['--reviewer-session-limit', 'no'], ['--reviewer-weekly-limit', '1.5'],
  ['--reviewer', 'other'], ['--codex-model', '   '], ['--codex-effort', 'unknown'],
]

it.each(INVALID_CONDITIONAL_FLAGS)('ST-56/AC-1: inactive %s %s refuses with existing user config before effects', async (flag, value) => {
  const cwd = makeRepo()
  const config = path.join(fresh('user-config'), 'config.json')
  const bytes = JSON.stringify(fixtureUserConfig()) + '\n'
  writeFileSync(config, bytes)
  const previous = before(cwd)
  const runner = watchGit()
  const r = await runInit(['--yes', flag, value], { cwd, machine: config, git: runner })
  expectRefusal(cwd, previous, r, runner)
  expect(r.err).toContain(flag)
  expect(r.gh.requests).toEqual([])
  expect(readFileSync(config, 'utf8')).toBe(bytes)
})

it.each([['--codex-model', ''], ['--codex-effort', 'unknown']])('ST-56/AC-1: inactive %s %s also refuses when a new config chooses Claude', async (flag, value) => {
  const cwd = makeRepo()
  const previous = before(cwd)
  const runner = watchGit()
  const r = await runInit(['--yes', '--reviewer', 'claude', flag, value], { cwd, git: runner })
  expectRefusal(cwd, previous, r, runner)
  expect(r.err).toContain(flag)
  expect(existsSync(r.machine)).toBe(false)
  expect(r.gh.requests).toEqual([])
})

it('ST-56/AC-1: an invalid inactive flag refuses on the no-diff path before labels or user-config provisioning', async () => {
  const cwd = makeRepo({ files: {
    'steward.config.json': '{"rulesFile":"REVIEW.md"}\n', 'REVIEW.md': 'existing\n',
    '.github/workflows/review-gate.yml': 'existing\n',
    '.github/workflows/land-approved.yml': 'existing\n',
    '.github/workflows/inspection.yml': 'existing\n',
    '.github/pull_request_template.md': 'Unit:\n',
  } })
  const config = path.join(fresh('user-config'), 'config.json')
  const bytes = JSON.stringify(fixtureUserConfig()) + '\n'
  writeFileSync(config, bytes)
  const previous = before(cwd)
  const runner = watchGit()
  const r = await runInit(['--yes', '--coder-session-limit', '0'], { cwd, machine: config, git: runner })
  expectRefusal(cwd, previous, r, runner)
  expect(r.err).toContain('--coder-session-limit')
  expect(r.out).not.toContain('No installation pull request is needed')
  expect(readFileSync(config, 'utf8')).toBe(bytes)
})

it('ST-56/AC-1: valid inactive flag values do not change preserved user config or select a Codex reviewer', async () => {
  const cwd = makeRepo()
  const config = path.join(fresh('user-config'), 'config.json')
  const bytes = JSON.stringify(fixtureUserConfig(), null, 4) + '\n'
  writeFileSync(config, bytes)
  const previous = before(cwd)
  const r = await runInit([
    '--yes', '--coder-session-limit', '60', '--coder-weekly-limit', '65',
    '--reviewer-session-limit', '80', '--reviewer-weekly-limit', '85',
    '--reviewer', 'codex', '--codex-model', 'unused-model', '--codex-effort', 'ultra',
  ], { cwd, machine: config })
  expect(r.code, r.err).toBe(0)
  expect(readFileSync(config, 'utf8')).toBe(bytes)
  expect(callerState(cwd)).toEqual(previous.caller)
  expect(indexBytes(cwd)).toEqual(previous.index)
})
