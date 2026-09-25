// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { coderAllowedTools } from './coder-env.mjs'
import { branchFor, dispatchCoder, findPromptChange, pushArgs } from './coder.mjs'
import { createContext } from './github.mjs'

// Each test builds a real origin and clones and runs a dozen git commands.
vi.setConfig({ testTimeout: 60_000 })

const here = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(path.join(here, 'coder.mjs'), 'utf8')
const TEMPLATE = readFileSync(path.join(here, '..', '..', '.claude', 'prompts', 'coder.md'), 'utf8')
const REPO = 'luplows/tower-workshop-paths'

const story = (id, { deps = '', blocked = 'null' } = {}) => `---
id: ${id}
title: A story
tier: next
kind: workflow
depends_on: [${deps}]
model: sonnet
blocked: ${blocked}
---

## Intent

Do the thing.

## Acceptance criteria

- [ ] **AC-1** — done.

## Open questions

*(none)*
`

// ---------------------------------------------------------------- fixtures

const git = (cwd, ...args) => execFileSync(
  'git',
  ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8' },
).trim()

const gitOk = (cwd, ...args) => {
  try {
    return git(cwd, ...args)
  } catch {
    return null
  }
}

let root
let count = 0
afterAll(() => rmSync(root, { recursive: true, force: true }))
beforeAll(() => { root = realpathSync(mkdtempSync(path.join(tmpdir(), 'tw-coder-test-'))) })

/**
 * A bare origin holding OQ-96 (waiting on an unfinished OQ-95), OQ-98 and OQ-99
 * (both ready), and a dispatcher checkout cloned from it. Each test gets its own.
 */
function makeWorld() {
  const dir = path.join(root, `world-${count++}`)
  const origin = path.join(dir, 'origin.git')
  const seed = path.join(dir, 'seed')
  const repoDir = path.join(dir, 'dispatcher')
  mkdirSync(dir)
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin)
  git(dir, 'clone', '-q', origin, seed)
  git(seed, 'checkout', '-q', '-b', 'main')
  mkdirSync(path.join(seed, 'stories'))
  writeFileSync(path.join(seed, 'stories', 'OQ-96-waits.md'), story('OQ-96', { deps: 'OQ-95' }))
  writeFileSync(path.join(seed, 'stories', 'OQ-98-first.md'), story('OQ-98'))
  writeFileSync(path.join(seed, 'stories', 'OQ-99-second.md'), story('OQ-99'))
  git(seed, 'add', '.')
  git(seed, 'commit', '-q', '-m', 'base')
  git(seed, 'push', '-q', 'origin', 'main')
  git(dir, 'clone', '-q', origin, repoDir)
  return { dir, origin, seed, repoDir }
}

const envelope = (result, overrides = {}) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result, ...overrides,
})

const block = (title = 'Do the thing', open = 'ready', body = '### What changed\n\nIt did.') =>
  `Branch pushed.\n\n## PR title\n${title}\n\n## PR body\n${body}\n\n## Open as\n${open}`

/**
 * A fake `runSession`: `behave({ cwd, args, env, prompt })` plays the coder in
 * its worktree and returns the text of the final report. `pushes` is called with
 * the worktree to do what a coder does; the default finishes the story.
 */
function fakeRun(behave) {
  const calls = []
  const run = async (options) => {
    calls.push(options)
    const out = await behave(options)
    // A behaviour returns report text, or a whole envelope to control it.
    const stdout = out.startsWith('{') ? out : envelope(out)
    return { record: { role: 'coder', exitCode: 0, signal: null, stdout, stoppedFor: null }, pid: 1 }
  }
  return { run, calls }
}

/** What a coder that finishes does: move the story and commit. It does not push (OQ-84). */
function finishStory(cwd, { file = 'OQ-98-first.md', frontmatter = (s) => s } = {}) {
  const branch = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
  const dest = path.join(cwd, 'stories', 'done', file)
  mkdirSync(path.dirname(dest), { recursive: true })
  git(cwd, 'mv', `stories/${file}`, `stories/done/${file}`)
  writeFileSync(dest, frontmatter(readFileSync(dest, 'utf8')).replace('- [ ]', '- [x]'))
  writeFileSync(path.join(cwd, 'work.txt'), 'work')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-q', '-m', 'implement')
  return branch
}

// A fake GitHub that records every request and answers a pull-request create.
function fakeGitHub() {
  const requests = []
  const fetch = async (url, init) => {
    requests.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined })
    return { ok: true, json: async () => ({ number: 7, html_url: 'https://example.test/pull/7', head: { sha: 'a'.repeat(40) } }) }
  }
  return { requests, ctx: createContext({ repo: REPO, fetch, getToken: async () => 'tok' }) }
}

