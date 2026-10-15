#!/usr/bin/env node
/**
 * Finds the unit a pull request implements from the link its body gives, reads
 * that unit as it stands on `main`, and words the note the reviewer is given
 * (ST-19; `docs/outline.md`, "Defining steward", "Review"). No model takes part.
 *
 * `findUnitLink` is pure. `readUnit` reads a file with `git show` and an issue
 * through `github.mjs`, and never throws for an unreadable link. `describeUnit`
 * is pure. Its caller will be the review (ST-22).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getIssue } from './github.mjs'

const execFileAsync = promisify(execFile)

const REMOTE = 'origin'

const UNIT_LINE_RE = /^ *Unit:(.*)$/
const ISSUE_LINK_RE = /^#([1-9][0-9]*)$/
// GitHub's closing keywords, followed by whitespace and `#<n>`. A `#<n>` that
// follows `owner/name` has no whitespace before it, so it never matches.
const CLOSING_RE =
  /(?<![\w/-])(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)[ \t]+#([1-9][0-9]*)(?![\w-])/gi

function classify(text) {
  if (text.toLowerCase() === 'none') return { kind: 'none' }
  const issue = ISSUE_LINK_RE.exec(text)
  if (issue) return { kind: 'link', type: 'issue', target: Number(issue[1]) }
  if (!/\s/.test(text) && !text.includes('://')) return { kind: 'link', type: 'file', target: text }
  return { kind: 'link', type: 'other', target: text }
}

/**
 * Finds the link in a pull request body, deterministically. Returns exactly one of
 * `{ kind: 'link', type, target }` (`type` is `issue`, `file` or `other`; an issue's
 * `target` is its number), `{ kind: 'none' }`, `{ kind: 'missing' }` and
 * `{ kind: 'several', links }`. A link whose type `unitLinks` does not include is
 * returned with `unread: true`; with `unitLinks` empty, `Unit:` text is not a link
 * and comes back as `{ kind: 'missing', unread: [text, ...] }`.
 * `Unit: none` is `none` whichever `unitLinks` is. Pure.
 */
export function findUnitLink(body, unitLinks) {
  const allowed = new Set(unitLinks ?? [])
  const found = []
  const unreadText = []
  let none = false
  const add = (link) => {
    if (!found.some((f) => f.type === link.type && f.target === link.target)) found.push(link)
  }

  for (const line of String(body ?? '').split(/\r?\n/)) {
    const unit = UNIT_LINE_RE.exec(line)
    if (unit) {
      const text = unit[1].trim()
      if (text === '') continue
      const c = classify(text)
      if (c.kind === 'none') none = true
      else if (allowed.size === 0) unreadText.push(text)
      else add({ type: c.type, target: c.target })
    }
    if (allowed.has('issue')) {
      for (const m of line.matchAll(CLOSING_RE)) add({ type: 'issue', target: Number(m[1]) })
    }
  }

  const links = found.map((l) => (allowed.has(l.type) ? l : { ...l, unread: true }))
  if (links.length > 1) return { kind: 'several', links }
  if (links.length === 1) return { kind: 'link', ...links[0] }
  if (none) return { kind: 'none' }
  return unreadText.length > 0 ? { kind: 'missing', unread: unreadText } : { kind: 'missing' }
}

function unreadable(reason) {
  return { read: false, reason }
}

function isUnsafePath(target) {
  if (target.startsWith('/') || target.startsWith('\\') || /^[A-Za-z]:/.test(target)) return true
  return target.split(/[\\/]/).includes('..')
}

async function readFileOnMain(target, { repoDir, base }) {
  if (isUnsafePath(target)) {
    return unreadable(`${target}: a path must be relative and have no ".." segment`)
  }
  const spec = `${REMOTE}/${base}:${target}`
  const git = (args) =>
    execFileAsync('git', ['-c', 'core.quotepath=off', ...args], {
      cwd: repoDir,
      maxBuffer: 64 * 1024 * 1024,
    })
  try {
    const type = (await git(['cat-file', '-t', spec])).stdout.trim()
    if (type !== 'blob') return unreadable(`${target}: is not a file on ${REMOTE}/${base}`)
    return { read: true, text: (await git(['show', spec])).stdout }
  } catch (err) {
    const detail = String(err.stderr || err.message).trim()
    return unreadable(`${target}: cannot be read from ${REMOTE}/${base}: ${detail}`)
  }
}

async function readIssue(number, ctx) {
  try {
    const issue = await getIssue(ctx, number)
    if (issue.isPullRequest) return unreadable(`#${number} is a pull request, not an issue`)
    return { read: true, text: `${issue.title}\n\n${issue.body}`.trimEnd() }
  } catch (err) {
    return unreadable(`#${number} cannot be read: ${err.message}`)
  }
}

/**
 * Reads a link `findUnitLink` returned as `{ kind: 'link', ... }`: a file as it
 * stands on `<remote>/<base>` in `repoDir`, never a pull request's head; an issue
 * of this repository through `github.mjs`, as its title and body; an `other` link
 * not at all, its text returned as given. Returns `{ read: true, text }` or
 * `{ read: false, reason }`, and never throws for an unreadable link.
 */
export async function readUnit(link, { repoDir, base, ctx }) {
  try {
    if (link?.unread === true) {
      return unreadable(`the project's unitLinks does not include "${link.type}" links`)
    }
    switch (link?.type) {
      case 'file':
        return await readFileOnMain(String(link.target), { repoDir, base })
      case 'issue':
        return await readIssue(link.target, ctx)
      case 'other':
        return { read: true, text: String(link.target) }
      default:
        return unreadable(`not a link this module reads: ${JSON.stringify(link)}`)
    }
  } catch (err) {
    return unreadable(`cannot be read: ${err.message}`)
  }
}

function name(link) {
  return link.type === 'issue' ? `issue #${link.target}` : `${link.type} ${link.target}`
}

/**
 * The note the reviewer is given, one of four in fixed words (a link read, a link
 * not read, `Unit: none`, no `Unit:` line), or the one for several links, none read.
 * `read` is `readUnit`'s result for `found`'s link. Pure.
 */
export function describeUnit(found, read) {
  switch (found.kind) {
    case 'link':
      if (read?.read === true) {
        return found.type === 'other'
          ? `Unit: the pull request body links its unit as ${name(found)}, which is not read. Its text as given:\n\n${read.text}`
          : `Unit: the pull request body links its unit as ${name(found)}. It is read as it stands on main, and follows:\n\n${read.text}`
      }
      return `Unit: the pull request body links its unit as ${name(found)}. It could not be read: ${read?.reason ?? 'it was not read'}.`
    case 'none':
      return 'Unit: none. The pull request body states that it implements no unit.'
    case 'several':
      return [
        'Unit: the pull request body links several units. None was read:',
        ...found.links.map((link) => `- ${name(link)}`),
      ].join('\n')
    default:
      return found.unread?.length > 0
        ? `Unit: the pull request body has no Unit: line this project reads. Its Unit: text, not read: ${found.unread.join('; ')}.`
        : 'Unit: the pull request body has no Unit: line.'
  }
}
