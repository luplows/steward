// @vitest-environment node

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { coordinatorPath, readRecord, runCoordinator, stopRequestPath } from './coordinator.mjs'
import { projectsPath, readProjects } from './project.mjs'
import { interruptRunning, readReviews, reviewsPath } from './review-admission.mjs'
import { readStateFile, writeStateFile } from './state-file.mjs'

// In a file of its own because it replaces these three of `node:fs` for what it imports. Each
// passes through until a test sets its hook, which throws to make the call fail.
const hooks = vi.hoisted(() => ({ writeFileSync: null, renameSync: null, rmSync: null }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal()
  const hooked = (name) => (...args) => {
    hooks[name]?.(...args)
    return fs[name](...args)
  }
  return { ...fs, writeFileSync: hooked('writeFileSync'), renameSync: hooked('renameSync'), rmSync: hooked('rmSync') }
})
const actual = await vi.importActual('node:fs')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// Every test works under a temporary folder: the real `~/.steward/` is never read or written.
let base
beforeAll(() => { base = mkdtempSync(path.join(tmpdir(), 'steward-state-file-')) })
afterAll(() => { rmSync(base, { recursive: true, force: true }) })
afterEach(() => { Object.assign(hooks, { writeFileSync: null, renameSync: null, rmSync: null }) })

