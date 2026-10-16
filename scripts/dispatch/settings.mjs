#!/usr/bin/env node
/**
 * Reads and validates a project's `steward.config.json` (OQ-122). This is the
 * first step of moving the workflow to a repository of its own: a project's
 * repository and story-id prefix are read from this file rather than carried
 * as constants in the scripts, so the same code can run a queue numbered
 * `ST-<n>` (`docs/agent-workflow-design.md`, "The story artifact", "Format").
 *
 * Its callers are the dispatch scripts, the story lint and the verdict
 * report, each passing the project root it works on.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const SETTINGS_FILENAME = 'steward.config.json'

const REPO_RE = /^[^/\s]+\/[^/\s]+$/
const STORY_PREFIX_RE = /^[A-Z]{1,8}$/

const COMMAND_KEYS = ['command', 'timeoutMinutes']
const LAND_WHEN_ALL = 'all-checks'
const USAGE_ROLES = ['coder', 'reviewer']
const USAGE_WINDOWS = ['session', 'weekly']
const UNIT_LINK_KINDS = ['issue', 'file', 'other']

const ALLOWED_KEYS = [
  'repo',
  'storyPrefix',
  'setup',
  'check',
  'landWhen',
  'land',
  'unitLinks',
  'rulesFile',
]

/** A non-empty array of distinct values, each passing `itemOk`. */
function isDistinctArray(value, itemOk, { allowEmpty }) {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every(itemOk) &&
    new Set(value).size === value.length
  )
}

/** A relative path with forward slashes: not absolute, no `..` segment, no empty segment. */
function isRelativeForwardPath(value) {
  if (typeof value !== 'string' || value === '') return false
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  return value.split('/').every((segment) => segment !== '' && segment !== '..')
}

/** Validates a `setup` or `check` value: `null`, or { command, timeoutMinutes }. */
function validateCommand(filePath, name, value) {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `${filePath}: '${name}' must be null or an object with 'command' and 'timeoutMinutes', got ${JSON.stringify(value)}`,
    )
  }
  for (const key of Object.keys(value)) {
    if (!COMMAND_KEYS.includes(key)) {
      throw new Error(`${filePath}: unrecognised key '${name}.${key}'`)
    }
  }
  for (const key of COMMAND_KEYS) {
    if (!(key in value)) {
      throw new Error(`${filePath}: missing required key '${name}.${key}'`)
    }
  }
  const { command, timeoutMinutes } = value
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error(`${filePath}: '${name}.command' must be a non-empty string, got ${JSON.stringify(command)}`)
  }
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1) {
    throw new Error(
      `${filePath}: '${name}.timeoutMinutes' must be a positive integer, got ${JSON.stringify(timeoutMinutes)}`,
    )
  }
  return { command, timeoutMinutes }
}

/**
 * Validates `usageLimits`: { coder, reviewer }, each { session, weekly }, integers 1 to 100.
 * The machine's settings hold it (ST-34); `machine-settings.mjs` calls this.
 */
export function validateUsageLimits(filePath, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${filePath}: 'usageLimits' must be an object with 'coder' and 'reviewer', got ${JSON.stringify(value)}`)
  }
  const checkKeys = (name, object, keys) => {
    for (const key of Object.keys(object)) {
      if (!keys.includes(key)) throw new Error(`${filePath}: unrecognised key '${name}.${key}'`)
    }
    for (const key of keys) {
      if (!(key in object)) throw new Error(`${filePath}: missing required key '${name}.${key}'`)
    }
  }
  checkKeys('usageLimits', value, USAGE_ROLES)
  const limits = {}
  for (const role of USAGE_ROLES) {
    const name = `usageLimits.${role}`
    const windows = value[role]
    if (windows === null || typeof windows !== 'object' || Array.isArray(windows)) {
      throw new Error(`${filePath}: '${name}' must be an object with 'session' and 'weekly', got ${JSON.stringify(windows)}`)
    }
    checkKeys(name, windows, USAGE_WINDOWS)
    limits[role] = {}
    for (const window of USAGE_WINDOWS) {
      const limit = windows[window]
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error(`${filePath}: '${name}.${window}' must be an integer from 1 to 100, got ${JSON.stringify(limit)}`)
      }
      limits[role][window] = limit
    }
  }
  return limits
}

/**
 * Reads and validates `<projectRoot>/steward.config.json`. Throws, naming the
 * file and the problem, on a missing file, invalid JSON, a missing key, an
 * invalid value, or any key beyond those listed in `docs/settings.md`
 * (inside a `setup` or `check` object too). Holds no default for any value --
 * a project without the file, or with an incomplete one, fails rather than
 * running with one assumed (ST-18).
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

  for (const key of ALLOWED_KEYS) {
    if (!(key in data)) {
      throw new Error(`${filePath}: missing required key '${key}'`)
    }
  }

  if (typeof repo !== 'string' || !REPO_RE.test(repo)) {
    throw new Error(`${filePath}: 'repo' must be of the form owner/name, got ${JSON.stringify(repo)}`)
  }

  if (typeof storyPrefix !== 'string' || !STORY_PREFIX_RE.test(storyPrefix)) {
    throw new Error(
      `${filePath}: 'storyPrefix' must match ${STORY_PREFIX_RE}, got ${JSON.stringify(storyPrefix)}`,
    )
  }

  const setup = validateCommand(filePath, 'setup', data.setup)
  const check = validateCommand(filePath, 'check', data.check)

  const { landWhen, land, unitLinks, rulesFile } = data
  if (
    landWhen !== LAND_WHEN_ALL &&
    !isDistinctArray(landWhen, (name) => typeof name === 'string' && name !== '', { allowEmpty: false })
  ) {
    throw new Error(
      `${filePath}: 'landWhen' must be "${LAND_WHEN_ALL}" or a non-empty array of distinct, non-empty strings, got ${JSON.stringify(landWhen)}`,
    )
  }
  if (typeof land !== 'boolean') {
    throw new Error(`${filePath}: 'land' must be a boolean, got ${JSON.stringify(land)}`)
  }
  if (!isDistinctArray(unitLinks, (kind) => UNIT_LINK_KINDS.includes(kind), { allowEmpty: true })) {
    throw new Error(
      `${filePath}: 'unitLinks' must be an array of distinct values from ${JSON.stringify(UNIT_LINK_KINDS)}, got ${JSON.stringify(unitLinks)}`,
    )
  }
  if (!isRelativeForwardPath(rulesFile)) {
    throw new Error(
      `${filePath}: 'rulesFile' must be a relative path with forward slashes and no '..' segment, got ${JSON.stringify(rulesFile)}`,
    )
  }

  return { repo, storyPrefix, setup, check, landWhen, land, unitLinks, rulesFile }
}
