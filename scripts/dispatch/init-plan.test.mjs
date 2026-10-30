// @vitest-environment node
// Ninth-review regressions: whether a pull request is needed is decided before any question that
// only shapes it, and every installer Git command reads paths and objects literally. Real Git,
// temporary bare remotes, injected GitHub and user config.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { LITERAL_GIT_OPTIONS } from './init-install.mjs'
import {
  callerState, failing, fakeGitHub, fresh, git, isGit, makeRepo, mergeInstall, pullWrites, readOn, remoteOf,
  runInit, setUpInitFixture, slashes, watchGit, writes,
} from './init-fixture.mjs'

setUpInitFixture()

const TWO = {
  '.github/PULL_REQUEST_TEMPLATE/bug.md': 'Unit:\n\n## Bug\n\n<!-- bug prompt -->\n',
  '.github/PULL_REQUEST_TEMPLATE/feature.md': 'Unit:\n\n## Feature\n\n<!-- feature prompt -->\n',
}
const refs = (repo) => git(repo, 'for-each-ref', '--format=%(refname) %(objectname)')

/** Installs with `args`, merges the installation into `main` and pushes it, as the crew would. */
async function installed(cwd, args = []) {
  const first = await runInit(['--yes', ...args], { cwd })
  expect(first.code, first.err).toBe(0)
  mergeInstall(cwd)
}

/** Everything a run must leave as it was when it makes no installation, read before and after. */
const untouched = (cwd) => ({ caller: callerState(cwd), remote: refs(remoteOf(cwd)), worktrees: git(cwd, 'worktree', 'list', '--porcelain') })

/** Asserts that a run made no branch, worktree, commit, push or pull request. */
function expectNoInstallation(cwd, previous, result, runner) {
  expect(runner.calls.some(({ args }) => isGit(args, 'worktree', 'add') || ['add', 'commit', 'push'].includes(args[0]))).toBe(false)
  expect(untouched(cwd)).toEqual(previous)
  expect(result.gh.requests.some((r) => r.rest.startsWith('/pulls'))).toBe(false)
  expect(pullWrites(result.gh)).toEqual([])
}

