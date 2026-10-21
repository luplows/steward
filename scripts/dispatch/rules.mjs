#!/usr/bin/env node
/**
 * Reads a project's checklist from `main` and parses it into sections
 * (ST-20; `docs/outline.md`, "The checklist's shape"). A section is a `## `
 * heading, an optional `Applies when:` line, and its own numbered items; a
 * finding cites a section and an item.
 *
 * An HTML comment (`<!-- … -->`, on one line or across several) is not part of a
 * checklist: `stripComments` removes it, and what the reviewer is given has
 * none (ST-43).
 *
 * Its caller will be the rotation, which parses the file before it starts
 * a reviewer so that a file that does not parse costs no review (ST-21).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const REMOTE = 'origin'

const SECTION_RE = /^## (.*)$/
const CONDITION_PREFIX = 'Applies when:'
const ITEM_RE = /^(\d+)\. (.*)$/

/**
 * Returns `text` with every HTML comment removed. A comment that is alone on
 * its lines takes its lines with it, so that removing it leaves no blank line
 * where it stood; one that shares a line with other text leaves that text. A
 * comment with no closing `-->` runs to the end of the text, so that nothing
 * after an unclosed opening reaches the reviewer. Pure (ST-43).
 */
export function stripComments(text) {
  const s = String(text)
  let out = ''
  let i = 0
  for (;;) {
    const open = s.indexOf('<!--', i)
    if (open === -1) {
      out += s.slice(i)
      return out
    }
    const close = s.indexOf('-->', open + 4)
    const end = close === -1 ? s.length : close + 3
    const before = out + s.slice(i, open)
    const lineStart = before.lastIndexOf('\n') + 1
    const trailing = /^[ \t]*(?:\r?\n|$)/.exec(s.slice(end))
    if (before.slice(lineStart).trim() === '' && trailing) {
      out = before.slice(0, lineStart)
      i = end + trailing[0].length
    } else {
      out = before
      i = end
    }
  }
}

/**
 * Parses the text of a rules file, ignoring its HTML comments (ST-43). Pure. Returns
 * `{ ok: true, preamble, sections: [{ name, appliesWhen, lead, items: [{ number, text }] }] }`,
 * or `{ ok: false, problems }` listing every problem found, each naming its
 * section. `appliesWhen` is `null` for a section without a condition, which
 * always applies. `lead` is the text between the heading, or the
 * `Applies when:` line, and the first item, trimmed, and `''` when there is
 * none (ST-28). An item's text runs from its line to the next item or the end
 * of its section.
 */
export function parseRules(text) {
  const preambleLines = []
  const raw = []
  for (const line of stripComments(text).split(/\r?\n/)) {
    const heading = SECTION_RE.exec(line)
    if (heading) raw.push({ name: heading[1].trim(), lines: [] })
    else if (raw.length > 0) raw[raw.length - 1].lines.push(line)
    else preambleLines.push(line)
  }

  const problems = []
  if (raw.length === 0) problems.push('the file has no section (a line beginning "## ")')

  const sections = raw.map(({ name, lines }) => {
    let appliesWhen = null
    let start = lines.findIndex((line) => line.trim() !== '')
    if (start === -1) start = lines.length
    if (start < lines.length && lines[start].startsWith(CONDITION_PREFIX)) {
      appliesWhen = lines[start].slice(CONDITION_PREFIX.length).trim()
      start += 1
    }

    const items = []
    const leadLines = []
    for (const line of lines.slice(start)) {
      const item = ITEM_RE.exec(line)
      if (item) items.push({ number: Number(item[1]), lines: [item[2]] })
      else if (items.length > 0) items[items.length - 1].lines.push(line)
      else leadLines.push(line)
    }
    return {
      name,
      appliesWhen,
      lead: leadLines.join('\n').trim(),
      items: items.map(({ number, lines: itemLines }) => ({
        number,
        text: itemLines.join('\n').trim(),
      })),
    }
  })

  const seenNames = new Set()
  for (const section of sections) {
    if (seenNames.has(section.name)) {
      problems.push(`section "${section.name}": another section has the same name`)
    }
    seenNames.add(section.name)

    if (section.items.length === 0) {
      problems.push(`section "${section.name}": has no item (a line beginning "1. ")`)
    }
    const seenNumbers = new Set()
    const reported = new Set()
    for (const { number } of section.items) {
      if (seenNumbers.has(number) && !reported.has(number)) {
        problems.push(`section "${section.name}": numbers two items ${number}`)
        reported.add(number)
      }
      seenNumbers.add(number)
    }
  }

  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, preamble: preambleLines.join('\n').trim(), sections }
}

/**
 * Reads `rulesFile` as it stands on `<remote>/<base>` in `repoDir`, never a
 * pull request's head, and parses it. A file that parses returns
 * `parseRules`'s result with the file's `text` added, its HTML comments
 * removed, which is what the reviewer is given (ST-21, ST-43). A file missing
 * from there, or one that does not parse, returns `{ ok: false, problems }`; neither throws.
 */
export async function readRules({ repoDir, base, rulesFile }) {
  let text
  try {
    const { stdout } = await execFileAsync('git', ['show', `${REMOTE}/${base}:${rulesFile}`], {
      cwd: repoDir,
      maxBuffer: 64 * 1024 * 1024,
    })
    text = stdout
  } catch (err) {
    const detail = String(err.stderr || err.message).trim()
    return {
      ok: false,
      problems: [`${rulesFile}: cannot be read from ${REMOTE}/${base}: ${detail}`],
    }
  }
  const parsed = parseRules(text)
  if (parsed.ok) return { ...parsed, text: stripComments(text) }
  return { ok: false, problems: parsed.problems.map((problem) => `${rulesFile}: ${problem}`) }
}
