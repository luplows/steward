import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSettings } from './settings.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

async function withTempProject(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'steward-settings-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function writeConfig(dir, contents) {
  writeFileSync(path.join(dir, 'steward.config.json'), contents)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('withTempProject', () => {
  it("OQ-135/AC-2 - keeps the directory until the given async function settles", async () => {
    let existedDuring
    const dirAfter = await withTempProject(async (dir) => {
      await delay(10)
      existedDuring = existsSync(dir)
      return dir
    })
    expect(existedDuring).toBe(true)
    expect(existsSync(dirAfter)).toBe(false)
  })

  it('OQ-135/AC-2 - removes the directory and propagates the rejection when the function rejects after a timer', async () => {
    let dir
    await expect(
      withTempProject(async (d) => {
        dir = d
        await delay(10)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(existsSync(dir)).toBe(false)
  })
})

describe('readSettings', () => {
  it('OQ-122/AC-2 - reads this repository\'s own steward.config.json as the committed values', async () => {
    const settings = await readSettings(REPO_ROOT)
    expect(settings).toEqual({ repo: 'luplows/tower-workshop-paths', storyPrefix: 'OQ' })
  })

  it('OQ-135/AC-3 - throws naming the file and the problem when steward.config.json is missing', async () => {
    await withTempProject(async (dir) => {
      const filePath = path.join(dir, 'steward.config.json')
      const promise = readSettings(dir)
      await expect(promise).rejects.toThrow(filePath)
      await expect(promise).rejects.toThrow('file not found')
    })
  })

  it('OQ-135/AC-3 - throws naming the file and the problem when the JSON is invalid', async () => {
    await withTempProject(async (dir) => {
      writeConfig(dir, '{ not json')
      const filePath = path.join(dir, 'steward.config.json')
      const promise = readSettings(dir)
      await expect(promise).rejects.toThrow(filePath)
      await expect(promise).rejects.toThrow('invalid JSON')
    })
  })

  it('OQ-135/AC-3 - throws naming the file and the problem when repo is missing', async () => {
    await withTempProject(async (dir) => {
      writeConfig(dir, JSON.stringify({ storyPrefix: 'OQ' }))
      const filePath = path.join(dir, 'steward.config.json')
      const promise = readSettings(dir)
      await expect(promise).rejects.toThrow(filePath)
      await expect(promise).rejects.toThrow("missing required key 'repo'")
    })
  })

  it('OQ-135/AC-3 - throws naming the file and the problem when storyPrefix is missing', async () => {
    await withTempProject(async (dir) => {
      writeConfig(dir, JSON.stringify({ repo: 'luplows/tower-workshop-paths' }))
      const filePath = path.join(dir, 'steward.config.json')
      const promise = readSettings(dir)
      await expect(promise).rejects.toThrow(filePath)
      await expect(promise).rejects.toThrow("missing required key 'storyPrefix'")
    })
  })

  it('OQ-135/AC-3 - throws naming the file and the problem when repo is not owner/name', async () => {
    await withTempProject(async (dir) => {
      writeConfig(dir, JSON.stringify({ repo: 'not-a-slug', storyPrefix: 'OQ' }))
      const filePath = path.join(dir, 'steward.config.json')
      const promise = readSettings(dir)
      await expect(promise).rejects.toThrow(filePath)
      await expect(promise).rejects.toThrow("'repo' must be of the form owner/name")
    })
  })

  it('OQ-135/AC-3 - throws naming the file and the problem when storyPrefix is lower case', async () => {
    await withTempProject(async (dir) => {
      writeConfig(dir, JSON.stringify({ repo: 'luplows/tower-workshop-paths', storyPrefix: 'oq' }))
      const filePath = path.join(dir, 'steward.config.json')
      const promise = readSettings(dir)
      await expect(promise).rejects.toThrow(filePath)
      await expect(promise).rejects.toThrow("'storyPrefix' must match")
    })
  })

  it('OQ-135/AC-3 - throws naming the file and the problem when storyPrefix is longer than 8 characters', async () => {
    await withTempProject(async (dir) => {
      writeConfig(dir, JSON.stringify({ repo: 'luplows/tower-workshop-paths', storyPrefix: 'TOOLONGPREFIX' }))
      const filePath = path.join(dir, 'steward.config.json')
      const promise = readSettings(dir)
      await expect(promise).rejects.toThrow(filePath)
      await expect(promise).rejects.toThrow("'storyPrefix' must match")
    })
  })

  it('OQ-135/AC-3 - throws naming the file and the problem when an extra key is present', async () => {
    await withTempProject(async (dir) => {
      writeConfig(
        dir,
        JSON.stringify({ repo: 'luplows/tower-workshop-paths', storyPrefix: 'OQ', extra: 'nope' }),
      )
      const filePath = path.join(dir, 'steward.config.json')
      const promise = readSettings(dir)
      await expect(promise).rejects.toThrow(filePath)
      await expect(promise).rejects.toThrow("unrecognised key 'extra'")
    })
  })
})
