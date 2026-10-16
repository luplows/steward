import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSettings } from './settings.mjs'
import { fixtureSettings } from './settings-fixture.mjs'

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

/** The fixture settings without `key`. */
function withoutKey(key) {
  const settings = fixtureSettings()
  delete settings[key]
  return settings
}

/** Reads `settings` from a temp project and asserts the error names the file and `fragment`. */
async function expectRejected(settings, fragment) {
  await withTempProject(async (dir) => {
    writeConfig(dir, JSON.stringify(settings))
    const filePath = path.join(dir, 'steward.config.json')
    const promise = readSettings(dir)
    await expect(promise).rejects.toThrow(filePath)
    await expect(promise).rejects.toThrow(fragment)
  })
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
    expect(settings).toEqual({
      repo: 'luplows/steward',
      storyPrefix: 'ST',
      setup: { command: 'npm ci', timeoutMinutes: 5 },
      check: { command: 'npm run check', timeoutMinutes: 10 },
      landWhen: 'all-checks',
      land: true,
      unitLinks: ['file'],
      rulesFile: 'REVIEW.md',
    })
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
      writeConfig(dir, JSON.stringify(withoutKey('repo')))
      const filePath = path.join(dir, 'steward.config.json')
      const promise = readSettings(dir)
      await expect(promise).rejects.toThrow(filePath)
      await expect(promise).rejects.toThrow("missing required key 'repo'")
    })
  })

  it('OQ-135/AC-3 - throws naming the file and the problem when storyPrefix is missing', async () => {
    await withTempProject(async (dir) => {
      writeConfig(dir, JSON.stringify(withoutKey('storyPrefix')))
      const filePath = path.join(dir, 'steward.config.json')
      const promise = readSettings(dir)
      await expect(promise).rejects.toThrow(filePath)
      await expect(promise).rejects.toThrow("missing required key 'storyPrefix'")
    })
  })

  it('OQ-135/AC-3 - throws naming the file and the problem when repo is not owner/name', async () => {
    await withTempProject(async (dir) => {
      writeConfig(dir, JSON.stringify(fixtureSettings({ repo: 'not-a-slug' })))
      const filePath = path.join(dir, 'steward.config.json')
      const promise = readSettings(dir)
      await expect(promise).rejects.toThrow(filePath)
      await expect(promise).rejects.toThrow("'repo' must be of the form owner/name")
    })
  })

  it('OQ-135/AC-3 - throws naming the file and the problem when storyPrefix is lower case', async () => {
    await withTempProject(async (dir) => {
      writeConfig(dir, JSON.stringify(fixtureSettings({ storyPrefix: 'oq' })))
      const filePath = path.join(dir, 'steward.config.json')
      const promise = readSettings(dir)
      await expect(promise).rejects.toThrow(filePath)
      await expect(promise).rejects.toThrow("'storyPrefix' must match")
    })
  })

  it('OQ-135/AC-3 - throws naming the file and the problem when storyPrefix is longer than 8 characters', async () => {
    await withTempProject(async (dir) => {
      writeConfig(dir, JSON.stringify(fixtureSettings({ storyPrefix: 'TOOLONGPREFIX' })))
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
        JSON.stringify(fixtureSettings({ extra: 'nope' })),
      )
      const filePath = path.join(dir, 'steward.config.json')
      const promise = readSettings(dir)
      await expect(promise).rejects.toThrow(filePath)
      await expect(promise).rejects.toThrow("unrecognised key 'extra'")
    })
  })
})

