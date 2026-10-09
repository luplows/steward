#!/usr/bin/env node
/**
 * Validates every story file's schema -- frontmatter, required sections, and
 * acceptance-criterion numbering -- plus the `**Planned (OQ-n, ...)**`
 * markers in docs/*.md that name a story. A malformed story previously
 * failed silently at dispatch (or produced a story that dispatches but
 * cannot be reviewed against); this surfaces the defect in the PR that
 * introduced it. See stories/done/OQ-61-story-schema-lint.md for the
 * acceptance criteria this implements.
 *
 * Collects every violation across every file in one run rather than
 * stopping at the first (AC-1). Each violation names the file, the
 * acceptance criterion of *this* lint that the story broke, and a 1-based
 * line number.
 *
 * Usage:
 *   node scripts/lint-stories.mjs
 *
 * Exit code: 0 when nothing blocking was found (an unknown frontmatter key
 * is reported but does not block, per AC-2); 1 otherwise.
 */
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readSettings } from './dispatch/settings.mjs'

/** The filename pattern for a project's stories, built from its story-id prefix (OQ-127). */
export function storyFilenameRe(prefix) {
  return new RegExp(`^${prefix}-\\d+-[\\w-]+\\.md$`)
}

const REQUIRED_FRONTMATTER_FIELDS = ['id', 'title', 'tier', 'kind', 'depends_on', 'model', 'blocked']
const TIERS = ['fix', 'next', 'normal', 'later']
const KINDS = ['product', 'workflow']
const REQUIRED_HEADINGS = ['Intent', 'Acceptance criteria', 'Out of scope', 'Constraints', 'Context', 'Open questions']

function violation(file, line, rule, message, blocking = true) {
  return { file, line, rule, message, blocking }
}

// Parses one YAML-ish scalar value from the right-hand side of `key: value`
// in a story's frontmatter -- `null`, `[a, b]` / `[]` lists, double-quoted
// strings, and bare strings, matching the small fixed schema in
// stories/_TEMPLATE.md rather than general YAML.
function parseScalarValue(raw) {
  const value = raw.trim()

  if (value.startsWith('"')) {
    const match = value.match(/^"((?:[^"\\]|\\.)*)"/)
    if (!match) return undefined
    return match[1].replace(/\\(.)/g, '$1')
  }

  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end === -1) return undefined
    const inner = value.slice(1, end).trim()
    return inner === '' ? [] : inner.split(',').map((entry) => entry.trim())
  }

  const commentIndex = value.indexOf(' #')
  const withoutComment = (commentIndex === -1 ? value : value.slice(0, commentIndex)).trim()

  return withoutComment === 'null' ? null : withoutComment
}

/**
 * Splits `source` into its frontmatter entries (each carrying the 1-based
 * line it was declared on) and where the body begins. `malformed` is true
 * when no `---`-delimited block is found at all, in which case the whole
 * file is still treated as body for the section checks below.
 */
export function parseFrontmatter(source) {
  const lines = source.split(/\r?\n/)
  if ((lines[0] ?? '').trim() !== '---') {
    return { entries: new Map(), bodyStartLine: 1, frontmatterEndLine: 1, malformed: true }
  }

  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) {
    return { entries: new Map(), bodyStartLine: 1, frontmatterEndLine: 1, malformed: true }
  }

  const entries = new Map()
  for (let i = 1; i < end; i++) {
    const raw = lines[i]
    if (raw.trim() === '' || /^[ \t]/.test(raw)) continue
    const match = raw.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!match) continue
    const [, key, rawValue] = match
    entries.set(key, { value: parseScalarValue(rawValue), line: i + 1 })
  }

  return { entries, bodyStartLine: end + 2, frontmatterEndLine: end + 1, malformed: false }
}

/**
 * Splits body lines (already split, with `offset` the 1-based line number of
 * `bodyLines[0]`) into `## `-heading sections, each carrying its own start
 * line and its content lines (each carrying its own line number). Fence-aware:
 * a `## `-looking line inside a fenced code block is content, not a heading.
 */
