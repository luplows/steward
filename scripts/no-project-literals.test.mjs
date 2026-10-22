// @vitest-environment node

/**
 * ST-41/AC-5: fails if steward's own story prefix (`ST-`) or steward's own repository
 * (`luplows/steward`) is spelt in the modules that take them from the project, in a regular
 * expression literal, a string literal or a template literal. The prefix is the `prefix` of
 * `stories/stories.json` and the repository is `steward.config.json`'s `repo`. Comments are left
 * alone deliberately -- they spell `ST-` throughout these files, documenting the stories that
 * built them. (OQ-129 wrote this guard for tower-workshop-paths' `OQ-` and repository.)
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.dirname(fileURLToPath(import.meta.url))

// Keywords after which a `/` starts a regular-expression literal rather than
// a division operator.
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'else', 'do', 'yield', 'case', 'await', 'default', 'extends',
])

function canStartRegex(prevSignificant) {
  return prevSignificant === 'start' || prevSignificant === 'punct' || prevSignificant === 'keyword'
}

/**
 * Walks `source` as a small lexer -- comments, strings, template literals
 * (including `${...}` interpolation) and regular-expression literals -- and
 * returns the `[start, end)` ranges that are `//` or `/* ... *\/` comments.
 * Not a JS parser: it classifies enough to tell a comment from everything
 * else without being confused by comment-like text inside a literal.
 */
function commentRanges(source) {
  const n = source.length
  const stack = [{ type: 'code', braceDepth: 0, prevSignificant: 'start' }]
  const ranges = []
  let i = 0

  while (i < n) {
    const frame = stack[stack.length - 1]
    const ch = source[i]

    if (frame.type === 'lineComment') {
      if (ch === '\n') {
        ranges.push([frame.start, i])
        stack.pop()
      }
      i++
      continue
    }

    if (frame.type === 'blockComment') {
      if (ch === '*' && source[i + 1] === '/') {
        ranges.push([frame.start, i + 2])
        stack.pop()
        i += 2
        continue
      }
      i++
      continue
    }

    if (frame.type === 'string') {
      if (ch === '\\') { i += 2; continue }
      if (ch === frame.quote) {
        stack.pop()
        const parent = stack[stack.length - 1]
        if (parent) parent.prevSignificant = 'value'
        i++
        continue
      }
      i++
      continue
    }

    if (frame.type === 'regex') {
      if (ch === '\\') { i += 2; continue }
      if (ch === '[') { frame.inClass = true; i++; continue }
      if (frame.inClass) {
        if (ch === ']') frame.inClass = false
        i++
        continue
      }
      if (ch === '/') {
        i++
        while (i < n && /[a-z]/i.test(source[i])) i++
        stack.pop()
        const parent = stack[stack.length - 1]
        if (parent) parent.prevSignificant = 'value'
        continue
      }
      i++
      continue
    }

    if (frame.type === 'templateText') {
      if (ch === '\\') { i += 2; continue }
      if (ch === '`') {
        stack.pop()
        const parent = stack[stack.length - 1]
        if (parent) parent.prevSignificant = 'value'
        i++
        continue
      }
      if (ch === '$' && source[i + 1] === '{') {
        stack.push({ type: 'code', braceDepth: 0, prevSignificant: 'start', templateExpr: true })
        i += 2
        continue
      }
      i++
      continue
    }

    // frame.type === 'code'
    if (ch === '/' && source[i + 1] === '/') {
      stack.push({ type: 'lineComment', start: i })
      i += 2
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      stack.push({ type: 'blockComment', start: i })
      i += 2
      continue
    }
    if (ch === '"' || ch === "'") {
      stack.push({ type: 'string', quote: ch })
      i++
      continue
    }
    if (ch === '`') {
      stack.push({ type: 'templateText' })
      i++
      continue
    }
    if (ch === '/') {
      if (canStartRegex(frame.prevSignificant)) {
        stack.push({ type: 'regex', inClass: false })
        i++
        continue
      }
      frame.prevSignificant = 'value'
      i++
      continue
    }
    if (ch === '{') { frame.braceDepth++; frame.prevSignificant = 'punct'; i++; continue }
    if (ch === '}') {
      if (frame.templateExpr && frame.braceDepth === 0) {
        stack.pop()
        i++
        continue
      }
      frame.braceDepth--
      frame.prevSignificant = 'close'
      i++
      continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i
      while (j < n && /[A-Za-z0-9_$]/.test(source[j])) j++
      frame.prevSignificant = REGEX_KEYWORDS.has(source.slice(i, j)) ? 'keyword' : 'value'
      i = j
      continue
    }
    if (/[0-9]/.test(ch)) {
      let j = i
      while (j < n && /[0-9.eExXa-fA-F]/.test(source[j])) j++
      frame.prevSignificant = 'value'
      i = j
      continue
    }
    if (ch === ')' || ch === ']') { frame.prevSignificant = 'close'; i++; continue }
    if (/\s/.test(ch)) { i++; continue }
    frame.prevSignificant = 'punct'
    i++
  }

  return ranges
}

