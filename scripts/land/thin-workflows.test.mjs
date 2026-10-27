import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMANDS } from '../dispatch/cli.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8')

const FILES = ['review-gate.yml', 'land-approved.yml']
const OWN = (file) => read('.github', 'workflows', file)
const THIN = (file) => read('templates', 'workflows', file)

// A checkout step of steward's own file: optional comment lines, the step (with an optional `with:`
// block), and the blank line after it.
const CHECKOUT_STEP =
  /(?: {6}#[^\n]*\n)*      - name: Check out steward[^\n]*\n        uses: actions\/checkout@v4\n(?: {8}with:\n(?: {10}[^\n]*\n)+)?\n/g
// The condition on the `pending` job's step running `mark-pending`, with its comment lines: it runs
// only when the base holds the command's module, which is part of how steward's own file starts it.
const GUARD = /(?: {8}#[^\n]*\n)* {8}if: hashFiles\([^\n]*\n/g
const OWN_START = 'node scripts/dispatch/cli.mjs '
const THIN_START = 'npx --yes --package=github:luplows/steward#v{{STEWARD_VERSION}} steward '

/**
 * Both files with the lines that start steward made the same: the checkout step that steward's
 * own file starts from, and the command prefix that each file puts before a command.
 */
function withoutStart(text, start) {
  return text.replaceAll(CHECKOUT_STEP, () => '').replaceAll(GUARD, () => '').replaceAll(start, () => 'STEWARD ')
}

/** The first line at which the two texts differ, as `{ line, own, thin }`, or null. */
function firstDifference(own, thin) {
  const a = withoutStart(own, OWN_START).split('\n')
  const b = withoutStart(thin, THIN_START).split('\n')
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return { line: i + 1, own: a[i], thin: b[i] }
  }
  return null
}

const commandsIn = (text, start) => [...text.matchAll(new RegExp(`run: ${start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\S+)$`, 'gm'))].map((m) => m[1])

describe('ST-42/AC-3: steward\'s own workflow files run steward\'s commands from its checkout, and hold no other logic', () => {
  it('ST-42/AC-3: keep their file names and workflow names', () => {
    expect(OWN('review-gate.yml')).toMatch(/^name: Review gate$/m)
    expect(OWN('land-approved.yml')).toMatch(/^name: Land approved PRs$/m)
  })

  it('ST-42/AC-3: every run: line is `node scripts/dispatch/cli.mjs <command>` for a command in COMMANDS', () => {
    for (const file of FILES) {
      const runs = [...OWN(file).matchAll(/^\s*run:(.*)$/gm)].map((m) => m[1].trim())
      expect(runs.length).toBeGreaterThan(0)
      for (const run of runs) {
        expect(run.startsWith(OWN_START)).toBe(true)
        expect(Object.keys(COMMANDS)).toContain(run.slice(OWN_START.length))
      }
    }
  })

  it('ST-42/AC-3: no step is a multi-line script', () => {
    for (const file of FILES) expect(OWN(file)).not.toMatch(/run: [|>]/)
  })

  it('ST-42/AC-3: the commands are the gate\'s and the runway\'s, in the jobs that ran them before', () => {
    expect(commandsIn(OWN('review-gate.yml'), OWN_START)).toEqual(['mark-pending', 'apply-verdict', 'apply-review-blocked'])
    expect(commandsIn(OWN('land-approved.yml'), OWN_START)).toEqual(['runway', 'delete-merged-heads'])
  })

  it('ST-42/AC-3: each job starts steward from a checkout of the repository', () => {
    for (const file of FILES) {
      const text = OWN(file)
      const jobs = text.slice(text.indexOf('\njobs:\n')).split(/^ {2}(?=[a-z][\w-]*:\s*$)/m).slice(1)
      expect(jobs.length).toBeGreaterThan(0)
      for (const job of jobs) expect(job).toContain('uses: actions/checkout@v4')
    }
  })

  it('ST-42/AC-3: the pull_request `pending` job checks out the pull request\'s base, never its merge tree', () => {
    const text = OWN('review-gate.yml')
    const pending = text.slice(text.indexOf('\n  pending:\n'), text.indexOf('\n  verdict:\n'))
    expect(pending).toContain('if: github.event_name == \'pull_request\'')
    expect(pending).toMatch(/uses: actions\/checkout@v4\n {8}with:\n {10}ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}\n/)
    // The step running mark-pending runs only when the base holds the module (the real path).
    const guard = "if: hashFiles('scripts/land/mark-pending.mjs') != ''"
    const step = pending.slice(pending.indexOf('- name: Mark review pending'))
    expect(step).toContain(guard)
    expect(step.indexOf(guard)).toBeLessThan(step.indexOf('run: node scripts/dispatch/cli.mjs mark-pending'))
    expect(existsSync(path.join(ROOT, 'scripts', 'land', 'mark-pending.mjs'))).toBe(true)
    // The thin file has neither the checkout nor the condition.
    expect(THIN('review-gate.yml')).not.toContain('hashFiles')
    // No checkout in the file may name the pull request's head or merge ref.
    expect(text).not.toMatch(/ref: .*(head|merge)/)
  })
})

