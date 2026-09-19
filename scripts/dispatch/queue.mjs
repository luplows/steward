#!/usr/bin/env node
/**
 * Reads stories/ and stories/done/, derives each story's status from its
 * frontmatter and body -- never from a stored status field -- and orders the
 * result deterministically by tier then id. See stories/README.md for the
 * status table and ordering rule this implements, and stories/OQ-49-*.md for
 * the acceptance criteria.
 *
 * Deliberately does not touch git or GitHub (in-progress/in-review belong to
 * a later dispatcher), spawn anything, or write to any story file.
 *
 * Usage:
 *   node scripts/dispatch/queue.mjs
 */
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const TIERS = ['fix', 'next', 'normal', 'later']

export const STORY_FILENAME_RE = /^OQ-\d+-[\w-]+\.md$/

export function isStoryFilename(name) {
  return STORY_FILENAME_RE.test(name)
}

const REQUIRED_FRONTMATTER_FIELDS = ['id', 'title', 'tier', 'depends_on', 'blocked']

const OPEN_QUESTIONS_MARKER = '*(none)*'

// Parses one YAML-ish scalar value from the right-hand side of `key: value`
// in a story's frontmatter. The schema is fixed and small (see
// stories/_TEMPLATE.md), so this handles exactly what it needs: `null`,
// `[a, b]` / `[]` lists, double-quoted strings, and bare strings -- not
// general YAML.
function parseScalarValue(raw) {
  const value = raw.trim()

  if (value.startsWith('"')) {
    const match = value.match(/^"((?:[^"\\]|\\.)*)"/)
    if (!match) throw new Error(`unterminated quoted string: ${raw}`)
    return match[1].replace(/\\(.)/g, '$1')
  }

  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end === -1) throw new Error(`unterminated list: ${raw}`)
    const inner = value.slice(1, end).trim()
    return inner === '' ? [] : inner.split(',').map((entry) => entry.trim())
  }

  const commentIndex = value.indexOf(' #')
  const withoutComment = (commentIndex === -1 ? value : value.slice(0, commentIndex)).trim()

  return withoutComment === 'null' ? null : withoutComment
}

/**
 * Splits `source` into its frontmatter block and body. Throws, naming
 * `filePath`, when the frontmatter is missing, an individual line is
 * unparseable, or a field this module reads (AC-2) is absent.
 */
export function parseFrontmatter(source, filePath) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) {
    throw new Error(`${filePath}: missing frontmatter block`)
  }

  const data = {}
  for (const rawLine of match[1].split(/\r?\n/)) {
    if (rawLine.trim() === '') continue
    // An indented line is a continuation of the previous key -- a block-style
    // YAML list (e.g. `mechanisms:` followed by `  - item`) or multi-line
    // scalar for a field this module doesn't read. Nothing this module needs
    // is ever written that way (see stories/_TEMPLATE.md), so it's skipped
    // rather than parsed.
    if (/^[ \t]/.test(rawLine)) continue

    const line = rawLine.trim()
    const lineMatch = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!lineMatch) {
      throw new Error(`${filePath}: unparseable frontmatter line: ${JSON.stringify(rawLine)}`)
    }

    const [, key, rawValue] = lineMatch
    try {
      data[key] = parseScalarValue(rawValue)
    } catch (err) {
      throw new Error(`${filePath}: frontmatter field '${key}': ${err.message}`)
    }
  }

  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    if (!(field in data)) {
      throw new Error(`${filePath}: frontmatter missing required field '${field}'`)
    }
  }

  return { data, body: source.slice(match[0].length) }
}

/**
 * Splits a story's body into its `## ` sections, keyed by heading text.
 * Fence-aware (AC-8): a `## ` line inside a ``` or ~~~ fence is content, not
 * a heading, so it neither starts nor ends a section.
 */
export function parseSections(body) {
  const sections = new Map()
  let currentHeading = null
  let currentLines = []
  let fenceChar = null
  let fenceLen = 0

  const flush = () => {
    if (currentHeading !== null) {
      sections.set(currentHeading, currentLines.join('\n'))
    }
  }

  for (const line of body.split(/\r?\n/)) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/)
    if (fenceMatch) {
      const [marker] = fenceMatch
      const char = marker.trim()[0]
      if (fenceChar === null) {
        fenceChar = char
        fenceLen = marker.trim().length
      } else if (char === fenceChar && marker.trim().length >= fenceLen) {
        fenceChar = null
        fenceLen = 0
      }
      currentLines.push(line)
      continue
    }

    if (fenceChar === null) {
      const headingMatch = line.match(/^##(?!#)\s+(.+?)\s*$/)
      if (headingMatch) {
        flush()
        currentHeading = headingMatch[1]
        currentLines = []
        continue
      }
    }

    currentLines.push(line)
  }
  flush()

  return sections
}

