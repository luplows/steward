/**
 * The one way steward reads and writes its JSON state files, `reviews.json`, `projects.json`,
 * `coordinator.json` and `handoffs.json`, under `~/.steward/state/`. The design is
 * `docs/agent-workflow-design.md`, Part 3, "Decided so far", "Per-user coordinator foundations and
 * manual independence".
 *
 * This module knows nothing of what a valid record is, which is each caller's to decide and report.
 * It is synchronous, and `project.mjs`, which is otherwise asynchronous, calls it too.
 *
 * The threat model is one member of the crew, one coordinator, one automatic review at a time, on
 * one machine, and a write that fails while steward is running. It is not a guard against another
 * process, or against a process killed during a write, whose temporary file the next write
 * overwrites and no read looks at.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The parsed value in `file`, or `undefined` when there is no file, which is nothing JSON can parse
 * to. A file that is not JSON throws `JSON.parse`'s own `SyntaxError`, and reading it throws no
 * other, so that each caller can tell it apart and say so in its own words. Any other failure to
 * read throws as `readFileSync` does.
 */
export function readStateFile(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  return JSON.parse(raw)
}

/**
 * Writes `value` as JSON to a temporary file beside `file` and renames it over `file`, creating the
 * folder first, so that a write that fails leaves `file` as it was: `file` itself is never opened
 * for writing. Throws the write's own error, the temporary file removed as best it can be.
 */
export function writeStateFile(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(temporary, file)
  } catch (error) {
    try { rmSync(temporary, { force: true }) } catch { /* The write's error is the one to report. */ }
    throw error
  }
}