describe('ST-56/AC-4 (review 9): a pull request is found to be needed before its questions are asked', () => {
  it('ST-56/AC-4: a complete installation with two templates and --yes, without --pr-template, exits 0 with no branch, worktree, push or pull request', async () => {
    const cwd = makeRepo({ files: TWO })
    await installed(cwd, ['--pr-template', '.github/PULL_REQUEST_TEMPLATE/bug.md'])
    const previous = untouched(cwd)
    const runner = watchGit()
    const result = await runInit(['--yes'], { cwd, git: runner })
    expect(result.err).toBe('')
    expect(result.code).toBe(0)
    expect(result.out).toMatch(/No installation pull request is needed/)
    expect(result.out).not.toMatch(/All Git hooks are disabled/)
    expectNoInstallation(cwd, previous, result, runner)
  })

  it('ST-56/AC-4: at a terminal, a complete installation with two templates is not asked which template to use', async () => {
    const cwd = makeRepo({ files: TWO })
    await installed(cwd, ['--pr-template', '.github/PULL_REQUEST_TEMPLATE/bug.md'])
    // A question asked at all stops the run, rather than waiting for an answer.
    const terminal = {
      isTTY: true,
      prompts: [],
      write() {},
      async question(prompt) {
        this.prompts.push(prompt)
        throw new Error(`asked: ${prompt}`)
      },
    }
    const result = await runInit(['--yes'], { cwd, terminal })
    expect(result.code, result.err).toBe(0)
    expect(terminal.prompts).toEqual([])
  })

  it('ST-56/AC-4: a partial installation with two templates and no --pr-template is refused, exit 2, before any effect', async () => {
    const settings = `${JSON.stringify({ repo: 'acme/widgets', setup: null, check: null, landWhen: 'all-checks', land: false, unitLinks: ['file'], rulesFile: 'REVIEW.md', inspectAfterHours: 6 })}\n`
    const cwd = makeRepo({ files: { ...TWO, 'steward.config.json': settings, 'REVIEW.md': 'mine\n' } })
    const previous = untouched(cwd)
    const runner = watchGit()
    const machine = path.join(fresh('home'), 'config.json')
    const result = await runInit(['--yes'], { cwd, git: runner, machine })
    expect(result.code).toBe(2)
    expect(result.err).toContain('--pr-template')
    expect(result.err).toMatch(/\(no default\)/)
    expect(result.err).toMatch(/Nothing was written/)
    expect(writes(result.gh)).toEqual([])
    expect(existsSync(machine)).toBe(false)
    expectNoInstallation(cwd, previous, result, runner)
  })

  it('ST-56/AC-4: a supplied --pr-template that is not a template is still refused when nothing is missing, and a valid one is accepted', async () => {
    const cwd = makeRepo({ files: TWO })
    await installed(cwd, ['--pr-template', '.github/PULL_REQUEST_TEMPLATE/bug.md'])
    const previous = untouched(cwd)
    const runner = watchGit()
    const machine = path.join(fresh('home'), 'config.json')
    const refused = await runInit(['--yes', '--pr-template', 'docs/not-a-template.md'], { cwd, git: runner, machine })
    expect(refused.code).toBe(2)
    expect(refused.err).toMatch(/--pr-template docs\/not-a-template\.md: not one of the project's pull request templates/)
    expect(writes(refused.gh)).toEqual([])
    expect(existsSync(machine)).toBe(false)
    expectNoInstallation(cwd, previous, refused, runner)

    const accepted = await runInit(['--yes', '--pr-template', '.github/PULL_REQUEST_TEMPLATE/feature.md'], { cwd })
    expect(accepted.err).toBe('')
    expect(accepted.code).toBe(0)
    expect(accepted.out).toMatch(/No installation pull request is needed/)
  })
})

describe('ST-56/AC-4 (review 9): every installer Git command reads paths and objects literally', () => {
  it('ST-56/AC-4: every Git command of an installation, a run with nothing missing, and a failed push carries --literal-pathspecs and --no-replace-objects', async () => {
    const runs = []
    const cwd = makeRepo()
    const install = watchGit()
    expect((await runInit(['--yes'], { cwd, git: install })).code).toBe(0)
    runs.push(install)
    mergeInstall(cwd)
    const again = watchGit()
    expect((await runInit(['--yes'], { cwd, git: again })).code).toBe(0)
    runs.push(again)
    const failed = watchGit({ before: (args) => (args[0] === 'push' ? failing('fatal: the remote hung up', 128) : undefined) })
    expect((await runInit(['--yes'], { cwd: makeRepo(), git: failed })).code).toBe(1)
    runs.push(failed)
    for (const runner of runs) {
      expect(runner.calls.length).toBeGreaterThan(0)
      for (const { argv } of runner.calls) {
        expect(argv.slice(0, LITERAL_GIT_OPTIONS.length), argv.join(' ')).toEqual(['--literal-pathspecs', '--no-replace-objects'])
      }
    }
    // The failed run also asked git what it had made, through the same runner.
    expect(failed.calls.some(({ args }) => isGit(args, 'ls-remote', '--heads'))).toBe(true)
  })

  it('ST-56/AC-4: an existing checklist named docs/[r]eview.md, beside docs/review.md, is found and left: nothing is missing, exit 0', async () => {
    const cwd = makeRepo({ files: { 'docs/[r]eview.md': 'the checklist\n', 'docs/review.md': 'another file\n' } })
    await installed(cwd, ['--rules-file', 'docs/[r]eview.md'])
    expect(JSON.parse(readOn(cwd, 'steward.config.json', 'main')).rulesFile).toBe('docs/[r]eview.md')
    const previous = untouched(cwd)
    const runner = watchGit()
    const result = await runInit(['--yes'], { cwd, git: runner })
    expect(result.err).toBe('')
    expect(result.code).toBe(0)
    expect(result.out).toContain('left docs/[r]eview.md: already there')
    expect(result.out).toMatch(/No installation pull request is needed/)
    expectNoInstallation(cwd, previous, result, runner)
  })

  it('ST-56/AC-4: an existing checklist literally named :(literal)REVIEW.md, with no REVIEW.md, is found and left: nothing is missing, exit 0', async () => {
    const cwd = makeRepo()
    await installed(cwd)
    // Windows allows no ':' in a file name, so the name is made in the tree only, on origin's main:
    // the checkout stays behind it, at the merged installation, which init accepts.
    const plain = (args, input) => execFileSync('git', args, { cwd, encoding: 'utf8', input }).trim()
    const settings = { ...JSON.parse(readOn(cwd, 'steward.config.json', 'main')), rulesFile: ':(literal)REVIEW.md' }
    const settingsBlob = plain(['hash-object', '-w', '--stdin'], `${JSON.stringify(settings, null, 2)}\n`)
    const entries = plain(['ls-tree', '-z', 'main']).split('\0').filter((e) => e !== '' && !/\t(REVIEW\.md|steward\.config\.json)$/.test(e))
    entries.push(`100644 blob ${plain(['rev-parse', 'main:REVIEW.md'])}\t:(literal)REVIEW.md`, `100644 blob ${settingsBlob}\tsteward.config.json`)
    const treeId = plain(['mktree', '-z'], `${entries.join('\0')}\0`)
    const commit = plain(['commit-tree', treeId, '-p', 'main', '-m', 'rename the checklist'])
    git(cwd, 'push', '-q', slashes(remoteOf(cwd)), `${commit}:refs/heads/main`)
    expect(plain(['ls-tree', '--name-only', commit]).split('\n')).toContain(':(literal)REVIEW.md')
    expect(plain(['ls-tree', '--name-only', commit]).split('\n')).not.toContain('REVIEW.md')

    const previous = untouched(cwd)
    const runner = watchGit()
    const result = await runInit(['--yes'], { cwd, git: runner })
    expect(result.err).toBe('')
    expect(result.code).toBe(0)
    expect(result.out).toContain('left :(literal)REVIEW.md: already there')
    expect(result.out).toMatch(/No installation pull request is needed/)
    expectNoInstallation(cwd, previous, result, runner)
  })

  it('ST-56/AC-6: a pull request template named [b]ug.md, beside bug.md, is the one chosen, and is found again when nothing is missing', async () => {
    const files = {
      '.github/PULL_REQUEST_TEMPLATE/[b]ug.md': 'Unit:\n\n<!-- bracketed prompt -->\n',
      '.github/PULL_REQUEST_TEMPLATE/bug.md': 'Unit:\n\n<!-- plain prompt -->\n',
    }
    const cwd = makeRepo({ files })
    const gh = fakeGitHub()
    const first = await runInit(['--yes', '--pr-template', '.github/PULL_REQUEST_TEMPLATE/[b]ug.md'], { cwd, gh })
    expect(first.err).toBe('')
    expect(first.code).toBe(0)
    expect(pullWrites(gh)[0].body.body).toContain('<!-- bracketed prompt -->')
    expect(pullWrites(gh)[0].body.body).not.toContain('plain prompt')
    mergeInstall(cwd)

    const previous = untouched(cwd)
    const runner = watchGit()
    const result = await runInit(['--yes', '--pr-template', '.github/PULL_REQUEST_TEMPLATE/[b]ug.md'], { cwd, git: runner })
    expect(result.err).toBe('')
    expect(result.code).toBe(0)
    expect(result.out).toContain("left .github/PULL_REQUEST_TEMPLATE/[b]ug.md: the project's pull request template")
    expectNoInstallation(cwd, previous, result, runner)
  })
})
