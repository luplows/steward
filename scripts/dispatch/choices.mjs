/**
 * Shared by `review.mjs` and `coder.mjs` (ST-35): trying a role's choices in order until one's tool
 * has usage to spare, and the `Coder:` line ATC keeps at the end of a coder's pull request body.
 *
 * Which choices are tried, and in what order, is each role's: the reviewer's (AC-2) and the
 * coder's (AC-6) are built by their own scripts. This module only reads the usage and walks the
 * list (`docs/machine-settings.md`, "How the choices are used").
 */
import { checkUsage } from './usage.mjs'

/** What a `skipped` entry keeps of a refusal: the status and the facts that status carries. */
function skippedEntry(choice, refusal) {
  const { status } = refusal
  if (status === 'over-usage') {
    return { name: choice.name, status, window: refusal.window, percent: refusal.percent, limit: refusal.limit }
  }
  return { name: choice.name, status, reason: refusal.reason }
}

/**
 * Tries `candidates`, choices as `{ name, tool, ... }`, in order, and starts with the first whose
 * tool's usage is readable and under `limits` (ST-35/AC-2, AC-6). `readers` maps a tool to its
 * `({ cwd })` usage reader. A tool's usage is read at most once per call, however many of its
 * choices are tried; a usage that cannot be read counts as spent. `extra` (a story's id) is added
 * to a refusal.
 *
 * Resolves `{ choice, skipped }`, where `skipped` holds one entry per choice passed over, in the
 * order tried; or `{ refusal }`, the first candidate's refusal (`checkUsage`'s) carrying `skipped`
 * for every candidate, when none can start.
 */
export async function firstWithUsage({ candidates, readers, cwd, limits, extra = {} }) {
  const reads = new Map()
  const readOnce = (tool) => {
    if (!reads.has(tool)) reads.set(tool, readers[tool]({ cwd }))
    return reads.get(tool)
  }
  const skipped = []
  let first = null
  for (const choice of candidates) {
    const refusal = await checkUsage({ read: () => readOnce(choice.tool), cwd, limits, extra })
    if (refusal === null) return { choice, skipped }
    first ??= refusal
    skipped.push(skippedEntry(choice, refusal))
  }
  return { refusal: { ...first, skipped } }
}

/** The line a `Coder:` line is: one that starts `Coder:`. */
const CODER_LINE_RE = /^Coder:/

const lines = (body) => String(body ?? '').split(/\r?\n/)

/**
 * The choice names on the last line of `body` that starts `Coder:` (ST-35/AC-7, AC-8), each once,
 * in the order written; `null` when no line does, or the last has no name.
 */
export function coderLineNames(body) {
  const line = lines(body).findLast((l) => CODER_LINE_RE.test(l))
  if (line === undefined) return null
  const names = [...new Set(line.slice('Coder:'.length).split(',').map((n) => n.trim()).filter((n) => n !== ''))]
  return names.length === 0 ? null : names
}

/**
 * `body` with every line that starts `Coder:` removed, followed by a last line `Coder: <names>`
 * (ST-35/AC-7). The line is ATC's: whatever the coder wrote under that name is dropped.
 */
export function withCoderLine(body, names) {
  const kept = lines(body).filter((l) => !CODER_LINE_RE.test(l)).join('\n').trimEnd()
  const line = `Coder: ${names.join(', ')}`
  return kept === '' ? line : `${kept}\n\n${line}`
}
