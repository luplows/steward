import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIRS = [path.join(ROOT, '.github', 'workflows'), path.join(ROOT, 'templates', 'workflows')]

const workflowFiles = (dir) => {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.yml')).sort().map((name) => ({ dir, name, text: readFileSync(path.join(dir, name), 'utf8') }))
  } catch {
    return []
  }
}

const unquote = (value) => value.replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2')

/**
 * The jobs of a workflow file and their steps, read line by line (no YAML library is a dependency):
 * `[{ job, steps: [{ name, uses, run, with }] }]`. `run` is the command text, a folded or literal
 * block included. Reads `\n` and `\r\n` line endings alike.
 */
function readJobs(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line))
  if (start < 0) return []
  const jobs = []
  let job = null
  let step = null
  let inSteps = false
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue
    if (!line.startsWith(' ')) break
    const header = /^ {2}([\w-]+):\s*$/.exec(line)
    if (header) {
      job = { job: header[1], steps: [] }
      jobs.push(job)
      step = null
      inSteps = false
      continue
    }
    if (!job) continue
    if (/^ {4}steps:\s*$/.test(line)) {
      inSteps = true
      continue
    }
    if (/^ {4}[\w-]+:/.test(line)) {
      inSteps = false
      continue
    }
    if (!inSteps) continue
    const dash = /^ {6}- (.*)$/.exec(line)
    if (dash) {
      step = { lines: [`        ${dash[1]}`] }
      job.steps.push(step)
    } else if (step) {
      step.lines.push(line)
    }
  }
  return jobs.map(({ job, steps }) => ({ job, steps: steps.map((s) => parseStep(s.lines)) }))
}

function parseStep(lines) {
  const step = { name: undefined, uses: undefined, run: undefined, with: {} }
  let block = null
  let withBlock = false
  for (const line of lines) {
    const key = /^ {8}([\w-]+):\s*(.*)$/.exec(line)
    if (key) {
      block = null
      withBlock = key[1] === 'with'
      const [, name, value] = key
      if (name === 'name' || name === 'uses') step[name] = unquote(value)
      else if (name === 'run') {
        if (/^[>|][+-]?$/.test(value.trim())) {
          block = { folded: value.trim().startsWith('>'), parts: [] }
          step.run = block
        } else step.run = unquote(value)
      }
      continue
    }
    const child = /^ {10}([\w-]+):\s*(.*)$/.exec(line)
    if (withBlock && child) step.with[child[1]] = unquote(child[2])
    else if (block && /^ {10}\S/.test(line)) block.parts.push(line.trim())
  }
  if (step.run && typeof step.run === 'object') step.run = step.run.parts.join(step.run.folded ? ' ' : '\n')
  return step
}

/** Whether a step's command starts a line with `node` or `npx`. */
const runsNode = (step) => typeof step.run === 'string' && step.run.split('\n').some((line) => /^(node|npx)(\s|$)/.test(line.trim()))

const majorOf = (version) => {
  const match = /^v?(\d+)/.exec(String(version).trim())
  return match ? Number(match[1]) : null
}

/**
 * What is wrong with a workflow file's jobs: each job with a `node` or `npx` step needs an earlier
 * `actions/setup-node` step whose `node-version` has major version `major`, with no `cache` unless
 * `cacheAllowed`.
 */
function problemsIn(text, { major, cacheAllowed }) {
  const problems = []
  for (const { job, steps } of readJobs(text)) {
    const first = steps.findIndex(runsNode)
    if (first < 0) continue
    const setups = steps.slice(0, first).filter((step) => (step.uses ?? '').startsWith('actions/setup-node@'))
    if (setups.length === 0) problems.push(`${job}: no actions/setup-node step before its first node or npx step`)
    for (const setup of setups) {
      if (majorOf(setup.with['node-version']) !== major) problems.push(`${job}: node-version is ${setup.with['node-version']}, not ${major}`)
      if (!cacheAllowed && 'cache' in setup.with) problems.push(`${job}: the setup-node step has a cache`)
    }
  }
  return problems
}

const engines = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).engines?.node
const MAJOR = majorOf(engines)

describe('ST-49/AC-1: package.json declares the one Node version', () => {
  it('ST-49/AC-1: engines.node is "24.x", and the lock file\'s root entry carries the same engines', () => {
    expect(engines).toBe('24.x')
    const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
    expect(lock.packages[''].engines).toEqual({ node: '24.x' })
  })
})