describe('ST-42/AC-4: the package carries the thin files a project uses', () => {
  it('ST-42/AC-4: a review-gate.yml and a land-approved.yml, with the same names as steward\'s own', () => {
    expect(THIN('review-gate.yml')).toMatch(/^name: Review gate$/m)
    expect(THIN('land-approved.yml')).toMatch(/^name: Land approved PRs$/m)
  })

  it('ST-42/AC-4: every run: line starts steward from the package at the pinned tag, and runs the same commands', () => {
    for (const file of FILES) {
      const runs = [...THIN(file).matchAll(/^\s*run:(.*)$/gm)].map((m) => m[1].trim())
      expect(runs.length).toBeGreaterThan(0)
      for (const run of runs) {
        expect(run.startsWith(THIN_START)).toBe(true)
        expect(Object.keys(COMMANDS)).toContain(run.slice(THIN_START.length))
      }
      expect(commandsIn(THIN(file), THIN_START)).toEqual(commandsIn(OWN(file), OWN_START))
    }
  })

  it('ST-42/AC-4: the tag is one placeholder, only in the lines that start steward', () => {
    for (const file of FILES) {
      const text = THIN(file)
      expect(text.match(/\{\{[A-Z_]+\}\}/g).every((placeholder) => placeholder === '{{STEWARD_VERSION}}')).toBe(true)
      const lines = text.split('\n').filter((line) => line.includes('{{STEWARD_VERSION}}'))
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) expect(line).toContain(`run: ${THIN_START}`)
    }
  })

  it('ST-42/AC-4: neither file checks out the project or installs its dependencies', () => {
    for (const file of FILES) {
      const text = THIN(file)
      expect(text).not.toMatch(/actions\/checkout/)
      expect(text).not.toMatch(/npm ci|npm install/)
    }
  })

  it('ST-42/AC-4: its placeholder is a valid YAML plain scalar: the line is `run:` then text with no ": " or " #"', () => {
    for (const file of FILES) {
      for (const line of THIN(file).split('\n').filter((l) => l.includes('{{STEWARD_VERSION}}'))) {
        expect(line.slice(line.indexOf('run:') + 4)).not.toMatch(/: | #/)
      }
    }
  })
})

describe('ST-42/AC-5: steward\'s own files and the thin files differ only in how steward is started', () => {
  it.each(FILES)('ST-42/AC-5: %s', (file) => {
    expect(firstDifference(OWN(file), THIN(file))).toBeNull()
  })

  it('ST-42/AC-5: fails on a thin file with a changed permission', () => {
    const changed = THIN('review-gate.yml').replace('statuses: write', () => 'statuses: read')
    expect(changed).not.toBe(THIN('review-gate.yml'))
    expect(firstDifference(OWN('review-gate.yml'), changed)).toMatchObject({ own: '  statuses: write', thin: '  statuses: read' })
  })

  it('ST-42/AC-5: fails on a thin file with a changed trigger', () => {
    const changed = THIN('review-gate.yml').replace('types: [created, edited]', () => 'types: [created]')
    expect(changed).not.toBe(THIN('review-gate.yml'))
    expect(firstDifference(OWN('review-gate.yml'), changed)).not.toBeNull()
    const landing = THIN('land-approved.yml').replace('workflow_dispatch:', () => 'workflow_dispatch:\n  schedule:')
    expect(firstDifference(OWN('land-approved.yml'), landing)).not.toBeNull()
  })

  it('ST-42/AC-5: fails on a thin file that runs a different command, or whose job is missing a step', () => {
    const other = THIN('land-approved.yml').replace(`${THIN_START}runway`, () => `${THIN_START}land`)
    expect(firstDifference(OWN('land-approved.yml'), other)).not.toBeNull()
    const lost = THIN('land-approved.yml').replace(/ {6}- name: Delete head branches[\s\S]*$/, () => '')
    expect(firstDifference(OWN('land-approved.yml'), lost)).not.toBeNull()
  })

  it('ST-49/AC-5: fails on a thin file that lacks the Node set-up step, or sets up another version', () => {
    const setup = / {6}- name: Set up Node\n(?: {8}[^\n]*\n)+\n/
    for (const file of FILES) {
      const lost = THIN(file).replace(setup, () => '')
      expect(lost).not.toBe(THIN(file))
      expect(firstDifference(OWN(file), lost)).not.toBeNull()
      const other = THIN(file).replace('node-version: 24', () => 'node-version: 22')
      expect(firstDifference(OWN(file), other)).not.toBeNull()
    }
  })

  it('ST-42/AC-5: fails on an own file that carries a step the thin file lacks, besides the checkout', () => {
    const extra = OWN('land-approved.yml').replace('        run: node scripts/dispatch/cli.mjs runway', () => '        run: node scripts/dispatch/cli.mjs runway\n      - run: echo hi')
    expect(firstDifference(extra, THIN('land-approved.yml'))).not.toBeNull()
  })
})