/**
 * True when the section counts as empty per AC-7: its content, ignoring
 * HTML comments and whitespace, is exactly `*(none)*`. Throws when the
 * section holds nothing at all -- malformed, not empty, because it cannot be
 * told apart from one nobody filled in.
 */
export function isOpenQuestionsEmpty(sectionText) {
  const stripped = sectionText.replace(/<!--[\s\S]*?-->/g, '').trim()
  if (stripped === '') {
    throw new Error("'Open questions' section is empty (no content and no *(none)* marker)")
  }
  return stripped === OPEN_QUESTIONS_MARKER
}

/**
 * Parses one story file into a story object, without deriving its status
 * (which additionally needs the full set of done ids -- see deriveStatus).
 * Throws, naming filePath, on anything AC-2 requires to fail loudly.
 */
export function buildStory(filePath, source, isDone) {
  const { data, body } = parseFrontmatter(source, filePath)
  const { id, title, tier, depends_on: dependsOn, blocked } = data

  if (typeof id !== 'string' || !/^OQ-\d+$/.test(id)) {
    throw new Error(`${filePath}: frontmatter 'id' is not of the form OQ-<n>: ${JSON.stringify(id)}`)
  }
  if (!TIERS.includes(tier)) {
    throw new Error(`${filePath}: unrecognised tier '${tier}'`)
  }
  if (!Array.isArray(dependsOn)) {
    throw new Error(`${filePath}: frontmatter 'depends_on' is not a list`)
  }

  const sections = parseSections(body)
  if (!sections.has('Open questions')) {
    throw new Error(`${filePath}: missing '## Open questions' section`)
  }

  let openQuestionsEmpty
  try {
    openQuestionsEmpty = isOpenQuestionsEmpty(sections.get('Open questions'))
  } catch (err) {
    throw new Error(`${filePath}: ${err.message}`)
  }

  return {
    id,
    numericId: Number(id.slice('OQ-'.length)),
    title,
    tier,
    dependsOn,
    blocked,
    isDone,
    openQuestionsEmpty,
    filePath,
  }
}

/**
 * Derives a story's status (AC-3): the first matching rung wins. `stories`
 * this depends on being in stories/done/ are looked up in `doneIds`.
 */
export function deriveStatus(story, doneIds) {
  if (story.isDone) return { status: 'done' }
  if (story.blocked !== null) return { status: 'blocked', reason: story.blocked }
  if (!story.openQuestionsEmpty) return { status: 'draft' }

  const waitingOn = story.dependsOn.filter((dep) => !doneIds.has(dep))
  if (waitingOn.length > 0) return { status: 'waiting', waitingOn }

  return { status: 'ready' }
}

/** Orders stories by tier (fix, next, normal, later), then lowest id first. */
export function orderStories(stories) {
  return [...stories].sort((a, b) => {
    const tierDiff = TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier)
    return tierDiff !== 0 ? tierDiff : a.numericId - b.numericId
  })
}

/** Only `ready` stories are dispatchable (AC-4). */
export function dispatchable(stories) {
  return stories.filter((story) => story.status === 'ready')
}

async function readStoryDir(dir, isDone) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }

  return entries.filter((entry) => entry.isFile() && isStoryFilename(entry.name)).map((entry) => ({
    filePath: path.join(dir, entry.name),
    isDone,
  }))
}

/**
 * Reads and orders the full queue from `<rootDir>/stories` and
 * `<rootDir>/stories/done`. Throws, naming the offending file, on the first
 * story that fails to parse (AC-2) -- never skips it.
 */
export async function loadQueue(rootDir = process.cwd()) {
  const storiesDir = path.join(rootDir, 'stories')
  const doneDir = path.join(storiesDir, 'done')

  const files = [...(await readStoryDir(storiesDir, false)), ...(await readStoryDir(doneDir, true))]

  const built = []
  for (const file of files) {
    const source = await readFile(file.filePath, 'utf8')
    built.push(buildStory(file.filePath, source, file.isDone))
  }

  const doneIds = new Set(built.filter((story) => story.isDone).map((story) => story.id))
  const withStatus = built.map((story) => ({ ...story, ...deriveStatus(story, doneIds) }))

  return orderStories(withStatus)
}

function formatQueueLine(story) {
  const suffix = story.status === 'waiting' ? ` (waiting on ${story.waitingOn.join(', ')})` : ''
  return `${story.id}  ${story.status.padEnd(8)}  ${story.title}${suffix}`
}

async function main() {
  const stories = await loadQueue()
  for (const story of stories) {
    console.log(formatQueueLine(story))
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