export function parseSections(bodyLines, offset) {
  const sections = new Map()
  let current = null
  let fenceChar = null
  let fenceLen = 0

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i]
    const lineNo = offset + i

    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      const char = marker[0]
      if (fenceChar === null) {
        fenceChar = char
        fenceLen = marker.length
      } else if (char === fenceChar && marker.length >= fenceLen) {
        fenceChar = null
        fenceLen = 0
      }
      if (current) current.lines.push({ text: line, line: lineNo })
      continue
    }

    if (fenceChar === null) {
      const headingMatch = line.match(/^##(?!#)\s+(.+?)\s*$/)
      if (headingMatch) {
        current = { startLine: lineNo, lines: [] }
        sections.set(headingMatch[1], current)
        continue
      }
    }

    if (current) current.lines.push({ text: line, line: lineNo })
  }

  return sections
}

/**
 * True when `text` -- a section's joined content lines -- counts as empty
 * (AC-6): nothing at all once HTML comments and surrounding whitespace are
 * stripped, or exactly one italic parenthetical placeholder such as
 * `*(none)*` or `*(must be empty to dispatch)*` alone on its line. Both
 * forms are treated identically; which placeholder text was used carries no
 * meaning beyond "considered, nothing here".
 */
export function isSectionEmpty(text) {
  const stripped = text.replace(/<!--[\s\S]*?-->/g, '').trim()
  if (stripped === '') return true
  return /^\*\(.*\)\*$/.test(stripped)
}

const AC_ITEM_RE = /^-\s*\[[ xX]\]\s*\*\*AC-(\d+)([a-z]?)\*\*/

/**
 * AC-5: every acceptance criterion is `**AC-N**` or `**AC-Nx**` (one
 * lowercase letter), the non-suffixed N's form `1..n` with no gap or
 * duplicate and `n >= 1`, and a suffixed id needs its base `AC-N` present
 * and is itself unique.
 */
function lintAcceptanceCriteria(filePath, section) {
  const violations = []
  const items = []
  for (const { text, line } of section.lines) {
    if (!/^-/.test(text)) continue
    const match = text.match(AC_ITEM_RE)
    if (match) {
      items.push({ n: Number(match[1]), suffix: match[2] ?? '', line })
    } else {
      violations.push(violation(filePath, line, 'AC-5', `list item is not a well-formed '- [ ] **AC-N**' task-list item: ${JSON.stringify(text.trim())}`))
    }
  }

  if (items.length === 0) {
    const sectionText = section.lines.map((l) => l.text).join('\n')
    const emptyNote = isSectionEmpty(sectionText) ? ' (section is empty)' : ''
    violations.push(violation(filePath, section.startLine, 'AC-5', `'Acceptance criteria' has no AC items${emptyNote}`))
    return violations
  }

  const baseLines = new Map()
  const suffixedLines = new Map()
  for (const item of items) {
    if (item.suffix === '') {
      if (!baseLines.has(item.n)) baseLines.set(item.n, [])
      baseLines.get(item.n).push(item.line)
    } else {
      const key = `${item.n}${item.suffix}`
      if (!suffixedLines.has(key)) suffixedLines.set(key, [])
      suffixedLines.get(key).push(item.line)
    }
  }

  for (const [n, lines] of baseLines) {
    for (const line of lines.slice(1)) {
      violations.push(violation(filePath, line, 'AC-5', `duplicate 'AC-${n}'`))
    }
  }
  for (const [key, lines] of suffixedLines) {
    for (const line of lines.slice(1)) {
      violations.push(violation(filePath, line, 'AC-5', `duplicate 'AC-${key}'`))
    }
  }

  if (baseLines.size === 0) {
    violations.push(violation(filePath, section.startLine, 'AC-5', `no non-suffixed 'AC-N' id found; n >= 1 is required`))
  } else {
    const maxN = Math.max(...baseLines.keys())
    for (let n = 1; n <= maxN; n++) {
      if (!baseLines.has(n)) {
        violations.push(violation(filePath, section.startLine, 'AC-5', `missing 'AC-${n}': ids must run 1..n with no gap`))
      }
    }
  }

  for (const [key, lines] of suffixedLines) {
    const baseN = Number(key.match(/^(\d+)/)[1])
    if (!baseLines.has(baseN)) {
      violations.push(violation(filePath, lines[0], 'AC-5', `'AC-${key}' has no base 'AC-${baseN}' in this story`))
    }
  }

  return violations
}