let counter = 0
const freshHome = () => {
  const dir = path.join(base, `home-${++counter}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
const freshFile = () => path.join(freshHome(), 'state.json')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, ms = 15_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await sleep(10)
  }
}

/** The way each step fails. A write gets part way first, so that a direct write would be caught. */
const FAILURES = [
  ['the write of the temporary file', 'part way through the write', (file) => {
    hooks.writeFileSync = (target) => {
      if (!String(target).startsWith(file)) return
      actual.writeFileSync(target, '{ "partial": [')
      throw Object.assign(new Error('part way through the write'), { code: 'ENOSPC' })
    }
  }],
  ['the rename', 'the rename failed', (file) => {
    hooks.renameSync = (from) => {
      if (String(from).startsWith(file)) throw Object.assign(new Error('the rename failed'), { code: 'EPERM' })
    }
  }],
]

describe('ST-66/AC-1: one module reads and writes a JSON state file', () => {
  it('ST-66/AC-1: a read with no file says so, with undefined', () => {
    expect(readStateFile(freshFile())).toBeUndefined()
  })

  it('ST-66/AC-1: a value written reads back, the folder is created, and the bytes are two-space JSON and a newline', () => {
    const file = path.join(freshHome(), 'a', 'b', 'state.json')
    const value = { projects: [{ repo: 'crew/client' }] }
    writeStateFile(file, value)
    expect(readStateFile(file)).toEqual(value)
    expect(readFileSync(file, 'utf8')).toBe(`${JSON.stringify(value, null, 2)}\n`)
    expect(readdirSync(path.dirname(file))).toEqual(['state.json'])
  })

  it('ST-66/AC-1: the read decides nothing about what a valid record is, and a file holding null is not "no file"', () => {
    const file = freshFile()
    for (const value of [null, 5, [], { anything: true }]) {
      actual.writeFileSync(file, JSON.stringify(value))
      expect(readStateFile(file)).toEqual(value)
    }
  })

  it('ST-66/AC-1: a read of a file that is not JSON throws a SyntaxError', () => {
    const file = freshFile()
    actual.writeFileSync(file, '{ not json')
    expect(() => readStateFile(file)).toThrow(SyntaxError)
  })

  it('ST-66/AC-1: any other failure to read throws as it is, and is not a SyntaxError', () => {
    const dir = freshHome()
    let thrown
    try {
      readStateFile(dir)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).not.toBeInstanceOf(SyntaxError)
    expect(thrown.code).toBe('EISDIR')
  })

  it('ST-66/AC-1: the write writes the temporary file in the target\'s folder and renames it over the target, never opening the target for writing', () => {
    const file = freshFile()
    actual.writeFileSync(file, '{"before":true}')
    const written = []
    const renamed = []
    hooks.writeFileSync = (target) => { written.push(String(target)) }
    hooks.renameSync = (from, to) => { renamed.push([String(from), String(to)]) }
    writeStateFile(file, { after: true })
    expect(written).toEqual([`${file}.tmp`])
    expect(renamed).toEqual([[`${file}.tmp`, file]])
    expect(readStateFile(file)).toEqual({ after: true })
  })

  it('a temporary file left by a process killed during a write is never read, and the next write replaces it', () => {
    const file = freshFile()
    actual.writeFileSync(file, '{"kept":true}')
    actual.writeFileSync(`${file}.tmp`, '{ "partial": [')
    expect(readStateFile(file)).toEqual({ kept: true })
    writeStateFile(file, { next: true })
    expect(readStateFile(file)).toEqual({ next: true })
    expect(readdirSync(path.dirname(file))).toEqual(['state.json'])
  })
})

describe('ST-66/AC-2: a failed write leaves the file as it was', () => {
  for (const [name, message, makeItFail] of FAILURES) {
    it(`ST-66/AC-2: when ${name} fails: the target is byte for byte unchanged, no temporary file stays, and the original error is thrown`, () => {
      const file = freshFile()
      const before = '{  "kept" :\n true }'
      actual.writeFileSync(file, before)
      makeItFail(file)
      expect(() => writeStateFile(file, { lost: true })).toThrow(message)
      expect(readFileSync(file, 'utf8')).toBe(before)
      expect(readdirSync(path.dirname(file))).toEqual(['state.json'])
    })

    it(`ST-66/AC-2: when ${name} fails and there is no target yet: there is still none, and no temporary file stays`, () => {
      const file = freshFile()
      makeItFail(file)
      expect(() => writeStateFile(file, { lost: true })).toThrow(message)
      expect(readdirSync(path.dirname(file))).toEqual([])
    })

    it(`ST-66/AC-2: when ${name} fails and the temporary file cannot be removed either, the error thrown is still the original`, () => {
      const file = freshFile()
      makeItFail(file)
      hooks.rmSync = (target) => {
        if (String(target).startsWith(file)) throw new Error('the removal failed')
      }
      expect(() => writeStateFile(file, { lost: true })).toThrow(message)
    })
  }
})

describe('ST-66/AC-3: all three files use it', () => {
  const lines = (name) => readFileSync(path.join(ROOT, 'scripts', 'dispatch', name), 'utf8').split('\n')
  const direct = (name) => lines(name).filter((line) => /\b(readFile|readFileSync|writeFile|writeFileSync)\b/.test(line))

  it('ST-66/AC-3: review-admission.mjs and project.mjs name no direct read or write', () => {
    expect(direct('review-admission.mjs')).toEqual([])
    expect(direct('project.mjs')).toEqual([])
  })

  it('ST-66/AC-3: coordinator.mjs names one, which writes the stop request and not its record', () => {
    expect(direct('coordinator.mjs')).toEqual([
      "import { existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs'",
      "    writeFileSync(stopRequestPath(homedir), `${new Date().toISOString()}\\n`, 'utf8')",
    ])
  })

  it('ST-66/AC-3: all three import the module, and writeReviews\' own temporary-file logic is gone', () => {
    for (const name of ['review-admission.mjs', 'project.mjs', 'coordinator.mjs']) {
      expect(lines(name)).toContain("import { readStateFile, writeStateFile } from './state-file.mjs'")
    }
    expect(lines('review-admission.mjs').filter((line) => /renameSync|rmSync|\.tmp|writeReviews|node:fs/.test(line))).toEqual([])
  })
})

describe('ST-66/AC-4: each reader\'s results and messages are unchanged', () => {
  const put = (file, text) => {
    mkdirSync(path.dirname(file), { recursive: true })
    actual.writeFileSync(file, text)
  }
  const jsonError = (text) => {
    try {
      JSON.parse(text)
    } catch (error) {
      return error.message
    }
    throw new Error('it parsed')
  }

  it('ST-66/AC-4: with no file, reviews and projects read as empty and the coordinator\'s record as null', async () => {
    const home = freshHome()
    expect(readReviews(reviewsPath(home))).toEqual([])
    expect(await readProjects(projectsPath(home))).toEqual([])
    expect(readRecord(coordinatorPath(home))).toBeNull()
  })

  for (const text of ['{ not json', '']) {
    it(`ST-66/AC-4: invalid JSON (${JSON.stringify(text)}) gets each reader's own message`, async () => {
      const home = freshHome()
      const reviews = reviewsPath(home)
      const projects = projectsPath(home)
      const record = coordinatorPath(home)
      for (const file of [reviews, projects, record]) put(file, text)
      expect(() => readReviews(reviews)).toThrow(new Error(`${reviews} is malformed: it is not valid JSON (${jsonError(text)}). Fix or remove it; until then no automatic review starts.`))
      await expect(readProjects(projects)).rejects.toThrow(new Error(`${projects} is malformed: it is not valid JSON (${jsonError(text)}). Fix or remove it; until then no project counts as activated.`))
      expect(() => readRecord(record)).toThrow(new Error(`${record} is not a coordinator record steward wrote. Stop the coordinator it names, if any, and remove the file.`))
    })
  }

  for (const text of ['null', '5', '[]', '{}', '{"pid":"1","startedAt":"t","state":"running"}']) {
    it(`ST-66/AC-4: JSON that is no coordinator record (${text}) gets its message`, () => {
      const record = coordinatorPath(freshHome())
      put(record, text)
      expect(() => readRecord(record)).toThrow(new Error(`${record} is not a coordinator record steward wrote. Stop the coordinator it names, if any, and remove the file.`))
    })
  }

  it('ST-66/AC-4: JSON of the wrong shape gets each validating reader\'s own message, null among it', async () => {
    const home = freshHome()
    const reviews = reviewsPath(home)
    const projects = projectsPath(home)
    put(reviews, 'null')
    put(projects, 'null')
    expect(() => readReviews(reviews)).toThrow(new Error(`${reviews} is malformed: it must be an object whose only key, "reviews", is a list. Fix or remove it; until then no automatic review starts.`))
    await expect(readProjects(projects)).rejects.toThrow(new Error(`${projects} is malformed: it must be an object whose only key, "projects", is a list. Fix or remove it; until then no project counts as activated.`))
  })

  it('ST-66/AC-4: a read that fails for another reason throws as it is, from each reader', async () => {
    const home = freshHome()
    const reviews = reviewsPath(home)
    const projects = projectsPath(home)
    const record = coordinatorPath(home)
    for (const file of [reviews, projects, record]) mkdirSync(file, { recursive: true })
    expect(() => readReviews(reviews)).toThrow(expect.objectContaining({ code: 'EISDIR' }))
    await expect(readProjects(projects)).rejects.toMatchObject({ code: 'EISDIR' })
    expect(() => readRecord(record)).toThrow(expect.objectContaining({ code: 'EISDIR' }))
  })

  it('ST-66/AC-4: a file from before this story, as it was written then, reads as it did, and a write keeps the format', () => {
    const home = freshHome()
    const entry = { repo: 'crew/client', number: 7, headSha: 'a'.repeat(40), state: 'running', startedAt: '2026-11-02T10:00:00.000Z' }
    const file = reviewsPath(home)
    put(file, `${JSON.stringify({ reviews: [entry] }, null, 2)}\n`)
    expect(readReviews(file)).toEqual([entry])
    const now = () => new Date('2026-11-02T11:00:00.000Z')
    interruptRunning({ homedir: home, now })
    const moved = { ...entry, state: 'ended', endedAt: now().toISOString(), result: { status: 'interrupted' } }
    expect(readFileSync(file, 'utf8')).toBe(`${JSON.stringify({ reviews: [moved] }, null, 2)}\n`)
  })
})

