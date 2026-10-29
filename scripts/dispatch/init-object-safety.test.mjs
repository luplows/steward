// @vitest-environment node
// Replacement-object and cleanup regressions use real Git and temporary local bare remotes.
import { expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { defaultGit } from './init-install.mjs'
import {
  bareRef, branchFiles, callerState, failing, fakeGitHub, git, isGit, makeRepo,
  pullWrites, remoteOf, runInit, setUpInitFixture, watchGit, writes,
} from './init-fixture.mjs'

setUpInitFixture()

const refs = (repo) => git(repo, 'for-each-ref', '--format=%(refname) %(objectname)')
const indexBytes = (cwd) => readFileSync(path.resolve(cwd, git(cwd, 'rev-parse', '--git-path', 'index')))

/** Make substituted objects without moving any branch, then leave a local replacement ref. */
function replaceObject(cwd, kind = 'commit') {
  const base = git(cwd, 'rev-parse', 'HEAD')
  const originalTree = git(cwd, 'rev-parse', 'HEAD^{tree}')
  const originalBlob = git(cwd, 'rev-parse', 'HEAD:package.json')
  const originalBytes = readFileSync(path.join(cwd, 'package.json'), 'utf8')
  writeFileSync(path.join(cwd, 'package.json'), '{"name":"substituted"}\n')
  writeFileSync(path.join(cwd, 'foreign-only.txt'), 'not part of the installation\n')
  git(cwd, 'add', '--', 'package.json', 'foreign-only.txt')
  const tree = git(cwd, 'write-tree')
  const commit = git(cwd, 'commit-tree', tree, '-m', 'replacement without a parent')
  const blob = git(cwd, 'rev-parse', `${tree}:package.json`)
  git(cwd, 'reset', '--hard', base)
  const original = kind === 'commit' ? base : kind === 'tree' ? originalTree : originalBlob
  const replacement = kind === 'commit' ? commit : kind === 'tree' ? tree : blob
  git(cwd, 'replace', original, replacement)
  return { base, original, originalBytes }
}

it.each(['commit', 'tree', 'blob'])('ST-56/AC-3: local replacement %s refuses before fetch and leaves every caller resource intact', async (kind) => {
  const cwd = makeRepo()
  const { original } = replaceObject(cwd, kind)
  const before = callerState(cwd)
  const index = indexBytes(cwd)
  const localRefs = refs(cwd)
  const remoteRefs = refs(remoteOf(cwd))
  const runner = watchGit()
  const r = await runInit(['--yes'], { cwd, git: runner })
  expect(r.code, r.err).toBe(2)
  expect(r.err).toContain(`refs/replace/${original}`)
  expect(r.err).toContain('replacement refs')
  expect(r.err).toContain('git replace --list')
  expect(runner.calls.some(({ args }) => args[0] === 'fetch' || args[0] === 'push' || isGit(args, 'worktree', 'add'))).toBe(false)
  expect(r.gh.requests).toEqual([])
  expect(existsSync(r.machine)).toBe(false)
  expect(existsSync(`${cwd}.worktrees`)).toBe(false)
  expect(callerState(cwd)).toEqual(before)
  expect(indexBytes(cwd)).toEqual(index)
  expect(refs(cwd)).toBe(localRefs)
  expect(refs(remoteOf(cwd))).toBe(remoteRefs)
})

it('ST-56/AC-3: an unreadable replacement-ref inventory refuses before fetch rather than assuming none exist', async () => {
  const cwd = makeRepo()
  const before = callerState(cwd)
  const runner = watchGit({ before: (args) =>
    args[0] === 'for-each-ref' && args.includes('refs/replace/') ? failing('cannot enumerate replacement refs') : undefined,
  })
  const r = await runInit(['--yes'], { cwd, git: runner })
  expect(r.code, r.err).toBe(2)
  expect(r.err).toContain('cannot enumerate replacement refs')
  expect(runner.calls.some(({ args }) => args[0] === 'fetch' || isGit(args, 'worktree', 'add'))).toBe(false)
  expect(r.gh.requests).toEqual([])
  expect(callerState(cwd)).toEqual(before)
  expect(existsSync(r.machine)).toBe(false)
})

it('ST-56/AC-3: installer Git reads original objects even if a replacement appears after preflight', () => {
  const cwd = makeRepo()
  const { base, originalBytes } = replaceObject(cwd)
  expect(git(cwd, 'show', `${base}:package.json`)).toContain('substituted')
  const read = defaultGit(cwd, ['show', `${base}:package.json`])
  expect(read.status, read.stderr).toBe(0)
  expect(read.stdout).toBe(originalBytes)
  const tree = defaultGit(cwd, ['ls-tree', '--name-only', base])
  expect(tree.status, tree.stderr).toBe(0)
  expect(tree.stdout).not.toContain('foreign-only.txt')
  // No caller configuration or replacement ref was changed to obtain the original view.
  expect(git(cwd, 'replace', '--list')).toBe(base)
  expect(git(cwd, 'show', `${base}:package.json`)).toContain('substituted')
})

it.each(['ignored-file', 'ignored-directory', 'assume-unchanged', 'skip-worktree'])('ST-56/AC-5: late %s work is retained after PR confirmation and never passed to worktree removal', async (kind) => {
  const cwd = makeRepo({ files: { '.gitignore': '*.private\nprivate-cache/\n' } })
  const before = callerState(cwd)
  const index = indexBytes(cwd)
  const dir = path.join(`${cwd}.worktrees`, 'steward-install')
  const rel = kind === 'ignored-file' ? 'notes.private' : kind === 'ignored-directory' ? 'private-cache/notes.txt' : 'package.json'
  const file = path.join(dir, ...rel.split('/'))
  const bytes = 'work left by another process while GitHub is confirming the PR\n'
  const gh = fakeGitHub()
  const fetch = gh.fetch
  gh.fetch = async (url, options) => {
    const response = await fetch(url, options)
    if (url.endsWith('/pulls') && options.method === 'POST') {
      mkdirSync(path.dirname(file), { recursive: true })
      if (kind === 'assume-unchanged' || kind === 'skip-worktree') git(dir, 'update-index', `--${kind}`, 'package.json')
      writeFileSync(file, bytes)
      if (kind.startsWith('ignored')) expect(git(dir, 'check-ignore', rel)).toBe(rel)
      else expect(git(dir, 'status', '--porcelain')).toBe('')
    }
    return response
  }
  const runner = watchGit()
  const r = await runInit(['--yes'], { cwd, gh, git: runner })
  expect(r.code, r.err).toBe(0)
  expect(r.err).toBe('')
  expect(r.out).toContain(`Kept the worktree ${dir}`)
  expect(r.out).not.toContain(`Removed the worktree ${dir}`)
  expect(existsSync(dir)).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe(bytes)
  expect(runner.calls.some(({ args }) => isGit(args, 'worktree', 'remove'))).toBe(false)
  expect(pullWrites(gh)).toHaveLength(1)
  expect(bareRef(cwd, 'refs/heads/steward/install')).toBe(git(cwd, 'rev-parse', 'steward/install'))
  if (kind.startsWith('ignored')) expect(branchFiles(cwd)).not.toContain(rel)
  expect(callerState(cwd)).toEqual(before)
  expect(indexBytes(cwd)).toEqual(index)
})

it('ST-56/AC-5: failure to inspect cleanup status keeps the worktree after confirmed success', async () => {
  const cwd = makeRepo()
  const dir = path.join(`${cwd}.worktrees`, 'steward-install')
  const gh = fakeGitHub()
  const fetch = gh.fetch
  let confirmed = false
  gh.fetch = async (url, options) => {
    const response = await fetch(url, options)
    if (url.endsWith('/pulls') && options.method === 'POST') confirmed = true
    return response
  }
  const runner = watchGit({ before: (args) => confirmed && args[0] === 'status' ? failing('cannot inspect cleanup status') : undefined })
  const r = await runInit(['--yes'], { cwd, gh, git: runner })
  expect(r.code, r.err).toBe(0)
  expect(r.out).toContain(`Kept the worktree ${dir}`)
  expect(r.out).toContain('cannot inspect cleanup status')
  expect(existsSync(dir)).toBe(true)
  expect(runner.calls.some(({ args }) => isGit(args, 'worktree', 'remove'))).toBe(false)
  expect(pullWrites(gh)).toHaveLength(1)
  expect(writes(gh).filter((request) => request.rest === '/labels')).toHaveLength(3)
})

it('ST-56/AC-5: a clean finished worktree with ignore rules is still removed after PR confirmation', async () => {
  const cwd = makeRepo({ files: { '.gitignore': '*.private\nprivate-cache/\n' } })
  const dir = path.join(`${cwd}.worktrees`, 'steward-install')
  const runner = watchGit()
  const r = await runInit(['--yes'], { cwd, git: runner })
  expect(r.code, r.err).toBe(0)
  expect(r.out).toContain(`Removed the worktree ${dir}`)
  expect(existsSync(dir)).toBe(false)
  expect(runner.calls.filter(({ args }) => isGit(args, 'worktree', 'remove'))).toHaveLength(1)
  expect(pullWrites(r.gh)).toHaveLength(1)
})