describe('ST-49/AC-4: every job that runs node or npx sets up the declared Node first', () => {
  const files = DIRS.flatMap(workflowFiles)

  it('ST-49/AC-4: finds workflow files in both folders', () => {
    for (const dir of DIRS) expect(workflowFiles(dir).length).toBeGreaterThan(0)
    expect(MAJOR).toBe(24)
  })

  it('ST-49/AC-4: finds the jobs and their steps in the files it reads', () => {
    const jobs = files.flatMap((file) => readJobs(file.text).map((j) => `${file.name}:${j.job}`))
    expect(jobs).toEqual(expect.arrayContaining(['ci.yml:test', 'review-gate.yml:pending', 'review-gate.yml:verdict', 'land-approved.yml:land', 'inspection.yml:inspect']))
    for (const file of files) for (const { steps } of readJobs(file.text)) expect(steps.some(runsNode)).toBe(true)
  })

  it.each(files.map((file) => [path.relative(ROOT, path.join(file.dir, file.name)).split(path.sep).join('/'), file]))(
    'ST-49/AC-2, ST-49/AC-3: %s',
    (_label, file) => {
      expect(problemsIn(file.text, { major: MAJOR, cacheAllowed: file.name === 'ci.yml' && file.dir.includes('.github') })).toEqual([])
    },
  )

  it('ST-49/AC-2: ci.yml\'s setup step keeps its name and its cache, and is the only one with a cache', () => {
    const [ci] = readJobs(readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'))
    const setup = ci.steps.find((step) => (step.uses ?? '').startsWith('actions/setup-node@'))
    expect(setup).toMatchObject({ name: 'Setup: Node', uses: 'actions/setup-node@v4', with: { 'node-version': '24', cache: 'npm' } })
    for (const file of files) {
      for (const { steps } of readJobs(file.text)) {
        for (const step of steps.filter((s) => (s.uses ?? '').startsWith('actions/setup-node@') && 'cache' in s.with)) {
          expect({ file: file.name, dir: file.dir.includes('templates'), step }).toEqual({ file: 'ci.yml', dir: false, step })
        }
      }
    }
  })

  it('ST-49/AC-3: a thin template\'s setup step names 24 literally, with no placeholder', () => {
    for (const file of workflowFiles(DIRS[1])) {
      for (const { steps } of readJobs(file.text)) {
        const setup = steps.find((step) => (step.uses ?? '').startsWith('actions/setup-node@'))
        expect(setup.with).toEqual({ 'node-version': '24' })
        expect(JSON.stringify(setup)).not.toContain('{{')
      }
    }
  })

  const SETUP = '      - uses: actions/setup-node@v4\n        with:\n          node-version: 24\n'
  const workflow = (steps) => `name: X\n\non:\n  push:\n\njobs:\n  work:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`
  const OPTIONS = { major: 24, cacheAllowed: false }

  it('ST-49/AC-4: passes a job with the setup step first, and a job that runs no node or npx', () => {
    expect(problemsIn(workflow(`${SETUP}      - run: node a.mjs\n`), OPTIONS)).toEqual([])
    expect(problemsIn(workflow('      - run: echo hi\n'), OPTIONS)).toEqual([])
  })

  it('ST-49/AC-4: fails on a job with no setup step', () => {
    expect(problemsIn(workflow('      - run: node a.mjs\n'), OPTIONS)).toHaveLength(1)
  })

  it('ST-49/AC-4: fails on a job whose setup step comes after the first node step', () => {
    expect(problemsIn(workflow(`      - run: node a.mjs\n${SETUP}`), OPTIONS)).toHaveLength(1)
  })

  it('ST-49/AC-4: fails on a setup step whose version is 22', () => {
    expect(problemsIn(workflow(`${SETUP.replace('24', '22')}      - run: node a.mjs\n`), OPTIONS)).toHaveLength(1)
  })

  it('ST-49/AC-4: fails on a thin template\'s setup step with a cache, and allows ci.yml\'s', () => {
    const cached = workflow(`${SETUP}          cache: npm\n      - run: node a.mjs\n`)
    expect(problemsIn(cached, OPTIONS)).toHaveLength(1)
    expect(problemsIn(cached, { major: 24, cacheAllowed: true })).toEqual([])
  })

  it('ST-49/AC-4: sees a folded `run: >-` command and a command after a literal block line', () => {
    expect(problemsIn(workflow('      - name: x\n        run: >-\n          npx --yes steward\n          inspect\n'), OPTIONS)).toHaveLength(1)
    expect(problemsIn(workflow('      - run: |\n          echo hi\n          node a.mjs\n'), OPTIONS)).toHaveLength(1)
  })

  it('ST-49/AC-4: reads `\\r\\n` line endings as it reads `\\n`', () => {
    const text = workflow('      - run: node a.mjs\n')
    expect(problemsIn(text.replaceAll('\n', '\r\n'), OPTIONS)).toEqual(problemsIn(text, OPTIONS))
    const good = workflow(`${SETUP}      - run: >-\n          node a.mjs\n`).replaceAll('\n', '\r\n')
    expect(problemsIn(good, OPTIONS)).toEqual([])
  })

  it('ST-49/AC-4: judges each job on its own', () => {
    const two = `${workflow(`${SETUP}      - run: node a.mjs\n`)}  other:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node b.mjs\n`
    expect(problemsIn(two, OPTIONS)).toEqual([expect.stringMatching(/^other: no actions\/setup-node/)])
  })
})
