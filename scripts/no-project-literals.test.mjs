// @vitest-environment node

/**
 * OQ-129: fails if the story prefix (`OQ-`) or this repository's name
 * (`luplows/tower-workshop-paths`) comes back into the modules OQ-125 to
 * OQ-128 made take them from the project's settings (steward.config.json),
 * in a regular expression literal, a string literal or a template literal.
 * Comments are left alone deliberately -- they spell `OQ-` throughout these
 * files, documenting the very story numbers that moved it out of the code.
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

function assertNoneFound(relativePath, needle) {
  const text = readFileSync(path.join(repoRoot, relativePath), 'utf8')
  const hits = findUncommentedOccurrences(text, needle)
  expect(hits, `${relativePath} has ${JSON.stringify(needle)} outside a comment on line(s) ${hits.join(', ')}`).toEqual([])
}

describe('OQ-129/AC-1', () => {
  const files = [
    'dispatch/queue.mjs',
    'lint-stories.mjs',
    'dispatch/coder.mjs',
    'dispatch/story.mjs',
    'dispatch/review.mjs',
  ]

  it.each(files)('%s does not spell the story prefix outside a comment', (relativePath) => {
    assertNoneFound(relativePath, 'OQ-')
  })
})

describe('OQ-129/AC-2', () => {
  const files = [
    'dispatch/coder.mjs',
    'dispatch/land.mjs',
    'dispatch/loop.mjs',
    'dispatch/review.mjs',
    'dispatch/story.mjs',
    'report/review-verdicts.mjs',
  ]

  it.each(files)('%s does not spell this repository\'s name outside a comment', (relativePath) => {
    assertNoneFound(relativePath, 'luplows/tower-workshop-paths')
  })
})

describe('OQ-129/AC-3', () => {
  it('reports OQ- found in a regex literal, a string literal and a template literal', () => {
    const source = [
      "const re = /OQ-\\d+/",
      "const str = 'OQ-300'",
      "const tmpl = `OQ-400`",
    ].join('\n')

    expect(findUncommentedOccurrences(source, 'OQ-')).toEqual([1, 2, 3])
  })

  it("reports luplows/tower-workshop-paths found in a string literal", () => {
    const source = "const repo = 'luplows/tower-workshop-paths'"

    expect(findUncommentedOccurrences(source, 'luplows/tower-workshop-paths')).toEqual([1])
  })

  it('reports nothing when both only appear in // and /* ... */ comments', () => {
    const source = [
      '// OQ-100 is mentioned here',
      '/* luplows/tower-workshop-paths is mentioned here too */',
      '/*',
      ' * and OQ-200 spans multiple comment lines',
      ' */',
    ].join('\n')

    expect(findUncommentedOccurrences(source, 'OQ-')).toEqual([])
    expect(findUncommentedOccurrences(source, 'luplows/tower-workshop-paths')).toEqual([])
  })
})