/** Line (1-based) that `index` falls on, for readable failure messages. */
function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

/**
 * Every `index` where `needle` starts in `source` outside a `//` or
 * `/* ... *\/` comment -- so inside a regular-expression literal, a string
 * literal, a template literal, or bare code.
 */
function findUncommentedOccurrences(source, needle) {
  const ranges = commentRanges(source)
  const hits = []
  let idx = source.indexOf(needle)
  while (idx !== -1) {
    const inComment = ranges.some(([start, end]) => idx >= start && idx < end)
    if (!inComment) hits.push(lineOf(source, idx))
    idx = source.indexOf(needle, idx + 1)
  }
  return hits
}

/**
 * The lines of `source` where any of `spellings` is spelt outside a comment, in order. A regular
 * expression literal cannot hold a bare `/`, so a repository name has a second spelling there.
 */
function findSpelt(source, spellings) {
  const lines = new Set(spellings.flatMap((spelling) => findUncommentedOccurrences(source, spelling)))
  return [...lines].sort((a, b) => a - b)
}

function assertNoneFound(relativePath, spellings) {
  const text = readFileSync(path.join(repoRoot, relativePath), 'utf8')
  const hits = findSpelt(text, spellings)
  expect(hits, `${relativePath} has ${JSON.stringify(spellings)} outside a comment on line(s) ${hits.join(', ')}`).toEqual([])
}

const PREFIX = ['ST-']
const REPOSITORY = ['luplows/steward', 'luplows\\/steward']

describe('ST-41/AC-5: the story prefix', () => {
  const files = [
    'dispatch/queue.mjs',
    'lint-stories.mjs',
    'dispatch/coder.mjs',
    'dispatch/story.mjs',
    'dispatch/review.mjs',
  ]

  it.each(files)('%s does not spell the story prefix outside a comment', (relativePath) => {
    assertNoneFound(relativePath, PREFIX)
  })
})

describe('ST-41/AC-5: the repository', () => {
  const files = [
    'dispatch/coder.mjs',
    'dispatch/land.mjs',
    'dispatch/loop.mjs',
    'dispatch/review.mjs',
    'dispatch/story.mjs',
    'report/review-verdicts.mjs',
  ]

  it.each(files)("%s does not spell this repository's name outside a comment", (relativePath) => {
    assertNoneFound(relativePath, REPOSITORY)
  })
})

describe('ST-41/AC-5: the guard finds each in code and not in a comment', () => {
  it('reports ST- found in a regex literal, a string literal and a template literal', () => {
    const source = [
      'const re = /ST-\\d+/',
      "const str = 'ST-300'",
      'const tmpl = `ST-400`',
    ].join('\n')

    expect(findSpelt(source, PREFIX)).toEqual([1, 2, 3])
  })

  it('reports luplows/steward found in a regex literal, a string literal and a template literal', () => {
    const source = [
      'const re = /luplows\\/steward/',
      "const str = 'luplows/steward'",
      'const tmpl = `luplows/steward`',
    ].join('\n')

    expect(findSpelt(source, REPOSITORY)).toEqual([1, 2, 3])
  })

  it('reports nothing when both only appear in // and /* ... */ comments', () => {
    const source = [
      '// ST-100 is mentioned here',
      '/* luplows/steward is mentioned here too */',
      '/*',
      ' * and ST-200 spans multiple comment lines',
      ' * and a regex-shaped luplows\\/steward',
      ' */',
    ].join('\n')

    expect(findSpelt(source, PREFIX)).toEqual([])
    expect(findSpelt(source, REPOSITORY)).toEqual([])
  })
})
