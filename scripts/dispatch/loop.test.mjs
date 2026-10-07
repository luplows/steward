// @vitest-environment node

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createContext } from './github.mjs'
import {
  STUCK_ISSUE_LIMIT,
  defaultWorktreePath,
  hasCheckedOutBranch,
  initWorktree,
  parseArgs,
  parseMaxStories,
  pickStory,
  requireOwnWorktree,
  runLoop,
  runStoryProcess,
  updateCheckout,
} from './loop.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })

// A minimal `ready` story: frontmatter queue.mjs requires, plus an empty
// Open questions section (stories/README.md's readiness test).
const story = (id, title = 'A story', { tier = 'normal', dependsOn = [], blocked = 'null' } = {}) =>
  `---\nid: ${id}\ntitle: ${title}\ntier: ${tier}\nkind: workflow\ndepends_on: [${dependsOn.join(', ')}]\nmodel: sonnet\nblocked: ${blocked}\n---\n\n## Intent\n\nx\n\n## Open questions\n\n*(none)*\n`

function writeStory(repoDir, id, slug, opts) {
  mkdirSync(path.join(repoDir, 'stories'), { recursive: true })
  writeFileSync(path.join(repoDir, 'stories', `${id}-${slug}.md`), story(id, undefined, opts))
}

/** A bare `origin` plus a clone, with `commit()` and `push()` helpers. */
function makeRepo(root) {
  const origin = path.join(root, 'origin.git')
  git(root, 'init', '--bare', '-b', 'main', origin)
  const repoDir = path.join(root, 'clone')
  git(root, 'clone', origin, repoDir)
  writeFileSync(path.join(repoDir, 'README.md'), 'init\n')
  git(repoDir, 'add', '.')
  git(repoDir, 'commit', '-m', 'init')
  git(repoDir, 'push', 'origin', 'main')
  return {
    origin,
    repoDir,
    commit: (msg) => {
      git(repoDir, 'add', '.')
      git(repoDir, 'commit', '-m', msg)
    },
    push: (ref = 'main') => git(repoDir, 'push', 'origin', ref),
    headSha: (cwd = repoDir) => git(cwd, 'rev-parse', 'HEAD').trim(),
    remoteTip: (branch) => {
      const out = git(repoDir, 'ls-remote', 'origin', `refs/heads/${branch}`).trim()
      return out === '' ? null : out.split(/\s+/)[0]
    },
  }
}

describe('OQ-109/AC-3: fetches origin and stops on anything uncommitted, rather than fast-forwarding', () => {
  const originalEnv = { ...process.env }
  let root

  beforeAll(() => {
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test'
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com'
    root = mkdtempSync(path.join(tmpdir(), 'tw-loop-test-'))
  })

  afterAll(() => {
    process.env = originalEnv
    rmSync(root, { recursive: true, force: true })
  })

  it('OQ-109/AC-3: an update to a newer origin/main checks out its tip, detached', async () => {
    const sub = path.join(root, 'ff')
    mkdirSync(sub)
    const repo = makeRepo(sub)
    // Advance origin/main from a second clone so repoDir stays behind.
    const otherClone = path.join(sub, 'other')
    git(sub, 'clone', repo.origin, otherClone)
    writeFileSync(path.join(otherClone, 'README.md'), 'advanced\n')
    git(otherClone, 'add', '.')
    git(otherClone, 'commit', '-m', 'advance')
    git(otherClone, 'push', 'origin', 'main')
    const advancedSha = git(otherClone, 'rev-parse', 'HEAD').trim()

    const result = await updateCheckout(repo.repoDir)
    expect(result).toEqual({ status: 'updated', headSha: advancedSha })
    expect(repo.headSha()).toBe(advancedSha)
    expect(await hasCheckedOutBranch(repo.repoDir)).toBe(false)
  })

  it('OQ-109/AC-3: a modified tracked file stops the update, naming the path and changing nothing', async () => {
    const sub = path.join(root, 'dirty-tracked')
    mkdirSync(sub)
    const repo = makeRepo(sub)
    const otherClone = path.join(sub, 'other')
    git(sub, 'clone', repo.origin, otherClone)
    writeFileSync(path.join(otherClone, 'README.md'), 'advanced\n')
    git(otherClone, 'add', '.')
    git(otherClone, 'commit', '-m', 'advance')
    git(otherClone, 'push', 'origin', 'main')

    // A tracked file modified but never committed in repoDir.
    writeFileSync(path.join(repo.repoDir, 'README.md'), 'edited locally\n')
    const localSha = repo.headSha()

    const result = await updateCheckout(repo.repoDir)
    expect(result.status).toBe('dirty')
    expect(result.paths).toEqual(['README.md'])
    // Nothing was dispatched: the checkout is untouched.
    expect(repo.headSha()).toBe(localSha)
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo.repoDir, encoding: 'utf8' }).trim()).not.toBe('')
  })

  it('OQ-109/AC-3: an untracked file stops the update, naming the path and changing nothing', async () => {
    const sub = path.join(root, 'dirty-untracked')
    mkdirSync(sub)
    const repo = makeRepo(sub)
    const localSha = repo.headSha()

    writeFileSync(path.join(repo.repoDir, 'scratch.txt'), 'not tracked\n')

    const result = await updateCheckout(repo.repoDir)
    expect(result.status).toBe('dirty')
    expect(result.paths).toEqual(['scratch.txt'])
    expect(repo.headSha()).toBe(localSha)
    expect(existsSync(path.join(repo.repoDir, 'scratch.txt'))).toBe(true)
  })

  it('OQ-109/AC-3: a story branch on origin does not affect the update', async () => {
    const sub = path.join(root, 'other-branch')
    mkdirSync(sub)
    const repo = makeRepo(sub)
    writeStory(repo.repoDir, 'OQ-50', 'in-progress')
    repo.commit('add a story')
    repo.push()
    git(repo.repoDir, 'push', 'origin', 'main:refs/heads/story/OQ-50-in-progress')
    expect(repo.remoteTip('story/OQ-50-in-progress')).not.toBeNull()

    const otherClone = path.join(sub, 'other')
    git(sub, 'clone', repo.origin, otherClone)
    writeFileSync(path.join(otherClone, 'README.md'), 'advanced again\n')
    git(otherClone, 'add', '.')
    git(otherClone, 'commit', '-m', 'advance again')
    git(otherClone, 'push', 'origin', 'main')
    const advancedSha = git(otherClone, 'rev-parse', 'HEAD').trim()

    const result = await updateCheckout(repo.repoDir)
    expect(result).toEqual({ status: 'updated', headSha: advancedSha })
  })

  it('OQ-109/AC-3: runLoop stops with its own status and dispatches nothing when the checkout is dirty', async () => {
    const pickStory = async () => { throw new Error('pickStory must not be called') }
    const runStoryProcess = async () => { throw new Error('runStoryProcess must not be called') }
    const dirtyUpdateCheckout = async () => ({ status: 'dirty', paths: ['README.md'] })

    const result = await runLoop({ deps: { updateCheckout: dirtyUpdateCheckout, pickStory, runStoryProcess } })
    expect(result.status).toBe('dirty')
    expect(result.paths).toEqual(['README.md'])
    expect(result.report).toEqual([])
  })

  it('OQ-86/AC-1: the checkout is not fetched and updated again while a story\'s process is running', async () => {
    const calls = []
    let running = false
    const guardedUpdateCheckout = async () => {
      calls.push('update')
      if (running) throw new Error('updateCheckout was called while a story was running')
      return { status: 'updated', headSha: 'deadbeef' }
    }
    let picks = 0
    const pickStory = async () => (picks++ === 0 ? { story: { id: 'OQ-1', branch: 'story/OQ-1-x' }, skipped: [] } : { story: null, skipped: [] })
    const runStoryProcess = async () => {
      calls.push('run-start')
      running = true
      await new Promise((resolve) => setTimeout(resolve, 10))
      running = false
      calls.push('run-end')
      return { status: 'ran', result: { status: 'merged' } }
    }

    const result = await runLoop({ deps: { updateCheckout: guardedUpdateCheckout, pickStory, runStoryProcess } })
    expect(result.status).toBe('nothing-ready')
    // One update before the story, none while it ran, one more after it
    // finished before the loop found nothing ready.
    expect(calls).toEqual(['update', 'run-start', 'run-end', 'update'])
  })
})

