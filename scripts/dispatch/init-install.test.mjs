// @vitest-environment node

// ST-56: `steward init` installs through a draft pull request. Every test uses temporary real git
// repositories with a temporary bare repository as `origin` (init-fixture.mjs), GitHub's answers
// injected, and the user config in a temporary file: no real repository, no `gh`, no request
// to api.github.com.

import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { assertAllowedRequest, buildCreatePull, buildListOpenPulls, GATE_WORKFLOWS, INSPECTION_WORKFLOW, writeWhole } from './init.mjs'
import { gitEnvironment } from './init-install.mjs'
import { composePullRequestBody } from './init-pr-body.mjs'
import {
  bareRef,
  branchFiles,
  bytesOn,
  callerState,
  commitFile,
  EXPECTED_NEW,
  fakeGitHub,
  fakeTerminal,
  failing,
  fresh,
  git,
  GITHUB_URL,
  hasOn,
  hook,
  isGit,
  labelWrites,
  makePackage,
  makeRepo,
  mergeInstall,
  pullWrites,
  pushToRemote,
  put,
  readOn,
  REPO,
  remoteOf,
  ROOT,
  runInit,
  setUpInitFixture,
  slashes,
  tree,
  tryGit,
  watchGit,
  writes,
} from './init-fixture.mjs'

setUpInitFixture()

const BASE_FILES = { '.gitignore': 'ignored.log\n', 'src/tracked.txt': 'tracked\n', 'shared.txt': 'base\n' }
const worktreeOf = (cwd, name = 'steward-install') => path.join(`${cwd}.worktrees`, name)
const bodyOf = (gh) => pullWrites(gh)[0].body.body
const titleOf = (gh) => pullWrites(gh)[0].body.title

/** The names and statuses (`A\tpath`) of what `commit` changes against `base`. */
const nameStatus = (cwd, base, commit) => git(cwd, 'diff', '--name-status', '--no-renames', base, commit).split('\n').filter((l) => l !== '').sort()

describe('ST-56/AC-1: the preflight, before anything is made', () => {
  const ACCEPTED = {
    'a clean main': () => {},
    'a feature branch with a commit of its own': (cwd) => {
      git(cwd, 'checkout', '-q', '-b', 'feature')
      commitFile(cwd, 'src/feature.txt', 'f\n')
    },
    'a main ahead of origin/main by an unrelated commit': (cwd) => commitFile(cwd, 'src/ahead.txt', 'a\n'),
    'a main behind origin/main': (cwd) => {
      pushToRemote(cwd, { 'upstream.txt': 'u\n' })
    },
    'a main that has diverged from origin/main': (cwd) => {
      commitFile(cwd, 'src/ahead.txt', 'a\n')
      pushToRemote(cwd, { 'upstream.txt': 'u\n' })
    },
    'a detached HEAD on an unrelated commit': (cwd) => {
      git(cwd, 'checkout', '-q', '--detach')
      commitFile(cwd, 'src/detached.txt', 'd\n')
    },
    'unrelated staged, unstaged, untracked and ignored work': (cwd) => {
      writeFileSync(path.join(cwd, 'src/staged.txt'), 's\n')
      git(cwd, 'add', 'src/staged.txt')
      writeFileSync(path.join(cwd, 'src/tracked.txt'), 'changed but not staged\n')
      writeFileSync(path.join(cwd, 'notes.txt'), 'untracked\n')
      writeFileSync(path.join(cwd, 'ignored.log'), 'ignored\n')
    },
    'unrelated files in the directories the installation looks in': (cwd) => {
      mkdirSync(path.join(cwd, 'docs'), { recursive: true })
      writeFileSync(path.join(cwd, 'docs/guide.md'), 'guide\n')
      mkdirSync(path.join(cwd, '.github/ISSUE_TEMPLATE'), { recursive: true })
      writeFileSync(path.join(cwd, '.github/ISSUE_TEMPLATE/bug.md'), 'bug\n')
    },
    'an unfinished merge with an unrelated conflict': (cwd) => {
      git(cwd, 'checkout', '-q', '-b', 'other')
      commitFile(cwd, 'shared.txt', 'other\n')
      git(cwd, 'checkout', '-q', 'main')
      commitFile(cwd, 'shared.txt', 'main\n')
      expect(() => git(cwd, 'merge', 'other')).toThrow()
      expect(existsSync(path.join(cwd, '.git/MERGE_HEAD'))).toBe(true)
    },
    'an unfinished rebase with an unrelated conflict': (cwd) => {
      git(cwd, 'checkout', '-q', '-b', 'other')
      commitFile(cwd, 'shared.txt', 'other\n')
      git(cwd, 'checkout', '-q', 'main')
      commitFile(cwd, 'shared.txt', 'main\n')
      git(cwd, 'checkout', '-q', 'other')
      expect(() => git(cwd, 'rebase', 'main')).toThrow()
      expect(existsSync(path.join(cwd, '.git/rebase-merge'))).toBe(true)
    },
  }

  it.each(Object.keys(ACCEPTED))('ST-56/AC-1: installs from %s, from the fetched base, and leaves the checkout exactly as it was', async (name) => {
    const cwd = makeRepo({ files: BASE_FILES })
    ACCEPTED[name](cwd)
    const expectedBase = bareRef(cwd, 'refs/heads/main')
    const before = callerState(cwd)
    const indexPath = path.resolve(cwd, git(cwd, 'rev-parse', '--git-path', 'index'))
    const indexBytes = readFileSync(indexPath)
    const watched = watchGit()
    const { code, err, gh } = await runInit(['--yes'], { cwd, git: watched })
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(callerState(cwd)).toEqual(before)
    expect(readFileSync(indexPath)).toEqual(indexBytes)

    const commit = bareRef(cwd, 'refs/heads/steward/install')
    expect(commit).toMatch(/^[0-9a-f]{40}$/)
    expect(git(cwd, 'rev-parse', `${commit}^`)).toBe(expectedBase)
    expect(git(cwd, 'rev-list', '--count', `${expectedBase}..${commit}`)).toBe('1')
    expect(git(cwd, 'rev-parse', 'refs/heads/steward/install')).toBe(commit)
    expect(nameStatus(cwd, expectedBase, commit)).toEqual(EXPECTED_NEW.map((f) => `A\t${f}`))
    expect(pullWrites(gh)).toHaveLength(1)
    // The branch was made from the fetched base, not from the checkout's own HEAD.
    const add = watched.calls.find((c) => isGit(c.args, 'worktree', 'add'))
    expect(add.args.at(-1)).toBe(expectedBase)
  })

  it('ST-56/AC-1: of the checkout itself it runs only commands that read, fetch, and add and remove its own worktree', async () => {
    const cwd = makeRepo({ files: BASE_FILES })
    const watched = watchGit()
    const { code } = await runInit(['--yes'], { cwd, git: watched })
    expect(code).toBe(0)
    const inCheckout = watched.calls.filter((c) => !c.cwd.includes('.worktrees'))
    const kinds = new Set(inCheckout.map((c) => c.args[0]))
    const allowed = ['rev-parse', 'config', 'remote', 'var', 'check-ref-format', 'fetch', 'ls-tree', 'cat-file', 'merge-base', 'diff', 'status', 'ls-files', 'show-ref', 'ls-remote', 'for-each-ref', 'worktree']
    expect([...kinds].filter((k) => !allowed.includes(k))).toEqual([])
    const worktreeCalls = inCheckout.filter((c) => c.args[0] === 'worktree').map((c) => c.args[1])
    expect([...new Set(worktreeCalls)].sort()).toEqual(['add', 'list', 'remove'])
    const fetches = inCheckout.filter((c) => c.args[0] === 'fetch').map((c) => c.args)
    expect(fetches).toHaveLength(1)
    expect(fetches[0].slice(0, 3)).toEqual(['fetch', '--no-tags', '--quiet'])
    expect(path.resolve(fetches[0][3])).toBe(path.resolve(remoteOf(cwd)))
    expect(fetches[0][4]).toBe('+refs/heads/main:refs/remotes/origin/main')
  })

  it('ST-56/AC-1: an unborn HEAD is refused, exit 2, naming the reason and the remedy, before anything is made', async () => {
    const cwd = fresh('unborn')
    git(cwd, 'init', '-q', '-b', 'main')
    git(cwd, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
    const gh = fakeGitHub()
    const machine = path.join(fresh('home'), 'config.json')
    const { code, err } = await runInit(['--yes'], { cwd, gh, machine })
    expect(code).toBe(2)
    expect(err).toMatch(/no readable HEAD commit/)
    expect(err).toMatch(/make its first commit/)
    expect(gh.requests).toEqual([])
    expect(existsSync(machine)).toBe(false)
    expect(existsSync(`${cwd}.worktrees`)).toBe(false)
  })

  it('ST-56/AC-1: an origin with no main is refused, exit 2, before anything is made', async () => {
    const cwd = makeRepo({ push: false })
    const gh = fakeGitHub()
    const { code, err } = await runInit(['--yes'], { cwd, gh })
    expect(code).toBe(2)
    expect(err).toMatch(/origin has no `main` branch/)
    expect(gh.requests).toEqual([])
    expect(existsSync(`${cwd}.worktrees`)).toBe(false)
    expect(tryGit(cwd, 'branch', '--list', 'steward/install')).toBe('')
  })

  it('ST-56/AC-1: invalid flags and unanswered questions without a terminal are refused, exit 2, before anything is made', async () => {
    for (const args of [['--yes', '--branch'], ['--yes', '--pr-title'], ['--yes', '--pr-body-file'], ['--yes', '--pr-template'], ['--yes', '--branch', 'a', '--branch', 'b'], []]) {
      const cwd = makeRepo()
      const gh = fakeGitHub()
      const { code } = await runInit(args, { cwd, gh })
      expect(code, args.join(' ')).toBe(2)
      expect(gh.requests).toEqual([])
      expect(tree(cwd)).toEqual(['package.json'])
      expect(existsSync(`${cwd}.worktrees`)).toBe(false)
    }
  })

  it('ST-56/AC-1: a sign-in that fails exits 1, claims no missing repository and no installation, and makes nothing', async () => {
    const cwd = makeRepo()
    const gh = fakeGitHub()
    const machine = path.join(fresh('home'), 'config.json')
    const { code, err, out } = await runInit(['--yes'], {
      cwd,
      gh,
      machine,
      getToken: async () => {
        throw new Error('`gh auth token` returned nothing')
      },
    })
    expect(code).toBe(1)
    expect(err).toMatch(/could not sign in to GitHub/)
    expect(err).not.toMatch(/not found|does not exist|no such repository|installed/i)
    expect(out).toBe('')
    expect(gh.requests).toEqual([])
    expect(existsSync(`${cwd}.worktrees`)).toBe(false)
    expect(existsSync(machine)).toBe(false)
  })

  it('ST-56/AC-1: a request to GitHub that fails or is not authorized exits 1 and makes nothing', async () => {
    for (const gh of [fakeGitHub({ pullListStatus: 401 }), fakeGitHub({ pullListStatus: 500 }), fakeGitHub({ throwOn: (m, rest) => m === 'GET' && rest.startsWith('/pulls?') })]) {
      const cwd = makeRepo()
      const machine = path.join(fresh('home'), 'config.json')
      const { code, err, out } = await runInit(['--yes'], { cwd, gh, machine })
      expect(code).toBe(1)
      expect(err).toMatch(/init stopped: /)
      expect(err).not.toMatch(/does not exist|no such repository/i)
      expect(out).not.toMatch(/draft pull request|installation pull request is open/)
      expect(existsSync(`${cwd}.worktrees`)).toBe(false)
      expect(tryGit(cwd, 'branch', '--list', 'steward/install')).toBe('')
      expect(bareRef(cwd, 'refs/heads/steward/install')).toBe('')
      expect(existsSync(machine)).toBe(false)
      expect(writes(gh)).toEqual([])
    }
  })

  it('ST-56/AC-1: a fetch that fails because origin cannot be reached exits 1, and does not say main is missing', async () => {
    const cwd = makeRepo()
    const watched = watchGit({ before: (args) => (args[0] === 'fetch' || args[0] === 'ls-remote' ? failing('fatal: unable to access the remote: network is down', 128) : undefined) })
    const gh = fakeGitHub()
    const { code, err } = await runInit(['--yes'], { cwd, gh, git: watched })
    expect(code).toBe(1)
    expect(err).toMatch(/could not read origin/)
    expect(err).not.toMatch(/has no `main`/)
    expect(watched.calls.some((c) => isGit(c.args, 'worktree', 'add'))).toBe(false)
    expect(gh.requests).toEqual([])
  })
})

describe('ST-56/AC-1a: the checkout\'s own changes to what the installation adds', () => {
  const symlinkInIndex = (cwd, rel) => {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd, encoding: 'utf8', input: 'elsewhere' }).trim()
    git(cwd, 'update-index', '--add', '--cacheinfo', `120000,${blob},${rel}`)
  }
  const CASES = [
    {
      name: 'a commit that adds steward.config.json',
      setup: (cwd) => {
        git(cwd, 'checkout', '-q', '-b', 'feature')
        commitFile(cwd, 'steward.config.json', '{}\n')
      },
      path: 'steward.config.json',
      what: /added in a commit of this checkout since it left origin\/main/,
    },
    {
      name: 'a commit that modifies the checklist',
      files: { 'REVIEW.md': 'base\n' },
      setup: (cwd) => commitFile(cwd, 'REVIEW.md', 'changed\n'),
      path: 'REVIEW.md',
      what: /modified in a commit/,
    },
    {
      name: 'a commit that deletes a workflow file',
      files: { '.github/workflows/review-gate.yml': 'x\n' },
      setup: (cwd) => {
        git(cwd, 'rm', '-q', '.github/workflows/review-gate.yml')
        git(cwd, 'commit', '-q', '-m', 'remove')
      },
      path: '.github/workflows/review-gate.yml',
      what: /deleted in a commit/,
    },
    {
      name: 'a commit that renames the checklist away (the source of a rename)',
      files: { 'REVIEW.md': 'rules\n' },
      setup: (cwd) => {
        git(cwd, 'mv', 'REVIEW.md', 'old-rules.txt')
        git(cwd, 'commit', '-q', '-m', 'rename')
      },
      path: 'REVIEW.md',
      what: /deleted in a commit/,
    },
    {
      name: 'a commit that renames a file to the checklist (the destination of a rename)',
      files: { 'notes.txt': 'n\n' },
      setup: (cwd) => {
        git(cwd, 'mv', 'notes.txt', 'REVIEW.md')
        git(cwd, 'commit', '-q', '-m', 'rename')
      },
      path: 'REVIEW.md',
      what: /added in a commit/,
    },
    {
      name: 'a commit that turns the checklist file into a directory',
      files: { 'REVIEW.md': 'r\n' },
      setup: (cwd) => {
        git(cwd, 'rm', '-q', 'REVIEW.md')
        commitFile(cwd, 'REVIEW.md/inside.txt', 'x\n')
      },
      path: 'REVIEW.md',
      what: /deleted in a commit/,
    },
    {
      name: 'a commit that turns the docs directory into a file (an ancestor)',
      files: { 'docs/a.txt': 'a\n' },
      setup: (cwd) => {
        git(cwd, 'rm', '-q', 'docs/a.txt')
        commitFile(cwd, 'docs', 'now a file\n')
      },
      path: 'docs',
      what: /added in a commit/,
    },
    {
      name: 'a commit that turns the checklist into a symbolic link',
      files: { 'REVIEW.md': 'r\n' },
      setup: (cwd) => {
        symlinkInIndex(cwd, 'REVIEW.md')
        git(cwd, 'commit', '-q', '-m', 'link')
      },
      path: 'REVIEW.md',
      what: /changed from one kind of entry to another/,
    },
    {
      name: 'a staged steward.config.json',
      setup: (cwd) => {
        writeFileSync(path.join(cwd, 'steward.config.json'), '{}\n')
        git(cwd, 'add', 'steward.config.json')
      },
      path: 'steward.config.json',
      what: /added in the index \(staged\)/,
    },
    {
      name: 'a staged deletion of the checklist',
      files: { 'REVIEW.md': 'r\n' },
      setup: (cwd) => git(cwd, 'rm', '-q', 'REVIEW.md'),
      path: 'REVIEW.md',
      what: /deleted in the index \(staged\)/,
    },
    {
      name: 'a staged change to the checklist that the working file undoes',
      files: { 'REVIEW.md': 'v1\n' },
      setup: (cwd) => {
        writeFileSync(path.join(cwd, 'REVIEW.md'), 'v2\n')
        git(cwd, 'add', 'REVIEW.md')
        writeFileSync(path.join(cwd, 'REVIEW.md'), 'v1\n')
      },
      path: 'REVIEW.md',
      what: /modified in the index \(staged\)/,
    },
    {
      name: 'a staged deletion of the checklist, with the file written back and left untracked',
      files: { 'REVIEW.md': 'r\n' },
      setup: (cwd) => {
        git(cwd, 'rm', '--cached', '-q', 'REVIEW.md')
        expect(readFileSync(path.join(cwd, 'REVIEW.md'), 'utf8')).toBe('r\n')
      },
      path: 'REVIEW.md',
      what: /deleted in the index \(staged\)/,
    },
    {
      name: 'a staged symbolic link in place of the checklist',
      files: { 'REVIEW.md': 'r\n' },
      setup: (cwd) => symlinkInIndex(cwd, 'REVIEW.md'),
      path: 'REVIEW.md',
      what: /changed from one kind of entry to another .*in the index/,
    },
    {
      name: 'an edit to the checklist that is not staged',
      files: { 'REVIEW.md': 'v1\n' },
      setup: (cwd) => writeFileSync(path.join(cwd, 'REVIEW.md'), 'v2\n'),
      path: 'REVIEW.md',
      what: /modified in the working files \(not staged\)/,
    },
    {
      name: 'a checklist deleted from the working files only',
      files: { 'REVIEW.md': 'v1\n' },
      setup: (cwd) => rmSync(path.join(cwd, 'REVIEW.md')),
      path: 'REVIEW.md',
      what: /deleted in the working files \(not staged\)/,
    },
    {
      name: 'an unmerged checklist',
      files: { 'REVIEW.md': 'base\n' },
      setup: (cwd) => {
        git(cwd, 'checkout', '-q', '-b', 'other')
        commitFile(cwd, 'REVIEW.md', 'other\n')
        git(cwd, 'checkout', '-q', 'main')
        commitFile(cwd, 'REVIEW.md', 'main\n')
        expect(() => git(cwd, 'merge', 'other')).toThrow()
      },
      path: 'REVIEW.md',
      what: /unmerged in the index/,
    },
    {
      name: 'an untracked steward.config.json',
      setup: (cwd) => writeFileSync(path.join(cwd, 'steward.config.json'), '{}\n'),
      path: 'steward.config.json',
      what: /an untracked file that exists only in this checkout/,
    },
    {
      name: 'an ignored steward.config.json',
      files: { '.gitignore': 'steward.config.json\n' },
      setup: (cwd) => writeFileSync(path.join(cwd, 'steward.config.json'), '{}\n'),
      path: 'steward.config.json',
      what: /an ignored file that exists only in this checkout/,
    },
    {
      name: 'an untracked .github directory holding a workflow file',
      setup: (cwd) => put(cwd, { '.github/workflows/review-gate.yml': 'mine\n' }),
      path: '.github/workflows/review-gate.yml',
      what: /an untracked file/,
    },
    {
      name: 'an ignored docs directory holding the chosen checklist',
      files: { '.gitignore': 'docs/\n' },
      args: ['--rules-file', 'docs/RULES.md'],
      setup: (cwd) => put(cwd, { 'docs/RULES.md': 'mine\n' }),
      path: 'docs/RULES.md',
      what: /an ignored file/,
    },
    {
      name: 'an untracked pull request template in docs (a change to template discovery)',
      setup: (cwd) => put(cwd, { 'docs/pull_request_template.md': 'Unit:\n' }),
      path: 'docs/pull_request_template.md',
      what: /an untracked file/,
    },
    {
      name: 'a staged pull request template in the root, in any case',
      setup: (cwd) => {
        put(cwd, { 'PULL_REQUEST_TEMPLATE.md': 'Unit:\n' })
        git(cwd, 'add', 'PULL_REQUEST_TEMPLATE.md')
      },
      path: 'PULL_REQUEST_TEMPLATE.md',
      what: /added in the index \(staged\)/,
    },
    {
      name: 'a deleted pull request template',
      files: { '.github/pull_request_template.md': 'Unit:\n' },
      setup: (cwd) => rmSync(path.join(cwd, '.github/pull_request_template.md')),
      path: '.github/pull_request_template.md',
      what: /deleted in the working files/,
    },
    {
      name: 'an untracked PULL_REQUEST_TEMPLATE directory',
      setup: (cwd) => put(cwd, { 'PULL_REQUEST_TEMPLATE/bug.md': 'Unit:\n' }),
      path: 'PULL_REQUEST_TEMPLATE/bug.md',
      what: /an untracked file/,
    },
    {
      name: 'a commit that adds a template to a PULL_REQUEST_TEMPLATE directory',
      setup: (cwd) => {
        git(cwd, 'checkout', '-q', '-b', 'feature')
        commitFile(cwd, 'docs/PULL_REQUEST_TEMPLATE/a.md', 'Unit:\n')
      },
      path: 'docs/PULL_REQUEST_TEMPLATE/a.md',
      what: /added in a commit/,
    },
  ]

  it.each(CASES.map((c) => [c.name, c]))('ST-56/AC-1a: %s is refused, exit 2, naming the path and leaving the checkout, GitHub and the remote untouched', async (_name, c) => {
    const cwd = makeRepo({ files: c.files ?? {} })
    c.setup(cwd)
    const before = callerState(cwd)
    const gh = fakeGitHub()
    const machine = path.join(fresh('home'), 'config.json')
    const { code, err, out } = await runInit(['--yes', ...(c.args ?? [])], { cwd, gh, machine })
    expect(code).toBe(2)
    expect(err).toContain(`  ${c.path}: `)
    expect(err).toMatch(c.what)
    expect(err).toMatch(/Resolve each one yourself .* or run init from another checkout/)
    expect(err).not.toMatch(/discard|reset|clean|stash|checkout -- |--hard/i)
    expect(err).toMatch(/nothing was written/)
    expect(out).toBe('')
    expect(callerState(cwd)).toEqual(before)
    expect(gh.requests).toEqual([])
    expect(existsSync(`${cwd}.worktrees`)).toBe(false)
    expect(bareRef(cwd, 'refs/heads/steward/install')).toBe('')
    expect(existsSync(machine)).toBe(false)
  })

  it('ST-56/AC-1a: a symbolic link in the working files in place of a tracked ancestor directory is refused where the platform can make one', async (ctx) => {
    const cwd = makeRepo({ files: { 'docs/a.txt': 'a\n' } })
    git(cwd, 'config', 'core.symlinks', 'true')
    rmSync(path.join(cwd, 'docs'), { recursive: true })
    try {
      symlinkSync('src', path.join(cwd, 'docs'), 'dir')
    } catch {
      ctx.skip('this platform cannot make a symbolic link here')
    }
    const { code, err } = await runInit(['--yes'], { cwd })
    expect(code).toBe(2)
    expect(err).toContain('  docs: ')
  })

  it('ST-56/AC-1a: upstream-only differences since the merge base are not the checkout\'s own changes', async () => {
    const cwd = makeRepo({ files: { 'REVIEW.md': 'base\n', ...BASE_FILES } })
    pushToRemote(cwd, { 'REVIEW.md': 'changed upstream\n', '.github/pull_request_template.md': 'Unit:\n\n## Summary\n' })
    const before = callerState(cwd)
    const { code, out, err } = await runInit(['--yes'], { cwd })
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(callerState(cwd)).toEqual(before)
    // The base is what origin has now: it has the checklist and a template, which are left.
    expect(out).toContain('left REVIEW.md: already there')
    expect(readOn(cwd, 'REVIEW.md')).toBe('changed upstream\n')
    expect(hasOn(cwd, '.github/pull_request_template.md')).toBe(true)
  })

  it('ST-56/AC-1a: with no common history, the checkout\'s HEAD is compared with the base itself', async () => {
    // Nothing relevant differs: the unrelated history is accepted.
    const clean = makeRepo({ files: BASE_FILES })
    git(clean, 'checkout', '-q', '--orphan', 'lone')
    git(clean, 'rm', '-rfq', '.')
    commitFile(clean, 'lone.txt', 'alone\n')
    const before = callerState(clean)
    const ok = await runInit(['--yes'], { cwd: clean })
    expect(ok.err).toBe('')
    expect(ok.code).toBe(0)
    expect(callerState(clean)).toEqual(before)

    // The base has a checklist that the unrelated history lacks: a relevant difference.
    const differing = makeRepo({ files: { 'REVIEW.md': 'rules\n' } })
    git(differing, 'checkout', '-q', '--orphan', 'lone')
    git(differing, 'rm', '-rfq', '.')
    commitFile(differing, 'lone.txt', 'alone\n')
    const refused = await runInit(['--yes'], { cwd: differing })
    expect(refused.code).toBe(2)
    expect(refused.err).toContain('  REVIEW.md: ')
    expect(refused.err).toMatch(/share no history with origin\/main/)
    expect(existsSync(`${differing}.worktrees`)).toBe(false)
  })

  it('ST-56/AC-1a: a comparison that cannot be made is a refusal, exit 2, not a guess', async () => {
    for (const command of ['merge-base', 'status', 'diff']) {
      const cwd = makeRepo({ files: BASE_FILES })
      const watched = watchGit({ before: (args) => (args[0] === command ? failing('fatal: simulated failure', 128) : undefined) })
      const gh = fakeGitHub()
      const { code, err } = await runInit(['--yes'], { cwd, gh, git: watched })
      expect(code, command).toBe(2)
      expect(err, command).toMatch(/init could not compare .* reliably/)
      expect(gh.requests).toEqual([])
      expect(existsSync(`${cwd}.worktrees`)).toBe(false)
    }
  })

  it('ST-56/AC-1a: a change that touches an installation target is refused even when nothing is missing, and with a supplied body', async () => {
    const cwd = makeRepo()
    expect((await runInit(['--yes'], { cwd })).code).toBe(0)
    mergeInstall(cwd)
    writeFileSync(path.join(cwd, 'steward.config.json'), '{"edited":"by the crew"}\n')
    const before = callerState(cwd)
    const gh = fakeGitHub()
    const noDiff = await runInit(['--yes'], { cwd, gh })
    expect(noDiff.code).toBe(2)
    expect(noDiff.err).toContain('  steward.config.json: ')
    expect(noDiff.out).not.toMatch(/No installation pull request is needed/)

    const bodyFile = path.join(fresh('body'), 'body.md')
    writeFileSync(bodyFile, 'my own body\n')
    const supplied = await runInit(['--yes', '--pr-body-file', bodyFile], { cwd, gh })
    expect(supplied.code).toBe(2)
    expect(supplied.err).toContain('  steward.config.json: ')
    expect(callerState(cwd)).toEqual(before)
    expect(gh.requests).toEqual([])
  })
})

