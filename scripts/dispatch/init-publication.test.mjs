// @vitest-environment node
// Publication races and partial-installation bodies use real Git and local bare remotes.
import { expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  bareRef, branchFiles, bytesOn, callerState, fakeGitHub, git, makeRepo, pullWrites, remoteOf,
  runInit, setUpInitFixture, watchGit,
} from './init-fixture.mjs'

setUpInitFixture()

const indexBytes = (cwd) => readFileSync(path.resolve(cwd, git(cwd, 'rev-parse', '--git-path', 'index')))

it.each(['during-config', 'before-push'])('ST-56/AC-3/AC-5: a local branch advance %s cannot replace the verified publication', async (when) => {
  const cwd = makeRepo()
  const before = callerState(cwd)
  const index = indexBytes(cwd)
  const base = bareRef(cwd, 'refs/heads/main')
  const worktree = path.join(`${cwd}.worktrees`, 'steward-install')
  let verified = null
  let foreignCommit = null
  let generatedChecklist = null
  const runner = watchGit({
    after: (args, dir, result) => {
      if (args[0] === 'commit' && result.status === 0) {
        verified = git(dir, 'rev-parse', 'HEAD')
        generatedChecklist = readFileSync(path.join(dir, 'REVIEW.md'))
      }
    },
    before: (args, dir) => {
      const interleave = when === 'during-config' ? args[0] === 'config' && args.includes('--list') : args[0] === 'push'
      if (verified !== null && foreignCommit === null && interleave) {
        // A real second commit, made after inventory/commit verification and before publication.
        writeFileSync(path.join(dir, 'foreign.txt'), 'concurrent work\n')
        writeFileSync(path.join(dir, 'REVIEW.md'), 'concurrent checklist changes\n')
        git(dir, 'add', '--', 'foreign.txt', 'REVIEW.md')
        git(dir, 'commit', '-q', '-m', 'concurrent work after verification')
        foreignCommit = git(dir, 'rev-parse', 'HEAD')
      }
    },
  })
  const r = await runInit(['--yes'], { cwd, git: runner })
  expect(r.code, r.err).toBe(0)
  expect(verified).toMatch(/^[0-9a-f]{40}$/)
  expect(foreignCommit).toMatch(/^[0-9a-f]{40}$/)
  expect(foreignCommit).not.toBe(verified)
  expect(bareRef(cwd, 'refs/heads/steward/install')).toBe(verified)
  expect(git(remoteOf(cwd), 'rev-parse', `${verified}^`)).toBe(base)
  expect(branchFiles(remoteOf(cwd))).not.toContain('foreign.txt')
  expect(bytesOn(remoteOf(cwd), 'REVIEW.md')).toEqual(generatedChecklist)
  expect(r.out).toContain(`commit: ${verified}`)
  expect(pullWrites(r.gh)).toHaveLength(1)
  const push = runner.calls.find(({ args }) => args[0] === 'push').args
  expect(push).toContain(`${verified}:refs/heads/steward/install`)
  expect(push).toContain('--force-with-lease=refs/heads/steward/install:')
  // The concurrent local commit is not reset, deleted or included in the installation PR.
  expect(git(cwd, 'rev-parse', 'steward/install')).toBe(foreignCommit)
  expect(existsSync(worktree)).toBe(true)
  expect(readFileSync(path.join(worktree, 'foreign.txt'), 'utf8')).toBe('concurrent work\n')
  expect(r.out).toContain(`Kept the worktree ${worktree}`)
  expect(callerState(cwd)).toEqual(before)
  expect(indexBytes(cwd)).toEqual(index)
})

it('ST-56/AC-7: failure evidence after a local branch advance distinguishes the published verified commit', async () => {
  const cwd = makeRepo()
  const before = callerState(cwd)
  const index = indexBytes(cwd)
  let verified = null
  let foreignCommit = null
  const runner = watchGit({
    after: (args, dir, result) => {
      if (args[0] === 'commit' && result.status === 0) verified = git(dir, 'rev-parse', 'HEAD')
    },
    before: (args, dir) => {
      if (args[0] === 'push') {
        writeFileSync(path.join(dir, 'foreign.txt'), 'concurrent work\n')
        git(dir, 'add', '--', 'foreign.txt')
        git(dir, 'commit', '-q', '-m', 'concurrent local commit')
        foreignCommit = git(dir, 'rev-parse', 'HEAD')
      }
    },
  })
  const r = await runInit(['--yes'], { cwd, git: runner, gh: fakeGitHub({ labelStatus: 500 }) })
  expect(r.code, r.err).toBe(1)
  expect(r.err).toContain('It stopped while creating the labels.')
  expect(bareRef(cwd, 'refs/heads/steward/install')).toBe(verified)
  expect(r.err).toContain(`local branch steward/install at ${foreignCommit}`)
  expect(r.err).toContain(`commit ${verified}`)
  const remoteEvidence = r.err.split('\n').find((line) => line.includes('branch steward/install on origin at '))
  expect(remoteEvidence).toContain(verified)
  expect(remoteEvidence).not.toContain("not this run's commit")
  expect(callerState(cwd)).toEqual(before)
  expect(indexBytes(cwd)).toEqual(index)
})

const WORKFLOWS = {
  '.github/workflows/review-gate.yml': 'existing gate pin, deliberately unvalidated\n',
  '.github/workflows/land-approved.yml': 'existing runway pin, deliberately unvalidated\n',
  '.github/workflows/inspection.yml': 'existing inspection pin, deliberately unvalidated\n',
}

it.each([
  ['checklist', 'default-version'], ['checklist', 'explicit-pin'],
  ['settings', 'default-version'], ['settings', 'explicit-pin'],
])('ST-56/AC-6: partial %s with %s reports generator and target without claiming preserved workflow pins', async (missing, selected) => {
  const checklist = missing === 'checklist' ? 'docs/REVIEW.md' : 'REVIEW.md'
  const files = {
    ...WORKFLOWS,
    '.github/pull_request_template.md': 'Unit:\n\n## What changed\n\n## Verification\n\n## Docs check\n',
    ...(missing === 'checklist' ? { 'steward.config.json': JSON.stringify({ rulesFile: checklist }) + '\n' } : { [checklist]: 'existing checklist\n' }),
  }
  const cwd = makeRepo({ files })
  const before = callerState(cwd)
  const pin = 'a'.repeat(40)
  const args = ['--yes', ...(selected === 'explicit-pin' ? ['--ref', pin] : [])]
  const r = await runInit(args, { cwd })
  expect(r.code, r.err).toBe(0)
  const body = pullWrites(r.gh)[0].body.body
  expect(body).toContain('Generated by steward v9.8.7.')
  expect(body).toContain(`Installation workflow target: ${selected === 'explicit-pin' ? `at commit ${pin}` : 'v9.8.7'}.`)
  expect(body).toContain('No workflow file was added here')
  expect(body).toContain('their pins were not validated')
  expect(body).not.toContain('The workflow files added here run steward')
  const expected = missing === 'checklist' ? checklist : 'steward.config.json'
  expect(git(remoteOf(cwd), 'diff-tree', '--no-commit-id', '--name-status', '-r', 'steward/install')).toBe(`A\t${expected}`)
  for (const [file, bytes] of Object.entries(WORKFLOWS)) {
    expect(readFileSync(path.join(cwd, ...file.split('/')), 'utf8')).toBe(bytes)
    expect(bytesOn(remoteOf(cwd), file).toString('utf8')).toBe(bytes)
  }
  expect(callerState(cwd)).toEqual(before)
})