describe('OQ-86/AC-4: pickStory skips an in-progress story and derives nothing-ready', () => {
  const originalEnv = { ...process.env }
  let root

  beforeAll(() => {
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test'
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com'
    root = mkdtempSync(path.join(tmpdir(), 'tw-loop-pick-'))
  })

  afterAll(() => {
    process.env = originalEnv
    rmSync(root, { recursive: true, force: true })
  })

  it('OQ-86/AC-4: a ready story with a branch on origin is skipped, the next ready story is picked', async () => {
    const sub = path.join(root, 'skip')
    mkdirSync(sub)
    const repo = makeRepo(sub)
    writeStory(repo.repoDir, 'OQ-20', 'already-running')
    writeStory(repo.repoDir, 'OQ-21', 'next-up')
    repo.commit('add stories')
    repo.push()
    git(repo.repoDir, 'push', 'origin', 'main:refs/heads/story/OQ-20-already-running')

    const picked = await pickStory(repo.repoDir)
    expect(picked.skipped).toEqual([{ id: 'OQ-20', branch: 'story/OQ-20-already-running', location: 'origin' }])
    expect(picked.story).toEqual({ id: 'OQ-21', branch: 'story/OQ-21-next-up' })
  })

  it('OQ-86/AC-4: a queue whose only ready stories all have branches on origin yields no story', async () => {
    const sub = path.join(root, 'all-skipped')
    mkdirSync(sub)
    const repo = makeRepo(sub)
    writeStory(repo.repoDir, 'OQ-30', 'running-one')
    writeStory(repo.repoDir, 'OQ-31', 'running-two')
    repo.commit('add stories')
    repo.push()
    git(repo.repoDir, 'push', 'origin', 'main:refs/heads/story/OQ-30-running-one')
    git(repo.repoDir, 'push', 'origin', 'main:refs/heads/story/OQ-31-running-two')

    const picked = await pickStory(repo.repoDir)
    expect(picked.story).toBeNull()
    expect(picked.skipped).toEqual([
      { id: 'OQ-30', branch: 'story/OQ-30-running-one', location: 'origin' },
      { id: 'OQ-31', branch: 'story/OQ-31-running-two', location: 'origin' },
    ])
  })
})

