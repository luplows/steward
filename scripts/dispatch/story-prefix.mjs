/**
 * Reads the story prefix (ST-41): the `prefix` of a project's `stories/stories.json`, the story
 * convention's own file. The prefix is not a setting (`steward.config.json` holds nothing about how
 * a project numbers its units), and a project with no story files has no such file.
 *
 * Its callers are steward's story tooling (the story lint, story containment, the queue reader)
 * and the engine's coder, each passing the project root it works on.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const STORY_PREFIX_FILE = path.posix.join('stories', 'stories.json')

const PREFIX_RE = /^[A-Z]{1,8}$/
const ALLOWED_KEYS = ['prefix']

/**
 * Reads and validates `<rootDir>/stories/stories.json` and returns its `prefix`. Throws, naming the
 * file and the problem, when the file is missing, is not valid JSON or a JSON object, holds a key
 * other than `prefix`, or has no `prefix` of 1 to 8 capital letters. Nothing falls back to a default.
 */
export async function readStoryPrefix(rootDir = process.cwd()) {
  const filePath = path.join(rootDir, STORY_PREFIX_FILE)

  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`${filePath}: file not found`)
    throw err
  }

  let data
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new Error(`${filePath}: invalid JSON: ${err.message}`)
  }

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${filePath}: must be a JSON object`)
  }
  for (const key of Object.keys(data)) {
    if (!ALLOWED_KEYS.includes(key)) throw new Error(`${filePath}: unrecognised key '${key}'`)
  }
  if (typeof data.prefix !== 'string' || !PREFIX_RE.test(data.prefix)) {
    throw new Error(`${filePath}: 'prefix' must match ${PREFIX_RE}, got ${JSON.stringify(data.prefix)}`)
  }
  return data.prefix
}