describe('ST-42/AC-6: no comment makes a statement particular to steward\'s repository', () => {
  const ALL = FILES.flatMap((file) => [OWN(file), THIN(file)])

  it('ST-42/AC-6: no mention of a file steward\'s repository has and another project does not', () => {
    for (const text of ALL) {
      expect(text).not.toMatch(/Open-Questions\.md|Completed-Questions\.md/)
      expect(text).not.toMatch(/\bOQ-\d+/)
      expect(text).not.toMatch(/\bST-\d+/)
      expect(text).not.toMatch(/tower-workshop-paths/)
    }
  })

  it('ST-42/AC-6: no comment narrates this repository\'s history: a past state, a date, an issue number or a measured rate', () => {
    const history = [
      /\bused to\b/i, /\bformerly\b/i, /\bno longer\b/i, /\bwidened\b/i, /\bwas `/,
      /\bdelivered roughly\b/i, /\bone run every\b/i, /\d{4}-\d{2}-\d{2}/, /(?:^|\s)#\d+\b/, /\d+% of\b/,
    ]
    for (const text of ALL) {
      const comments = text.split('\n').filter((line) => line.trimStart().startsWith('#'))
      expect(comments.length).toBeGreaterThan(10)
      for (const line of comments) {
        const hit = history.find((pattern) => pattern.test(line))
        expect({ line, hit }).toEqual({ line, hit: undefined })
      }
    }
  })

  it('ST-42/AC-6: no claim that the repository is public', () => {
    for (const text of ALL) {
      expect(text).not.toMatch(/repository is public|forking is allowed/i)
    }
  })

  it('ST-42/AC-6: the only repository file a comment points at is one the package carries', () => {
    for (const text of ALL) {
      for (const [, ref] of text.matchAll(/(?:^|[\s`(])((?:scripts|docs|templates)\/[\w./-]+\.(?:mjs|md))/gm)) {
        const exists = (() => {
          try {
            readFileSync(path.join(ROOT, ref))
            return true
          } catch {
            return false
          }
        })()
        expect({ ref, exists }).toEqual({ ref, exists: true })
      }
    }
  })
})