async function dispatch(world, behave, extra = {}) {
  const gh = fakeGitHub()
  const fake = fakeRun(behave)
  const result = await dispatchCoder({
    ctx: gh.ctx,
    repoDir: world.repoDir,
    promptTemplate: TEMPLATE,
    baseEnv: { PATH: '/bin', GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret', GH_ENTERPRISE_TOKEN: 'secret' },
    sessionOptions: { executable: 'fake-claude', run: fake.run },
    // The fixture worktree has no package.json, so the real `npm ci` is replaced.
    install: async () => {},
    ...extra,
  })
  return { result, gh, fake }
}

const worktrees = (repoDir) => git(repoDir, 'worktree', 'list', '--porcelain')
  .split('\n').filter((l) => l.startsWith('worktree ')).map((l) => path.resolve(l.slice(9)))
const remoteBranch = (world, branch) => gitOk(world.dir, '--git-dir', world.origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)
const pulls = (gh) => gh.requests.filter((r) => r.method === 'POST')

// ------------------------------------------------------------------- tests

describe('branchFor', () => {
  it('derives story/<filename without .md>', () => {
    expect(branchFor('OQ-70-coder-dispatch.md')).toBe('story/OQ-70-coder-dispatch')
  })
})

describe('OQ-70/AC-1: next story to an open pull request', () => {
  it('OQ-70/AC-1: takes the head of the queue, spawns the coder in a worktree and opens the PR from its block', async () => {
    const world = makeWorld()
    const { result, gh, fake } = await dispatch(world, ({ cwd }) => {
      finishStory(cwd)
      return block('Ship OQ-98', 'ready', '### What changed\n\nShipped.')
    })

    expect(result.status).toBe('opened')
    expect(result.storyId).toBe('OQ-98') // not OQ-96 (waiting), not OQ-99 (later)
    expect(result.branch).toBe('story/OQ-98-first')
    expect(result.pr).toEqual({ number: 7, url: 'https://example.test/pull/7', headSha: 'a'.repeat(40) })

    expect(fake.calls).toHaveLength(1)
    const [call] = fake.calls
    expect(call.role).toBe('coder')
    expect(call.cwd).not.toBe(world.repoDir)
    expect(call.prompt).toContain('OQ-98')
    expect(call.prompt).toContain('stories/OQ-98-first.md')

    expect(pulls(gh)).toEqual([{
      method: 'POST',
      url: `https://api.github.com/repos/${REPO}/pulls`,
      body: { title: 'Ship OQ-98', body: '### What changed\n\nShipped.', head: 'story/OQ-98-first', base: 'main', draft: false },
    }])
  })

  it('OQ-70/AC-1: an explicit story id picks that story only if it is ready', async () => {
    const world = makeWorld()
    const { result } = await dispatch(world, ({ cwd }) => {
      finishStory(cwd, { file: 'OQ-99-second.md' })
      return block()
    }, { storyId: 'OQ-99' })
    expect(result.status).toBe('opened')
    expect(result.branch).toBe('story/OQ-99-second')

    const waiting = await dispatch(makeWorld(), () => { throw new Error('must not spawn') }, { storyId: 'OQ-96' })
    expect(waiting.result.status).toBe('not-ready')
    expect(waiting.fake.calls).toHaveLength(0)
  })

  it('OQ-70/AC-1: reports nothing-ready when no story is dispatchable', async () => {
    const world = makeWorld()
    for (const f of ['OQ-98-first.md', 'OQ-99-second.md']) {
      git(world.seed, 'rm', '-q', `stories/${f}`)
    }
    git(world.seed, 'commit', '-q', '-m', 'drop')
    git(world.seed, 'push', '-q', 'origin', 'main')
    git(world.repoDir, 'pull', '-q')
    const { result, fake } = await dispatch(world, () => { throw new Error('must not spawn') })
    expect(result.status).toBe('nothing-ready')
    expect(fake.calls).toHaveLength(0)
  })
})

describe('OQ-70/AC-2: branch from current origin/main, no upstream', () => {
  it('OQ-70/AC-2: the branch is made from origin/main as it is now and tracks nothing', async () => {
    const world = makeWorld()
    // origin/main moves after the dispatcher's checkout was made.
    writeFileSync(path.join(world.seed, 'later.txt'), 'later')
    git(world.seed, 'add', '.')
    git(world.seed, 'commit', '-q', '-m', 'main moves')
    git(world.seed, 'push', '-q', 'origin', 'main')
    const newMain = git(world.seed, 'rev-parse', 'HEAD')

    let seen
    await dispatch(world, ({ cwd }) => {
      const branch = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
      seen = {
        branch,
        head: git(cwd, 'rev-parse', 'HEAD'),
        remote: gitOk(cwd, 'config', '--get', `branch.${branch}.remote`),
        merge: gitOk(cwd, 'config', '--get', `branch.${branch}.merge`),
        upstream: gitOk(cwd, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'),
      }
      finishStory(cwd)
      return block()
    })

    expect(seen.branch).toBe('story/OQ-98-first')
    expect(seen.head).toBe(newMain)
    expect(seen.remote).toBeNull()
    expect(seen.merge).toBeNull()
    expect(seen.upstream).toBeNull()
  })
})

describe('OQ-70/AC-3: the coder\'s environment and allowlist', () => {
  it('OQ-70/AC-3: no credential variable survives, and the allowlist is coderAllowedTools(branch)', async () => {
    const world = makeWorld()
    const { fake } = await dispatch(world, ({ cwd }) => { finishStory(cwd); return block() })
    const [{ env, args }] = fake.calls

    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN']) expect(env).not.toHaveProperty(key)
    expect(Object.values(env)).not.toContain('secret')
    expect(env.PATH).toBe('/bin')
    expect(env.GH_CONFIG_DIR).toBeTruthy()

    const at = args.indexOf('--allowedTools')
    const allowed = args.slice(at + 1, args.indexOf('--disallowedTools'))
    expect(allowed).toEqual(coderAllowedTools('story/OQ-98-first'))
  })
})

describe('OQ-70/AC-4: no commit, no pull request', () => {
  it('OQ-70/AC-4: a session that reports success having committed nothing gets no PR', async () => {
    const world = makeWorld()
    const { result, gh } = await dispatch(world, () => block()) // a complete, correct block; no commit
    expect(result.status).toBe('nothing-committed')
    expect(pulls(gh)).toHaveLength(0)
    expect(remoteBranch(world, 'story/OQ-98-first')).toBeNull()
  })

  it('OQ-70/AC-4, OQ-84/AC-3: a session that reports failure gets no push and no PR, and its commits stay on the local branch', async () => {
    const world = makeWorld()
    const { result, gh } = await dispatch(world, ({ cwd }) => {
      finishStory(cwd)
      return envelope(block(), { is_error: true })
    })
    expect(result.status).toBe('session-failed')
    expect(result.pushed).toBe(false)
    expect(pulls(gh)).toHaveLength(0)
    expect(remoteBranch(world, 'story/OQ-98-first')).toBeNull()
    expect(gitOk(world.repoDir, 'rev-parse', '--verify', '--quiet', 'refs/heads/story/OQ-98-first')).toBeTruthy()
  })
})

describe('OQ-84/AC-1: the dispatcher pushes the branch, never forced', () => {
  it('OQ-84/AC-1: a completed session with a commit is pushed by the dispatcher, then the PR opens', async () => {
    const world = makeWorld()
    const tips = []
    const { result, gh } = await dispatch(world, ({ cwd }) => {
      finishStory(cwd)
      tips.push(git(cwd, 'rev-parse', 'HEAD'))
      // The coder did not push: the remote has nothing until the session is over.
      expect(remoteBranch(world, 'story/OQ-98-first')).toBeNull()
      return block()
    })
    expect(result.status).toBe('opened')
    expect(remoteBranch(world, 'story/OQ-98-first')).toBe(tips[0])
    expect(result.headSha).toBe(tips[0])
    expect(pulls(gh)).toHaveLength(1)
  })

  it('OQ-84/AC-1: the push is exactly `git push origin <branch>`, and no forced form can be constructed', () => {
    expect(pushArgs('story/OQ-84-dispatcher-pushes')).toEqual(['push', 'origin', 'story/OQ-84-dispatcher-pushes'])
    for (const bad of [
      '+story/OQ-84-x', '-f', '--force', '-f story/x', 'story/x:story/x', 'HEAD:story/x', '+refs/heads/story/x',
      'main', 'refs/heads/main', '', undefined, 'story/x --force', 'story/../x',
    ]) {
      expect(() => pushArgs(bad), String(bad)).toThrow()
    }
    // The only `git` call that names `push` is the one built by pushArgs (the
    // `--force` in the worktree removal is not a push).
    expect(SOURCE.match(/'push'/g)).toHaveLength(1)
    expect(SOURCE).not.toMatch(/force-with-lease/)
  })
})

describe('OQ-84/AC-3: what the session left decides the status', () => {
  const remoteEmpty = (world) => expect(remoteBranch(world, 'story/OQ-98-first')).toBeNull()
  const localKept = (world) => expect(gitOk(world.repoDir, 'rev-parse', '--verify', '--quiet', 'refs/heads/story/OQ-98-first')).toBeTruthy()

  it('OQ-84/AC-3: completed with no commit beyond the base is nothing-committed, and nothing is pushed', async () => {
    const world = makeWorld()
    const { result, gh } = await dispatch(world, () => block())
    expect(result.status).toBe('nothing-committed')
    expect(result.paths).toEqual([])
    expect(pulls(gh)).toHaveLength(0)
    remoteEmpty(world)
  })

  it('OQ-84/AC-3: no commit wins over uncommitted changes, and the uncommitted paths are still listed', async () => {
    const world = makeWorld()
    const { result, gh } = await dispatch(world, ({ cwd }) => {
      writeFileSync(path.join(cwd, 'work.txt'), 'edited, never committed') // tracked, modified
      writeFileSync(path.join(cwd, 'stray.txt'), 'never added') // untracked
      return block()
    })
    expect(result.status).toBe('nothing-committed')
    expect(result.paths.sort()).toEqual(['stray.txt', 'work.txt'])
    expect(result.reason).toContain('stray.txt')
    expect(pulls(gh)).toHaveLength(0)
    remoteEmpty(world)
  })

  it('OQ-84/AC-3: an uncommitted change is uncommitted-changes, listing the paths; the dispatcher does not commit for the coder', async () => {
    const world = makeWorld()
    let tip
    const { result, gh } = await dispatch(world, ({ cwd }) => {
      finishStory(cwd)
      tip = git(cwd, 'rev-parse', 'HEAD')
      writeFileSync(path.join(cwd, 'work.txt'), 'edited after the commit') // tracked, modified
      writeFileSync(path.join(cwd, 'stray.txt'), 'never added') // untracked
      return block()
    })
    expect(result.status).toBe('uncommitted-changes')
    expect(result.paths.sort()).toEqual(['stray.txt', 'work.txt'])
    expect(pulls(gh)).toHaveLength(0)
    remoteEmpty(world)
    // Kept locally, at the coder's own commit: nothing was committed for it.
    localKept(world)
    expect(git(world.repoDir, 'rev-parse', 'refs/heads/story/OQ-98-first')).toBe(tip)
  })

  it('OQ-84/AC-3: a new screenshot baseline left untracked still pushes, and is listed, never pushed', async () => {
    const world = makeWorld()
    const { result } = await dispatch(world, ({ cwd }) => {
      finishStory(cwd)
      mkdirSync(path.join(cwd, 'e2e', '__screenshots__', 'flow.spec.ts'), { recursive: true })
      writeFileSync(path.join(cwd, 'e2e', '__screenshots__', 'flow.spec.ts', 'new-baseline.png'), 'png')
      return block()
    })
    expect(result.status).toBe('opened')
    expect(result.untrackedScreenshots).toEqual(['e2e/__screenshots__/flow.spec.ts/new-baseline.png'])
    expect(git(world.dir, '--git-dir', world.origin, 'ls-tree', '-r', '--name-only', 'story/OQ-98-first')).not.toContain('__screenshots__')
  })

  it('OQ-84/AC-3: any other untracked file stops the push, even beside a baseline', async () => {
    const world = makeWorld()
    const { result, gh } = await dispatch(world, ({ cwd }) => {
      finishStory(cwd)
      mkdirSync(path.join(cwd, 'e2e', '__screenshots__'), { recursive: true })
      writeFileSync(path.join(cwd, 'e2e', '__screenshots__', 'new-baseline.png'), 'png')
      writeFileSync(path.join(cwd, 'notes.txt'), 'forgotten')
      return block()
    })
    expect(result.status).toBe('uncommitted-changes')
    expect(result.paths).toEqual(['notes.txt'])
    expect(result.screenshots).toEqual(['e2e/__screenshots__/new-baseline.png'])
    expect(pulls(gh)).toHaveLength(0)
    remoteEmpty(world)
  })

  it('OQ-84/AC-3: a tracked change under e2e/__screenshots__/ is not excepted', async () => {
    const world = makeWorld()
    const { result } = await dispatch(world, ({ cwd }) => {
      mkdirSync(path.join(cwd, 'e2e', '__screenshots__'), { recursive: true })
      writeFileSync(path.join(cwd, 'e2e', '__screenshots__', 'old.png'), 'v1')
      finishStory(cwd)
      writeFileSync(path.join(cwd, 'e2e', '__screenshots__', 'old.png'), 'v2')
      return block()
    })
    expect(result.status).toBe('uncommitted-changes')
    expect(result.paths).toEqual(['e2e/__screenshots__/old.png'])
  })

  it('OQ-84/AC-3: a rejected push is push-failed with git\'s error, the PR is not opened and the commits are kept', async () => {
    const world = makeWorld()
    // A pre-receive hook on the origin refuses every push.
    const hook = path.join(world.origin, 'hooks', 'pre-receive')
    writeFileSync(hook, '#!/bin/sh\necho "refused by test hook" >&2\nexit 1\n', { mode: 0o755 })
    const { result, gh } = await dispatch(world, ({ cwd }) => { finishStory(cwd); return block() })
    expect(result.status).toBe('push-failed')
    expect(result.reason).toContain('refused by test hook')
    expect(pulls(gh)).toHaveLength(0)
    remoteEmpty(world)
    localKept(world)
  })

  it('OQ-84/AC-3: a session that did not complete is not pushed', async () => {
    const world = makeWorld()
    const { result } = await dispatch(world, ({ cwd }) => { finishStory(cwd); return envelope('x', { is_error: true }) })
    expect(result.status).toBe('session-failed')
    remoteEmpty(world)
  })
})

describe('OQ-84/AC-5: every result after a session carries its output', () => {
  const full = (result) => envelope(result, {
    total_cost_usd: 1.25,
    num_turns: 9,
    permission_denials: [
      { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'git push origin HEAD' } },
      { tool_name: 'Write', tool_use_id: 't2', tool_input: { file_path: '.claude/prompts/coder.md' } },
    ],
  })
  const expectSession = (result, outcome, report) => {
    expect(result.session).toEqual({
      outcome,
      report,
      costUsd: 1.25,
      turns: 9,
      refused: [
        { tool: 'Bash', command: 'git push origin HEAD' },
        { tool: 'Write', command: JSON.stringify({ file_path: '.claude/prompts/coder.md' }) },
      ],
    })
  }

  it('OQ-84/AC-5: opened', async () => {
    const report = block()
    const { result } = await dispatch(makeWorld(), ({ cwd }) => { finishStory(cwd); return full(report) })
    expect(result.status).toBe('opened')
    expectSession(result, 'completed', report)
  })

  it('OQ-84/AC-5: nothing-committed', async () => {
    const { result } = await dispatch(makeWorld(), () => full('did nothing'))
    expect(result.status).toBe('nothing-committed')
    expectSession(result, 'completed', 'did nothing')
  })

  it('OQ-84/AC-5: uncommitted-changes', async () => {
    const { result } = await dispatch(makeWorld(), ({ cwd }) => {
      finishStory(cwd)
      writeFileSync(path.join(cwd, 'stray.txt'), 'x')
      return full('left a file')
    })
    expect(result.status).toBe('uncommitted-changes')
    expectSession(result, 'completed', 'left a file')
  })

  it('OQ-84/AC-5: push-failed', async () => {
    const world = makeWorld()
    writeFileSync(path.join(world.origin, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const { result } = await dispatch(world, ({ cwd }) => { finishStory(cwd); return full('committed') })
    expect(result.status).toBe('push-failed')
    expectSession(result, 'completed', 'committed')
  })

  it('OQ-84/AC-5: session-failed', async () => {
    const { result } = await dispatch(makeWorld(), () => full('x').replace('"is_error":false', '"is_error":true'))
    expect(result.status).toBe('session-failed')
    expectSession(result, result.session.outcome, 'x')
    expect(result.session.outcome).not.toBe('completed')
  })

  it('OQ-84/AC-5: an invalid PR block', async () => {
    const { result } = await dispatch(makeWorld(), ({ cwd }) => { finishStory(cwd); return full('no block here') })
    expect(result.status).toBe('pr-block-invalid')
    expectSession(result, 'completed', 'no block here')
  })

  it('OQ-84/AC-5: the CLI prints the result as JSON, so the session is printed with it', () => {
    expect(SOURCE).toMatch(/console\.log\(JSON\.stringify\(result, null, 2\)\)/)
  })
})

describe('OQ-70/AC-5: a missing or malformed PR block', () => {
  const cases = {
    'no block at all': 'All done, branch pushed.',
    'no body heading': 'Done.\n\n## PR title\nT\n\n## Open as\nready',
    'trailing text after the flag': `${block()}\n\nhead abc123`,
  }
  for (const [name, report] of Object.entries(cases)) {
    it(`OQ-70/AC-5: ${name} is a classified failure, leaving the branch and no PR`, async () => {
      const world = makeWorld()
      const { result, gh } = await dispatch(world, ({ cwd }) => { finishStory(cwd); return report })
      expect(result.status).toBe('pr-block-invalid')
      expect(result.reason).toBeTruthy()
      expect(pulls(gh)).toHaveLength(0)
      expect(remoteBranch(world, 'story/OQ-98-first')).toBeTruthy()
    })
  }
})

describe('OQ-70/AC-6: the draft or ready flag is honoured', () => {
  it('OQ-70/AC-6: ready opens a non-draft PR and draft opens a draft, exactly as emitted', async () => {
    const ready = await dispatch(makeWorld(), ({ cwd }) => { finishStory(cwd); return block('T', 'ready') })
    expect(pulls(ready.gh)[0].body.draft).toBe(false)
    expect(ready.result.draft).toBe(false)

    const draft = await dispatch(makeWorld(), ({ cwd }) => { finishStory(cwd); return block('T', 'draft') })
    expect(pulls(draft.gh)[0].body.draft).toBe(true)
    expect(draft.result.draft).toBe(true)
  })

  it('OQ-70/AC-6: an absent flag opens nothing rather than defaulting either way', async () => {
    const world = makeWorld()
    const { result, gh } = await dispatch(world, ({ cwd }) => {
      finishStory(cwd)
      return 'Done.\n\n## PR title\nT\n\n## PR body\nB'
    })
    expect(result.status).toBe('pr-block-invalid')
    expect(pulls(gh)).toHaveLength(0)
  })
})

describe('OQ-70/AC-7: no commit status', () => {
  it('OQ-70/AC-7: the only request that writes is the pull-request create', async () => {
    const world = makeWorld()
    const { gh } = await dispatch(world, ({ cwd }) => { finishStory(cwd); return block() })
    expect(gh.requests.map((r) => `${r.method} ${r.url}`)).toEqual([`POST https://api.github.com/repos/${REPO}/pulls`])
    expect(gh.requests.some((r) => /status/i.test(r.url))).toBe(false)
  })

  it('OQ-70/AC-7: the module imports only pull-request creation from github.mjs', () => {
    const imported = SOURCE.match(/import \{([^}]*)\} from '\.\/github\.mjs'/)[1].split(',').map((s) => s.trim())
    expect(imported).toEqual(['createContext', 'createPullRequest'])
  })
})

describe('OQ-70/AC-7b: a prompt diff is reported, not applied', () => {
  const promptBody = [
    '### What changed', '', 'Everything.', '',
    '### Proposed prompt edit', '',
    '```diff',
    'diff --git a/.claude/prompts/coder.md b/.claude/prompts/coder.md',
    '--- a/.claude/prompts/coder.md',
    '+++ b/.claude/prompts/coder.md',
    '@@ -1 +1 @@', '-old', '+new',
    '```',
  ].join('\n')

  it('OQ-70/AC-7b: the run finishes, the PR opens, and the result names the pending prompt change', async () => {
    const world = makeWorld()
    const before = git(world.repoDir, 'status', '--porcelain')
    const { result, gh } = await dispatch(world, ({ cwd }) => { finishStory(cwd); return block('T', 'ready', promptBody) })

    expect(result.status).toBe('opened')
    expect(result.promptChange).toEqual({ pending: true, files: ['.claude/prompts/coder.md'] })
    expect(pulls(gh)[0].body.body).toBe(promptBody) // the coder's text, untouched

    // Nothing was written to the dispatcher's checkout, `.claude/` included.
    expect(git(world.repoDir, 'status', '--porcelain')).toBe(before)
    expect(existsSync(path.join(world.repoDir, '.claude'))).toBe(false)
    expect(git(world.origin, 'log', '--all', '--format=%H', '--', '.claude')).toBe('')
  })

  it('OQ-70/AC-7b: a body with no prompt edit reports none', () => {
    expect(findPromptChange('### What changed\n\nNothing about prompts.')).toBeNull()
  })

  it('OQ-70/AC-7b: no code path in the module writes to .claude/ or invokes git apply', () => {
    expect(SOURCE).not.toMatch(/['"`]apply['"`]/)
    expect(SOURCE).not.toMatch(/\b(writeFile|writeFileSync|appendFile|appendFileSync|copyFile|cp|cpSync|rename|renameSync)\b/)
    // The one mention of `.claude` is the read of the prompt template.
    const mentions = SOURCE.split('\n').filter((l) => l.includes("'.claude'"))
    expect(mentions).toEqual(["const CODER_PROMPT = path.join(DISPATCHER_ROOT, '.claude', 'prompts', 'coder.md')"])
    expect(SOURCE).toMatch(/readFileSync\(CODER_PROMPT/)
  })
})

describe('OQ-70/AC-8: a blocked story is opened as a draft', () => {
  it('OQ-70/AC-8: blocked: set by the coder forces draft though the coder said ready', async () => {
    const world = makeWorld()
    const { result, gh } = await dispatch(world, ({ cwd }) => {
      // The escape route: set `blocked:` in the story file, leave it in stories/.
      const file = path.join(cwd, 'stories', 'OQ-98-first.md')
      writeFileSync(file, readFileSync(file, 'utf8').replace('blocked: null', 'blocked: Which reading of AC-2?'))
      git(cwd, 'add', '.')
      git(cwd, 'commit', '-q', '-m', 'block')
      return block('Blocked', 'ready')
    })
    expect(result.status).toBe('opened')
    expect(result.blocked).toBe('Which reading of AC-2?')
    expect(result.draft).toBe(true)
    expect(pulls(gh)[0].body.draft).toBe(true)
  })

  it('OQ-70/AC-8: a story with no blocked: value keeps the coder\'s ready', async () => {
    const { gh } = await dispatch(makeWorld(), ({ cwd }) => { finishStory(cwd); return block('T', 'ready') })
    expect(pulls(gh)[0].body.draft).toBe(false)
  })
})

describe('OQ-70/AC-9: the worktree is removed when the run finishes', () => {
  const leaked = (world, treeDirs) => {
    expect(worktrees(world.repoDir)).toEqual([path.resolve(world.repoDir)])
    for (const dir of treeDirs) expect(existsSync(dir)).toBe(false)
  }

  it('OQ-70/AC-9: removed after a successful run, and the pushed local branch is not left to block the next run', async () => {
    const world = makeWorld()
    const cwds = []
    await dispatch(world, ({ cwd }) => { cwds.push(cwd); finishStory(cwd); return block() })
    leaked(world, cwds)
    expect(gitOk(world.repoDir, 'rev-parse', '--verify', '--quiet', 'refs/heads/story/OQ-98-first')).toBeNull()
  })

  it('OQ-70/AC-9: removed when the session fails', async () => {
    const world = makeWorld()
    const cwds = []
    const { result } = await dispatch(world, ({ cwd }) => { cwds.push(cwd); return envelope('x', { is_error: true }) })
    expect(result.status).toBe('session-failed')
    leaked(world, cwds)
  })

  it('OQ-70/AC-9: removed when nothing was pushed, or the block is invalid', async () => {
    const a = makeWorld()
    const cwdsA = []
    await dispatch(a, ({ cwd }) => { cwdsA.push(cwd); return block() })
    leaked(a, cwdsA)

    const b = makeWorld()
    const cwdsB = []
    await dispatch(b, ({ cwd }) => { cwdsB.push(cwd); finishStory(cwd); return 'no block' })
    leaked(b, cwdsB)
  })

  it('OQ-70/AC-9: removed when the spawn itself throws, and unpushed work is kept on its local branch', async () => {
    const world = makeWorld()
    const cwds = []
    await expect(dispatch(world, ({ cwd }) => {
      cwds.push(cwd)
      writeFileSync(path.join(cwd, 'wip.txt'), 'wip')
      git(cwd, 'add', '.')
      git(cwd, 'commit', '-q', '-m', 'unpushed wip')
      throw new Error('spawn blew up')
    })).rejects.toThrow('spawn blew up')
    leaked(world, cwds)
    expect(gitOk(world.repoDir, 'rev-parse', '--verify', '--quiet', 'refs/heads/story/OQ-98-first')).toBeTruthy()
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('tw-coder-') && cwds.some((c) => c.includes(n)))).toEqual([])
  })
})

describe('OQ-78/AC-8 and AC-9: dependencies are installed before the coder, or the dispatch stops', () => {
  it('OQ-78/AC-8: npm ci runs in the new worktree with the coder\'s credential-free environment, before the session', async () => {
    const world = makeWorld()
    const order = []
    const installs = []
    const install = async (options) => {
      order.push('install')
      installs.push({ ...options, branch: git(options.cwd, 'rev-parse', '--abbrev-ref', 'HEAD') })
    }
    const { fake } = await dispatch(world, ({ cwd }) => { order.push('session'); finishStory(cwd); return block() }, {
      install, baseEnv: { PATH: '/bin', GH_TOKEN: 'a', GITHUB_TOKEN: 'b', GH_ENTERPRISE_TOKEN: 'c' },
    })
    expect(order).toEqual(['install', 'session'])
    expect(installs).toHaveLength(1)
    expect(installs[0].cwd).toBe(fake.calls[0].cwd)
    expect(installs[0].cwd).not.toBe(world.repoDir)
    expect(installs[0].branch).toBe('story/OQ-98-first')
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN']) expect(installs[0].env).not.toHaveProperty(key)
    expect(installs[0].env.GH_CONFIG_DIR).toBeTruthy()
    expect(installs[0].env.PATH).toBe('/bin')
  })

  it('OQ-78/AC-9: a failed install has its own status, spawns no coder, opens no PR, and cleans up', async () => {
    const world = makeWorld()
    let installCwd
    const { result, fake, gh } = await dispatch(world, () => { throw new Error('must not spawn') }, {
      install: async ({ cwd }) => { installCwd = cwd; throw new Error('npm ci failed') },
    })
    expect(result).toMatchObject({ status: 'install-failed', storyId: 'OQ-98', reason: 'npm ci failed' })
    expect(fake.calls).toHaveLength(0)
    expect(pulls(gh)).toEqual([])
    expect(worktrees(world.repoDir)).toEqual([path.resolve(world.repoDir)])
    expect(existsSync(installCwd)).toBe(false)
    expect(gitOk(world.repoDir, 'rev-parse', '--verify', '--quiet', 'refs/heads/story/OQ-98-first')).toBeNull()
    // main() exits non-zero for every status outside NON_FAILURES.
    expect(SOURCE.match(/const NON_FAILURES = (\[[^\]]*\])/)[1]).not.toContain('install-failed')
  })
})

describe('OQ-78/AC-10: the story is chosen from the freshly fetched origin/main', () => {
  it('OQ-78/AC-10: a story finished on origin but open in a stale checkout is not chosen, and nothing throws', async () => {
    const world = makeWorld()
    // OQ-98 lands in stories/done/ on the origin; the dispatcher's checkout is not updated.
    mkdirSync(path.join(world.seed, 'stories', 'done'))
    git(world.seed, 'mv', 'stories/OQ-98-first.md', 'stories/done/OQ-98-first.md')
    git(world.seed, 'commit', '-q', '-m', 'OQ-98 done')
    git(world.seed, 'push', '-q', 'origin', 'main')
    expect(existsSync(path.join(world.repoDir, 'stories', 'OQ-98-first.md'))).toBe(true)

    const { result } = await dispatch(world, ({ cwd }) => {
      finishStory(cwd, { file: 'OQ-99-second.md' })
      return block()
    })
    expect(result.status).toBe('opened')
    expect(result.storyId).toBe('OQ-99')
  })

  it('OQ-78/AC-10: asking for the finished story by id is a status, not a throw out of readFileSync', async () => {
    const world = makeWorld()
    mkdirSync(path.join(world.seed, 'stories', 'done'))
    git(world.seed, 'mv', 'stories/OQ-98-first.md', 'stories/done/OQ-98-first.md')
    git(world.seed, 'commit', '-q', '-m', 'OQ-98 done')
    git(world.seed, 'push', '-q', 'origin', 'main')
    const { result, fake } = await dispatch(world, () => { throw new Error('must not spawn') }, { storyId: 'OQ-98' })
    expect(result.status).toBe('not-ready')
    expect(fake.calls).toHaveLength(0)
  })

  it('OQ-78/AC-10: the repoDir docstring no longer says its stories/ should be current', () => {
    expect(SOURCE).not.toMatch(/should be\s+current/)
  })
})

describe('refusing to run over existing work', () => {
  it('a branch already on the remote is not a coder having pushed', async () => {
    const world = makeWorld()
    git(world.seed, 'push', '-q', 'origin', 'main:story/OQ-98-first')
    const { result, fake } = await dispatch(world, () => { throw new Error('must not spawn') })
    expect(result.status).toBe('branch-exists')
    expect(fake.calls).toHaveLength(0)
  })
})