describe('ST-18: the review side settings keys', () => {
  const COMMAND_KEYS = ['setup', 'check']
  const NEW_KEYS = ['setup', 'check', 'landWhen', 'land', 'unitLinks', 'rulesFile']

  async function readBack(settings) {
    return withTempProject(async (dir) => {
      writeConfig(dir, JSON.stringify(settings))
      return readSettings(dir)
    })
  }

  it('ST-18/AC-1: a valid value for each new key is read back unchanged', async () => {
    const settings = fixtureSettings({
      setup: { command: 'make deps', timeoutMinutes: 1 },
      check: { command: 'make check', timeoutMinutes: 30 },
      landWhen: ['test', 'lint'],
      land: false,
      unitLinks: ['issue', 'file', 'other'],
      rulesFile: 'docs/rules/REVIEW.md',
    })
    expect(await readBack(settings)).toEqual(settings)
  })

  it.each(COMMAND_KEYS)('ST-18/AC-1: %s accepts null', async (key) => {
    expect((await readBack(fixtureSettings({ [key]: null })))[key]).toBeNull()
  })

  it('ST-18/AC-1: landWhen accepts "all-checks", unitLinks accepts [], land accepts true', async () => {
    const settings = fixtureSettings({ landWhen: 'all-checks', unitLinks: [], land: true })
    expect(await readBack(settings)).toEqual(settings)
  })

  it.each(NEW_KEYS)('ST-18/AC-2: a missing %s names the file and the key', async (key) => {
    await expectRejected(withoutKey(key), `missing required key '${key}'`)
  })

  it('ST-18/AC-2: an unknown top-level key names the file and the key', async () => {
    await expectRejected(fixtureSettings({ landing: true }), "unrecognised key 'landing'")
  })

  it.each(COMMAND_KEYS)('ST-18/AC-2: an unknown key inside %s names its parent', async (key) => {
    await expectRejected(
      fixtureSettings({ [key]: { command: 'x', timeoutMinutes: 1, shell: 'sh' } }),
      `unrecognised key '${key}.shell'`,
    )
  })

  it.each(COMMAND_KEYS)('ST-18/AC-2: %s missing command or timeoutMinutes names the nested key', async (key) => {
    await expectRejected(fixtureSettings({ [key]: { timeoutMinutes: 1 } }), `missing required key '${key}.command'`)
    await expectRejected(fixtureSettings({ [key]: { command: 'x' } }), `missing required key '${key}.timeoutMinutes'`)
  })

  it.each(COMMAND_KEYS)('ST-18/AC-2: %s with a malformed value names the key', async (key) => {
    await expectRejected(fixtureSettings({ [key]: 'npm ci' }), `'${key}' must be null or an object`)
    await expectRejected(fixtureSettings({ [key]: ['npm ci'] }), `'${key}' must be null or an object`)
    for (const bad of ['', '  ', 5, null]) {
      await expectRejected(fixtureSettings({ [key]: { command: bad, timeoutMinutes: 1 } }), `'${key}.command'`)
    }
    for (const bad of [0, -1, 1.5, '5', null]) {
      await expectRejected(fixtureSettings({ [key]: { command: 'x', timeoutMinutes: bad } }), `'${key}.timeoutMinutes'`)
    }
  })

  it('ST-18/AC-2: landWhen of the wrong form names the key', async () => {
    for (const bad of ['some-check', [], ['a', 'a'], ['a', ''], ['a', 3], true, null]) {
      await expectRejected(fixtureSettings({ landWhen: bad }), "'landWhen' must be")
    }
  })

  it('ST-18/AC-2: land of the wrong form names the key', async () => {
    for (const bad of ['true', 1, null, []]) {
      await expectRejected(fixtureSettings({ land: bad }), "'land' must be a boolean")
    }
  })

  it('ST-18/AC-2: unitLinks of the wrong form names the key', async () => {
    for (const bad of ['file', ['pr'], ['file', 'file'], [1], null, { file: true }]) {
      await expectRejected(fixtureSettings({ unitLinks: bad }), "'unitLinks' must be")
    }
  })

  it('ST-18/AC-2: rulesFile of the wrong form names the key', async () => {
    const bad = ['', '/REVIEW.md', 'C:/rules.md', 'docs\\REVIEW.md', '../REVIEW.md', 'a/../b.md', 'a//b.md', 'a/', 3, null]
    for (const value of bad) {
      await expectRejected(fixtureSettings({ rulesFile: value }), "'rulesFile' must be")
    }
  })

  it('ST-18/AC-2: nothing is defaulted: a file with only repo and storyPrefix is rejected', async () => {
    await expectRejected({ repo: 'owner/repo', storyPrefix: 'ST' }, "missing required key 'setup'")
  })
})

describe('ST-34/AC-3: usageLimits left the project settings', () => {
  it('ST-34/AC-3: refuses usageLimits as an unknown key', async () => {
    const usageLimits = { coder: { session: 70, weekly: 75 }, reviewer: { session: 90, weekly: 90 } }
    await expectRejected(fixtureSettings({ usageLimits }), "unrecognised key 'usageLimits'")
  })

  it("ST-34/AC-3: this repository's steward.config.json has no usageLimits", async () => {
    expect(await readSettings(REPO_ROOT)).not.toHaveProperty('usageLimits')
  })
})
