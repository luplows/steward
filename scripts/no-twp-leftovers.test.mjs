// @vitest-environment node

/**
 * ST-99/AC-8: fails if what steward carries from tower-workshop-paths and acts on a project with
 * comes back: its dispatcher's git identity, its scratch directory names, its screenshot folder,
 * or the `TW_MACHINE_LABEL` name anywhere but the one place that reads it as the fallback for
 * `STEWARD_MACHINE_LABEL`. It scans `scripts/` (other than test files and `fixtures/` folders),
 * `.claude/`, `.github/` and `templates/`. `docs/` and dated records are not scanned: they say what
 * was.
 */

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCANNED = ['scripts', '.claude', '.github', 'templates']

// What may not appear at all. `tw-handoff-` is the same prefix, which ST-91 made for its scratch folder.
const FORBIDDEN = [
  'tw-dispatch', 'tower-workshop-paths.invalid', 'tw-coder-', 'tw-review-', 'tw-stop-', 'tw-handoff-', 'e2e/__screenshots__',
]
const FALLBACK_NAME = 'TW_MACHINE_LABEL'
// The one file that reads `FALLBACK_NAME`, and the one line in it that names it in code.
const FALLBACK_FILE = 'scripts/dispatch/coder.mjs'
const FALLBACK_LINE = "const LEGACY_MACHINE_LABEL_VARIABLE = 'TW_MACHINE_LABEL'"

/** Every file under `dir` that is not a test file or under a `fixtures` folder, as repo-relative paths. */
function filesUnder(dir) {
  const out = []
  for (const entry of readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name !== 'fixtures' && entry.name !== 'node_modules') out.push(...filesUnder(rel))
    } else if (!entry.name.endsWith('.test.mjs')) {
      out.push(rel)
    }
  }
  return out
}

/** The problems in `files`, each `{ file, line, found }`, reading each file's text with `read`. */
export function leftovers(files, read) {
  const problems = []
  for (const file of files) {
    read(file).split(/\r?\n/).forEach((text, i) => {
      for (const token of FORBIDDEN) {
        if (text.includes(token)) problems.push({ file, line: i + 1, found: token })
      }
      if (text.includes(FALLBACK_NAME)) {
        const isComment = /^\s*(?:\*|\/\/|\/\*)/.test(text)
        const allowed = file === FALLBACK_FILE && (isComment || text.trim() === FALLBACK_LINE)
        if (!allowed) problems.push({ file, line: i + 1, found: FALLBACK_NAME })
      }
    })
  }
  return problems
}

describe('ST-99/AC-8: nothing of tower-workshop-paths\' identities is left in what steward runs', () => {
  const files = SCANNED.flatMap(filesUnder)

  it('ST-99/AC-8: the scan reaches the scripts, the prompts, the workflows and the templates', () => {
    expect(files).toContain(FALLBACK_FILE)
    expect(files).toContain('scripts/dispatch/handoff-coder.mjs')
    expect(files).toContain('.claude/prompts/coder.md')
    expect(files).toContain('.github/workflows/ci.yml')
    expect(files).toContain('templates/review-checklist.md')
    expect(files.some((f) => f.endsWith('.test.mjs'))).toBe(false)
    expect(files.some((f) => f.includes('/fixtures/'))).toBe(false)
  })

  it('ST-99/AC-8: none of the identity, scratch-name or screenshot strings appears, and TW_MACHINE_LABEL only as the fallback', () => {
    expect(leftovers(files, (file) => readFileSync(path.join(repoRoot, file), 'utf8'))).toEqual([])
  })

  it('ST-99/AC-8: the fallback is still there to be allowed: coder.mjs names TW_MACHINE_LABEL in code, once', () => {
    const lines = readFileSync(path.join(repoRoot, FALLBACK_FILE), 'utf8').split(/\r?\n/)
    expect(lines.filter((l) => l.trim() === FALLBACK_LINE)).toHaveLength(1)
  })

  describe('each check fails on what it forbids', () => {
    const scan = (file, text) => leftovers([file], () => text).map((p) => p.found)

    for (const token of FORBIDDEN) {
      it(`ST-99/AC-8: ${token}`, () => {
        expect(scan('scripts/dispatch/x.mjs', `const a = '${token}x'`)).toEqual([token])
      })
    }

    it('ST-99/AC-8: TW_MACHINE_LABEL in any other file, or in code of the fallback file other than its one line', () => {
      expect(scan('scripts/dispatch/handoff-coder.mjs', 'env.TW_MACHINE_LABEL')).toEqual([FALLBACK_NAME])
      expect(scan(FALLBACK_FILE, 'const raw = env.TW_MACHINE_LABEL')).toEqual([FALLBACK_NAME])
      expect(scan('.github/workflows/ci.yml', 'TW_MACHINE_LABEL: laptop')).toEqual([FALLBACK_NAME])
      expect(scan(FALLBACK_FILE, FALLBACK_LINE)).toEqual([])
      expect(scan(FALLBACK_FILE, ' * `TW_MACHINE_LABEL` only when STEWARD_MACHINE_LABEL is unset')).toEqual([])
    })
  })
})