describe('ST-66/AC-3: the coordinator\'s record goes through the module, with its failures handled as before', () => {
  const stateFiles = (home) => readdirSync(path.dirname(coordinatorPath(home))).sort()

  it('ST-66/AC-3: its first write keeps the record\'s location and format', async () => {
    const home = freshHome()
    const coordinator = runCoordinator({ homedir: home, pid: 4321, now: () => new Date('2026-11-02T10:00:00.000Z'), pollMs: 10 })
    expect(readFileSync(coordinatorPath(home), 'utf8')).toBe(`${JSON.stringify({ pid: 4321, startedAt: '2026-11-02T10:00:00.000Z', state: 'running' }, null, 2)}\n`)
    coordinator.fail(new Error('over'))
    await coordinator.done
  })

  for (const [name, message, makeItFail] of FAILURES) {
    it(`ST-66/AC-3: when ${name} fails at its first write: runCoordinator throws that error, and a record already there is byte for byte as it was`, () => {
      const home = freshHome()
      const file = coordinatorPath(home)
      mkdirSync(path.dirname(file), { recursive: true })
      const before = '{"pid":1,"startedAt":"then","state":"running"}'
      actual.writeFileSync(file, before)
      makeItFail(file)
      expect(() => runCoordinator({ homedir: home, pollMs: 10 })).toThrow(message)
      expect(readFileSync(file, 'utf8')).toBe(before)
      expect(stateFiles(home)).toEqual(['coordinator.json'])
    })

    it(`ST-66/AC-3: when ${name} fails at the stopping write: the record stays as it was, admission closes, and the coordinator ends with that error once its work has finished`, async () => {
      const home = freshHome()
      const file = coordinatorPath(home)
      const coordinator = runCoordinator({ homedir: home, pollMs: 10 })
      const before = readFileSync(file, 'utf8')
      let release
      const job = new Promise((resolve) => { release = resolve })
      expect(coordinator.admit(() => job)).toBe(true)

      makeItFail(file)
      actual.writeFileSync(stopRequestPath(home), 'stop\n')
      await until(() => !coordinator.admit(() => {}))
      await until(() => !existsSync(stopRequestPath(home)))
      expect(readFileSync(file, 'utf8')).toBe(before)
      expect(stateFiles(home)).toEqual(['coordinator.json'])
      expect(readRecord(file).state).toBe('running')

      release()
      expect((await coordinator.done).message).toBe(message)
      expect(existsSync(file)).toBe(false)
    })
  }
})

describe('ST-66/AC-6: the docs', () => {
  const read = (...rel) => readFileSync(path.join(ROOT, ...rel), 'utf8')

  it('ST-66/AC-6: no Planned marker names ST-66, and its decision and what would reopen it stay', () => {
    const design = read('docs', 'agent-workflow-design.md')
    expect(design).not.toMatch(/\*\*Planned \([^)]*\bST-66\b/)
    const text = design.replace(/\s+/g, ' ')
    expect(text).toContain('Every JSON file under `~/.steward/state/` is read and written through one small module, `scripts/dispatch/state-file.mjs`')
    expect(text).toContain('The crew would revisit a database at the first story that needs two writers at once')
  })

  it('ST-66/AC-6: docs/user-config.md says how the state files are written', () => {
    const text = read('docs', 'user-config.md').replace(/\s+/g, ' ')
    expect(text).toContain('`scripts/dispatch/state-file.mjs`: a write goes to a temporary file beside its target, `<file>.tmp`, and is renamed over it, so a write that fails leaves the file as it was.')
  })
})