describe('OQ-86/AC-2: two stories run from a checkout that catches up between them', () => {
  const originalEnv = { ...process.env }
  let root

  beforeAll(() => {
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test'
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com'
    root = mkdtempSync(path.join(tmpdir(), 'tw-loop-two-'))
  })

  afterAll(() => {
    process.env = originalEnv
    rmSync(root, { recursive: true, force: true })
  })

  it('OQ-86/AC-2: the second story\'s process starts only after an update that includes the first\'s merge', async () => {
    const sub = path.join(root, 'two-stories')
    mkdirSync(sub)
    const repo = makeRepo(sub)
    writeStory(repo.repoDir, 'OQ-40', 'first')
    writeStory(repo.repoDir, 'OQ-41', 'second')
    repo.commit('add stories')
    repo.push()

    const headAtCall = []
    let call = 0
    const mergedShas = []
    // Production merges to origin/main through a separate landing sweep
    // (land.mjs), never by committing in the dispatcher's own checkout
    // (repoDir). So this fake lands each story from its own throwaway clone,
    // pushed straight to origin, and never touches repoDir -- the only way
    // repoDir's HEAD can include a merge is through runLoop's own
    // updateCheckout call on the next iteration. If that call were skipped,
    // repoDir would stay stale, OQ-40 would still read ready in its working
    // tree, and the second pick would be OQ-40 again instead of OQ-41.
    const runStoryProcess = async ({ repoDir, storyId }) => {
      call++
      headAtCall.push(git(repoDir, 'rev-parse', 'HEAD').trim())
      const slug = storyId === 'OQ-40' ? 'first' : 'second'
      const landingClone = path.join(sub, `land-${storyId}`)
      git(sub, 'clone', repo.origin, landingClone)
      mkdirSync(path.join(landingClone, 'stories', 'done'), { recursive: true })
      git(landingClone, 'mv', `stories/${storyId}-${slug}.md`, `stories/done/${storyId}-${slug}.md`)
      git(landingClone, 'commit', '-m', `merge ${storyId}`)
      git(landingClone, 'push', 'origin', 'main')
      const sha = git(landingClone, 'rev-parse', 'HEAD').trim()
      mergedShas.push(sha)
      return { status: 'ran', result: { status: 'merged', pr: call } }
    }

    const result = await runLoop({ repoDir: repo.repoDir, deps: { runStoryProcess } })
    expect(result.status).toBe('nothing-ready')
    expect(result.report.map((r) => r.id)).toEqual(['OQ-40', 'OQ-41'])
    expect(result.report.every((r) => r.outcome === 'merged')).toBe(true)

    // The second story's process started from a checkout whose HEAD was the
    // first story's merge -- only the update between the two calls
    // (runLoop's own updateCheckout, not this test's fake) could have put it
    // there, since runStoryProcess never touches repoDir.
    expect(headAtCall[1]).toBe(mergedShas[0])
  })
})

describe('OQ-86/AC-2, AC-3: runStoryProcess as a real child process', () => {
  const originalEnv = { ...process.env }
  let root

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'tw-loop-process-'))
  })

  afterAll(() => {
    process.env = originalEnv
    rmSync(root, { recursive: true, force: true })
  })

  it('OQ-86/AC-2: stdout is parsed as JSON even when the child process exits non-zero', async () => {
    const scriptPath = path.join(root, 'prints-and-fails.mjs')
    writeFileSync(
      scriptPath,
      "console.log(JSON.stringify({ status: 'nothing-committed', stopped: true })); process.exitCode = 1\n",
    )

    const result = await runStoryProcess({ repoDir: root, repo: 'x/y', storyId: 'OQ-1', scriptPath })
    expect(result).toEqual({ status: 'ran', result: { status: 'nothing-committed', stopped: true } })
  })

  it('OQ-86/AC-3: a process-error is reported when nothing parseable is printed', async () => {
    const scriptPath = path.join(root, 'prints-nothing.mjs')
    writeFileSync(scriptPath, "console.error('killed by signal SIGKILL'); process.exitCode = 1\n")

    const result = await runStoryProcess({ repoDir: root, repo: 'x/y', storyId: 'OQ-1', scriptPath })
    expect(result.status).toBe('process-error')
    expect(result.reason).toMatch(/OQ-1/)
    expect(result.reason).toMatch(/SIGKILL/)
  })
})

describe('OQ-86/AC-3: the loop goes on only after a merge or a fully recorded stop', () => {
  const stories = (ids) => {
    let i = 0
    return async () => {
      const id = ids[i]
      i++
      return id ? { story: { id, branch: `story/${id}-x` }, skipped: [] } : { story: null, skipped: [] }
    }
  }
  const updated = async () => ({ status: 'updated', headSha: 'deadbeef' })

  it('OQ-86/AC-3: a merged story is followed by the next story', async () => {
    const calls = []
    const runStoryProcess = async ({ storyId }) => {
      calls.push(storyId)
      return { status: 'ran', result: { status: 'merged' } }
    }
    const result = await runLoop({ deps: { updateCheckout: updated, pickStory: stories(['OQ-1', 'OQ-2']), runStoryProcess } })
    expect(result.status).toBe('nothing-ready')
    expect(calls).toEqual(['OQ-1', 'OQ-2'])
    expect(result.report).toEqual([{ id: 'OQ-1', outcome: 'merged' }, { id: 'OQ-2', outcome: 'merged' }])
  })

  it('OQ-86/AC-3: a fully recorded stop is followed by the next story', async () => {
    const calls = []
    const runStoryProcess = async ({ storyId }) => {
      calls.push(storyId)
      if (storyId === 'OQ-1') {
        return {
          status: 'ran',
          result: { status: 'ci-round-bound', stopped: true, reason: 'three red rounds', record: { recorded: true, draft: true, blocked: 'ci-round-bound' } },
        }
      }
      return { status: 'ran', result: { status: 'merged' } }
    }
    const result = await runLoop({ deps: { updateCheckout: updated, pickStory: stories(['OQ-1', 'OQ-2']), runStoryProcess } })
    expect(result.status).toBe('nothing-ready')
    expect(calls).toEqual(['OQ-1', 'OQ-2'])
    expect(result.report[0]).toEqual({ id: 'OQ-1', outcome: 'stopped-recorded', status: 'ci-round-bound' })
  })

  it('OQ-86/AC-3: a stop before a pull request exists stops the loop, with no further coder session', async () => {
    const calls = []
    const runStoryProcess = async ({ storyId }) => {
      calls.push(storyId)
      return { status: 'ran', result: { status: 'nothing-committed', stopped: true, reason: 'nothing to commit' } }
    }
    const result = await runLoop({ deps: { updateCheckout: updated, pickStory: stories(['OQ-1', 'OQ-2']), runStoryProcess } })
    expect(result.status).toBe('story-stopped')
    expect(result.storyStatus).toBe('nothing-committed')
    expect(calls).toEqual(['OQ-1'])
  })

  it('OQ-86/AC-3: a stop whose recording failed stops the loop, with no further coder session', async () => {
    const calls = []
    const runStoryProcess = async ({ storyId }) => {
      calls.push(storyId)
      return {
        status: 'ran',
        result: { status: 'review-round-bound', stopped: true, reason: 'bound', record: { recorded: false, draft: true, failed: [{ step: 'blocked', reason: 'push-failed' }] } },
      }
    }
    const result = await runLoop({ deps: { updateCheckout: updated, pickStory: stories(['OQ-1', 'OQ-2']), runStoryProcess } })
    expect(result.status).toBe('story-stopped')
    expect(result.storyStatus).toBe('review-round-bound')
    expect(calls).toEqual(['OQ-1'])
  })

  it('OQ-86/AC-3: a process that exits with an error stops the loop, with no further coder session', async () => {
    const calls = []
    const runStoryProcess = async ({ storyId }) => {
      calls.push(storyId)
      return { status: 'process-error', reason: 'killed by signal SIGKILL' }
    }
    const result = await runLoop({ deps: { updateCheckout: updated, pickStory: stories(['OQ-1', 'OQ-2']), runStoryProcess } })
    expect(result.status).toBe('process-error')
    expect(result.reason).toMatch(/SIGKILL/)
    expect(calls).toEqual(['OQ-1'])
  })
})