/** Validates one story file's schema (AC-2 through AC-5), against the project's story-id `prefix` (OQ-127). */
export function lintStory(filePath, source, prefix) {
  const violations = []
  const fileName = path.basename(filePath)
  const { entries, bodyStartLine, frontmatterEndLine, malformed } = parseFrontmatter(source)

  if (malformed) {
    violations.push(violation(filePath, 1, 'AC-2', 'missing or malformed frontmatter block'))
  }

  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    if (!entries.has(field)) {
      violations.push(violation(filePath, frontmatterEndLine, 'AC-2', `missing required frontmatter field '${field}'`))
    }
  }

  const idRe = new RegExp(`^${prefix}-\\d+$`)

  const idEntry = entries.get('id')
  let id = null
  if (idEntry) {
    id = idEntry.value
    if (typeof id !== 'string' || !idRe.test(id)) {
      violations.push(violation(filePath, idEntry.line, 'AC-2', `frontmatter 'id' does not match ^${prefix}-\\d+$: ${JSON.stringify(id)}`))
    }
  }

  const tierEntry = entries.get('tier')
  if (tierEntry && !TIERS.includes(tierEntry.value)) {
    violations.push(violation(filePath, tierEntry.line, 'AC-2', `frontmatter 'tier' is not one of ${TIERS.join(', ')}: ${JSON.stringify(tierEntry.value)}`))
  }

  const kindEntry = entries.get('kind')
  if (kindEntry && !KINDS.includes(kindEntry.value)) {
    violations.push(violation(filePath, kindEntry.line, 'AC-2', `frontmatter 'kind' is not one of ${KINDS.join(', ')}: ${JSON.stringify(kindEntry.value)}`))
  }

  const dependsEntry = entries.get('depends_on')
  if (dependsEntry) {
    if (!Array.isArray(dependsEntry.value)) {
      violations.push(violation(filePath, dependsEntry.line, 'AC-2', `frontmatter 'depends_on' is not a list: ${JSON.stringify(dependsEntry.value)}`))
    } else {
      for (const dep of dependsEntry.value) {
        if (!idRe.test(dep)) {
          violations.push(violation(filePath, dependsEntry.line, 'AC-2', `frontmatter 'depends_on' entry does not match ^${prefix}-\\d+$: ${JSON.stringify(dep)}`))
        }
      }
    }
  }

  const blockedEntry = entries.get('blocked')
  if (blockedEntry) {
    const value = blockedEntry.value
    const isNonEmptyString = typeof value === 'string' && value.length > 0
    if (value !== null && !isNonEmptyString) {
      violations.push(violation(filePath, blockedEntry.line, 'AC-2', `frontmatter 'blocked' is neither null nor a non-empty string: ${JSON.stringify(value)}`))
    }
  }

  const knownFields = new Set(REQUIRED_FRONTMATTER_FIELDS)
  for (const [key, entry] of entries) {
    if (!knownFields.has(key)) {
      violations.push(violation(filePath, entry.line, 'AC-2', `unknown frontmatter field '${key}'`, false))
    }
  }

  const prefixMatch = fileName.match(new RegExp(`^(${prefix}-\\d+)-`))
  if (prefixMatch && idEntry && typeof id === 'string') {
    if (id !== prefixMatch[1]) {
      violations.push(violation(filePath, idEntry.line, 'AC-3', `id '${id}' does not match this file's '${prefix}-<n>' prefix '${prefixMatch[1]}'`))
    }
  }

  const bodyLines = source.split(/\r?\n/).slice(bodyStartLine - 1)
  const sections = parseSections(bodyLines, bodyStartLine)

  for (const heading of REQUIRED_HEADINGS) {
    if (!sections.has(heading)) {
      violations.push(violation(filePath, bodyStartLine, 'AC-4', `missing '## ${heading}' section`))
    }
  }

  if (sections.has('Acceptance criteria')) {
    violations.push(...lintAcceptanceCriteria(filePath, sections.get('Acceptance criteria')))
  }

  return violations
}

