#!/usr/bin/env node
/**
 * Checks whether a pull request that implements a story (OQ-82) changes
 * `stories/` beyond what its own story permits: that story's move into
 * `stories/done/`, acceptance-criterion lines ticking `- [ ]` to `- [x]`
 * and nothing else on those lines, and its `blocked:` frontmatter line
 * (`coder.md`; OQ-70's AC-8). A pull request that implements no story is not
 * restricted -- that is Session A's territory, covered by `REVIEW.md`'s
 * "PRs that add or change a story" items instead.
 *
 * `resolveStory` (review.mjs) decides whether a diff implements a story --
 * reused here rather than re-derived, per this story's Context.
 *
 * Usage:
 *   node scripts/dispatch/story-containment.mjs <base-sha> <head-sha> [branch]
 *
 * Run from a checkout where both commits are reachable (`ci.yml` fetches full
 * history before this step). Exit code 0 when nothing blocking was found;
 * 1 otherwise, with each violation printed as `<file>:<line>: <message>`.
 */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { resolveStory } from './review.mjs'

const execFileAsync = promisify(execFile)

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout
}

async function showFile(cwd, ref, file) {
  try {
    return await git(cwd, ['show', `${ref}:${file}`])
  } catch {
    return null
  }
}

function commonPrefixLen(a, b) {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

function commonSuffixLen(a, b, prefix) {
  let i = 0
  while (i < a.length - prefix && i < b.length - prefix && a[a.length - 1 - i] === b[b.length - 1 - i]) i++
  return i
}

/**
 * The middle region between the common prefix and common suffix of two line
 * arrays: every line that changed, in order. Several non-adjacent edits (two
 * ticks, or a tick plus a `blocked:` edit) still line up correctly -- the
 * unchanged lines between them fall in the middle too and compare equal.
 */
function changedLines(oldLines, newLines) {
  const prefix = commonPrefixLen(oldLines, newLines)
  const suffix = commonSuffixLen(oldLines, newLines, prefix)
  const oldMid = oldLines.slice(prefix, oldLines.length - suffix)
  const newMid = newLines.slice(prefix, newLines.length - suffix)
  return { prefix, oldMid, newMid }
}

const TICK_RE = /^(\s*-\s\[)([ x])(\].*)$/
const BLOCKED_RE = /^blocked:(\s|$)/

// AC-2: the only two kinds of line-level edit a story's own file may carry.
// Direction matters -- [x] regressing to [ ] is a violation, not a no-op.
function isAllowedEdit(oldLine, newLine) {
  if (BLOCKED_RE.test(oldLine) && BLOCKED_RE.test(newLine)) return true
  const was = oldLine.match(TICK_RE)
  const now = newLine.match(TICK_RE)
  return Boolean(was && now && was[2] === ' ' && now[2] === 'x' && was[1] === now[1] && was[3] === now[3])
}

// AC-2: the own story file's content, before and after -- whichever path(s)
// it lived at (unmoved, or moved into stories/done/). Anything other than a
// tick flip or a `blocked:` edit is a violation, named by line.
function checkOwnFile(file, oldText, newText) {
  const oldLines = (oldText ?? '').split(/\r?\n/)
  const newLines = (newText ?? '').split(/\r?\n/)
  const { prefix, oldMid, newMid } = changedLines(oldLines, newLines)
  if (oldMid.length !== newMid.length) {
    return [{
      file,
      line: prefix + 1,
      message: 'its own story file changed by more than a line-for-line edit (lines added or removed)',
    }]
  }
  const violations = []
  for (let k = 0; k < oldMid.length; k++) {
    if (oldMid[k] === newMid[k]) continue
    if (!isAllowedEdit(oldMid[k], newMid[k])) {
      violations.push({
        file,
        line: prefix + k + 1,
        message: `disallowed change to its own story: "${oldMid[k]}" -> "${newMid[k]}"`,
      })
    }
  }
  return violations
}

// AC-2: any other file under stories/ -- another story added, edited, moved
// or deleted, or a non-story file under stories/ touched.
function checkOtherFile(file, oldText, newText) {
  if (oldText === null) {
    return [{ file, line: 1, message: 'added under stories/ by a pull request that implements a different story' }]
  }
  if (newText === null) {
    return [{ file, line: 1, message: 'deleted under stories/ by a pull request that implements a different story' }]
  }
  const oldLines = oldText.split(/\r?\n/)
  const newLines = newText.split(/\r?\n/)
  const { prefix, oldMid, newMid } = changedLines(oldLines, newLines)
  if (oldMid.length === 0 && newMid.length === 0) return []
  return [{ file, line: prefix + 1, message: 'changed under stories/ by a pull request that implements a different story' }]
}

/**
 * `cwd` is a git checkout with both `base` and `head` reachable as commits.
 * `branch` is the head branch name, used only as `resolveStory`'s fallback.
 *
 * Returns `{ ok: true }` when the pull request implements no story (AC-3) or
 * conforms (AC-2), or `{ ok: false, violations: [{ file, line, message }] }`.
 */
export async function checkStoryContainment({ cwd, base, head, branch }) {
  const nameStatus = await git(cwd, ['diff', '--name-status', '--no-renames', `${base}...${head}`, '--', 'stories/'])
  const resolved = resolveStory({ nameStatus, branch })
  if (resolved.kind === 'none') return { ok: true }

  const touched = new Map()
  for (const line of nameStatus.split(/\r?\n/)) {
    const [status, file] = line.split('\t')
    if (!file) continue
    touched.set(file, status)
  }

  let ownBefore = null
  let ownAfter = null
  if (resolved.kind === 'moved') {
    ownBefore = `stories/${resolved.file}`
    ownAfter = `stories/done/${resolved.file}`
  } else if (resolved.kind === 'branch-only') {
    const ownRe = new RegExp(`^stories/${resolved.id}-[\\w-]+\\.md$`)
    const match = [...touched.keys()].find((file) => ownRe.test(file))
    if (match) {
      ownBefore = match
      ownAfter = match
    }
  }
  // resolved.kind === 'ambiguous': no own file is recognised, so every
  // touched file -- including both moved stories -- is reported below.

  const mergeBase = (await git(cwd, ['merge-base', base, head])).trim()
  const violations = []
  for (const file of touched.keys()) {
    if (file === ownBefore && file === ownAfter) {
      const oldText = await showFile(cwd, mergeBase, file)
      const newText = await showFile(cwd, head, file)
      violations.push(...checkOwnFile(file, oldText, newText))
    } else if (file === ownBefore || file === ownAfter) {
      continue // the other half of a moved own-file pair, handled below
    } else {
      const oldText = await showFile(cwd, mergeBase, file)
      const newText = await showFile(cwd, head, file)
      violations.push(...checkOtherFile(file, oldText, newText))
    }
  }
  if (ownBefore && ownAfter && ownBefore !== ownAfter) {
    const oldText = await showFile(cwd, mergeBase, ownBefore)
    const newText = await showFile(cwd, head, ownAfter)
    violations.push(...checkOwnFile(ownAfter, oldText, newText))
  }

  violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
  return violations.length ? { ok: false, violations } : { ok: true }
}

// --------------------------------------------------------------------- CLI

async function main(argv) {
  const [base, head, branch] = argv
  if (!base || !head) {
    throw new Error('usage: node scripts/dispatch/story-containment.mjs <base-sha> <head-sha> [branch]')
  }
  const result = await checkStoryContainment({ cwd: process.cwd(), base, head, branch })
  if (!result.ok) {
    for (const v of result.violations) console.error(`${v.file}:${v.line}: ${v.message}`)
    process.exitCode = 1
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.stack || error.message)
    process.exitCode = 1
  })
}
