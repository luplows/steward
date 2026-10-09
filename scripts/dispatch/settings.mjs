#!/usr/bin/env node
/**
 * Reads and validates a project's `steward.config.json` (OQ-122). This is the
 * first step of moving the workflow to a repository of its own: a project's
 * repository and story-id prefix are read from this file rather than carried
 * as constants in the scripts, so the same code can run a queue numbered
 * `ST-<n>` (`docs/agent-workflow-design.md`, "The story artifact", "Format").
 *
 * Nothing yet calls this from outside its own tests -- see the story's Out of
 * scope.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const SETTINGS_FILENAME = 'steward.config.json'

const REPO_RE = /^[^/\s]+\/[^/\s]+$/
const STORY_PREFIX_RE = /^[A-Z]{1,8}$/

const ALLOWED_KEYS = ['repo', 'storyPrefix']

/**
 * Reads and validates `<projectRoot>/steward.config.json`. Throws, naming the
 * file and the problem, on a missing file, invalid JSON, a missing key, an
 * invalid value, or any key beyond `repo` and `storyPrefix`. Holds no default
 * for either value -- a project without the file, or with an incomplete one,
 * fails rather than running with one assumed.
 */
export async function readSettings(projectRoot) {
  const filePath = path.join(projectRoot, SETTINGS_FILENAME)

  let raw
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`${filePath}: file not found`)
    }
    throw err
  }

  let data
  try {
    data = JSON.parse(raw)
  } catch (err) {
    throw new Error(`${filePath}: invalid JSON: ${err.message}`)
  }

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${filePath}: must be a JSON object`)
  }

  for (const key of Object.keys(data)) {
    if (!ALLOWED_KEYS.includes(key)) {
      throw new Error(`${filePath}: unrecognised key '${key}'`)
    }
  }

  const { repo, storyPrefix } = data

  if (!('repo' in data)) {
    throw new Error(`${filePath}: missing required key 'repo'`)
  }
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) {
    throw new Error(`${filePath}: 'repo' must be of the form owner/name, got ${JSON.stringify(repo)}`)
  }

  if (!('storyPrefix' in data)) {
    throw new Error(`${filePath}: missing required key 'storyPrefix'`)
  }
  if (typeof storyPrefix !== 'string' || !STORY_PREFIX_RE.test(storyPrefix)) {
    throw new Error(
      `${filePath}: 'storyPrefix' must match ${STORY_PREFIX_RE}, got ${JSON.stringify(storyPrefix)}`,
    )
  }

  return { repo, storyPrefix }
}