async function listStoryFiles(dir, prefix) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  return entries.filter((entry) => entry.isFile() && storyFilenameRe(prefix).test(entry.name)).map((entry) => path.join(dir, entry.name))
}

async function collectStoryIds(rootDir, prefix) {
  const storiesDir = path.join(rootDir, 'stories')
  const doneDir = path.join(storiesDir, 'done')
  const open = new Set()
  const done = new Set()
  const prefixRe = new RegExp(`^(${prefix}-\\d+)-`)
  for (const [dir, set] of [
    [storiesDir, open],
    [doneDir, done],
  ]) {
    for (const file of await listStoryFiles(dir, prefix)) {
      const match = path.basename(file).match(prefixRe)
      if (match) set.add(match[1])
    }
  }
  return { open, done }
}

// Matches both forms actually used: `**Planned (...):**` (the common case,
// the colon sitting inside the bold run) and the bare `**Planned (...)**`
// of the illustrative example in "Reading this document".
const PLANNED_MARKER_RE = /\*\*Planned \(([^)]*)\)(?::\*\*|\*\*)/g

/**
 * AC-7: a `**Planned (OQ-n, ...)**` marker in docs/*.md is rejected when it
 * names a story already in stories/done/, or a numeric id with no story file
 * at all. Only numeric ids are read -- the illustrative `**Planned (OQ-n)**`
 * has none and passes untouched.
 */
export async function lintDocs(rootDir) {
  const violations = []
  const docsDir = path.join(rootDir, 'docs')

  let entries
  try {
    entries = await readdir(docsDir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return violations
    throw err
  }

  const mdFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => path.join(docsDir, entry.name))
  const { storyPrefix: prefix } = await readSettings(rootDir)
  const { open, done } = await collectStoryIds(rootDir, prefix)
  const idRe = new RegExp(`^${prefix}-\\d+$`)

  for (const file of mdFiles) {
    const source = await readFile(file, 'utf8')
    const lines = source.split(/\r?\n/)
    lines.forEach((line, index) => {
      for (const match of line.matchAll(PLANNED_MARKER_RE)) {
        const ids = match[1]
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => idRe.test(entry))

        for (const id of ids) {
          if (done.has(id)) {
            violations.push(violation(file, index + 1, 'AC-7', `**Planned** marker names '${id}', already in stories/done/`))
          } else if (!open.has(id)) {
            violations.push(violation(file, index + 1, 'AC-7', `**Planned** marker names '${id}', which has no story file`))
          }
        }
      }
    })
  }

  return violations
}

/** Runs every check (AC-2 through AC-5, and AC-7) across the whole repo, against its own `steward.config.json` story-id prefix (OQ-127). */
export async function lintAll(rootDir = process.cwd()) {
  const violations = []
  const storiesDir = path.join(rootDir, 'stories')
  const doneDir = path.join(storiesDir, 'done')
  const { storyPrefix } = await readSettings(rootDir)

  for (const file of [...(await listStoryFiles(storiesDir, storyPrefix)), ...(await listStoryFiles(doneDir, storyPrefix))]) {
    const source = await readFile(file, 'utf8')
    violations.push(...lintStory(file, source, storyPrefix))
  }

  violations.push(...(await lintDocs(rootDir)))

  return violations
}

function formatViolation(v, rootDir) {
  const rel = path.relative(rootDir, v.file).split(path.sep).join('/')
  return `${rel}:${v.line}: ${v.rule} ${v.message}`
}

async function main() {
  const rootDir = process.cwd()
  const violations = await lintAll(rootDir)

  for (const v of violations) {
    console.error(formatViolation(v, rootDir))
  }

  process.exitCode = violations.some((v) => v.blocking !== false) ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message)
    process.exitCode = 1
  })
}
