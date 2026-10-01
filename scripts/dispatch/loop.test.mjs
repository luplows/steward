// @vitest-environment node

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseArgs, parseMaxStories, pickStory, runLoop, runStoryProcess, updateCheckout } from './loop.mjs'

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

describe('OQ-86/AC-1: fetches and fast-forwards the checkout between stories', () => {
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

  it('OQ-86/AC-1: a checkout behind origin/main fast-forwards to it', async () => {
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
  })

  it('OQ-86/AC-1: a checkout that has diverged (a local commit not on origin) refuses', async () => {
    const sub = path.join(root, 'diverged')
    mkdirSync(sub)
    const repo = makeRepo(sub)
    const otherClone = path.join(sub, 'other')
    git(sub, 'clone', repo.origin, otherClone)
    writeFileSync(path.join(otherClone, 'README.md'), 'advanced\n')
    git(otherClone, 'add', '.')
    git(otherClone, 'commit', '-m', 'advance')
    git(otherClone, 'push', 'origin', 'main')

    // repoDir makes its own local commit, never pushed: now diverged from origin/main.
    writeFileSync(path.join(repo.repoDir, 'local.txt'), 'local only\n')
    repo.commit('local, unpushed')
    const localSha = repo.headSha()

    const result = await updateCheckout(repo.repoDir)
    expect(result.status).toBe('not-fast-forward')
    expect(typeof result.reason).toBe('string')
    // Nothing was dispatched: the checkout is untouched.
    expect(repo.headSha()).toBe(localSha)
  })

  it('OQ-86/AC-1: the fast-forward is unaffected by another story\'s branch existing on origin', async () => {
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

  it('OQ-86/AC-1: runLoop stops with its own status and dispatches nothing when the fast-forward refuses', async () => {
    const pickStory = async () => { throw new Error('pickStory must not be called') }
    const runStoryProcess = async () => { throw new Error('runStoryProcess must not be called') }
    const failingUpdateCheckout = async () => ({ status: 'not-fast-forward', reason: 'local changes would be discarded' })

    const result = await runLoop({ deps: { updateCheckout: failingUpdateCheckout, pickStory, runStoryProcess } })
    expect(result.status).toBe('update-failed')
    expect(result.reason).toBe('local changes would be discarded')
    expect(result.report).toEqual([])
  })

  it('OQ-86/AC-1: the checkout is not fetched and fast-forwarded again while a story\'s process is running', async () => {
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
    expect(picked.skipped).toEqual([{ id: 'OQ-20', branch: 'story/OQ-20-already-running' }])
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
      { id: 'OQ-30', branch: 'story/OQ-30-running-one' },
      { id: 'OQ-31', branch: 'story/OQ-31-running-two' },
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

  it('OQ-86/AC-2: the second story\'s process starts only after a fast-forward that includes the first\'s merge', async () => {
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
    // first story's merge -- only the fast-forward between the two calls
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

describe('OQ-86/AC-4: a local-only branch stops the loop rather than looping on branch-exists', () => {
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