describe('a dispatch that returns branch-exists still stops the loop (OQ-111 retitle: a local-only branch no longer does, since pickStory now pushes and skips it before any dispatch)', () => {
  it('OQ-86/AC-4: dispatchCoder\'s branch-exists (no pull request, nothing recorded) stops the loop', async () => {
    const calls = []
    const pickStory = async () => (calls.length === 0 ? { story: { id: 'OQ-1', branch: 'story/OQ-1-x' }, skipped: [] } : { story: null, skipped: [] })
    const runStoryProcess = async ({ storyId }) => {
      calls.push(storyId)
      return { status: 'ran', result: { status: 'branch-exists', stopped: true, reason: `story/${storyId}-x already exists locally` } }
    }
    const result = await runLoop({ deps: { updateCheckout: async () => ({ status: 'updated' }), pickStory, runStoryProcess } })
    expect(result.status).toBe('story-stopped')
    expect(result.storyStatus).toBe('branch-exists')
    expect(calls).toEqual(['OQ-1'])
  })
})

describe('OQ-111: a story whose branch exists only locally is pushed to origin and skipped', () => {
  const originalEnv = { ...process.env }
  let root

  beforeAll(() => {
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test'
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com'
    root = mkdtempSync(path.join(tmpdir(), 'tw-loop-local-only-'))
  })

  afterAll(() => {
    process.env = originalEnv
    rmSync(root, { recursive: true, force: true })
  })

  it('OQ-111/AC-1, AC-2: a local-only branch is pushed as it is and skipped, and the next ready story is dispatched', async () => {
    const sub = path.join(root, 'local-only')
    mkdirSync(sub)
    const repo = makeRepo(sub)
    writeStory(repo.repoDir, 'OQ-50', 'local-only')
    writeStory(repo.repoDir, 'OQ-51', 'next-up')
    repo.commit('add stories')
    repo.push()
    const branch = 'story/OQ-50-local-only'
    git(repo.repoDir, 'branch', branch)
    const localSha = git(repo.repoDir, 'rev-parse', branch).trim()
    expect(repo.remoteTip(branch)).toBeNull()

    const picked = await pickStory(repo.repoDir)
    expect(picked.skipped).toEqual([{ id: 'OQ-50', branch, location: 'local', pushed: true }])
    expect(picked.story).toEqual({ id: 'OQ-51', branch: 'story/OQ-51-next-up' })
    // The claim push landed the branch's tip exactly as it was, not a new commit.
    expect(repo.remoteTip(branch)).toBe(localSha)
  })

  it('OQ-111/AC-1: a local-only branch whose push fails is still skipped, with git\'s error reported', async () => {
    const sub = path.join(root, 'local-only-push-fails')
    mkdirSync(sub)
    const repo = makeRepo(sub)
    writeStory(repo.repoDir, 'OQ-52', 'push-fails')
    repo.commit('add story')
    repo.push()
    const branch = 'story/OQ-52-push-fails'
    git(repo.repoDir, 'branch', branch)

    // A pre-receive hook that refuses every push, so the claim push fails
    // deterministically rather than relying on a real race with another machine.
    const hookPath = path.join(repo.origin, 'hooks', 'pre-receive')
    writeFileSync(hookPath, '#!/bin/sh\nexit 1\n')
    chmodSync(hookPath, 0o755)

    const picked = await pickStory(repo.repoDir)
    expect(picked.story).toBeNull()
    expect(picked.skipped).toHaveLength(1)
    expect(picked.skipped[0]).toMatchObject({ id: 'OQ-52', branch, location: 'local', pushed: false })
    expect(picked.skipped[0].error).toBeTruthy()
    expect(repo.remoteTip(branch)).toBeNull()
  })

  it('OQ-111/AC-2: a branch on origin only is skipped as on origin, with nothing pushed', async () => {
    const sub = path.join(root, 'origin-only')
    mkdirSync(sub)
    const repo = makeRepo(sub)
    writeStory(repo.repoDir, 'OQ-53', 'origin-only')
    writeStory(repo.repoDir, 'OQ-54', 'after')
    repo.commit('add stories')
    repo.push()
    const branch = 'story/OQ-53-origin-only'
    git(repo.repoDir, 'push', 'origin', `main:refs/heads/${branch}`)
    const originSha = repo.remoteTip(branch)

    const picked = await pickStory(repo.repoDir)
    expect(picked.skipped).toEqual([{ id: 'OQ-53', branch, location: 'origin' }])
    expect(picked.story).toEqual({ id: 'OQ-54', branch: 'story/OQ-54-after' })
    expect(repo.remoteTip(branch)).toBe(originSha)
  })

  it('OQ-111/AC-2: a branch both local and on origin at different tips is skipped as on origin, with nothing pushed', async () => {
    const sub = path.join(root, 'local-and-origin')
    mkdirSync(sub)
    const repo = makeRepo(sub)
    writeStory(repo.repoDir, 'OQ-55', 'both')
    repo.commit('add story')
    repo.push()
    const branch = 'story/OQ-55-both'
    git(repo.repoDir, 'branch', branch)
    git(repo.repoDir, 'push', 'origin', branch)
    const originSha = repo.remoteTip(branch)

    git(repo.repoDir, 'checkout', branch)
    git(repo.repoDir, 'commit', '--allow-empty', '-m', 'diverge locally')
    const localSha = git(repo.repoDir, 'rev-parse', branch).trim()
    expect(localSha).not.toBe(originSha)

    const picked = await pickStory(repo.repoDir)
    expect(picked.story).toBeNull()
    expect(picked.skipped).toEqual([{ id: 'OQ-55', branch, location: 'origin' }])
    expect(repo.remoteTip(branch)).toBe(originSha)
  })

  it('OQ-111/AC-3: runLoop goes on to dispatch the next ready story after pickStory pushes and skips a local-only branch', async () => {
    const sub = path.join(root, 'loop-continues')
    mkdirSync(sub)
    const repo = makeRepo(sub)
    writeStory(repo.repoDir, 'OQ-60', 'local-only')
    writeStory(repo.repoDir, 'OQ-61', 'next')
    repo.commit('add stories')
    repo.push()
    const branch = 'story/OQ-60-local-only'
    git(repo.repoDir, 'branch', branch)

    const calls = []
    const runStoryProcess = async ({ storyId }) => {
      calls.push(storyId)
      return { status: 'ran', result: { status: 'merged' } }
    }

    const result = await runLoop({ repoDir: repo.repoDir, maxStories: 1, deps: { runStoryProcess } })
    expect(result.status).toBe('max-stories')
    expect(calls).toEqual(['OQ-61'])
    expect(result.report[0]).toEqual({ id: 'OQ-60', branch, outcome: 'skipped' })
    expect(result.report[1]).toEqual({ id: 'OQ-61', outcome: 'merged' })
    expect(repo.remoteTip(branch)).not.toBeNull()
  })
})

