import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSettings } from './settings.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function withTempProject(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'steward-settings-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function writeConfig(dir, contents) {
  writeFileSync(path.join(dir, 'steward.config.json'), contents)
}

describe('readSettings', () => {
  it('OQ-122/AC-2 - reads this repository\'s own steward.config.json as the committed values', async () => {
    const settings = await readSettings(REPO_ROOT)
    expect(settings).toEqual({ repo: 'luplows/tower-workshop-paths', storyPrefix: 'OQ' })
  })

  it('OQ-122/AC-2 - throws naming the file when steward.config.json is missing', async () => {
    await withTempProject(async (dir) => {
      await expect(readSettings(dir)).rejects.toThrow(path.join(dir, 'steward.config.json'))
    })
  })

  it('OQ-122/AC-2 - throws naming the file when the JSON is invalid', async () => {
    await withTempProject(async (dir) => {
      writeConfig(dir, '{ not json')
      await expect(readSettings(dir)).rejects.toThrow(path.join(dir, 'steward.config.json'))
    })
  })

  it('OQ-122/AC-2 - throws when repo is missing', async () => {
    await withTempProject(async (dir) => {
      writeConfig(dir, JSON.stringify({ storyPrefix: 'OQ' }))
      await expect(readSettings(dir)).rejects.toThrow(/repo/)
    })
  })

  it('OQ-122/AC-2 - throws when storyPrefix is missing', async () => {
    await withTempProject(async (dir) => {
      writeConfig(dir, JSON.stringify({ repo: 'luplows/tower-workshop-paths' }))
      await expect(readSettings(dir)).rejects.toThrow(/storyPrefix/)
    })
  })

  it('OQ-122/AC-2 - throws when repo is not owner/name', async () => {
    await withTempProject(async (dir) => {
      writeConfig(dir, JSON.stringify({ repo: 'not-a-slug', storyPrefix: 'OQ' }))
      await expect(readSettings(dir)).rejects.toThrow(/repo/)
    })
  })

  it('OQ-122/AC-2 - throws when storyPrefix does not match ^[A-Z]{1,8}$', async () => {
    await withTempProject(async (dir) => {
      writeConfig(dir, JSON.stringify({ repo: 'luplows/tower-workshop-paths', storyPrefix: 'oq' }))
      await expect(readSettings(dir)).rejects.toThrow(/storyPrefix/)
    })
  })

  it('OQ-122/AC-2 - throws when storyPrefix is longer than 8 characters', async () => {
    await withTempProject(async (dir) => {
      writeConfig(dir, JSON.stringify({ repo: 'luplows/tower-workshop-paths', storyPrefix: 'TOOLONGPREFIX' }))
      await expect(readSettings(dir)).rejects.toThrow(/storyPrefix/)
    })
  })

  it('OQ-122/AC-2 - throws when an extra key is present', async () => {
    await withTempProject(async (dir) => {
      writeConfig(
        dir,
        JSON.stringify({ repo: 'luplows/tower-workshop-paths', storyPrefix: 'OQ', extra: 'nope' }),
      )
      await expect(readSettings(dir)).rejects.toThrow(/extra/)
    })
  })
})
