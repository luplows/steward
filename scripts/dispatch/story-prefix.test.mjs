import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lintAll } from '../lint-stories.mjs'
import { loadQueue } from './queue.mjs'
import { checkStoryContainment } from './story-containment.mjs'
import { readStoryPrefix } from './story-prefix.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** Runs `fn` with a project root holding `stories/stories.json` of `contents` (none when null). */
async function withProject(contents, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'steward-story-prefix-'))
  try {
    mkdirSync(path.join(dir, 'stories'))
    if (contents !== null) writeFileSync(path.join(dir, 'stories', 'stories.json'), contents)
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('ST-41/AC-2: readStoryPrefix', () => {
  it("ST-41/AC-2: reads this repository's own stories/stories.json as ST", async () => {
    expect(await readStoryPrefix(REPO_ROOT)).toBe('ST')
  })

  it('ST-41/AC-2: reads the prefix of a well-formed file', async () => {
    await withProject('{ "prefix": "OQ" }', async (dir) => {
      expect(await readStoryPrefix(dir)).toBe('OQ')
    })
  })

  it('ST-41/AC-2: refuses a missing file, naming the file and the problem', async () => {
    await withProject(null, async (dir) => {
      const promise = readStoryPrefix(dir)
      await expect(promise).rejects.toThrow(path.join(dir, 'stories', 'stories.json'))
      await expect(promise).rejects.toThrow('file not found')
    })
  })

  it('ST-41/AC-2: refuses invalid JSON, naming the file and the problem', async () => {
    await withProject('{ not json', async (dir) => {
      const promise = readStoryPrefix(dir)
      await expect(promise).rejects.toThrow('stories.json')
      await expect(promise).rejects.toThrow('invalid JSON')
    })
  })

  it.each(['[]', 'null', '"ST"'])('ST-41/AC-2: refuses %s, which is not a JSON object', async (contents) => {
    await withProject(contents, async (dir) => {
      await expect(readStoryPrefix(dir)).rejects.toThrow('must be a JSON object')
    })
  })

  it('ST-41/AC-2: refuses a key other than prefix, naming it', async () => {
    await withProject('{ "prefix": "ST", "start": 1 }', async (dir) => {
      const promise = readStoryPrefix(dir)
      await expect(promise).rejects.toThrow('stories.json')
      await expect(promise).rejects.toThrow("unrecognised key 'start'")
    })
  })

  it.each([
    ['missing', '{}'],
    ['lower case', '{ "prefix": "st" }'],
    ['longer than 8 letters', '{ "prefix": "TOOLONGPR" }'],
    ['empty', '{ "prefix": "" }'],
    ['not a string', '{ "prefix": 7 }'],
    ['with a digit', '{ "prefix": "S1" }'],
  ])('ST-41/AC-2: refuses a prefix that is %s, naming the file and the problem', async (_name, contents) => {
    await withProject(contents, async (dir) => {
      const promise = readStoryPrefix(dir)
      await expect(promise).rejects.toThrow('stories.json')
      await expect(promise).rejects.toThrow("'prefix' must match")
    })
  })

  it('ST-41/AC-2: accepts a prefix of 1 and of 8 capital letters', async () => {
    await withProject('{ "prefix": "A" }', async (dir) => expect(await readStoryPrefix(dir)).toBe('A'))
    await withProject('{ "prefix": "ABCDEFGH" }', async (dir) => expect(await readStoryPrefix(dir)).toBe('ABCDEFGH'))
  })
})

describe('ST-41/AC-3: story tooling takes the prefix from stories/stories.json and reads no settings file', () => {
  // None of these project roots holds a steward.config.json.
  it('ST-41/AC-3: loadQueue reads the queue of a project with only a stories/stories.json', async () => {
    await withProject('{ "prefix": "XY" }', async (dir) => {
      expect(await loadQueue(dir)).toEqual([])
    })
  })

  it('ST-41/AC-3: loadQueue refuses a project with no stories/stories.json', async () => {
    await withProject(null, async (dir) => {
      await expect(loadQueue(dir)).rejects.toThrow('file not found')
    })
  })

  it('ST-41/AC-3: lintAll lints a project with only a stories/stories.json', async () => {
    await withProject('{ "prefix": "XY" }', async (dir) => {
      expect(await lintAll(dir)).toEqual([])
    })
  })

  it('ST-41/AC-3: lintAll refuses a project with no stories/stories.json', async () => {
    await withProject(null, async (dir) => {
      await expect(lintAll(dir)).rejects.toThrow('file not found')
    })
  })

  it('ST-41/AC-3: checkStoryContainment runs in a project with only a stories/stories.json', async () => {
    await withProject('{ "prefix": "XY" }', async (dir) => {
      const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
      git('init', '-q', '-b', 'main')
      git('config', 'user.email', 'test@example.com')
      git('config', 'user.name', 'Test')
      git('add', '.')
      git('commit', '-q', '--allow-empty', '-m', 'base')
      git('commit', '-q', '--allow-empty', '-m', 'head')
      expect(await checkStoryContainment({ cwd: dir, base: 'HEAD~1', head: 'HEAD', branch: 'feature/x' })).toEqual({ ok: true })
    })
  })

  it('ST-41/AC-3: checkStoryContainment refuses a project with no stories/stories.json', async () => {
    await withProject(null, async (dir) => {
      await expect(checkStoryContainment({ cwd: dir, base: 'HEAD~1', head: 'HEAD', branch: 'x' })).rejects.toThrow('file not found')
    })
  })
})