describe('OQ-86/AC-6: --max-stories caps how many stories a run starts', () => {
  const twoReady = () => {
    let i = 0
    const ids = ['OQ-1', 'OQ-2']
    return async () => {
      const id = ids[i]
      i++
      return id ? { story: { id, branch: `story/${id}-x` }, skipped: [] } : { story: null, skipped: [] }
    }
  }
  const oneReady = () => {
    let i = 0
    return async () => (i++ === 0 ? { story: { id: 'OQ-1', branch: 'story/OQ-1-x' }, skipped: [] } : { story: null, skipped: [] })
  }
  const updated = async () => ({ status: 'updated' })
  const merged = async () => ({ status: 'ran', result: { status: 'merged' } })

  it('OQ-86/AC-6: --max-stories 1 with two ready stories runs one and stops max-stories', async () => {
    const calls = []
    const runStoryProcess = async ({ storyId }) => (calls.push(storyId), merged())
    const result = await runLoop({ maxStories: 1, deps: { updateCheckout: updated, pickStory: twoReady(), runStoryProcess } })
    expect(result.status).toBe('max-stories')
    expect(calls).toEqual(['OQ-1'])
  })

  it('OQ-86/AC-6: with no cap, two ready stories are both run', async () => {
    const calls = []
    const runStoryProcess = async ({ storyId }) => (calls.push(storyId), merged())
    const result = await runLoop({ deps: { updateCheckout: updated, pickStory: twoReady(), runStoryProcess } })
    expect(result.status).toBe('nothing-ready')
    expect(calls).toEqual(['OQ-1', 'OQ-2'])
  })

  it('OQ-86/AC-6: --max-stories 2 with one ready story runs it and stops nothing-ready', async () => {
    const calls = []
    const runStoryProcess = async ({ storyId }) => (calls.push(storyId), merged())
    const result = await runLoop({ maxStories: 2, deps: { updateCheckout: updated, pickStory: oneReady(), runStoryProcess } })
    expect(result.status).toBe('nothing-ready')
    expect(calls).toEqual(['OQ-1'])
  })

  it('OQ-86/AC-6: 0, -1, x and 07 are each refused, with no story started', () => {
    for (const bad of ['0', '-1', 'x', '07']) {
      expect(() => parseMaxStories(bad)).toThrow()
    }
    // A thrown parse happens before runLoop is ever called (the CLI awaits it
    // first), so refusing it structurally starts no story.
    expect(parseMaxStories(undefined)).toBeUndefined()
    expect(parseMaxStories('1')).toBe(1)
    expect(parseMaxStories('12')).toBe(12)
  })

  it('OQ-86/AC-6: a trailing --max-stories with no value is refused by the CLI parser, not silently uncapped', () => {
    // Exercises parseArgs, the function main() calls before touching repoDir
    // or the network -- not parseMaxStories alone, which a value of undefined
    // (indistinguishable from the flag being absent) would pass straight
    // through as "uncapped".
    expect(() => parseArgs(['--max-stories'])).toThrow()
    // --repo takes its value first, leaving --max-stories trailing with
    // nothing of its own -- the flag must not silently steal --repo's value.
    expect(() => parseArgs(['--max-stories', '--repo', 'x/y'])).toThrow()
  })

  it('OQ-86/AC-6: parseArgs accepts a well-formed invocation', () => {
    expect(parseArgs(['--max-stories', '3', '--repo', 'x/y'])).toEqual({ repo: 'x/y', maxStories: 3 })
    expect(parseArgs([])).toEqual({ repo: 'luplows/tower-workshop-paths', maxStories: undefined })
  })
})