describe('ST-44/AC-6: the thin inspection workflow the package carries stays in step with steward\'s own', () => {
  const FILE = 'inspection.yml'

  it('ST-44/AC-6: differs from steward\'s own inspection.yml only in how steward is started', () => {
    expect(firstDifference(OWN(FILE), THIN(FILE))).toBeNull()
    expect(OWN(FILE)).toContain(`run: ${OWN_START}inspect`)
    expect(THIN(FILE)).toContain(`run: ${THIN_START}inspect`)
    expect(OWN(FILE)).not.toBe(THIN(FILE))
  })

  it('ST-44/AC-6: fails on a thin file with a changed permission, trigger or timeout', () => {
    for (const [from, to] of [
      ['issues: write', 'issues: read'],
      ['workflow_dispatch:', 'workflow_dispatch:\n  push:'],
      ["cron: '17 6 * * *'", "cron: '17 6 * * 1'"],
      ['timeout-minutes: 10', 'timeout-minutes: 30'],
    ]) {
      const changed = THIN(FILE).replace(from, () => to)
      expect(changed).not.toBe(THIN(FILE))
      expect(firstDifference(OWN(FILE), changed)).not.toBeNull()
    }
  })

  it('ST-44/AC-6: fails on a thin file that runs another command, or whose job lost its checkout', () => {
    expect(firstDifference(OWN(FILE), THIN(FILE).replace(`${THIN_START}inspect`, () => `${THIN_START}land`))).not.toBeNull()
    const lost = THIN(FILE).replace(/ {6}- name: Check out the repository\n {8}uses: actions\/checkout@v4\n\n/, () => '')
    expect(lost).not.toBe(THIN(FILE))
    expect(firstDifference(OWN(FILE), lost)).not.toBeNull()
  })

  it('ST-44/AC-6: starts steward from the package at the pinned tag, with the one placeholder, and keeps the checkout that gives it the project\'s settings', () => {
    const text = THIN(FILE)
    expect(text).toMatch(/^name: Inspection$/m)
    expect(commandsIn(text, THIN_START)).toEqual(['inspect'])
    expect(Object.keys(COMMANDS)).toContain('inspect')
    expect(text.match(/\{\{[A-Z_]+\}\}/g)).toEqual(['{{STEWARD_VERSION}}'])
    expect(text).toContain('uses: actions/checkout@v4')
    expect(text).not.toMatch(/npm ci|npm install/)
  })

  it('ST-44/AC-6: no comment in either file makes a statement particular to steward\'s repository', () => {
    for (const file of [OWN(FILE), THIN(FILE)]) {
      const text = file.split('\n').filter((line) => line.trimStart().startsWith('#')).join('\n')
      expect(text.length).toBeGreaterThan(500)
      expect(text).not.toMatch(/\bST-\d+|\bOQ-\d+|tower-workshop-paths|controller|\brotation\b/)
      expect(text).not.toMatch(/(?:^|[\s`(])(?:scripts|docs|templates)\//m)
    }
  })
})

describe('ST-54/AC-6: the landing workflows take the mode, the pull request and the head, and pass them through env', () => {
  const FILE = 'land-approved.yml'
  const texts = () => [OWN(FILE), THIN(FILE)]
  const step = (text) => text.slice(text.indexOf('      - name: Land the oldest ready PR'), text.indexOf('      # Deleting a merged'))

  it('ST-54/AC-6: both files declare the inputs pr, mode (default unattended) and head, all optional strings', () => {
    for (const text of texts()) {
      const inputs = text.slice(text.indexOf('  workflow_dispatch:'), text.indexOf('\npermissions:'))
      expect([...inputs.matchAll(/^ {6}(\w+):$/gm)].map((m) => m[1])).toEqual(['pr', 'mode', 'head'])
      expect(inputs).toMatch(/ {6}mode:\n(?: {8}[^\n]*\n)*? {8}default: 'unattended'\n/)
      expect(inputs.match(/required: false/g)).toHaveLength(3)
      expect(inputs.match(/type: string/g)).toHaveLength(3)
      expect(inputs).not.toMatch(/\bactor\b/i)
    }
  })

  it('ST-54/AC-6: the runway step receives each input and the trusted context only as env values', () => {
    for (const text of texts()) {
      const landing = step(text)
      expect(landing).toMatch(/^ {10}MODE_INPUT: \$\{\{ inputs\.mode \}\}$/m)
      expect(landing).toMatch(/^ {10}PR_INPUT: \$\{\{ inputs\.pr \}\}$/m)
      expect(landing).toMatch(/^ {10}HEAD_INPUT: \$\{\{ inputs\.head \}\}$/m)
      expect(landing).toMatch(/^ {10}EVENT_NAME: \$\{\{ github\.event_name \}\}$/m)
      expect(landing).toMatch(/^ {10}ACTOR: \$\{\{ github\.actor \}\}$/m)
    }
  })

  it('ST-54/AC-6: no run: line interpolates anything, so no input or actor reaches shell text', () => {
    for (const text of texts()) {
      for (const [, run] of text.matchAll(/^\s*run:(.*)$/gm)) {
        expect(run).not.toContain('${{')
        expect(run).not.toMatch(/inputs|github\.actor|github\.event/)
      }
    }
  })

  it('ST-54/AC-6: the job holds the permissions it held, none added for the permission check', () => {
    for (const text of texts()) {
      const permissions = text.slice(text.indexOf('\npermissions:'), text.indexOf('\n# Never two sweeps'))
      expect(permissions.replace(/ +#[^\n]*\n/g, '\n').replace(/\n+/g, '\n')).toBe(
        '\npermissions:\n  contents: write\n  pull-requests: write\n  statuses: read\n  checks: read\n',
      )
    }
  })

  it('ST-54/AC-6: fails on a thin file that drops one of the new env values or inputs', () => {
    for (const line of ['          HEAD_INPUT: ${{ inputs.head }}\n', '          ACTOR: ${{ github.actor }}\n', '          MODE_INPUT: ${{ inputs.mode }}\n']) {
      const lost = THIN(FILE).replace(line, () => '')
      expect(lost).not.toBe(THIN(FILE))
      expect(firstDifference(OWN(FILE), lost)).not.toBeNull()
    }
    const lostInput = THIN(FILE).replace(/ {6}head:\n(?: {8}[^\n]*\n)+/, () => '')
    expect(lostInput).not.toBe(THIN(FILE))
    expect(firstDifference(OWN(FILE), lostInput)).not.toBeNull()
  })
})
