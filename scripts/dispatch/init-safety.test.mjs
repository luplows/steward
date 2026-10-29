// @vitest-environment node
// Post-review ST-56 contract: real Git repositories and bare remotes, no GitHub writes.
import { expect, it } from 'vitest'
import { cpSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { writeWhole } from './init.mjs'
import {
  bareRef, callerState, fakeGitHub, failing, fresh, git, GITHUB_URL, hook, isGit,
  makeRepo, pullWrites, readOn, remoteOf, REMOTES, runInit, setUpInitFixture, slashes,
  watchGit, writes,
} from './init-fixture.mjs'

setUpInitFixture()

async function refused(cwd, { key, env, runner = watchGit() } = {}) {
  const before = callerState(cwd)
  const index = git(cwd, 'rev-parse', '--git-path', 'index')
  const indexPath = path.resolve(cwd, index)
  const indexBytes = readFileSync(indexPath)
  const gh = fakeGitHub()
  const result = await runInit(['--yes'], { cwd, gh, env, git: runner })
  expect(result.code, result.err).toBe(2)
  expect(result.err.toLowerCase()).toContain(key.toLowerCase())
  expect(result.err).toMatch(/checkout|terminal/)
  expect(runner.calls.some((c) => c.args[0] === 'fetch' || isGit(c.args, 'worktree', 'add'))).toBe(false)
  expect(gh.requests).toEqual([])
  expect(existsSync(result.machine)).toBe(false)
  expect(git(cwd, 'show-ref', '--heads')).toBe(before.refs.filter((r) => r.startsWith('refs/heads/')).map((r) => r.split(' ').reverse().join(' ')).join('\n'))
  expect(callerState(cwd)).toEqual(before)
  expect(readFileSync(indexPath)).toEqual(indexBytes)
  expect(bareRef(cwd, 'refs/heads/steward/install')).toBe('')
  return result
}

it('ST-56/AC-1b: a chained insteadOf redirect refuses before the first fetch', async () => {
  const cwd = makeRepo()
  git(cwd, 'remote', 'set-url', 'origin', 'git@github.com:acme/widgets.git')
  git(cwd, 'config', 'url.https://github.com/acme/widgets.git.insteadOf', 'git@github.com:acme/widgets.git')
  git(cwd, 'config', 'url.https://github.com/elsewhere/repo.git.insteadOf', GITHUB_URL)
  expect(git(cwd, 'remote', 'get-url', 'origin')).toBe(GITHUB_URL)
  expect(git(cwd, 'ls-remote', '--get-url', GITHUB_URL)).toBe('https://github.com/elsewhere/repo.git')
  await refused(cwd, { key: 'insteadOf' })
})

it.each(['insteadOf', 'pushInsteadOf'])('ST-56/AC-1b: even an unrelated included %s refuses and names its source', async (kind) => {
  const cwd = makeRepo()
  const source = path.join(fresh('included'), 'rules.gitconfig')
  writeFileSync(source, `[url "https://other.example/"]\n\t${kind} = unrelated:\n`)
  git(cwd, 'config', 'include.path', slashes(source))
  const r = await refused(cwd, { key: kind })
  expect(r.err).toContain('rules.gitconfig')
})

it.each([1, 2])('ST-56/AC-1b: %i pushurl values refuse even when they name the same repository', async (count) => {
  const cwd = makeRepo()
  for (let i = 0; i < count; i++) git(cwd, 'config', '--add', 'remote.origin.pushurl', GITHUB_URL)
  await refused(cwd, { key: 'remote.origin.pushurl' })
})

it.each(['extension', 'disabled-with-file', 'linked-file'])('ST-56/AC-1b: per-worktree config refuses (%s)', async (kind) => {
  let cwd = makeRepo()
  if (kind === 'extension') git(cwd, 'config', 'extensions.worktreeConfig', 'true')
  else {
    if (kind === 'linked-file') {
      const parent = cwd
      cwd = path.join(fresh('linked'), 'checkout')
      git(parent, 'worktree', 'add', '-q', '-b', 'feature', cwd)
      REMOTES.set(cwd, remoteOf(parent))
    }
    const own = path.resolve(cwd, git(cwd, 'rev-parse', '--git-path', 'config.worktree'))
    writeFileSync(own, '[core]\n\tabbrev = 12\n')
  }
  await refused(cwd, { key: 'config.worktree' })
})

it.each(['ordinary', 'linked'])('ST-56/AC-1b: relative .git/hooks refuses in a %s checkout', async (kind) => {
  let cwd = makeRepo()
  if (kind === 'linked') {
    const parent = cwd
    cwd = path.join(fresh('linked'), 'checkout')
    git(parent, 'worktree', 'add', '-q', '-b', 'feature', cwd)
    REMOTES.set(cwd, remoteOf(parent))
    expect(readFileSync(path.join(cwd, '.git'), 'utf8')).toMatch(/^gitdir:/)
  }
  git(cwd, 'config', 'core.hooksPath', '.git/hooks')
  await refused(cwd, { key: 'core.hookspath' })
})

it('ST-56/AC-1b: absolute Git-internal hooks refuse too', async () => {
  const cwd = makeRepo()
  git(cwd, 'config', 'core.hooksPath', slashes(path.join(cwd, '.git', 'hooks')))
  await refused(cwd, { key: 'Git metadata' })
})

it('ST-56/AC-1b: an absolute hooks path linked into Git metadata also refuses', async () => {
  const cwd = makeRepo()
  const linked = path.join(fresh('hooks-link'), 'hooks')
  symlinkSync(path.join(cwd, '.git', 'hooks'), linked, 'junction')
  git(cwd, 'config', 'core.hooksPath', slashes(linked))
  await refused(cwd, { key: 'Git metadata' })
})

it.each([
  'GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL', 'GIT_SSH_COMMAND', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL',
  'GIT_ALLOW_PROTOCOL', 'GIT_EXEC_PATH', 'GIT_NAMESPACE', 'git_index_file', 'GIT_FUTURE_OVERRIDE',
])('ST-56/AC-1b: inherited %s refuses without exposing its value', async (key) => {
  const cwd = makeRepo()
  const r = await refused(cwd, { key, env: { [key]: 'private override value' } })
  expect(r.err).not.toContain('private override value')
})

it('ST-56/AC-1b: unreadable effective configuration refuses before fetch', async () => {
  const runner = watchGit({ before: (args) => args.includes('--show-origin') ? failing('cannot read configuration') : undefined })
  await refused(makeRepo(), { key: 'cannot inspect effective Git configuration', runner })
})

it.each(['user.name', 'user.email'])('ST-56/AC-5: missing or blank %s refuses before effects', async (key) => {
  for (const blank of [false, true]) {
    const cwd = makeRepo()
    if (blank) git(cwd, 'config', key, '   ')
    else git(cwd, 'config', '--unset', key)
    await refused(cwd, { key })
  }
})

it.each(['true', 'yes', 'on', '1', 'not-a-boolean'])('ST-56/AC-5: unsupported commit.gpgSign=%s refuses before fetch', async (value) => {
  const cwd = makeRepo()
  git(cwd, 'config', 'commit.gpgSign', value)
  await refused(cwd, { key: 'commit.gpgsign' })
})

it.each([null, 'false', 'no', 'off', '0', ''])('ST-56/AC-5: an unused signing key is permitted with signing %s', async (value) => {
  const cwd = makeRepo()
  if (value === null) git(cwd, 'config', '--unset', 'commit.gpgSign')
  else git(cwd, 'config', 'commit.gpgSign', value)
  git(cwd, 'config', 'user.signingKey', 'UNUSED')
  git(cwd, 'config', 'gpg.program', '/nonexistent/gpg')
  const r = await runInit(['--yes'], { cwd })
  expect(r.code, r.err).toBe(0)
  expect(git(cwd, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', 'steward/install')).toBe('Crew <crew@example.com>|Crew <crew@example.com>')
  expect(git(cwd, 'cat-file', '-p', 'steward/install')).not.toContain('gpgsig')
})

it('ST-56/AC-5: a valueless signing key is Git boolean true and refuses', async () => {
  const cwd = makeRepo()
  writeFileSync(path.join(cwd, '.git', 'config'), '\n[commit]\n\tgpgSign\n', { flag: 'a' })
  expect(git(cwd, 'config', '--bool', '--get', 'commit.gpgSign')).toBe('true')
  await refused(cwd, { key: 'commit.gpgsign' })
})

it('ST-56/AC-1b: an uninspectable conditional rewrite effective only on the installation branch refuses before effects', async () => {
  const cwd = makeRepo()
  const file = path.join(fresh('conditional'), 'rewrite.gitconfig')
  writeFileSync(file, '[url "https://github.com/other/repo.git"]\n\tinsteadOf = https://github.com/acme/widgets.git\n')
  git(cwd, 'config', 'includeIf.onbranch:steward/**.path', slashes(file))
  await refused(cwd, { key: 'includeif.' })
})

it.each(['default', 'external'])('ST-56/AC-2: %s hooks are disabled from worktree add, including a post-checkout that would create the checklist', async (location) => {
  const cwd = makeRepo()
  const marker = path.join(fresh('hook'), 'ran')
  for (const name of ['post-checkout', 'pre-commit', 'commit-msg', 'post-commit', 'pre-push']) {
    hook(cwd, name, `echo ran >> "${slashes(marker)}"\necho foreign > REVIEW.md\nexit 1`)
  }
  // Fetch invokes the caller's reference-transaction hook; it must remain enabled there. This
  // hook only rejects transactions in the installation worktree, whose hooks must be disabled.
  hook(cwd, 'reference-transaction', `if test "$(git symbolic-ref -q HEAD)" = refs/heads/steward/install; then\n  echo ran >> "${slashes(marker)}"\n  exit 1\nfi\nexit 0`)
  if (location === 'external') {
    const external = path.join(fresh('external-hooks'), 'hooks')
    cpSync(path.join(cwd, '.git', 'hooks'), external, { recursive: true })
    git(cwd, 'config', 'core.hooksPath', slashes(external))
  }
  const before = callerState(cwd)
  const r = await runInit(['--yes'], { cwd })
  expect(r.code, r.err).toBe(0)
  expect(existsSync(marker)).toBe(false)
  expect(readOn(cwd, 'REVIEW.md')).not.toContain('foreign')
  expect(callerState(cwd)).toEqual(before)
  expect(r.out).toContain('All Git hooks are disabled')
  expect(pullWrites(r.gh)[0].body.body).toContain('All Git hooks were disabled')
  // The caller still runs its configured hook when the crew commits there.
  writeFileSync(path.join(cwd, 'caller.txt'), 'crew\n')
  git(cwd, 'add', 'caller.txt')
  expect(() => git(cwd, 'commit', '-q', '-m', 'caller')).toThrow()
  expect(existsSync(marker)).toBe(true)
})

it('ST-56/AC-6: a supplied body without disclosure stays verbatim and output reports the outstanding crew action', async () => {
  const cwd = makeRepo()
  const body = 'Unit: https://example.com/task\r\nA native body.\r\n'
  const file = path.join(fresh('body'), 'body.md')
  writeFileSync(file, body)
  const r = await runInit(['--yes', '--pr-body-file', file], { cwd })
  expect(r.code, r.err).toBe(0)
  expect(pullWrites(r.gh)[0].body.body).toBe(body)
  expect(r.out).toContain('All Git hooks are disabled')
  expect(r.out).toContain('Crew action before marking this PR ready: add the hook-bypass disclosure')
})

it('ST-56/AC-3: a foreign target appearing after worktree creation is refused, preserved and never committed', async () => {
  const cwd = makeRepo()
  const runner = watchGit({ after: (args, _dir, result) => {
    if (isGit(args, 'worktree', 'add') && result.status === 0) writeFileSync(path.join(args[5], 'REVIEW.md'), 'foreign bytes\n')
  } })
  const r = await runInit(['--yes'], { cwd, git: runner })
  expect(r.code, r.err).toBe(1)
  expect(r.err).toContain('REVIEW.md: an unexpected path exists')
  expect(readFileSync(path.join(`${cwd}.worktrees`, 'steward-install', 'REVIEW.md'), 'utf8')).toBe('foreign bytes\n')
  expect(runner.calls.some((c) => ['commit', 'push'].includes(c.args[0]))).toBe(false)
  expect(writes(r.gh)).toEqual([])
})

it('ST-56/AC-3: an unexpected ancestor link cannot redirect create-only writes outside the worktree', async () => {
  const cwd = makeRepo()
  const outside = fresh('outside')
  const sentinel = path.join(outside, 'sentinel')
  writeFileSync(sentinel, 'user bytes\n')
  const runner = watchGit({ after: (args, _dir, result) => {
    if (isGit(args, 'worktree', 'add') && result.status === 0) symlinkSync(outside, path.join(args[5], 'docs'), 'junction')
  } })
  const r = await runInit(['--yes', '--rules-file', 'docs/RULES.md'], { cwd, git: runner })
  expect(r.code, r.err).toBe(1)
  expect(r.err).toContain('refusing to write docs/RULES.md through it')
  expect(existsSync(path.join(outside, 'RULES.md'))).toBe(false)
  expect(readFileSync(sentinel, 'utf8')).toBe('user bytes\n')
  expect(runner.calls.some((c) => ['commit', 'push'].includes(c.args[0]))).toBe(false)
  expect(writes(r.gh)).toEqual([])
})

it.each(['after-stage', 'after-commit'])('ST-56/AC-3: working-file substitution %s stops before publication', async (when) => {
  const cwd = makeRepo()
  const before = callerState(cwd)
  const runner = watchGit({ after: (args, dir, result) => {
    if (result.status === 0 && (when === 'after-stage' ? isGit(args, '--literal-pathspecs', 'add') : args[0] === 'commit')) {
      writeFileSync(path.join(dir, 'REVIEW.md'), 'substituted bytes\n')
    }
  } })
  const r = await runInit(['--yes'], { cwd, git: runner })
  expect(r.code, r.err).toBe(1)
  expect(r.err).toContain('REVIEW.md: its working-file bytes or type are not what was generated')
  if (when === 'after-stage') expect(runner.calls.some((c) => c.args[0] === 'commit')).toBe(false)
  expect(runner.calls.some((c) => c.args[0] === 'push')).toBe(false)
  expect(writes(r.gh)).toEqual([])
  expect(callerState(cwd)).toEqual(before)
})

it('ST-56/AC-3: a clean filter changing generated staged bytes is rejected rather than treated as expected content', async () => {
  const cwd = makeRepo({ files: { '.gitattributes': 'REVIEW.md filter=replace\n' } })
  git(cwd, 'config', 'filter.replace.clean', 'echo replaced')
  const runner = watchGit()
  const r = await runInit(['--yes'], { cwd, git: runner })
  expect(r.code, r.err).toBe(1)
  expect(r.err).toContain('REVIEW.md: its content is not what was generated')
  expect(runner.calls.some((c) => ['commit', 'push'].includes(c.args[0]))).toBe(false)
  expect(writes(r.gh)).toEqual([])
})

it('ST-56/AC-7: an unowned predictable temporary file is never removed or called successful settings provisioning', async () => {
  const cwd = makeRepo()
  const machine = path.join(fresh('settings'), 'settings.json')
  const temporary = `${machine}.${process.pid}.tmp`
  writeFileSync(temporary, 'unowned bytes\n')
  await expect(writeWhole(machine, 'new bytes')).rejects.toThrow('temporary settings file collision')
  expect(readFileSync(temporary, 'utf8')).toBe('unowned bytes\n')
  const r = await runInit(['--yes'], { cwd, machine })
  expect(r.code, r.err).toBe(1)
  expect(r.err).toContain(temporary)
  expect(r.err).toContain('not owned by this invocation')
  expect(r.err).toContain(`machine settings ${machine}: the write failed, and no file is there now`)
  expect(r.out).not.toContain(`left ${machine}`)
  expect(existsSync(machine)).toBe(false)
  expect(readFileSync(temporary, 'utf8')).toBe('unowned bytes\n')
})

it.each(['no-file', 'partial-file', 'colliding-partial'])('ST-56/AC-7: a writer reporting %s cannot produce false success', async (kind) => {
  const machine = path.join(fresh('settings'), 'settings.json')
  const r = await runInit(['--yes'], { cwd: makeRepo(), machine, writeMachineSettings: async () => {
    if (kind !== 'no-file') writeFileSync(machine, '{partial')
    if (kind === 'colliding-partial') throw Object.assign(new Error('target collision'), { code: 'EEXIST' })
  } })
  expect(r.code, r.err).toBe(1)
  expect(r.err).toContain("It stopped while writing the machine's settings")
  expect(r.out).not.toMatch(/wrote .*settings.json|left .*settings.json/)
})