describe('OQ-109/AC-1: --init creates a worktree of the loop\'s own, detached at origin/main', () => {
  const originalEnv = { ...process.env }
  let root

  beforeAll(() => {
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test'
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com'
    root = mkdtempSync(path.join(tmpdir(), 'tw-loop-init-'))
  })

  afterAll(() => {
    process.env = originalEnv
    rmSync(root, { recursive: true, force: true })
  })

  it('OQ-109/AC-1: the default path is a sibling of the repository root, named after it with -loop appended', () => {
    const repoDir = path.resolve(path.sep, 'Source', 'tower-workshop-paths')
    expect(defaultWorktreePath(repoDir)).toBe(path.resolve(path.sep, 'Source', 'tower-workshop-paths-loop'))
  })

  it('OQ-109/AC-1: creates a worktree at the given path, with a detached HEAD at origin/main', async () => {
    const sub = path.join(root, 'create')
    mkdirSync(sub)
    const repo = makeRepo(sub)
    const target = path.join(sub, 'loop-worktree')

    await initWorktree(repo.repoDir, target)

    expect(existsSync(target)).toBe(true)
    expect(git(target, 'rev-parse', 'HEAD').trim()).toBe(repo.headSha())
    expect(await hasCheckedOutBranch(target)).toBe(false)
  })

  it('OQ-109/AC-1: refuses, exiting non-zero and creating nothing, when the path already exists', async () => {
    const sub = path.join(root, 'refuse')
    mkdirSync(sub)
    const repo = makeRepo(sub)
    const target = path.join(sub, 'already-there')
    mkdirSync(target)
    writeFileSync(path.join(target, 'marker.txt'), 'pre-existing\n')

    await expect(initWorktree(repo.repoDir, target)).rejects.toThrow(/already exists/)
    // Refusal left the pre-existing directory exactly as it was -- no worktree was added.
    expect(existsSync(path.join(target, 'marker.txt'))).toBe(true)
    expect(git(repo.repoDir, 'worktree', 'list')).not.toContain('already-there')
  })
})