describe('ST-56/AC-2: one isolated installation branch', () => {
  it('ST-56/AC-2: the worktree is beside the checkout in <checkout>.worktrees/, from the captured base, on steward/install, and is removed once the pull request is confirmed', async () => {
    const cwd = makeRepo()
    const expectedBase = bareRef(cwd, 'refs/heads/main')
    const watched = watchGit()
    const { code } = await runInit(['--yes'], { cwd, git: watched })
    expect(code).toBe(0)
    const add = watched.calls.find((c) => isGit(c.args, 'worktree', 'add')).args
    expect(add.slice(0, 5)).toEqual(['worktree', 'add', '--quiet', '-b', 'steward/install'])
    expect(path.resolve(add[5])).toBe(path.resolve(worktreeOf(cwd)))
    expect(add[6]).toBe(expectedBase)
    expect(existsSync(worktreeOf(cwd))).toBe(false)
    expect(git(cwd, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1)
    // The finished branch is kept, locally and on origin.
    expect(git(cwd, 'branch', '--list', 'steward/install')).toMatch(/steward\/install/)
    expect(bareRef(cwd, 'refs/heads/steward/install')).toBe(git(cwd, 'rev-parse', 'steward/install'))
    expect(git(remoteOf(cwd), 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n').sort()).toEqual(['refs/heads/main', 'refs/heads/steward/install'])
  })

  it('ST-56/AC-2: --branch names the branch, the worktree\'s folder and the pull request\'s head', async () => {
    const cwd = makeRepo()
    const watched = watchGit()
    const gh = fakeGitHub()
    const { code } = await runInit(['--yes', '--branch', 'crew/install-steward'], { cwd, gh, git: watched })
    expect(code).toBe(0)
    const add = watched.calls.find((c) => isGit(c.args, 'worktree', 'add')).args
    expect(add[4]).toBe('crew/install-steward')
    expect(path.resolve(add[5])).toBe(path.resolve(worktreeOf(cwd, 'crew-install-steward')))
    expect(pullWrites(gh)[0].body.head).toBe('crew/install-steward')
    expect(bareRef(cwd, 'refs/heads/crew/install-steward')).toMatch(/^[0-9a-f]{40}$/)
    expect(bareRef(cwd, 'refs/heads/steward/install')).toBe('')
    expect(hasOn(cwd, 'steward.config.json', 'crew/install-steward')).toBe(true)
  })

  it.each([['main'], ['release/v0.1.0'], ['bad..name'], ['-x'], ['a b'], ['HEAD'], ['x.lock'], ['end/']])(
    'ST-56/AC-2: the branch name %j is refused, exit 2, before anything is made',
    async (name) => {
      const cwd = makeRepo()
      const gh = fakeGitHub()
      const { code, err } = await runInit(['--yes', `--branch=${name}`], { cwd, gh })
      expect(code).toBe(2)
      expect(err).toContain(`--branch ${name}`)
      expect(gh.requests).toEqual([])
      expect(existsSync(`${cwd}.worktrees`)).toBe(false)
      expect(tree(cwd)).toEqual(['package.json'])
    },
  )

  const taken = {
    'a local branch of that name': {
      setup: (cwd) => git(cwd, 'branch', 'steward/install'),
      says: /the local branch steward\/install already exists/,
    },
    'a branch of that name that is checked out in another worktree': {
      setup: (cwd) => git(cwd, 'worktree', 'add', '-q', '-b', 'steward/install', path.join(fresh('elsewhere'), 'tree')),
      says: /the local branch steward\/install already exists, checked out in .*tree/,
    },
    'a branch of that name on origin': {
      setup: (cwd) => pushToRemote(cwd, { 'someone-elses.txt': 'x\n' }, { branch: 'steward/install' }),
      says: /origin already has a branch steward\/install/,
    },
  }
  it.each(Object.keys(taken))('ST-56/AC-2: %s is refused, exit 2, and is not reused, moved or appended to', async (name) => {
    const cwd = makeRepo()
    taken[name].setup(cwd)
    const localBefore = tryGit(cwd, 'rev-parse', '--verify', '--quiet', 'refs/heads/steward/install')
    const remoteBefore = bareRef(cwd, 'refs/heads/steward/install')
    const before = callerState(cwd)
    const gh = fakeGitHub()
    const machine = path.join(fresh('home'), 'config.json')
    const { code, err } = await runInit(['--yes'], { cwd, gh, machine })
    expect(code).toBe(2)
    expect(err).toMatch(taken[name].says)
    expect(err).toMatch(/never reuses, moves, adds to or deletes an existing branch or pull request/)
    expect(err).toMatch(/--branch/)
    expect(tryGit(cwd, 'rev-parse', '--verify', '--quiet', 'refs/heads/steward/install')).toBe(localBefore)
    expect(bareRef(cwd, 'refs/heads/steward/install')).toBe(remoteBefore)
    expect(callerState(cwd, { ignoreBranch: 'none' }).files).toEqual(before.files)
    expect(writes(gh)).toEqual([])
    expect(existsSync(worktreeOf(cwd))).toBe(false)
    expect(existsSync(machine)).toBe(false)
  })

  it('ST-56/AC-2: an open pull request with that head and base is named by its address, and nothing is made', async () => {
    const cwd = makeRepo()
    const open = { number: 7, html_url: `https://github.com/${REPO}/pull/7`, state: 'open', head: { ref: 'steward/install', repo: { full_name: REPO } }, base: { ref: 'main' } }
    const gh = fakeGitHub({ pulls: [open, { ...open, number: 8, html_url: `https://github.com/${REPO}/pull/8`, head: { ref: 'other', repo: { full_name: REPO } } }] })
    const { code, err } = await runInit(['--yes'], { cwd, gh })
    expect(code).toBe(2)
    expect(err).toContain(`https://github.com/${REPO}/pull/7`)
    expect(err).not.toContain('pull/8')
    expect(writes(gh)).toEqual([])
    expect(existsSync(`${cwd}.worktrees`)).toBe(false)
    expect(bareRef(cwd, 'refs/heads/steward/install')).toBe('')
  })

  it('ST-56/AC-2: the first push requires that the branch not exist, so a racing installer\'s branch is not overwritten', async () => {
    const cwd = makeRepo()
    let racer = null
    const watched = watchGit({
      before: (args) => {
        if (args[0] === 'push') racer = pushToRemote(cwd, { 'race.txt': 'first\n' }, { branch: 'steward/install' })
        return undefined
      },
    })
    const gh = fakeGitHub()
    const machine = path.join(fresh('home'), 'config.json')
    const { code, err } = await runInit(['--yes'], { cwd, gh, machine, git: watched })
    expect(code).toBe(1)
    expect(err).toMatch(/It stopped while pushing the branch to origin/)
    expect(err).toContain('git ls-remote --heads origin steward/install')
    expect(bareRef(cwd, 'refs/heads/steward/install')).toBe(racer)
    expect(git(remoteOf(cwd), 'ls-tree', '-r', '--name-only', 'refs/heads/steward/install')).not.toMatch(/steward\.config\.json/)
    const pushes = watched.calls.filter((c) => c.args[0] === 'push')
    expect(pushes).toHaveLength(1)
    expect(pushes[0].args.slice(0, 5)).toEqual(['push', '--no-follow-tags', '--no-signed', '--no-push-option', '--recurse-submodules=no'])
    expect(path.resolve(pushes[0].args[5])).toBe(path.resolve(remoteOf(cwd)))
    expect(pushes[0].args.slice(6)).toEqual([`${git(cwd, 'rev-parse', 'steward/install')}:refs/heads/steward/install`, '--force-with-lease=refs/heads/steward/install:'])
    expect(pushes[0].args.some((a) => a === '--force' || a === '-f' || a === '--delete' || a.startsWith('+'))).toBe(false)
    expect(writes(gh)).toEqual([])
    expect(existsSync(machine)).toBe(false)
  })

  it('ST-56/AC-2: it leaves the checkout\'s HEAD, branch, index and files unchanged on every failure too', async () => {
    const runs = [
      { git: watchGit({ before: (args) => (args[0] === 'push' ? failing('fatal: the remote hung up', 128) : undefined) }) },
      { gh: fakeGitHub({ pullCreate: 500 }) },
      { gh: fakeGitHub({ labelStatus: 500 }) },
    ]
    for (const options of runs) {
      const cwd = makeRepo({ files: BASE_FILES })
      writeFileSync(path.join(cwd, 'notes.txt'), 'untracked\n')
      const before = callerState(cwd)
      const { code } = await runInit(['--yes'], { cwd, ...options })
      expect(code).toBe(1)
      expect(callerState(cwd)).toEqual(before)
    }
  })
})

describe('ST-56/AC-3: only the installation diff', () => {
  it('ST-56/AC-3: the commit holds exactly the generated files, byte for byte, one parent, the checkout\'s identity and no trailer', async () => {
    const cwd = makeRepo()
    const pkg = makePackage('9.8.7')
    const expectedBase = bareRef(cwd, 'refs/heads/main')
    const { code } = await runInit(['--yes'], { cwd, pkg })
    expect(code).toBe(0)
    const commit = git(cwd, 'rev-parse', 'steward/install')
    expect(nameStatus(cwd, expectedBase, commit)).toEqual(EXPECTED_NEW.map((f) => `A\t${f}`))
    expect(JSON.parse(readOn(cwd, 'steward.config.json'))).toEqual({
      repo: REPO, setup: null, check: null, landWhen: 'all-checks', land: false, unitLinks: ['file', 'issue'], rulesFile: 'REVIEW.md', inspectAfterHours: 24,
    })
    expect(bytesOn(cwd, 'REVIEW.md')).toEqual(readFileSync(path.join(ROOT, 'templates/review-checklist.md')))
    expect(bytesOn(cwd, '.github/pull_request_template.md')).toEqual(readFileSync(path.join(ROOT, 'templates/pull_request_template.md')))
    for (const file of [...GATE_WORKFLOWS, INSPECTION_WORKFLOW]) {
      expect(readOn(cwd, `.github/workflows/${file}`)).toBe(readFileSync(path.join(ROOT, 'templates/workflows', file), 'utf8').replaceAll('v{{STEWARD_VERSION}}', () => 'v9.8.7'))
    }
    expect(git(cwd, 'rev-list', '--parents', '-n', '1', commit).split(' ')).toEqual([commit, expectedBase])
    expect(git(cwd, 'log', '-1', '--format=%an|%ae|%cn|%ce', commit)).toBe('Crew|crew@example.com|Crew|crew@example.com')
    expect(git(cwd, 'log', '-1', '--format=%B', commit)).toBe('Install Steward review gate')
    expect(git(cwd, 'cat-file', 'commit', commit)).not.toMatch(/gpgsig|Co-Authored-By|Signed-off-by/i)
  })

  it('ST-56/AC-3: nothing of the checkout\'s unrelated work reaches the commit, staged or not', async () => {
    const cwd = makeRepo({ files: BASE_FILES })
    commitFile(cwd, 'src/ahead.txt', 'a\n')
    writeFileSync(path.join(cwd, 'src/staged.txt'), 's\n')
    git(cwd, 'add', 'src/staged.txt')
    writeFileSync(path.join(cwd, 'notes.txt'), 'untracked\n')
    const expectedBase = bareRef(cwd, 'refs/heads/main')
    const { code } = await runInit(['--yes'], { cwd })
    expect(code).toBe(0)
    const commit = git(cwd, 'rev-parse', 'steward/install')
    expect(nameStatus(cwd, expectedBase, commit)).toEqual(EXPECTED_NEW.map((f) => `A\t${f}`))
    expect(branchFiles(cwd)).not.toContain('src/ahead.txt')
    expect(branchFiles(cwd)).not.toContain('src/staged.txt')
    expect(branchFiles(cwd)).not.toContain('notes.txt')
  })

  it('ST-56/AC-3: an edit other than an addition made after the files were staged stops the operation before the commit', async () => {
    const cwd = makeRepo()
    const watched = watchGit({
      after: (args, where, real) => {
        if (args.includes('add') && real.status === 0 && where.includes('.worktrees')) {
          writeFileSync(path.join(where, 'extra.txt'), 'not part of the installation\n')
          git(where, 'add', 'extra.txt')
        }
        return undefined
      },
    })
    const gh = fakeGitHub()
    const { code, err } = await runInit(['--yes'], { cwd, gh, git: watched })
    expect(code).toBe(1)
    expect(err).toMatch(/It stopped while checking the installation diff/)
    expect(err).toContain('extra.txt: a change that is not one of the files the installation adds')
    expect(watched.calls.some((c) => c.args[0] === 'commit')).toBe(false)
    expect(watched.calls.some((c) => c.args[0] === 'push')).toBe(false)
    expect(bareRef(cwd, 'refs/heads/steward/install')).toBe('')
    expect(writes(gh)).toEqual([])
    expect(existsSync(worktreeOf(cwd))).toBe(true)
  })

  it.each([
    ['an external edit to an added file', 'REVIEW.md', /REVIEW\.md: its content is not what was generated/],
    ['an external addition', 'extra.txt', /extra\.txt: a change that is not one of the files the installation adds/],
  ])('ST-56/AC-3: %s during commit is found and stops the operation before the push', async (_name, rel, finding) => {
    const cwd = makeRepo()
    const watched = watchGit({ before: (args, where) => {
      if (args[0] === 'commit') {
        put(where, { [rel]: 'external content\n' })
        git(where, 'add', rel)
      }
    } })
    const gh = fakeGitHub()
    const { code, err } = await runInit(['--yes'], { cwd, gh, git: watched })
    expect(code).toBe(1)
    expect(err).toMatch(/It stopped while checking the installation commit/)
    expect(err).toMatch(finding)
    expect(watched.calls.some((c) => c.args[0] === 'push')).toBe(false)
    expect(bareRef(cwd, 'refs/heads/steward/install')).toBe('')
    expect(writes(gh)).toEqual([])
    expect(existsSync(worktreeOf(cwd))).toBe(true)
  })

  it('ST-56/AC-3: files already on origin/main are never overwritten, repinned or staged', async () => {
    const cwd = makeRepo({ files: { '.github/workflows/review-gate.yml': 'my own gate, pinned elsewhere\n', 'REVIEW.md': 'my rules\n' } })
    const expectedBase = bareRef(cwd, 'refs/heads/main')
    const watched = watchGit()
    const { code, out } = await runInit(['--yes'], { cwd, git: watched })
    expect(code).toBe(0)
    expect(readOn(cwd, '.github/workflows/review-gate.yml')).toBe('my own gate, pinned elsewhere\n')
    expect(readOn(cwd, 'REVIEW.md')).toBe('my rules\n')
    const commit = git(cwd, 'rev-parse', 'steward/install')
    expect(nameStatus(cwd, expectedBase, commit)).toEqual(
      EXPECTED_NEW.filter((f) => f !== 'REVIEW.md' && f !== '.github/workflows/review-gate.yml').map((f) => `A\t${f}`),
    )
    expect(out).toContain('left .github/workflows/review-gate.yml: already there')
    const adds = watched.calls.filter((c) => isGit(c.args, 'add'))
    expect(adds).toHaveLength(1)
    expect(adds[0].argv.slice(0, 4)).toEqual(['--literal-pathspecs', '--no-replace-objects', 'add', '--'])
    expect(adds[0].args.slice(2).sort()).toEqual(EXPECTED_NEW.filter((f) => f !== 'REVIEW.md' && f !== '.github/workflows/review-gate.yml'))
  })
})

describe('ST-56/AC-4: existing and partial installations', () => {
  const settingsText = (extra = {}) =>
    `${JSON.stringify({ repo: REPO, setup: null, check: null, landWhen: 'all-checks', land: true, unitLinks: ['file'], rulesFile: 'docs/RULES.md', inspectAfterHours: 6, ...extra }, null, 4)}\n`

  it('ST-56/AC-4: a partial installation gets only what is missing, and every preserved file is reported, valid or not', async () => {
    const files = { 'steward.config.json': settingsText(), '.github/workflows/review-gate.yml': 'garbage: [\n', 'docs/RULES.md': 'not a checklist at all\n' }
    const cwd = makeRepo({ files })
    const expectedBase = bareRef(cwd, 'refs/heads/main')
    const gh = fakeGitHub()
    const { code, out } = await runInit(['--yes'], { cwd, gh })
    expect(code).toBe(0)
    const commit = git(cwd, 'rev-parse', 'steward/install')
    expect(nameStatus(cwd, expectedBase, commit)).toEqual(
      ['.github/pull_request_template.md', '.github/workflows/inspection.yml', '.github/workflows/land-approved.yml'].map((f) => `A\t${f}`),
    )
    expect(hasOn(cwd, 'REVIEW.md')).toBe(false)
    for (const rel of Object.keys(files)) {
      expect(out).toContain(`left ${rel}: already there`)
      expect(readOn(cwd, rel)).toBe(files[rel])
    }
    // The body lists each, and does not say they were checked.
    const body = bodyOf(gh)
    for (const rel of Object.keys(files)) expect(body).toContain(`\`${rel}\``)
    expect(body).toMatch(/did not validate them or check that they work with the steward installed here/)
    const withoutDenial = body.replace('claims that an existing installation is compatible with this one', '')
    expect(withoutDenial).not.toMatch(/is compatible|are compatible|were validated|was validated/)
    expect(body).toContain('nothing here claims that an existing installation is compatible with this one')
  })

  it('ST-56/AC-4: the settings\' bytes and chosen land value are kept, and the checklist goes where the settings name', async () => {
    for (const land of [true, false]) {
      const text = settingsText({ land })
      const cwd = makeRepo({ files: { 'steward.config.json': text } })
      const { code } = await runInit(['--yes', '--land', land ? 'no' : 'yes'], { cwd })
      expect(code).toBe(0)
      expect(readOn(cwd, 'steward.config.json')).toBe(text)
      expect(hasOn(cwd, 'docs/RULES.md')).toBe(true)
      expect(bytesOn(cwd, 'docs/RULES.md')).toEqual(readFileSync(path.join(ROOT, 'templates/review-checklist.md')))
      expect(hasOn(cwd, 'REVIEW.md')).toBe(false)
    }
  })

  it('ST-56/AC-4: a --rules-file that names the settings\' own path is accepted', async () => {
    const cwd = makeRepo({ files: { 'steward.config.json': settingsText() } })
    const { code } = await runInit(['--yes', '--rules-file', 'docs/RULES.md'], { cwd })
    expect(code).toBe(0)
    expect(hasOn(cwd, 'docs/RULES.md')).toBe(true)
  })

  it.each([
    ['a settings file that is not JSON', '{ not json', /not valid JSON/, []],
    ['a settings file with no rulesFile', '{"land":false}\n', /no usable rulesFile/, []],
    ['a settings file whose rulesFile climbs out of the project', '{"rulesFile":"../outside.md"}\n', /no usable rulesFile/, []],
    ['a settings file whose rulesFile is absolute', '{"rulesFile":"/etc/rules.md"}\n', /no usable rulesFile/, []],
    ['a settings file whose rulesFile is not a string', '{"rulesFile":5}\n', /no usable rulesFile/, []],
    ['a settings file that is an array', '[]\n', /no usable rulesFile/, []],
    ['a --rules-file that conflicts with the settings\' rulesFile', null, /--rules-file REVIEW\.md conflicts with steward\.config\.json on origin\/main, whose rulesFile is docs\/RULES\.md/, ['--rules-file', 'REVIEW.md']],
  ])('ST-56/AC-4: %s is refused, exit 2, before anything is made, so that no unused checklist is written', async (_name, text, says, args) => {
    const cwd = makeRepo({ files: { 'steward.config.json': text ?? settingsText() } })
    const gh = fakeGitHub()
    const machine = path.join(fresh('home'), 'config.json')
    const before = callerState(cwd)
    const { code, err } = await runInit(['--yes', ...args], { cwd, gh, machine })
    expect(code).toBe(2)
    expect(err).toMatch(says)
    expect(gh.requests).toEqual([])
    expect(callerState(cwd)).toEqual(before)
    expect(existsSync(`${cwd}.worktrees`)).toBe(false)
    expect(existsSync(machine)).toBe(false)
  })

  it('ST-56/AC-4: when nothing is missing it says no installation pull request is needed, makes no branch, commit, push or pull request, and still finishes the labels and user config', async () => {
    const cwd = makeRepo()
    expect((await runInit(['--yes'], { cwd })).code).toBe(0)
    mergeInstall(cwd)
    const branchesBefore = git(cwd, 'branch', '--list')
    const remoteBefore = git(remoteOf(cwd), 'for-each-ref', '--format=%(refname) %(objectname)')
    const before = callerState(cwd)
    const watched = watchGit()
    const gh = fakeGitHub()
    const machine = path.join(fresh('home'), 'config.json')
    const { code, out, err } = await runInit(['--yes'], { cwd, gh, machine, git: watched })
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out).toMatch(/No installation pull request is needed: everything steward installs is already on origin\/main/)
    expect(out.split('\n').filter((line) => line.startsWith('wrote '))).toEqual([`wrote ${machine}: the user config`])
    expect(watched.calls.some((c) => ['add', 'commit', 'push'].includes(c.args[0]) || isGit(c.args, 'worktree', 'add'))).toBe(false)
    expect(git(cwd, 'branch', '--list')).toBe(branchesBefore)
    expect(git(remoteOf(cwd), 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(remoteBefore)
    expect(callerState(cwd)).toEqual(before)
    expect(gh.requests.some((r) => r.rest.startsWith('/pulls'))).toBe(false)
    expect(pullWrites(gh)).toEqual([])
    expect(labelWrites(gh).map((r) => r.body.name)).toEqual(['review-blocked', 'breaker-override', 'inspection'])
    expect(existsSync(machine)).toBe(true)
  })

  it('ST-56/AC-4: running again while the installation branch exists is refused, with no duplicate pull request', async () => {
    const cwd = makeRepo()
    const gh = fakeGitHub()
    const first = await runInit(['--yes'], { cwd, gh })
    expect(first.code).toBe(0)
    const open = gh.created[0]
    const again = fakeGitHub({ pulls: [open] })
    const second = await runInit(['--yes'], { cwd, gh: again })
    expect(second.code).toBe(2)
    expect(second.err).toMatch(/the local branch steward\/install already exists/)
    expect(second.err).toMatch(/origin already has a branch steward\/install/)
    expect(second.err).toContain(open.html_url)
    expect(pullWrites(again)).toEqual([])
    expect(gh.created).toHaveLength(1)
  })
})

describe('ST-56/AC-5: the draft pull request', () => {
  it('ST-56/AC-5: one draft pull request against main is created from the pushed branch, and the repository, branch, base, commit and address are printed', async () => {
    const cwd = makeRepo()
    const gh = fakeGitHub()
    const { code, out } = await runInit(['--yes'], { cwd, gh })
    expect(code).toBe(0)
    expect(pullWrites(gh)).toHaveLength(1)
    const request = pullWrites(gh)[0]
    expect(request.method).toBe('POST')
    expect(request.body).toEqual({ title: 'Install Steward review gate', head: 'steward/install', base: 'main', draft: true, body: expect.any(String) })
    const commit = git(cwd, 'rev-parse', 'steward/install')
    expect(out).toContain(`  repository: ${REPO}`)
    expect(out).toContain('  branch: steward/install')
    expect(out).toContain('  base: main')
    expect(out).toContain(`  commit: ${commit}`)
    expect(out).toContain(`  pull request: https://github.com/${REPO}/pull/41`)
    expect(out.indexOf('Pushed steward/install to origin.')).toBeLessThan(out.indexOf('Opened the draft pull request'))
  })

  it('ST-56/AC-5: it does not report completion when GitHub does not confirm a draft pull request', async () => {
    for (const pullCreate of ['notDraft', 'ok200']) {
      const cwd = makeRepo()
      const gh = fakeGitHub({ pullCreate })
      const machine = path.join(fresh('home'), 'config.json')
      const { code, out, err } = await runInit(['--yes'], { cwd, gh, machine })
      expect(code, pullCreate).toBe(1)
      expect(err).toMatch(/did not confirm an open draft pull request from steward\/install into main/)
      expect(err).toMatch(/It stopped while opening the draft pull request/)
      expect(`${out}\n${err}`).not.toMatch(/installation pull request is open for the crew/)
      expect(labelWrites(gh)).toEqual([])
      expect(existsSync(machine)).toBe(false)
      expect(bareRef(cwd, 'refs/heads/steward/install')).toMatch(/^[0-9a-f]{40}$/)
      expect(existsSync(worktreeOf(cwd))).toBe(true)
    }
  })

  it('ST-56/AC-5: it uses the configured identity, disables installation hooks, and invents no author, trailer or signing override', async () => {
    const cwd = makeRepo()
    const marker = path.join(fresh('marker'), 'ran')
    hook(cwd, 'pre-commit', `echo hook-ran > "${marker.replaceAll('\\', '/')}"`)
    const watched = watchGit()
    const { code } = await runInit(['--yes'], { cwd, git: watched })
    expect(code).toBe(0)
    expect(existsSync(marker)).toBe(false)
    const commits = watched.calls.filter((c) => c.args[0] === 'commit')
    expect(commits.map((c) => c.args)).toEqual([['commit', '--quiet', '-m', 'Install Steward review gate']])
    const everyArg = watched.calls.flatMap((c) => c.args)
    for (const forbidden of ['--no-verify', '-n', '--no-gpg-sign', '-S', '--gpg-sign', '--author', '--amend', '--allow-empty', '--signoff', '-s', '--trailer', '-c']) {
      expect(everyArg, forbidden).not.toContain(forbidden)
    }
    expect(git(cwd, 'log', '-1', '--format=%an <%ae>', 'steward/install')).toBe('Crew <crew@example.com>')
  })

  it('ST-56/AC-5: a worktree that is not clean after the pull request is confirmed is kept, not removed, and the run still finishes', async () => {
    const cwd = makeRepo()
    const gh = fakeGitHub()
    const fetch = gh.fetch
    gh.fetch = async (url, options) => {
      const response = await fetch(url, options)
      if (url.endsWith('/pulls') && options.method === 'POST') put(worktreeOf(cwd), { 'junk.txt': 'left by another process\n' })
      return response
    }
    const { code, out, err } = await runInit(['--yes'], { cwd, gh })
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out).toMatch(/Kept the worktree .* \(git would not remove it: /)
    expect(existsSync(path.join(worktreeOf(cwd), 'junk.txt'))).toBe(true)
    expect(pullWrites(gh)).toHaveLength(1)
    expect(bareRef(cwd, 'refs/heads/steward/install')).toBe(git(cwd, 'rev-parse', 'steward/install'))
  })

  it('ST-56/AC-5: a commit command that fails stops publication', async () => {
    const cwd = makeRepo()
    const watched = watchGit({ before: (args) => args[0] === 'commit' ? failing('commit says no') : undefined })
    const gh = fakeGitHub()
    const { code, err } = await runInit(['--yes'], { cwd, gh, git: watched })
    expect(code).toBe(1)
    expect(err).toMatch(/It stopped while committing the installation/)
    expect(err).toContain('commit says no')
    expect(watched.calls.some((c) => c.args[0] === 'push')).toBe(false)
    expect(bareRef(cwd, 'refs/heads/steward/install')).toBe('')
    expect(writes(gh)).toEqual([])
    expect(watched.calls.filter((c) => c.args[0] === 'commit')).toHaveLength(1)
  })
})

describe('ST-56/AC-6: the body, written as the project expects', () => {
  const PROJECT_TEMPLATE = [
    'Unit:',
    '<!-- Link the issue this resolves. -->',
    '',
    '## Summary',
    '',
    '<!-- Say what you did. -->',
    '',
    '## What changed',
    '',
    '<!-- List the files. -->',
    '',
    '## Test plan',
    '',
    '- [ ] I ran the suite',
    '',
  ].join('\n')

  it('ST-56/AC-6: with one project template it is the skeleton: headings and prompts kept, Unit set to none, the sections it has filled, the rest in a labelled summary', async () => {
    const cwd = makeRepo({ files: { 'docs/pull_request_template.md': PROJECT_TEMPLATE } })
    const gh = fakeGitHub()
    const { code } = await runInit(['--yes'], { cwd, gh })
    expect(code).toBe(0)
    const body = bodyOf(gh)
    for (const kept of ['<!-- Link the issue this resolves. -->', '## Summary', '<!-- Say what you did. -->', '## What changed', '<!-- List the files. -->', '## Test plan', '- [ ] I ran the suite']) {
      expect(body, kept).toContain(kept)
    }
    expect(body.startsWith('Unit: none\n')).toBe(true)
    expect(body.match(/^Unit:.*$/gm)).toEqual(['Unit: none'])
    // The filled section sits where the project's heading is, before its next heading.
    expect(body.indexOf('## What changed')).toBeLessThan(body.indexOf('This pull request installs steward\'s review gate'))
    expect(body.indexOf('This pull request installs steward\'s review gate')).toBeLessThan(body.indexOf('## Test plan'))
    // The two standard sections the template lacks are in a clearly labelled summary within it.
    expect(body).toMatch(/## Installation summary\n\nThis section holds what `steward init` knows about the installation, because the template above has no section for it\./)
    expect(body.indexOf('## Installation summary')).toBeGreaterThan(body.indexOf('- [ ] I ran the suite'))
    expect(body).toContain('**Verification**')
    expect(body).toContain('**Docs check**')
    expect(body.match(/^## Verification$/gm)).toBeNull()
    // What the installer cannot complete is the crew's, named.
    expect(body).toContain('Confirm the `Unit:` line above. The installer set it to `none`')
    expect(body).toContain('`## Summary`, `## Test plan`')
    expect(body).toMatch(/Tick or remove the 1 unchecked item in the template above/)
    // The project's template was neither edited nor replaced.
    expect(readOn(cwd, 'docs/pull_request_template.md')).toBe(PROJECT_TEMPLATE)
    expect(hasOn(cwd, '.github/pull_request_template.md')).toBe(false)
  })

  it('ST-56/AC-6: with no usable template it uses the package\'s, whose three sections are filled and which also becomes the project\'s template', async () => {
    const cwd = makeRepo()
    const gh = fakeGitHub()
    const { code } = await runInit(['--yes'], { cwd, gh })
    expect(code).toBe(0)
    const body = bodyOf(gh)
    expect(body.match(/^## .+$/gm)).toEqual(['## What changed', '## Verification', '## Docs check'])
    expect(body).not.toContain('Installation summary')
    expect(body).toContain('<!-- What this PR does and why.')
    expect(body.startsWith('Unit: none\n')).toBe(true)
    expect(hasOn(cwd, '.github/pull_request_template.md')).toBe(true)
  })

  it('ST-56/AC-6: it lists the files added and left, the version, the checks it ran with their results, and the crew\'s follow-up, and claims nothing else', async () => {
    const cwd = makeRepo({ files: { 'REVIEW.md': 'my rules\n' } })
    const gh = fakeGitHub()
    const base = bareRef(cwd, 'refs/heads/main')
    const { code } = await runInit(['--yes'], { cwd, gh, pkg: makePackage('9.8.7') })
    expect(code).toBe(0)
    const body = bodyOf(gh)
    for (const rel of EXPECTED_NEW.filter((f) => f !== 'REVIEW.md')) expect(body).toContain(`- \`${rel}\`: `)
    expect(body).toMatch(/Left as they were \(already in the project\):\n- `REVIEW\.md`/)
    expect(body).toContain('The workflow files added here run steward v9.8.7.')
    expect(body).toContain(`from \`main\` at commit \`${base}\``)
    expect(body).toContain('on branch `steward/install`')
    expect(body).toMatch(/Checks `steward init` ran while making this pull request, and their results:\n- Base: fetched `origin\/main`/)
    expect(body).toMatch(/Diff: .* They add exactly the 5 files listed above, each with the content steward generated, and change nothing else\. .* Passed\./)
    expect(body).toMatch(/Settings: `steward\.config\.json` was read back and accepted by steward\. Passed\./)
    expect(body).toMatch(/Not run: the project's tests, setup and checks, and no steward review\./)
    expect(body).toMatch(/did not validate them or check that they work with the steward installed here/)
    expect(body).toMatch(/Merge it through the project's existing process\. Steward's gate cannot review the pull request that installs it/)
    expect(body).toMatch(/This pull request is a draft\. Before the crew marks it ready:/)
    // (The template's own prompts say "tests pass" as an example of what not to write.)
    expect(body.replace(/<!--[\s\S]*?-->/g, '')).not.toMatch(/tests? (passed|pass|ran)\b|all checks pass/i)
  })

  it('ST-56/AC-6: a pinned commit is named as the explicit pin', async () => {
    const gh = fakeGitHub()
    const { code } = await runInit(['--yes', '--ref', 'a'.repeat(40)], { cwd: makeRepo(), gh })
    expect(code).toBe(0)
    expect(bodyOf(gh)).toContain(`The workflow files added here run steward at commit ${'a'.repeat(40)}.`)
  })

  it('ST-56/AC-6: no story or criterion id and no file or module of steward\'s own is in the body, the title or what init prints', async () => {
    const gh = fakeGitHub()
    const { code, out, err } = await runInit(['--yes'], { cwd: makeRepo({ files: { 'docs/pull_request_template.md': PROJECT_TEMPLATE } }), gh })
    expect(code).toBe(0)
    const internals = /ST-\d|AC-\d|scripts\/|\.mjs|init-install|init-pr-body/
    expect(`${bodyOf(gh)}\n${titleOf(gh)}\n${out}\n${err}`).not.toMatch(internals)
  })

  const TWO = { '.github/PULL_REQUEST_TEMPLATE/bug.md': 'Unit:\n\n## Bug\n\n<!-- bug prompt -->\n', '.github/PULL_REQUEST_TEMPLATE/feature.md': 'Unit:\n\n## Feature\n\n<!-- feature prompt -->\n' }

  it('ST-56/AC-6: with several templates --yes cannot choose: the question has no default, and without a terminal the flag is required', async () => {
    const cwd = makeRepo({ files: TWO })
    const gh = fakeGitHub()
    const before = callerState(cwd)
    const { code, err } = await runInit(['--yes'], { cwd, gh })
    expect(code).toBe(2)
    expect(err).toContain('--pr-template')
    expect(err).toContain('.github/PULL_REQUEST_TEMPLATE/bug.md, .github/PULL_REQUEST_TEMPLATE/feature.md')
    expect(err).toMatch(/\(no default\)/)
    expect(err).toMatch(/Nothing was written/)
    expect(callerState(cwd)).toEqual(before)
    expect(gh.requests).toEqual([])
  })

  it('ST-56/AC-6: --pr-template names one of them, and the body is written from it', async () => {
    const cwd = makeRepo({ files: TWO })
    const gh = fakeGitHub()
    const { code } = await runInit(['--yes', '--pr-template', '.github/PULL_REQUEST_TEMPLATE/feature.md'], { cwd, gh })
    expect(code).toBe(0)
    expect(bodyOf(gh)).toContain('<!-- feature prompt -->')
    expect(bodyOf(gh)).not.toContain('bug prompt')
    // Neither is edited, and the package's template is not added beside them.
    expect(hasOn(cwd, '.github/PULL_REQUEST_TEMPLATE/bug.md')).toBe(true)
    expect(hasOn(cwd, '.github/pull_request_template.md')).toBe(false)
  })

  it('ST-56/AC-6: a path that is not one of the discovered templates is refused, whatever the number of templates', async () => {
    for (const files of [TWO, { 'docs/pull_request_template.md': 'Unit:\n' }, {}]) {
      const cwd = makeRepo({ files })
      const gh = fakeGitHub()
      const { code, err } = await runInit(['--yes', '--pr-template', 'docs/not-a-template.md'], { cwd, gh })
      expect(code).toBe(2)
      expect(err).toMatch(/--pr-template docs\/not-a-template\.md/)
      expect(gh.requests).toEqual([])
      expect(existsSync(`${cwd}.worktrees`)).toBe(false)
    }
  })

  it('ST-56/AC-6: at a terminal the choice is asked with no default, and a wrong answer is asked again', async () => {
    const cwd = makeRepo({ files: TWO })
    const terminal = fakeTerminal(['nope', '.github/PULL_REQUEST_TEMPLATE/bug.md'])
    const gh = fakeGitHub()
    const { code } = await runInit(['--yes'], { cwd, gh, terminal })
    expect(code).toBe(0)
    expect(terminal.prompts).toHaveLength(2)
    expect(terminal.prompts[0]).toContain('.github/PULL_REQUEST_TEMPLATE/bug.md, .github/PULL_REQUEST_TEMPLATE/feature.md')
    expect(terminal.prompts[0]).not.toMatch(/\[[^\]]*\] $/)
    expect(terminal.written.join('')).toContain('answer one of: ')
    expect(bodyOf(gh)).toContain('<!-- bug prompt -->')
  })

  it('ST-56/AC-6: an empty template directory counts as no usable template, is reported, and the package\'s template is used', async () => {
    // Git keeps no empty directory: a directory holding only a subdirectory has no template file.
    const cwd = makeRepo({ files: { '.github/PULL_REQUEST_TEMPLATE/archive/old.md': 'old\n' } })
    const gh = fakeGitHub()
    const { code, out } = await runInit(['--yes'], { cwd, gh })
    expect(code).toBe(0)
    expect(out).toContain('left .github/PULL_REQUEST_TEMPLATE/: an empty directory, which counts as no usable pull request template')
    expect(hasOn(cwd, '.github/pull_request_template.md')).toBe(true)
    expect(bodyOf(gh).match(/^## .+$/gm)).toEqual(['## What changed', '## Verification', '## Docs check'])
    expect(bodyOf(gh)).toContain('`.github/PULL_REQUEST_TEMPLATE/`: an empty template directory, which counts as no pull request template')
  })

  it('ST-56/AC-6: a template that is a symbolic link cannot be the skeleton: it is refused before anything is made, and a supplied body is the way out', async () => {
    const cwd = makeRepo()
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd, encoding: 'utf8', input: 'docs/elsewhere.md' }).trim()
    git(cwd, 'update-index', '--add', '--cacheinfo', `120000,${blob},.github/pull_request_template.md`)
    git(cwd, 'commit', '-q', '-m', 'link')
    git(cwd, 'push', '-q', slashes(remoteOf(cwd)), 'main')
    git(cwd, 'checkout', '-q', '--', '.github/pull_request_template.md')
    const gh = fakeGitHub()
    const refused = await runInit(['--yes'], { cwd, gh })
    expect(refused.err).toMatch(/\.github\/pull_request_template\.md on origin\/main is a symbolic link, so the body cannot be written from it/)
    expect(refused.code).toBe(2)
    expect(gh.requests).toEqual([])
    expect(existsSync(`${cwd}.worktrees`)).toBe(false)

    const file = path.join(fresh('body'), 'body.md')
    writeFileSync(file, 'my own body\n')
    const supplied = fakeGitHub()
    const ok = await runInit(['--yes', '--pr-body-file', file], { cwd, gh: supplied })
    expect(ok.err).toBe('')
    expect(ok.code).toBe(0)
    expect(bodyOf(supplied)).toBe('my own body\n')
  })

  it('ST-56/AC-6: --pr-title replaces the title; the default is "Install Steward review gate"', async () => {
    const gh = fakeGitHub()
    expect((await runInit(['--yes', '--pr-title', 'Add the review gate (crew request)'], { cwd: makeRepo(), gh })).code).toBe(0)
    expect(titleOf(gh)).toBe('Add the review gate (crew request)')
    const plain = fakeGitHub()
    await runInit(['--yes'], { cwd: makeRepo(), gh: plain })
    expect(titleOf(plain)).toBe('Install Steward review gate')
    const empty = await runInit(['--yes', '--pr-title', '  '], { cwd: makeRepo() })
    expect(empty.code).toBe(2)
  })

  it('ST-56/AC-6: --pr-body-file is read before anything is made and used verbatim, with no headings or Unit line of steward\'s, and no template choice', async () => {
    const text = 'Closes the adoption ticket (PROJ-12).\r\n\r\nno headings here\n'
    const file = path.join(fresh('body'), 'body.md')
    writeFileSync(file, text)
    const cwd = makeRepo({ files: TWO })
    const gh = fakeGitHub()
    const { code } = await runInit(['--yes', '--pr-body-file', file], { cwd, gh })
    expect(code).toBe(0)
    expect(bodyOf(gh)).toBe(text)

    const missing = makeRepo()
    const refusedGh = fakeGitHub()
    const refused = await runInit(['--yes', '--pr-body-file', path.join(fresh('body'), 'absent.md')], { cwd: missing, gh: refusedGh })
    expect(refused.code).toBe(2)
    expect(refused.err).toMatch(/--pr-body-file .* cannot be read/)
    expect(refusedGh.requests).toEqual([])
    expect(existsSync(`${missing}.worktrees`)).toBe(false)

    const both = await runInit(['--yes', '--pr-body-file', file, '--pr-template', '.github/PULL_REQUEST_TEMPLATE/bug.md'], { cwd: makeRepo({ files: TWO }) })
    expect(both.code).toBe(2)
    expect(both.err).toMatch(/give --pr-body-file or --pr-template, not both/)
  })

  it('ST-56/AC-6: a supplied body keeps its own unit link', async () => {
    const file = path.join(fresh('body'), 'body.md')
    writeFileSync(file, 'Unit: #123\n\nDetails.\n')
    const gh = fakeGitHub()
    expect((await runInit(['--yes', '--pr-body-file', file], { cwd: makeRepo(), gh })).code).toBe(0)
    expect(bodyOf(gh)).toBe('Unit: #123\n\nDetails.\n')
  })

  describe('the body composer', () => {
    const FACTS = {
      repo: REPO,
      branch: 'steward/install',
      baseSha: 'b'.repeat(40),
      version: '1.2.3',
      pin: 'v1.2.3',
      workflowsAdded: true,
      added: [{ rel: 'steward.config.json', note: 'settings' }],
      preserved: [],
      emptyTemplates: [],
      land: false,
      checks: ['Base: fetched. Passed.'],
    }

    it('ST-56/AC-6: it keeps the skeleton\'s line endings, and a skeleton with no section of steward\'s gets all three in the summary', () => {
      const body = composePullRequestBody({ skeleton: 'Unit: \r\n\r\n## Notes\r\n\r\ntext\r\n', facts: FACTS })
      expect(body.includes('\r\n')).toBe(true)
      expect(body.replace(/\r\n/g, '')).not.toMatch(/\n/)
      expect(body.startsWith('Unit: none\r\n')).toBe(true)
      for (const label of ['**What changed**', '**Verification**', '**Docs check**']) expect(body).toContain(label)
      expect(body.match(/## Installation summary/g)).toHaveLength(1)
    })

    it('ST-56/AC-6: a skeleton with all three sections gets no summary, and its sections of any heading level are filled in place', () => {
      const skeleton = '### What changed\n\n<!-- a -->\n\n### Verification\n\n<!-- b -->\n\n### Docs check\n\n<!-- c -->\n'
      const body = composePullRequestBody({ skeleton, facts: FACTS })
      expect(body).not.toContain('Installation summary')
      expect(body.indexOf('<!-- a -->')).toBeLessThan(body.indexOf('This pull request installs'))
      expect(body.indexOf('This pull request installs')).toBeLessThan(body.indexOf('### Verification'))
      expect(body.indexOf('<!-- b -->')).toBeLessThan(body.indexOf('Checks `steward init` ran'))
      expect(body.indexOf('<!-- c -->')).toBeLessThan(body.indexOf('did not check or change the project'))
      expect(body).not.toMatch(/Confirm the `Unit:` line/)
    })

    it('ST-56/AC-6: with no workflow added it names the generator and target while disclaiming preserved pins', () => {
      const body = composePullRequestBody({ skeleton: '## What changed\n', facts: { ...FACTS, workflowsAdded: false, land: null } })
      expect(body).toContain('Left as they were: none, since every file steward installs was missing.')
      expect(body).toContain('No workflow file was added here, so this pull request installs no version of steward.')
      expect(body).toContain('Generated by steward v1.2.3. Installation workflow target: v1.2.3.')
      expect(body).toContain('their pins were not validated')
      expect(body).not.toMatch(/`land`/)
    })
  })
})

describe('ST-56/AC-7: bounded failures with recoverable evidence', () => {
  /**
   * Runs init expecting exit 1 and returns the result with the paths of what it should have made.
   */
  async function failAt({ gh = fakeGitHub(), git: runner, machine = path.join(fresh('home'), 'config.json'), prepare = () => {} } = {}) {
    const cwd = makeRepo({ files: BASE_FILES })
    prepare(cwd)
    const result = await runInit(['--yes'], { cwd, gh, machine, git: runner })
    expect(result.code).toBe(1)
    return { err: result.err, out: result.out, gh, cwd, machine, worktree: worktreeOf(cwd) }
  }

  it('ST-56/AC-7: a worktree that cannot be made stops before installation files, branch or request, reporting its private hooks folder', async () => {
    const watched = watchGit({ before: (args) => (isGit(args, 'worktree', 'add') ? failing('fatal: simulated failure', 128) : undefined) })
    const r = await failAt({ git: watched })
    expect(r.err).toMatch(/^init stopped: git worktree add .*simulated failure/m)
    expect(r.err).toMatch(/It stopped while creating the installation worktree\./)
    expect(r.err).toContain('empty hooks directory for this installation')
    expect(r.err).not.toContain('local branch steward/install at')
    expect(r.err).toContain('your checkout is as it was')
    expect(r.err).not.toContain('<worktree>')
    expect(writes(r.gh)).toEqual([])
    expect(existsSync(r.machine)).toBe(false)
  })

  it('ST-56/AC-7: a file that cannot be written stops the rest, and keeps the worktree and branch with what was written', async () => {
    const watched = watchGit({
      after: (args, _where, real) => {
        // Once the worktree is made, put a file where the .github directory has to go.
        if (isGit(args, 'worktree', 'add') && real.status === 0) writeFileSync(path.join(args[5], '.github'), 'a file, not a directory\n')
        return undefined
      },
    })
    const r = await failAt({ git: watched })
    expect(r.err).toMatch(/It stopped while writing the installation files\./)
    expect(r.err).toContain(`worktree ${r.worktree}`)
    expect(r.err).toContain('local branch steward/install')
    expect(r.err).toMatch(/Nothing was pushed and no pull request was opened\./)
    expect(r.err).toMatch(/To finish by hand once the cause is fixed: stage and commit the files there, run git -C .* push origin steward\/install, and open a draft pull request against main/)
    expect(existsSync(path.join(r.worktree, 'steward.config.json'))).toBe(true)
    expect(watched.calls.some((c) => c.args[0] === 'commit' || c.args[0] === 'push')).toBe(false)
    expect(writes(r.gh)).toEqual([])
    expect(bareRef(r.cwd, 'refs/heads/steward/install')).toBe('')
  })

  it('ST-56/AC-7: a file that cannot be staged stops before the commit', async () => {
    const watched = watchGit({ before: (args) => (isGit(args, 'add') ? failing('fatal: simulated failure', 128) : undefined) })
    const r = await failAt({ git: watched })
    expect(r.err).toMatch(/It stopped while staging the installation files\./)
    expect(watched.calls.some((c) => c.args[0] === 'commit' || c.args[0] === 'push')).toBe(false)
    expect(existsSync(r.worktree)).toBe(true)
  })

  it('ST-56/AC-7: a commit that fails keeps the worktree, says so, and stops', async () => {
    const r = await failAt({ git: watchGit({ before: (args) => args[0] === 'commit' ? failing('no commits today') : undefined }) })
    expect(r.err).toMatch(/It stopped while committing the installation\./)
    expect(r.err).toContain('no commits today')
    expect(r.err).toContain(`worktree ${r.worktree}`)
    expect(r.err).not.toMatch(/\n  commit [0-9a-f]{40}/)
    expect(existsSync(r.worktree)).toBe(true)
    expect(writes(r.gh)).toEqual([])
  })

  it('ST-56/AC-7: a push that fails is not retried, says that whether origin has the branch is not certain, and tells how to look and how to finish by hand', async () => {
    const watched = watchGit({ before: (args) => (args[0] === 'push' ? failing('fatal: the remote end hung up unexpectedly', 128) : undefined) })
    const r = await failAt({ git: watched })
    expect(r.err).toMatch(/It stopped while pushing the branch to origin\./)
    expect(r.err).toMatch(/\n  commit [0-9a-f]{40}/)
    expect(r.err).toContain('Whether origin received the branch is not certain.')
    expect(r.err).toContain('git ls-remote --heads origin steward/install')
    expect(r.err).toContain('If it lists the branch, do not push again')
    expect(r.err).toMatch(/push by hand: git -C .* push origin steward\/install, then open a draft pull request against main/)
    expect(watched.calls.filter((c) => c.args[0] === 'push')).toHaveLength(1)
    expect(writes(r.gh)).toEqual([])
    expect(existsSync(r.worktree)).toBe(true)
  })

  it.each([
    ['GitHub refusing it', { pullCreate: 422 }, /POST .*\/pulls failed with 422: Validation Failed; no commits between main and the branch/],
    ['the answer never arriving', { throwOn: (m, rest) => m === 'POST' && rest === '/pulls' }, /fetch failed/],
  ])('ST-56/AC-7: a pull request that cannot be opened because of %s is not retried; the pushed branch is kept and named, and GitHub is to be looked at first', async (_name, options, says) => {
    const gh = fakeGitHub(options)
    const r = await failAt({ gh })
    expect(r.err).toMatch(says)
    expect(r.err).toMatch(/It stopped while opening the draft pull request\./)
    expect(r.err).toContain('branch steward/install on origin')
    expect(r.err).toContain(`Look at https://github.com/${REPO}/pulls for one from steward/install before opening another`)
    expect(pullWrites(gh)).toHaveLength(1)
    expect(labelWrites(gh)).toEqual([])
    expect(existsSync(r.machine)).toBe(false)
    expect(bareRef(r.cwd, 'refs/heads/steward/install')).toBe(git(r.cwd, 'rev-parse', 'steward/install'))
    expect(existsSync(r.worktree)).toBe(true)
  })

  it('ST-56/AC-7: a label that fails after the pull request names the pull request and the labels already made, rolls nothing back, and writes no user config', async () => {
    const gh = fakeGitHub({ labelStatus: 500 })
    const r = await failAt({ gh })
    expect(r.err).toMatch(/It stopped while creating the labels\./)
    expect(r.err).toContain(`draft pull request https://github.com/${REPO}/pull/41`)
    expect(r.err).toContain(`The installation pull request is open: https://github.com/${REPO}/pull/41`)
    expect(r.err).toContain("The labels and the user config are separate from the pull request: they are not part of it, and neither is rolled back.")
    expect(r.err).toContain('Run init again once the installation has merged')
    expect(gh.requests.filter((r2) => r2.method === 'DELETE' || r2.method === 'PATCH')).toEqual([])
    expect(existsSync(r.machine)).toBe(false)
    expect(bareRef(r.cwd, 'refs/heads/steward/install')).toMatch(/^[0-9a-f]{40}$/)
    // The pull request was confirmed, so the finished worktree is removed and the branch kept.
    expect(existsSync(r.worktree)).toBe(false)
    expect(r.err).not.toContain(`worktree ${r.worktree}`)
  })

  it('ST-56/AC-7: user config that cannot be written are reported with the pull request and the labels already made, and nothing is rolled back', async () => {
    const blocker = path.join(fresh('home'), 'a-file')
    writeFileSync(blocker, 'x')
    const gh = fakeGitHub()
    const r = await failAt({ gh, machine: path.join(blocker, 'config.json') })
    expect(r.err).toMatch(/It stopped while writing the user config\./)
    expect(r.err).toContain(`draft pull request https://github.com/${REPO}/pull/41`)
    expect(r.err).toContain('  label review-blocked')
    expect(r.err).toContain('  label inspection')
    expect(labelWrites(gh)).toHaveLength(3)
    expect(gh.requests.filter((q) => q.method === 'DELETE')).toEqual([])
  })

  it('ST-56/AC-7: nothing is deleted or rolled back by any failure, and no git command that removes or force-updates is run', async () => {
    const watched = watchGit({ before: (args) => (args[0] === 'push' ? failing('fatal: simulated', 128) : undefined) })
    const r = await failAt({ git: watched })
    const kinds = watched.calls.map((c) => c.args.filter((a) => !a.startsWith('--literal'))[0])
    expect(kinds).not.toContain('branch')
    expect(kinds).not.toContain('reset')
    expect(kinds).not.toContain('clean')
    expect(watched.calls.some((c) => isGit(c.args, 'worktree', 'remove'))).toBe(false)
    expect(existsSync(r.worktree)).toBe(true)
    expect(git(r.cwd, 'branch', '--list', 'steward/install')).toMatch(/steward\/install/)
  })

  it('ST-56/AC-7: it installs nothing into the project\'s dependencies and runs no project setup or check', async () => {
    const cwd = makeRepo({ files: { 'steward.config.json': JSON.stringify({ rulesFile: 'REVIEW.md', setup: 'echo setup > ../setup-ran', check: 'echo check > ../check-ran' }) } })
    const watched = watchGit()
    const { code } = await runInit(['--yes'], { cwd, git: watched })
    expect(code).toBe(0)
    expect(existsSync(`${cwd}.worktrees/setup-ran`)).toBe(false)
    expect(existsSync(path.join(path.dirname(cwd), 'setup-ran'))).toBe(false)
    expect(watched.calls.every((c) => !['npm', 'npx', 'node'].includes(c.args[0]))).toBe(true)
    expect(branchFiles(cwd)).not.toContain('package-lock.json')
    expect(readdirSync(path.dirname(cwd)).filter((n) => /setup-ran|check-ran/.test(n))).toEqual([])
  })
})

describe('ST-56/AC-8: adoption and activation stay separate', () => {
  it('ST-56/AC-8: it asks GitHub only to list, create, read labels and create labels, never marks ready, merges, lands, or touches protection', async () => {
    const gh = fakeGitHub()
    const { code } = await runInit(['--yes', '--land', 'yes'], { cwd: makeRepo(), gh })
    expect(code).toBe(0)
    const shapes = gh.requests.map((r) => `${r.method} ${r.rest.replace(/\?.*$/, '').replace(/labels\/.+$/, 'labels/<name>')}`)
    expect([...new Set(shapes)].sort()).toEqual(['GET /labels/<name>', 'GET /pulls', 'POST /labels', 'POST /pulls'])
    expect(pullWrites(gh).map((r) => r.body.draft)).toEqual([true])
    expect(shapes.some((s) => /merge|auto|protection|dispatches|ready|graphql|PATCH|PUT|DELETE/i.test(s))).toBe(false)
  })

  it('ST-56/AC-8: the output and the body say the crew reviews and merges through the project\'s process, that a fresh gate cannot review its own install, and that merging starts nothing locally', async () => {
    const gh = fakeGitHub()
    const { code, out } = await runInit(['--yes'], { cwd: makeRepo(), gh })
    expect(code).toBe(0)
    const lines = out.split('\n')
    expect(out).toMatch(/The crew reviews and merges it through the project's existing process: a fresh install cannot be reviewed by the gate it introduces, and where the project already has a gate, its rules still apply, since init bypasses none\./)
    expect(out).toContain('Merging it starts nothing on any machine: running steward on a machine is a separate step.')
    // The recommendation of protection comes last, after adoption, and nowhere else in the output.
    expect(lines.at(-1)).toMatch(/Steward is then set up\. .*run `steward protect` once it has merged\.$/)
    expect(lines.filter((l) => /protect/i.test(l))).toEqual([lines.at(-1)])
    const body = bodyOf(gh)
    expect(body).toMatch(/Steward's gate cannot review the pull request that installs it, and where the project already has a gate, its rules still apply: the installer bypassed none\./)
    expect(body).toMatch(/Merging this starts nothing on any machine: running steward on a machine is a separate step, and nothing here grants permission for it\./)
    expect(body).toMatch(/Optionally, once it has merged, run `steward protect`/)
    expect(`${out}\n${body}`).not.toMatch(/steward (start|enable|activate|register|rotation)\b/i)
  })

  it('ST-56/AC-8: ST-55\'s review-only default, the explicit opt-in and the landing notes are kept, in the output and in the body', async () => {
    const off = fakeGitHub()
    const offRun = await runInit(['--yes'], { cwd: makeRepo(), gh: off })
    expect(offRun.out).toMatch(/land set to false: steward can review pull requests but will not land any unattended/)
    expect(offRun.out).toMatch(/--yes took the default for the landing question, no: it does not consent to unattended landing/)
    expect(JSON.parse(readOn(offRun.cwd, 'steward.config.json')).land).toBe(false)
    expect(bodyOf(off)).toContain('`steward.config.json` sets `land` to `false`: steward reviews pull requests and does not land any unattended')
    const on = fakeGitHub()
    const onRun = await runInit(['--yes', '--land', 'yes'], { cwd: makeRepo(), gh: on })
    expect(onRun.out).toMatch(/land set to true: unattended landing was explicitly enabled/)
    expect(JSON.parse(readOn(onRun.cwd, 'steward.config.json')).land).toBe(true)
    expect(bodyOf(on)).toContain('`steward.config.json` sets `land` to `true`: unattended landing was chosen explicitly.')
    // An existing file's body says nothing of a land value it did not write.
    const existing = fakeGitHub()
    await runInit(['--yes'], { cwd: makeRepo({ files: { 'steward.config.json': '{"rulesFile":"REVIEW.md"}\n' } }), gh: existing })
    expect(bodyOf(existing)).not.toMatch(/sets `land`/)
  })
})

describe('ST-56/AC-9: the request allowlist, the source and the documents', () => {
  const API = `https://api.github.com/repos/${REPO}`
  const listUrl = (head = 'acme:steward/install') => `${API}/pulls?state=open&head=${encodeURIComponent(head)}&base=main&per_page=100`
  const create = { title: 't', body: 'b', head: 'steward/install', base: 'main', draft: true }

  it('ST-56/AC-9: it admits the installation\'s own list and create requests, and the requests the builders make', () => {
    expect(() => assertAllowedRequest(REPO, { method: 'GET', url: listUrl() })).not.toThrow()
    expect(() => assertAllowedRequest(REPO, { method: 'POST', url: `${API}/pulls`, body: create })).not.toThrow()
    expect(() => assertAllowedRequest(REPO, buildListOpenPulls(REPO, 'crew/install'))).not.toThrow()
    expect(() => assertAllowedRequest(REPO, buildCreatePull(REPO, { title: 'x', body: 'y', branch: 'crew/install' }))).not.toThrow()
  })

  it('ST-56/AC-9: it admits nothing broader: no other repository, owner, base, state, verb or field', () => {
    const refused = [
      { method: 'GET', url: `${API}/pulls` },
      { method: 'GET', url: `${API}/pulls/1` },
      { method: 'GET', url: listUrl('other:steward/install') },
      { method: 'GET', url: listUrl('acme:') },
      { method: 'GET', url: listUrl('steward/install') },
      { method: 'GET', url: `${API}/pulls?state=all&head=acme%3Ax&base=main&per_page=100` },
      { method: 'GET', url: `${API}/pulls?state=open&head=acme%3Ax&base=release%2Fv1&per_page=100` },
      { method: 'GET', url: `${API}/pulls?state=open&head=acme%3Ax&base=main&per_page=100&x=1` },
      { method: 'GET', url: `https://api.github.com/repos/acme/other/pulls?state=open&head=acme%3Ax&base=main&per_page=100` },
      { method: 'DELETE', url: listUrl() },
      { method: 'POST', url: `${API}/pulls`, body: { ...create, draft: false } },
      { method: 'POST', url: `${API}/pulls`, body: { ...create, base: 'release/v1' } },
      { method: 'POST', url: `${API}/pulls`, body: { ...create, head: 'someone:branch' } },
      { method: 'POST', url: `${API}/pulls`, body: { ...create, maintainer_can_modify: true } },
      { method: 'POST', url: `${API}/pulls`, body: { title: 't', body: 'b', head: 'x', base: 'main' } },
      { method: 'POST', url: `${API}/pulls`, body: { ...create, title: 5 } },
      { method: 'POST', url: `${API}/pulls`, body: null },
      { method: 'POST', url: `${API}/pulls` },
      { method: 'PATCH', url: `${API}/pulls/1`, body: { draft: false } },
      { method: 'PUT', url: `${API}/pulls/1/merge`, body: {} },
      { method: 'POST', url: `${API}/pulls/1/requested_reviewers`, body: {} },
      { method: 'POST', url: `${API}/issues/1/comments`, body: { body: 'x' } },
      { method: 'POST', url: `${API}/git/refs`, body: { ref: 'refs/heads/x', sha: 'a'.repeat(40) } },
      { method: 'DELETE', url: `${API}/git/refs/heads/steward/install` },
      { method: 'PUT', url: `${API}/branches/main/protection`, body: {} },
      { method: 'POST', url: `${API}/actions/workflows/land-approved.yml/dispatches`, body: { ref: 'main' } },
      { method: 'POST', url: 'https://api.github.com/graphql', body: { query: 'mutation {}' } },
    ]
    for (const request of refused) {
      expect(() => assertAllowedRequest(REPO, request), `${request.method} ${request.url}`).toThrow(/refusing a request outside the operations init performs/)
    }
  })

  it('ST-56/AC-9: the printed usage lists the new flags and says what init does', async () => {
    const { err } = await runInit(['--nope'], { cwd: makeRepo() })
    for (const flag of ['--branch <name>', '--pr-title <text>', '--pr-body-file <path>', '--pr-template <answer>']) expect(err).toContain(flag)
    expect(err).toMatch(/init commits its files on a new branch \(steward\/install, or --branch\), pushes it and opens a draft pull request against main; it changes nothing in your checkout\./)
    expect(err).toMatch(/--pr-template names the template to write the body from when the project has several/)
  })

  const codeOf = (file) =>
    readFileSync(path.join(ROOT, 'scripts/dispatch', file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  it('ST-56/AC-9: git is run only as argument arrays, with no shell, and never with a command that discards, rewrites or bypasses', () => {
    for (const file of ['init.mjs', 'init-install.mjs', 'init-pr-body.mjs']) {
      const code = codeOf(file)
      expect(code, file).not.toMatch(/(?<![.\w])exec(Sync|File|FileSync)?\(|\bspawn\(|shell\s*:\s*true/)
      expect(code, file).not.toMatch(/'(stash|reset|clean|checkout|switch|restore|rebase|merge|cherry-pick|am|apply|gc|prune|update-ref|symbolic-ref|branch|tag|filter-branch)'/)
      expect(code, file).not.toMatch(/'(--no-verify|--no-gpg-sign|-S|--gpg-sign|--author|--amend|--allow-empty|--signoff|--force|-f|-A|--hard)'/)
    }
    const install = codeOf('init-install.mjs')
    expect([...install.matchAll(/spawnSync\(([^,]+),/g)].map((m) => m[1])).toEqual(["'git'"])
    expect(install).toContain("['add', '--', ...rels]")
    expect(install).toContain('`--force-with-lease=refs/heads/${branch}:`')
    expect(install).toContain("'commit', '--quiet', '-m', message")
    expect(install).not.toMatch(/'add',\s*'(-A|\.)'/)
  })

  it('ST-56/AC-9: init\'s own source holds nothing about branch protection', () => {
    for (const file of ['init.mjs', 'init-install.mjs', 'init-pr-body.mjs']) {
      expect(codeOf(file), file).not.toMatch(/protection|--protect-main|protectMain|PROTECTION/i)
    }
  })

  it('ST-56/AC-9: README, the settings pages and the walkthrough describe the pull request, and no Planned marker for it remains in docs/', () => {
    const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
    expect(readme).not.toMatch(/Planned for 0\.1|ST-56/)
    expect(readme).toMatch(/opens a\s+\*\*draft pull request\*\* against `main`/)
    expect(readme).toMatch(/--pr-template <path>/)
    expect(readme).toMatch(/--pr-body-file <path>/)
    expect(readme).toMatch(/--branch <name>/)
    expect(readme).not.toMatch(/It commits, stages and pushes nothing/)
    expect(readme).not.toMatch(/Commit what it wrote, and open a pull request of the project's own/)
    const walkthrough = readFileSync(path.join(ROOT, 'docs/release-review.md'), 'utf8')
    expect(walkthrough).not.toMatch(/merge by hand the pull\s+request `init` leaves/)
    expect(walkthrough).toMatch(/`init` pushes a branch and opens the installation as a draft pull request/)
    expect(readFileSync(path.join(ROOT, 'docs/settings.md'), 'utf8')).toMatch(/draft pull request/)
    expect(readFileSync(path.join(ROOT, 'docs/user-config.md'), 'utf8')).toMatch(/Made by `steward init`/)
    const marked = []
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.md') && /Planned \([^)]*ST-56/.test(readFileSync(full, 'utf8'))) marked.push(full)
      }
    }
    walk(path.join(ROOT, 'docs'))
    expect(marked).toEqual([])
  })
})

describe('ST-56/AC-1a, AC-3 and AC-4 (review 1): paths as git spells them', () => {
  const config = (rulesFile) => `${JSON.stringify({ repo: REPO, setup: null, check: null, landWhen: 'all-checks', land: false, unitLinks: ['file'], rulesFile, inspectAfterHours: 6 })}\n`

  it('ST-56/AC-4: a rulesFile with a . segment is the checklist git reports: an existing one is found, left and reported', async () => {
    const cwd = makeRepo({ files: { 'steward.config.json': config('docs/./RULES.md'), 'docs/RULES.md': 'mine\n' } })
    const { code, out, err } = await runInit(['--yes'], { cwd })
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out).toContain('left docs/RULES.md: already there')
    expect(readOn(cwd, 'docs/RULES.md')).toBe('mine\n')
    expect(hasOn(cwd, 'docs/./RULES.md')).toBe(false)
  })

  it('ST-56/AC-1a: a local edit of that checklist is a conflict named by git\'s spelling', async () => {
    const cwd = makeRepo({ files: { 'steward.config.json': config('./docs/./RULES.md'), 'docs/RULES.md': 'mine\n' } })
    writeFileSync(path.join(cwd, 'docs/RULES.md'), 'edited\n')
    const { code, err } = await runInit(['--yes'], { cwd })
    expect(code).toBe(2)
    expect(err).toContain('  docs/RULES.md: ')
  })

  it.each([['./docs/./RULES.md'], ['docs/./RULES.md'], ['./REVIEW.md']])('ST-56/AC-3: --rules-file %s is written at git\'s spelling, in the settings and the checklist, and passes the diff check', async (flag) => {
    const cwd = makeRepo()
    const { code, err } = await runInit(['--yes', '--rules-file', flag], { cwd })
    expect(err).toBe('')
    expect(code).toBe(0)
    const canonical = flag.split('/').filter((s) => s !== '.').join('/')
    expect(JSON.parse(readOn(cwd, 'steward.config.json')).rulesFile).toBe(canonical)
    expect(hasOn(cwd, canonical)).toBe(true)
  })

  it('ST-56/AC-1a: a local file at that checklist is a conflict whatever the flag\'s spelling', async () => {
    const cwd = makeRepo()
    put(cwd, { 'docs/RULES.md': 'mine\n' })
    const { code, err } = await runInit(['--yes', '--rules-file', 'docs/./RULES.md'], { cwd })
    expect(code).toBe(2)
    expect(err).toContain('  docs/RULES.md: ')
  })

  it('ST-56/AC-4: a --rules-file equal to the settings\' rulesFile after canonicalizing is accepted, and a doubled slash or a bare . is refused', async () => {
    const cwd = makeRepo({ files: { 'steward.config.json': config('docs/./RULES.md') } })
    expect((await runInit(['--yes', '--rules-file', './docs/RULES.md'], { cwd })).code).toBe(0)
    for (const bad of ['docs//RULES.md', '.', './']) {
      const refused = await runInit(['--yes', '--rules-file', bad], { cwd: makeRepo() })
      expect(refused.code, bad).toBe(2)
    }
  })

  it('ST-56/AC-6: --pr-template is compared as git spells the path', async () => {
    const cwd = makeRepo({ files: { '.github/PULL_REQUEST_TEMPLATE/bug.md': 'Unit:\n<!-- bug -->\n', '.github/PULL_REQUEST_TEMPLATE/feature.md': 'Unit:\n<!-- feature -->\n' } })
    const gh = fakeGitHub()
    const { code } = await runInit(['--yes', '--pr-template', './.github/./PULL_REQUEST_TEMPLATE/feature.md'], { cwd, gh })
    expect(code).toBe(0)
    expect(bodyOf(gh)).toContain('<!-- feature -->')
  })
})

describe('ST-56/AC-1a (review 1): changes that git status does not show', () => {
  const refused = async (cwd) => {
    const gh = fakeGitHub()
    const { code, err } = await runInit(['--yes'], { cwd, gh })
    expect(code).toBe(2)
    expect(gh.requests).toEqual([])
    expect(existsSync(worktreeOf(cwd))).toBe(false)
    return err
  }

  it.each([
    ['assume-unchanged', 'no-assume-unchanged'],
    ['skip-worktree', 'no-skip-worktree'],
  ])('ST-56/AC-1a: a tracked relevant file marked %s is refused, naming the path, the flag and how to clear it, on a new installation', async (flag, clear) => {
    const cwd = makeRepo({ files: { 'REVIEW.md': 'v1\n' } })
    git(cwd, 'update-index', `--${flag}`, 'REVIEW.md')
    writeFileSync(path.join(cwd, 'REVIEW.md'), 'v2\n')
    expect(git(cwd, 'status', '--porcelain')).not.toMatch(/REVIEW\.md/)
    const before = callerState(cwd)
    const err = await refused(cwd)
    expect(err).toContain('  REVIEW.md: ')
    expect(err).toContain(`marked ${flag}`)
    expect(err).toContain(`git update-index --${clear} REVIEW.md`)
    expect(callerState(cwd)).toEqual(before)
  })

  it.each([['assume-unchanged'], ['skip-worktree']])('ST-56/AC-1a: the same on the path where nothing is missing (%s)', async (flag) => {
    const cwd = makeRepo()
    expect((await runInit(['--yes'], { cwd })).code).toBe(0)
    mergeInstall(cwd)
    git(cwd, 'update-index', `--${flag}`, 'steward.config.json')
    writeFileSync(path.join(cwd, 'steward.config.json'), '{"edited":true}\n')
    const err = await refused(cwd)
    expect(err).toContain('  steward.config.json: ')
    expect(err).toContain(`marked ${flag}`)
  })

  it('ST-56/AC-1a: a flag on a file the installation does not touch is not a conflict', async () => {
    const cwd = makeRepo({ files: BASE_FILES })
    git(cwd, 'update-index', '--assume-unchanged', 'src/tracked.txt')
    writeFileSync(path.join(cwd, 'src/tracked.txt'), 'hidden edit\n')
    expect((await runInit(['--yes'], { cwd })).code).toBe(0)
  })

  it('ST-56/AC-1a: the caller\'s git configuration cannot hide an edit: core.ignoreStat, an untracked-files setting of no, and info/exclude', async () => {
    const edited = makeRepo({ files: { 'REVIEW.md': 'v1\n' } })
    git(edited, 'config', 'core.ignoreStat', 'true')
    writeFileSync(path.join(edited, 'REVIEW.md'), 'v2 with a different length\n')
    expect(await refused(edited)).toContain('  REVIEW.md: ')

    const untracked = makeRepo()
    git(untracked, 'config', 'status.showUntrackedFiles', 'no')
    writeFileSync(path.join(untracked, 'steward.config.json'), '{}\n')
    expect(await refused(untracked)).toContain('  steward.config.json: ')

    const excluded = makeRepo()
    writeFileSync(path.join(excluded, '.git/info/exclude'), 'steward.config.json\n')
    writeFileSync(path.join(excluded, 'steward.config.json'), '{}\n')
    expect(await refused(excluded)).toMatch(/steward\.config\.json: an ignored file/)
  })
})

describe('ST-56/AC-7 (review 1): what exists is asked of git after a failure', () => {
  const attempt = async (hookName, script, runner) => {
    const cwd = makeRepo({ files: BASE_FILES })
    hook(cwd, hookName, script)
    const gh = fakeGitHub()
    const result = await runInit(['--yes'], { cwd, gh, git: runner })
    return { cwd, gh, err: result.err, code: result.code }
  }

  it('ST-56/AC-7: worktree add reported failed after Git created resources: both are reported', async () => {
    const runner = watchGit({ after: (args) => isGit(args, 'worktree', 'add') ? failing('failure after worktree creation') : undefined })
    const r = await attempt('post-checkout', 'exit 1', runner)
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/It stopped while creating the installation worktree\./)
    expect(r.err).not.toContain('Nothing had been created yet.')
    expect(r.err).toContain(`worktree ${worktreeOf(r.cwd)}`)
    expect(r.err).toContain('local branch steward/install at ')
    expect(existsSync(worktreeOf(r.cwd))).toBe(true)
    expect(writes(r.gh)).toEqual([])
  })

  it('ST-56/AC-7: a commit failure leaves the worktree and branch, and no commit, in the report', async () => {
    const runner = watchGit({ before: (args) => args[0] === 'commit' ? failing('message refused') : undefined })
    const r = await attempt('commit-msg', 'exit 1', runner)
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/It stopped while committing the installation\./)
    expect(r.err).toContain('message refused')
    expect(r.err).toContain(`worktree ${worktreeOf(r.cwd)}`)
    expect(r.err).toContain('local branch steward/install at ')
    expect(r.err).not.toMatch(/\n {2}commit [0-9a-f]{40}/)
  })

  it('ST-56/AC-5: a configured failing post-commit hook is bypassed and the run finishes', async () => {
    const r = await attempt('post-commit', 'echo "after the commit" >&2\nexit 1')
    expect(r.code).toBe(0)
    expect(pullWrites(r.gh)).toHaveLength(1)
  })

  it('ST-56/AC-7: a push failure reports the commit and worktree and how to inspect origin before recovery', async () => {
    const runner = watchGit({ before: (args) => args[0] === 'push' ? failing('push refused') : undefined })
    const r = await attempt('pre-push', 'exit 1', runner)
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/It stopped while pushing the branch to origin\./)
    expect(r.err).toContain('push refused')
    expect(r.err).toMatch(/\n {2}commit [0-9a-f]{40}/)
    expect(r.err).toContain(`worktree ${worktreeOf(r.cwd)}`)
    expect(r.err).not.toContain('on origin at')
    expect(r.err).toContain('git ls-remote --heads origin steward/install')
    expect(bareRef(r.cwd, 'refs/heads/steward/install')).toBe('')
    expect(writes(r.gh)).toEqual([])
  })

  it('ST-56/AC-7: a push that reaches origin but is reported as failed: the branch on origin is found by asking, at this run\'s commit', async () => {
    const runner = watchGit({ after: (args) => (args[0] === 'push' ? failing('connection lost after the push', 128) : undefined) })
    const r = await attempt('pre-commit', 'exit 0', runner)
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/It stopped while pushing the branch to origin\./)
    const commit = bareRef(r.cwd, 'refs/heads/steward/install')
    expect(commit).toMatch(/^[0-9a-f]{40}$/)
    expect(r.err).toContain(`branch steward/install on origin at ${commit}`)
    expect(r.err).not.toContain("not this run's commit")
  })

  it('ST-56/AC-7: a branch that origin has from someone else is reported as not this run\'s commit', async () => {
    const cwd = makeRepo()
    let racer = null
    const runner = watchGit({
      before: (args) => {
        if (args[0] === 'push') racer = pushToRemote(cwd, { 'race.txt': 'x\n' }, { branch: 'steward/install' })
        return undefined
      },
    })
    const { code, err } = await runInit(['--yes'], { cwd, git: runner })
    expect(code).toBe(1)
    expect(err).toContain(`branch steward/install on origin at ${racer} (not this run's commit`)
  })
})

describe('ST-56/AC-5 and AC-2 (review 2): what a push can add, and where it goes', () => {
  it('ST-56/AC-5: the push sends the branch only: push.followTags, a remote.origin.push refspec for tags and remote.origin.mirror add nothing', async () => {
    const cwd = makeRepo()
    git(cwd, 'tag', '-a', 'v1', '-m', 'release')
    git(cwd, 'config', 'push.followTags', 'true')
    git(cwd, 'config', '--add', 'remote.origin.push', 'refs/tags/*:refs/tags/*')
    git(cwd, 'config', 'remote.origin.mirror', 'true')
    const watched = watchGit()
    const { code, err } = await runInit(['--yes'], { cwd, git: watched })
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(git(remoteOf(cwd), 'tag', '--list')).toBe('')
    expect(git(remoteOf(cwd), 'for-each-ref', '--format=%(refname)').split('\n').sort()).toEqual(['refs/heads/main', 'refs/heads/steward/install'])
    const push = watched.calls.find((c) => c.args[0] === 'push').args
    expect(push).toContain('--no-follow-tags')
    expect(push).toContain('--no-signed')
    expect(push).toContain('--no-push-option')
    expect(push).toContain('--recurse-submodules=no')
    expect(push).not.toContain('origin')
  })

  const setups = {
    'a remote.origin.pushurl for another repository': (cwd) => git(cwd, 'config', 'remote.origin.pushurl', 'https://github.com/other/repo.git'),
    'two push URLs': (cwd) => {
      git(cwd, 'config', '--add', 'remote.origin.pushurl', 'https://github.com/acme/widgets.git')
      git(cwd, 'config', '--add', 'remote.origin.pushurl', 'git@github.com:acme/widgets.git')
    },
    'a url.<base>.pushInsteadOf rewrite': (cwd) => git(cwd, 'config', `url.${slashes(fresh('elsewhere'))}.pushInsteadOf`, GITHUB_URL),
  }
  it.each(Object.keys(setups))('ST-56/AC-2: %s is refused before anything is made, naming what to clear', async (name) => {
    const cwd = makeRepo()
    setups[name](cwd)
    const before = callerState(cwd)
    const watched = watchGit()
    const gh = fakeGitHub()
    const { code, err } = await runInit(['--yes'], { cwd, gh, git: watched })
    expect(code).toBe(2)
    expect(err).toMatch(/remote\.origin\.pushurl|pushinsteadof/)
    expect(err).toContain('ordinary checkout')
    expect(gh.requests).toEqual([])
    expect(watched.calls.some((c) => c.args[0] === 'fetch' || isGit(c.args, 'worktree', 'add'))).toBe(false)
    expect(callerState(cwd)).toEqual(before)
    expect(existsSync(worktreeOf(cwd))).toBe(false)
    expect(bareRef(cwd, 'refs/heads/steward/install')).toBe('')
  })

  it('ST-56/AC-1b: a pushurl naming even the same repository in another spelling is refused', async () => {
    const cwd = makeRepo()
    git(cwd, 'config', 'remote.origin.pushurl', 'git@github.com:acme/widgets.git')
    const watched = watchGit()
    const { code, err } = await runInit(['--yes'], { cwd, git: watched })
    expect(err).toContain('remote.origin.pushurl')
    expect(code).toBe(2)
    expect(bareRef(cwd, 'refs/heads/steward/install')).toBe('')
  })

  const rewrites = {
    'a url.<base>.insteadOf that rewrites origin to another GitHub repository': 'https://github.com/other/repo.git',
    'a url.<base>.insteadOf that rewrites origin to a URL that is not GitHub': 'https://gitlab.com/acme/widgets.git',
    'a url.<base>.insteadOf that rewrites origin to a local path': '/somewhere/else.git',
  }
  it.each(Object.keys(rewrites))('ST-56/AC-1: %s (fetch and push alike) is refused before anything is made, naming the URL', async (name) => {
    const cwd = makeRepo()
    git(cwd, 'config', `url.${rewrites[name]}.insteadOf`, GITHUB_URL)
    const before = callerState(cwd)
    const watched = watchGit()
    const gh = fakeGitHub()
    const { code, err } = await runInit(['--yes'], { cwd, gh, git: watched })
    expect(code).toBe(2)
    expect(err.toLowerCase()).toContain(rewrites[name].toLowerCase())
    expect(err).toMatch(/insteadof/)
    expect(gh.requests).toEqual([])
    expect(watched.calls.some((c) => c.args[0] === 'fetch' || isGit(c.args, 'worktree', 'add'))).toBe(false)
    expect(callerState(cwd)).toEqual(before)
    expect(existsSync(worktreeOf(cwd))).toBe(false)
    expect(bareRef(cwd, 'refs/heads/steward/install')).toBe('')
  })

  it('ST-56/AC-1: with no transport given, as in a real run, init goes to the URL git names: here GitHub, which the file transport refuses, so nothing is made', async () => {
    const cwd = makeRepo()
    const watched = watchGit()
    const gh = fakeGitHub()
    const { code, err } = await runInit(['--yes'], { cwd, gh, git: watched, transport: (url) => url })
    expect(code).toBe(1)
    expect(err).toMatch(/could not read origin/)
    const fetch = watched.calls.find((c) => c.args[0] === 'fetch')
    expect(fetch.args[3]).toBe(GITHUB_URL)
    expect(gh.requests).toEqual([])
    expect(existsSync(worktreeOf(cwd))).toBe(false)
  })

  it('ST-56/AC-1: the transport is an option of main, not of the command line or the environment', () => {
    const source = readFileSync(path.join(ROOT, 'scripts/dispatch/init.mjs'), 'utf8')
    expect(source).toContain('transport = (url) => url,')
    expect(source).toContain('process.exitCode = await main(process.argv.slice(2))')
    expect(source).not.toMatch(/process\.env[^\n]*transport|transport[^\n]*process\.env|'--transport'/)
  })

  it('ST-56/AC-2: main at the push destination must be the commit that was fetched: if it is not, init refuses before anything is made', async () => {
    const cwd = makeRepo()
    const watched = watchGit({
      before: (args) => {
        if (args[0] === 'ls-remote' && args.at(-1) === 'refs/heads/main') pushToRemote(cwd, { 'moved.txt': 'moved' })
        return undefined
      },
    })
    const gh = fakeGitHub()
    const { code, err } = await runInit(['--yes'], { cwd, gh, git: watched })
    expect(code).toBe(2)
    expect(err).toMatch(/the fetch and the push go to different places, or main moved just now; run init again/)
    expect(gh.requests).toEqual([])
    expect(watched.calls.some((c) => isGit(c.args, 'worktree', 'add'))).toBe(false)
  })

  it('ST-56/AC-2: the collision check and the push read and write the one destination, never "origin" by name', async () => {
    const cwd = makeRepo()
    const watched = watchGit()
    expect((await runInit(['--yes'], { cwd, git: watched })).code).toBe(0)
    const remoteReads = watched.calls.filter((c) => c.args[0] === 'ls-remote')
    expect(remoteReads.length).toBeGreaterThan(0)
    for (const call of remoteReads) {
      expect(call.args).not.toContain('origin')
      expect(path.resolve(call.args.at(-2))).toBe(path.resolve(remoteOf(cwd)))
    }
  })
})

describe('ST-56/AC-2 (review 2): the caller\'s repository environment', () => {
  it('ST-56/AC-1b: GIT_INDEX_FILE, GIT_DIR and GIT_WORK_TREE refuse and leave the index byte for byte unchanged', async () => {
    const cwd = makeRepo({ files: BASE_FILES })
    writeFileSync(path.join(cwd, 'src/staged.txt'), 's\n')
    git(cwd, 'add', 'src/staged.txt')
    const indexFile = path.join(cwd, '.git', 'index')
    const before = readFileSync(indexFile)
    const result = await runInit(['--yes'], { cwd, env: { GIT_INDEX_FILE: indexFile, GIT_DIR: path.join(cwd, '.git'), GIT_WORK_TREE: cwd } })
    expect(result.err).toContain('unsupported inherited Git environment')
    expect(result.code).toBe(2)
    expect(readFileSync(indexFile).equals(before)).toBe(true)
    expect(tryGit(cwd, 'rev-parse', '--verify', '--quiet', 'refs/heads/steward/install')).toBe('')
    expect(git(cwd, 'diff', '--cached', '--name-only')).toBe('src/staged.txt')
  })

  it('ST-56/AC-2: git runs without every repository-local variable, and keeps the caller\'s identity variables', () => {
    const env = gitEnvironment({ PATH: 'p', GIT_DIR: 'x', GIT_INDEX_FILE: 'y', GIT_WORK_TREE: 'z', GIT_OBJECT_DIRECTORY: 'o', GIT_ALTERNATE_OBJECT_DIRECTORIES: 'a', GIT_COMMON_DIR: 'c', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Eve', GIT_AUTHOR_NAME: 'Ann' })
    for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR']) expect(env[key], key).toBeUndefined()
    expect(env.GIT_AUTHOR_NAME).toBe('Ann')
    expect(env.PATH).toBe('p')
    expect(Object.entries(env).filter(([k]) => k.startsWith('GIT_CONFIG_VALUE_')).map(([, v]) => v)).not.toContain('Eve')
  })

  it('ST-56/AC-2: core.worktree in the configuration is refused before anything is made', async () => {
    const cwd = makeRepo()
    git(cwd, 'config', 'core.worktree', cwd)
    const gh = fakeGitHub()
    const { code, err } = await runInit(['--yes'], { cwd, gh })
    expect(code).toBe(2)
    expect(err).toMatch(/core\.worktree is set/)
    expect(gh.requests).toEqual([])
    expect(existsSync(worktreeOf(cwd))).toBe(false)
  })
})

describe('ST-56/AC-5 (review 2): who commits and which hooks run in the new worktree', () => {
  it.each([
    ['user.name', ['user.name', 'Someone Else']],
    ['user.email', ['user.email', 'else@example.com']],
    ['core.hooksPath', ['core.hooksPath', 'elsewhere-hooks']],
    ['commit.gpgSign', ['commit.gpgSign', 'false']],
    ['user.signingKey', ['user.signingKey', 'ABCDEF']],
  ])('ST-56/AC-5: %s in the checkout\'s own worktree configuration is refused before anything is made', async (_key, [name, value]) => {
    const cwd = makeRepo()
    git(cwd, 'config', 'extensions.worktreeConfig', 'true')
    git(cwd, 'config', '--worktree', name, value)
    const gh = fakeGitHub()
    const { code, err } = await runInit(['--yes'], { cwd, gh })
    expect(code).toBe(2)
    expect(err).toContain('config.worktree')
    expect(err.toLowerCase()).toContain('extensions.worktreeconfig')
    expect(err).toContain('ordinary checkout')
    expect(gh.requests).toEqual([])
    expect(existsSync(worktreeOf(cwd))).toBe(false)
    expect(bareRef(cwd, 'refs/heads/steward/install')).toBe('')
  })

  it('ST-56/AC-1b: enabled per-worktree config refuses even a harmless setting', async () => {
    const cwd = makeRepo()
    git(cwd, 'config', 'extensions.worktreeConfig', 'true')
    git(cwd, 'config', '--worktree', 'core.abbrev', '12')
    expect((await runInit(['--yes'], { cwd })).code).toBe(2)
  })

  it('ST-56/AC-5: a new worktree that would commit with another effective setting is refused before the commit, whatever made it differ', async () => {
    // A per-worktree setting that appears only in the new worktree.
    const cwd = makeRepo()
    const watched = watchGit({
      after: (args, _where, real) => {
        if (isGit(args, 'worktree', 'add') && real.status === 0) {
          git(args[5], 'config', 'extensions.worktreeConfig', 'true')
          git(args[5], 'config', '--worktree', 'user.email', 'other@example.com')
        }
        return undefined
      },
    })
    const gh = fakeGitHub()
    const { code, err } = await runInit(['--yes'], { cwd, gh, git: watched })
    expect(code).toBe(1)
    expect(err).toContain('extensions.worktreeconfig')
    expect(err).toContain(`worktree ${worktreeOf(cwd)}`)
    expect(watched.calls.some((c) => c.args[0] === 'commit')).toBe(false)
    expect(writes(gh)).toEqual([])

    // An includeIf on the branch name gives the installation branch another identity.
    const other = makeRepo()
    const included = path.join(fresh('include'), 'identity.gitconfig')
    writeFileSync(included, '[user]\n\tname = Branch Person\n')
    git(other, 'config', 'includeIf.onbranch:steward/**.path', slashes(included))
    const watchedOther = watchGit()
    const result = await runInit(['--yes'], { cwd: other, git: watchedOther })
    expect(result.code).toBe(2)
    expect(result.err).toContain('includeif.')
    expect(watchedOther.calls.some((c) => c.args[0] === 'fetch' || isGit(c.args, 'worktree', 'add'))).toBe(false)
    expect(watchedOther.calls.some((c) => c.args[0] === 'commit')).toBe(false)
  })

  it('ST-56/AC-1b: inherited identity variables refuse before commit', async () => {
    const cwd = makeRepo()
    const result = await runInit(['--yes'], { cwd, env: { GIT_AUTHOR_NAME: 'Env Author', GIT_AUTHOR_EMAIL: 'author@example.com', GIT_COMMITTER_NAME: 'Env Committer', GIT_COMMITTER_EMAIL: 'committer@example.com' } })
    expect(result.code).toBe(2)
    expect(result.err).toContain('GIT_AUTHOR_NAME')
    expect(tryGit(cwd, 'rev-parse', '--verify', '--quiet', 'refs/heads/steward/install')).toBe('')
  })
})

describe('ST-56/AC-7 (review 2): the user config file', () => {
  it('ST-56/AC-7: a write that fails and leaves a file is reported with its path, that a file is there, and what to do; the pull request and labels are reported too', async () => {
    const home = fresh('home')
    const machine = path.join(home, 'sub', 'config.json')
    const gh = fakeGitHub()
    const { code, err } = await runInit(['--yes'], {
      cwd: makeRepo(),
      gh,
      machine,
      writeUserConfig: async (file) => {
        writeFileSync(file, '{ "usageLim')
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      },
    })
    expect(code).toBe(1)
    expect(err).toMatch(/It stopped while writing the user config\./)
    expect(err).toContain(`user config ${machine}: the write failed, and a file IS there now; inspect it or remove it before running init again`)
    expect(err).toMatch(/folder .*home-\d+.sub\n/)
    expect(err).toContain('draft pull request ')
    expect(err).toContain('  label review-blocked')
    expect(readFileSync(machine, 'utf8')).toBe('{ "usageLim')
  })

  it('ST-56/AC-7: a write that fails and leaves nothing says no file is there', async () => {
    const machine = path.join(fresh('home'), 'config.json')
    const { code, err } = await runInit(['--yes'], {
      cwd: makeRepo(),
      machine,
      writeUserConfig: async () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      },
    })
    expect(code).toBe(1)
    expect(err).toContain(`user config ${machine}: the write failed, and no file is there now`)
  })

  it('ST-56/AC-7: the real writer is create-only and whole: it leaves no temporary file, and an existing file is kept', async () => {
    const dir = fresh('whole')
    const file = path.join(dir, 'config.json')
    await writeWhole(file, '{"a":1}\n')
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}\n')
    await expect(writeWhole(file, 'other')).rejects.toMatchObject({ code: 'EEXIST' })
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}\n')
    expect(readdirSync(dir)).toEqual(['config.json'])
    // A failure before the link leaves nothing under the final name.
    const blocked = path.join(dir, 'no-such-folder', 'config.json')
    await expect(writeWhole(blocked, 'x')).rejects.toThrow()
    expect(existsSync(blocked)).toBe(false)
    expect(readdirSync(dir)).toEqual(['config.json'])
  })
})
