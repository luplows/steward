import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { coderChoice, machineSettingsPath, readMachineSettings } from './machine-settings.mjs'
import { fixtureMachineSettings } from './settings-fixture.mjs'

async function withTempHome(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'steward-machine-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Writes `contents` as `<home>/.steward/settings.json`, and returns its path. */
function writeHomeFile(home, contents) {
  mkdirSync(path.join(home, '.steward'), { recursive: true })
  writeFileSync(path.join(home, '.steward', 'settings.json'), contents)
  return path.join(home, '.steward', 'settings.json')
}

/** Reads `settings` as the file under a temp home and asserts the error names the file and `fragment`. */
async function expectRejected(settings, fragment) {
  await withTempHome(async (home) => {
    const filePath = writeHomeFile(home, JSON.stringify(settings))
    const promise = readMachineSettings({ env: {}, homedir: home })
    await expect(promise).rejects.toThrow(filePath)
    await expect(promise).rejects.toThrow(fragment)
  })
}

/** The fixture with `change` applied to a copy. */
function changed(change) {
  const settings = fixtureMachineSettings()
  change(settings)
  return settings
}

describe('ST-34/AC-1: where the file is read from', () => {
  it('ST-34/AC-1: reads <homedir>/.steward/settings.json when STEWARD_SETTINGS is not set', async () => {
    await withTempHome(async (home) => {
      writeHomeFile(home, JSON.stringify(fixtureMachineSettings()))
      expect(await readMachineSettings({ env: {}, homedir: home })).toEqual(fixtureMachineSettings())
    })
  })

  it('ST-34/AC-1: reads the file STEWARD_SETTINGS names, and not the one under homedir', async () => {
    await withTempHome(async (home) => {
      writeHomeFile(home, '{ not json')
      const named = path.join(home, 'elsewhere.json')
      writeFileSync(named, JSON.stringify(fixtureMachineSettings()))
      expect(await readMachineSettings({ env: { STEWARD_SETTINGS: named }, homedir: home })).toEqual(
        fixtureMachineSettings(),
      )
      expect(machineSettingsPath({ env: { STEWARD_SETTINGS: named }, homedir: home })).toBe(named)
      expect(machineSettingsPath({ env: {}, homedir: home })).toBe(path.join(home, '.steward', 'settings.json'))
    })
  })

  it('ST-34/AC-1: a missing file is an error naming it, and nothing is defaulted', async () => {
    await withTempHome(async (home) => {
      const filePath = path.join(home, '.steward', 'settings.json')
      const promise = readMachineSettings({ env: {}, homedir: home })
      await expect(promise).rejects.toThrow(filePath)
      await expect(promise).rejects.toThrow('file not found')
      const named = path.join(home, 'absent.json')
      await expect(readMachineSettings({ env: { STEWARD_SETTINGS: named }, homedir: home })).rejects.toThrow(named)
    })
  })

  it('ST-34/AC-1: invalid JSON, and JSON that is not an object, are errors naming the file', async () => {
    await withTempHome(async (home) => {
      const filePath = writeHomeFile(home, '{ not json')
      await expect(readMachineSettings({ env: {}, homedir: home })).rejects.toThrow(`${filePath}: invalid JSON`)
      writeHomeFile(home, '[]')
      await expect(readMachineSettings({ env: {}, homedir: home })).rejects.toThrow(`${filePath}: must be a JSON object`)
    })
  })
})

describe('ST-34/AC-2: the form of the file', () => {
  it('ST-34/AC-2: accepts a valid file and keeps the order of the choices', async () => {
    await withTempHome(async (home) => {
      const settings = changed((s) => {
        s.roles.reviewer.available = {
          zed: { tool: 'claude', model: 'opus', effort: 'max' },
          'a.b-c_1': { tool: 'claude', model: 'claude-sonnet-5-5', effort: 'low' },
        }
        s.roles.reviewer.default = 'zed'
      })
      writeHomeFile(home, JSON.stringify(settings))
      const read = await readMachineSettings({ env: {}, homedir: home })
      expect(read).toEqual(settings)
      expect(Object.keys(read.roles.reviewer.available)).toEqual(['zed', 'a.b-c_1'])
    })
  })

  it.each(['usageLimits', 'roles'])('ST-34/AC-2: rejects a missing %s and an unknown top-level key', async (key) => {
    await expectRejected(changed((s) => delete s[key]), `missing required key '${key}'`)
    await expectRejected({ ...fixtureMachineSettings(), extra: 1 }, "unrecognised key 'extra'")
  })

  it('ST-34/AC-2: usageLimits has the form ST-31 gave it, and is checked', async () => {
    await expectRejected({ ...fixtureMachineSettings(), usageLimits: [] }, "'usageLimits' must be an object")
    await expectRejected(changed((s) => { s.usageLimits.other = {} }), "unrecognised key 'usageLimits.other'")
    await expectRejected(changed((s) => delete s.usageLimits.reviewer), "missing required key 'usageLimits.reviewer'")
    await expectRejected(changed((s) => { s.usageLimits.coder = 70 }), "'usageLimits.coder' must be an object")
    await expectRejected(changed((s) => delete s.usageLimits.coder.weekly), "missing required key 'usageLimits.coder.weekly'")
    await expectRejected(changed((s) => { s.usageLimits.coder.extra = 1 }), "unrecognised key 'usageLimits.coder.extra'")
    for (const bad of [0, 101, 70.5, '70', null]) {
      await expectRejected(
        changed((s) => { s.usageLimits.reviewer.session = bad }),
        "'usageLimits.reviewer.session' must be an integer from 1 to 100",
      )
    }
  })

  it('ST-34/AC-2: accepts 1 and 100 for a limit', async () => {
    await withTempHome(async (home) => {
      const settings = changed((s) => { s.usageLimits.coder = { session: 1, weekly: 100 } })
      writeHomeFile(home, JSON.stringify(settings))
      expect((await readMachineSettings({ env: {}, homedir: home })).usageLimits).toEqual(settings.usageLimits)
    })
  })

  it('ST-34/AC-2: roles must be an object with exactly coder and reviewer', async () => {
    await expectRejected({ ...fixtureMachineSettings(), roles: [] }, "'roles' must be an object")
    await expectRejected(changed((s) => delete s.roles.reviewer), "missing required key 'roles.reviewer'")
    await expectRejected(changed((s) => { s.roles.planner = s.roles.coder }), "unrecognised key 'roles.planner'")
    await expectRejected(changed((s) => { s.roles.coder = 'sonnet' }), "'roles.coder' must be an object")
  })

  it.each(['coder', 'reviewer'])('ST-34/AC-2: roles.%s has exactly default and available', async (role) => {
    await expectRejected(changed((s) => delete s.roles[role].default), `missing required key 'roles.${role}.default'`)
    await expectRejected(changed((s) => delete s.roles[role].available), `missing required key 'roles.${role}.available'`)
    await expectRejected(changed((s) => { s.roles[role].extra = 1 }), `unrecognised key 'roles.${role}.extra'`)
  })

  it.each(['coder', 'reviewer'])('ST-34/AC-2: roles.%s.available must be a non-empty object', async (role) => {
    await expectRejected(changed((s) => { s.roles[role].available = {} }), `'roles.${role}.available' must be a non-empty object`)
    await expectRejected(changed((s) => { s.roles[role].available = [] }), `'roles.${role}.available' must be a non-empty object`)
  })

  it.each(['Opus', '-opus', 'has space', 'a/b', ''])('ST-34/AC-2: rejects %j as a choice name', async (name) => {
    await expectRejected(
      changed((s) => { s.roles.coder.available[name] = { tool: 'claude', model: 'opus', effort: 'low' } }),
      `'roles.coder.available.${name}'`,
    )
  })

  it.each(['tool', 'model', 'effort'])('ST-34/AC-2: a choice must have %s, and no key beyond tool, model and effort', async (key) => {
    await expectRejected(
      changed((s) => delete s.roles.reviewer.available.opus[key]),
      `missing required key 'roles.reviewer.available.opus.${key}'`,
    )
    await expectRejected(
      changed((s) => { s.roles.reviewer.available.opus.extra = 1 }),
      "unrecognised key 'roles.reviewer.available.opus.extra'",
    )
  })

  it('ST-34/AC-2: a choice must be an object', async () => {
    await expectRejected(changed((s) => { s.roles.coder.available.opus = 'opus' }), "'roles.coder.available.opus' must be an object")
  })

  it('ST-34/AC-2: tool must be "claude", the only tool until ST-32', async () => {
    for (const bad of ['codex', 'Claude', '', null]) {
      await expectRejected(
        changed((s) => { s.roles.reviewer.available.opus.tool = bad }),
        "'roles.reviewer.available.opus.tool' must be one of",
      )
    }
  })

  it('ST-34/AC-2: model must be a non-empty string', async () => {
    for (const bad of ['', '  ', 5, null]) {
      await expectRejected(
        changed((s) => { s.roles.coder.available.sonnet.model = bad }),
        "'roles.coder.available.sonnet.model' must be a non-empty string",
      )
    }
  })

  it('ST-34/AC-2: effort must be one of low, medium, high, xhigh and max', async () => {
    await withTempHome(async (home) => {
      for (const good of ['low', 'medium', 'high', 'xhigh', 'max']) {
        writeHomeFile(home, JSON.stringify(changed((s) => { s.roles.coder.available.sonnet.effort = good })))
        await expect(readMachineSettings({ env: {}, homedir: home })).resolves.toBeTruthy()
      }
    })
    for (const bad of ['ultra', 'High', '', 3, null]) {
      await expectRejected(
        changed((s) => { s.roles.reviewer.available.opus.effort = bad }),
        "'roles.reviewer.available.opus.effort' must be one of",
      )
    }
  })

  it.each(['coder', 'reviewer'])('ST-34/AC-2: roles.%s.default must name a key of available', async (role) => {
    await expectRejected(
      changed((s) => { s.roles[role].default = 'haiku' }),
      `'roles.${role}.default' must name a key of 'roles.${role}.available'`,
    )
    await expectRejected(changed((s) => { s.roles[role].default = null }), `'roles.${role}.default'`)
    await expectRejected(changed((s) => { s.roles[role].default = 'toString' }), `'roles.${role}.default'`)
  })
})

describe('ST-34/AC-4: coderChoice', () => {
  it('ST-34/AC-4: a name is that choice, null is the default, an unknown name is null', () => {
    const machine = fixtureMachineSettings()
    expect(coderChoice(machine, 'opus')).toEqual({ name: 'opus', tool: 'claude', model: 'opus', effort: 'high' })
    expect(coderChoice(machine, null)).toEqual({ name: 'sonnet', tool: 'claude', model: 'sonnet', effort: 'medium' })
    expect(coderChoice(machine, 'haiku')).toBeNull()
    expect(coderChoice(machine, 'toString')).toBeNull()
    expect(coderChoice(machine, 5)).toBeNull()
  })
})