describe('OQ-109/AC-2: the loop refuses to run from a checkout that has a branch checked out', () => {
  const originalEnv = { ...process.env }
  let root

  beforeAll(() => {
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test'
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com'
    root = mkdtempSync(path.join(tmpdir(), 'tw-loop-ownwt-'))
  })

  afterAll(() => {
    process.env = originalEnv
    rmSync(root, { recursive: true, force: true })
  })

  it('OQ-109/AC-2: a checkout with a branch checked out is refused, naming the checkout and pointing at --init', async () => {
    const sub = path.join(root, 'branch')
    mkdirSync(sub)
    const repo = makeRepo(sub)
    // A fresh clone has `main` checked out, not detached.
    expect(await hasCheckedOutBranch(repo.repoDir)).toBe(true)

    let caught
    try {
      await requireOwnWorktree(repo.repoDir)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    expect(caught.message).toContain(repo.repoDir)
    expect(caught.message).toContain('--init')
  })

  it('OQ-109/AC-2: a detached checkout goes on', async () => {
    const sub = path.join(root, 'detached')
    mkdirSync(sub)
    const repo = makeRepo(sub)
    git(repo.repoDir, 'checkout', '--detach', 'HEAD')
    expect(await hasCheckedOutBranch(repo.repoDir)).toBe(false)

    await expect(requireOwnWorktree(repo.repoDir)).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------- OQ-112: stuck stories

const REPO = 'luplows/tower-workshop-paths'

/** Like github.test.mjs's fakeFetch: answers queued responses in order. */
function fakeFetch(responses) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined })
    const next = responses.shift()
    if (!next) throw new Error(`no fake response queued for ${init.method} ${url}`)
    return { ok: next.ok ?? true, status: next.status ?? 200, json: async () => next.json ?? {}, text: async () => JSON.stringify(next.json ?? {}) }
  }
  fn.calls = calls
  return fn
}

function makeCtx(responses) {
  const fetch = fakeFetch(responses)
  return { fetch, ctx: createContext({ repo: REPO, fetch, getToken: async () => 'tok' }) }
}

const noIssuesOpen = { json: [] }
const issueCreated = (number) => ({ json: { number, html_url: `https://x/issues/${number}` } })
const updated = async () => ({ status: 'updated' })
const neverCalled = (name) => async () => { throw new Error(`${name} must not be called`) }

describe('OQ-112/AC-3, AC-4, AC-5: a stuck story opens exactly one GitHub issue', () => {
  it('OQ-112/AC-3, AC-4: a branch on origin with no open pull request and no claim opens an issue naming the story, branch, machine and reason', async () => {
    const { ctx, fetch } = makeCtx([noIssuesOpen, noIssuesOpen, issueCreated(11), noIssuesOpen])
    const pickStory = async () => ({ story: null, skipped: [{ id: 'OQ-1', branch: 'story/OQ-1-x', location: 'origin' }] })
    const result = await runLoop({
      ctx, baseEnv: { TW_MACHINE_LABEL: 'laptop' },
      deps: {
        updateCheckout: updated, pickStory, runStoryProcess: neverCalled('runStoryProcess'),
        listOpenPullRequestsForHead: async () => [], claimAgeMs: async () => null,
      },
    })
    expect(result.status).toBe('nothing-ready')
    expect(result.report[0]).toMatchObject({ id: 'OQ-1', branch: 'story/OQ-1-x', outcome: 'skipped' })
    expect(result.report[0].stuck).toEqual({ opened: true, issue: { number: 11, url: 'https://x/issues/11' } })
    const createCall = fetch.calls.find((c) => c.method === 'POST')
    expect(createCall.url).toBe(`https://api.github.com/repos/${REPO}/issues`)
    expect(createCall.body).toEqual({
      title: 'Loop: OQ-1 is stuck',
      body: expect.stringContaining('Story: OQ-1'),
      labels: ['loop-stuck'],
    })
    expect(createCall.body.body).toContain('Branch: story/OQ-1-x')
    expect(createCall.body.body).toContain('Machine: laptop')
  })

  it('OQ-112/AC-3: a local-only branch opens an issue whatever its age, without checking a pull request or a claim', async () => {
    const { ctx } = makeCtx([noIssuesOpen, noIssuesOpen, issueCreated(12), noIssuesOpen])
    const pickStory = async () => ({ story: null, skipped: [{ id: 'OQ-2', branch: 'story/OQ-2-x', location: 'local', pushed: true }] })
    const result = await runLoop({
      ctx,
      deps: {
        updateCheckout: updated, pickStory, runStoryProcess: neverCalled('runStoryProcess'),
        listOpenPullRequestsForHead: neverCalled('listOpenPullRequestsForHead'), claimAgeMs: neverCalled('claimAgeMs'),
      },
    })
    expect(result.report[0].stuck).toEqual({ opened: true, issue: { number: 12, url: 'https://x/issues/12' } })
  })

  it('OQ-112/AC-4: a local-only branch whose push failed names the real push error, not a false claim that it was pushed', async () => {
    const { ctx, fetch } = makeCtx([noIssuesOpen, noIssuesOpen, issueCreated(21), noIssuesOpen])
    const pickStory = async () => ({
      story: null,
      skipped: [{ id: 'OQ-5', branch: 'story/OQ-5-x', location: 'local', pushed: false, error: 'remote rejected' }],
    })
    const result = await runLoop({
      ctx,
      deps: {
        updateCheckout: updated, pickStory, runStoryProcess: neverCalled('runStoryProcess'),
        listOpenPullRequestsForHead: neverCalled('listOpenPullRequestsForHead'), claimAgeMs: neverCalled('claimAgeMs'),
      },
    })
    expect(result.report[0].stuck).toEqual({ opened: true, issue: { number: 21, url: 'https://x/issues/21' } })
    const createCall = fetch.calls.find((c) => c.method === 'POST')
    expect(createCall.body.body).toContain('pushing it to origin failed: remote rejected')
    expect(createCall.body.body).not.toContain('was just pushed to origin')
  })

  it('OQ-112/AC-3: a dispatch that stopped before a pull request existed opens an issue; branch-exists does not', async () => {
    const { ctx: stuckCtx } = makeCtx([noIssuesOpen, noIssuesOpen, noIssuesOpen, issueCreated(13)])
    const pickStory = async () => ({ story: { id: 'OQ-3', branch: 'story/OQ-3-x' }, skipped: [] })
    const runStoryProcess = async () => ({
      status: 'ran',
      result: { status: 'install-failed', stopped: true, reason: 'npm ci failed', dispatch: { status: 'install-failed', reason: 'npm ci failed' } },
    })
    const result = await runLoop({ ctx: stuckCtx, deps: { updateCheckout: updated, pickStory, runStoryProcess } })
    expect(result.status).toBe('story-stopped')
    expect(result.report[0].stuck).toEqual({ opened: true, issue: { number: 13, url: 'https://x/issues/13' } })

    const { ctx: branchExistsCtx } = makeCtx([noIssuesOpen, noIssuesOpen])
    const runStoryProcess2 = async () => ({
      status: 'ran',
      result: { status: 'branch-exists', stopped: true, reason: 'taken', dispatch: { status: 'branch-exists', reason: 'taken' } },
    })
    const result2 = await runLoop({ ctx: branchExistsCtx, deps: { updateCheckout: updated, pickStory, runStoryProcess: runStoryProcess2 } })
    expect(result2.report[0].stuck).toBeUndefined()
  })

  it('OQ-112/AC-4, AC-5: an already-open issue with the same title is left alone, no second one created', async () => {
    const { ctx, fetch } = makeCtx([noIssuesOpen, { json: [{ number: 9, title: 'Loop: OQ-1 is stuck' }] }, noIssuesOpen])
    const pickStory = async () => ({ story: null, skipped: [{ id: 'OQ-1', branch: 'story/OQ-1-x', location: 'origin' }] })
    const result = await runLoop({
      ctx,
      deps: {
        updateCheckout: updated, pickStory, runStoryProcess: neverCalled('runStoryProcess'),
        listOpenPullRequestsForHead: async () => [], claimAgeMs: async () => null,
      },
    })
    expect(result.report[0].stuck).toEqual({ opened: false, alreadyOpen: true })
    expect(fetch.calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('OQ-112/AC-5: a skip with an open pull request, or a claim younger than STUCK_AFTER_MS, gets no issue', async () => {
    const { ctx: withPr } = makeCtx([noIssuesOpen, noIssuesOpen])
    const pickStory = async () => ({ story: null, skipped: [{ id: 'OQ-1', branch: 'story/OQ-1-x', location: 'origin' }] })
    const resultWithPr = await runLoop({
      ctx: withPr,
      deps: {
        updateCheckout: updated, pickStory, runStoryProcess: neverCalled('runStoryProcess'),
        listOpenPullRequestsForHead: async () => [{ number: 5, headRef: 'story/OQ-1-x' }], claimAgeMs: neverCalled('claimAgeMs'),
      },
    })
    expect(resultWithPr.report[0].stuck).toBeUndefined()

    const { ctx: youngClaim } = makeCtx([noIssuesOpen, noIssuesOpen])
    const resultYoung = await runLoop({
      ctx: youngClaim,
      deps: {
        updateCheckout: updated, pickStory, runStoryProcess: neverCalled('runStoryProcess'),
        listOpenPullRequestsForHead: async () => [], claimAgeMs: async () => 5 * 60 * 1000,
      },
    })
    expect(resultYoung.report[0].stuck).toBeUndefined()
  })

  it('OQ-112/AC-5: a failed issue creation is recorded on the report, and the loop goes on to the next story', async () => {
    const { ctx } = makeCtx([noIssuesOpen, noIssuesOpen, { ok: false, status: 500, json: { message: 'boom' } }, noIssuesOpen, noIssuesOpen])
    let i = 0
    const pickStory = async () => (i++ === 0
      ? { story: { id: 'OQ-2', branch: 'story/OQ-2-x' }, skipped: [{ id: 'OQ-1', branch: 'story/OQ-1-x', location: 'origin' }] }
      : { story: null, skipped: [] })
    const runStoryProcess = async () => ({ status: 'ran', result: { status: 'merged' } })
    const result = await runLoop({
      ctx,
      deps: {
        updateCheckout: updated, pickStory, runStoryProcess,
        listOpenPullRequestsForHead: async () => [], claimAgeMs: async () => null,
      },
    })
    expect(result.status).toBe('nothing-ready')
    expect(result.report[0].stuck.opened).toBe(false)
    expect(result.report[0].stuck.error).toMatch(/500/)
    expect(result.report[1]).toEqual({ id: 'OQ-2', outcome: 'merged' })
  })

  it('without a ctx, the pre-OQ-112 control flow runs unchanged: no issue is checked for or opened', async () => {
    const pickStory = async () => ({ story: null, skipped: [{ id: 'OQ-1', branch: 'story/OQ-1-x', location: 'local', pushed: true }] })
    const result = await runLoop({ deps: { updateCheckout: updated, pickStory, runStoryProcess: neverCalled('runStoryProcess') } })
    expect(result.report).toEqual([{ id: 'OQ-1', branch: 'story/OQ-1-x', outcome: 'skipped' }])
  })
})

describe('OQ-112/AC-6: two or more open loop-stuck issues stop the queue completely', () => {
  it('OQ-112/AC-6: a run that starts at the limit picks nothing, naming the count and each issue\'s number', async () => {
    const { ctx } = makeCtx([{ json: [{ number: 1, title: 'Loop: OQ-1 is stuck' }, { number: 2, title: 'Loop: OQ-2 is stuck' }] }])
    const result = await runLoop({
      ctx,
      deps: { updateCheckout: neverCalled('updateCheckout'), pickStory: neverCalled('pickStory'), runStoryProcess: neverCalled('runStoryProcess') },
    })
    expect(result.status).toBe('stuck-limit')
    expect(result.reason).toContain('2 open loop-stuck issues')
    expect(result.reason).toContain('#1')
    expect(result.reason).toContain('#2')
    expect(STUCK_ISSUE_LIMIT).toBe(2)
  })

  it('OQ-112/AC-6: a run that reaches the limit partway, after a skip opens the second issue, picks nothing more', async () => {
    const { ctx } = makeCtx([
      { json: [{ number: 1, title: 'Loop: OQ-1 is stuck' }] }, // start of run: below the limit
      { json: [{ number: 1, title: 'Loop: OQ-1 is stuck' }] }, // reportStuck's own existing-issue check
      issueCreated(2), // the second issue is opened
      { json: [{ number: 1, title: 'x' }, { number: 2, title: 'y' }] }, // before-pick: now at the limit
    ])
    const pickStory = async () => ({ story: { id: 'OQ-3', branch: 'story/OQ-3-x' }, skipped: [{ id: 'OQ-2', branch: 'story/OQ-2-x', location: 'local' }] })
    const result = await runLoop({
      ctx,
      deps: { updateCheckout: updated, pickStory, runStoryProcess: neverCalled('runStoryProcess') },
    })
    expect(result.status).toBe('stuck-limit')
    expect(result.report[0]).toMatchObject({ id: 'OQ-2', outcome: 'skipped' })
  })

  it('OQ-112/AC-6: a run below the limit goes on as usual', async () => {
    const { ctx } = makeCtx([noIssuesOpen, noIssuesOpen, noIssuesOpen])
    let i = 0
    const pickStory = async () => (i++ === 0 ? { story: { id: 'OQ-1', branch: 'story/OQ-1-x' }, skipped: [] } : { story: null, skipped: [] })
    const runStoryProcess = async () => ({ status: 'ran', result: { status: 'merged' } })
    const result = await runLoop({ ctx, deps: { updateCheckout: updated, pickStory, runStoryProcess } })
    expect(result.status).toBe('nothing-ready')
    expect(result.report).toEqual([{ id: 'OQ-1', outcome: 'merged' }])
  })

  it('OQ-112/AC-6: a failed count is treated as the limit reached, naming the error, and picks nothing', async () => {
    const { ctx } = makeCtx([{ ok: false, status: 503, json: { message: 'unavailable' } }])
    const result = await runLoop({
      ctx,
      deps: { updateCheckout: neverCalled('updateCheckout'), pickStory: neverCalled('pickStory'), runStoryProcess: neverCalled('runStoryProcess') },
    })
    expect(result.status).toBe('stuck-limit')
    expect(result.reason).toMatch(/503/)
  })
})
