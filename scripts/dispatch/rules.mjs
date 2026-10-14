#!/usr/bin/env node
/**
 * Reads a project's rules file from `main` and parses it into sections
 * (ST-20; `docs/harness-outline.md`, "The rules file's shape"). A section is
 * a `## ` heading, an optional `Applies when:` line, and its own numbered
 * items; a finding cites a section and an item.
 *
 * Its caller will be the review pass, which parses the file before it starts
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
 * Parses the text of a rules file. Pure. Returns
 * `{ ok: true, preamble, sections: [{ name, appliesWhen, items: [{ number, text }] }] }`,
 * or `{ ok: false, problems }` listing every problem found, each naming its
 * section. `appliesWhen` is `null` for a section without a condition, which
 * always applies. An item's text runs from its line to the next item or the
 * end of its section.
 */
export function parseRules(text) {
  const preambleLines = []
  const raw = []
  for (const line of String(text).split(/\r?\n/)) {
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
    for (const line of lines.slice(start)) {
      const item = ITEM_RE.exec(line)
      if (item) items.push({ number: Number(item[1]), lines: [item[2]] })
      else if (items.length > 0) items[items.length - 1].lines.push(line)
    }
    return {
      name,
      appliesWhen,
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
 * pull request's head, and parses it. A file missing from there, or one that
 * does not parse, returns `{ ok: false, problems }`; neither throws.
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
  if (parsed.ok) return parsed
  return { ok: false, problems: parsed.problems.map((problem) => `${rulesFile}: ${problem}`) }
}
