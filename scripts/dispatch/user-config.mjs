#!/usr/bin/env node
/**
 * Reads and validates per-OS-user configuration (ST-63): the usage limits, which describe the
 * crew member's plan, and each role's default and available choices of tool, model and effort
 * (`docs/user-config.md`).
 *
 * Required role and usage settings have no defaults. Only an absent coordinator section gets
 * the default cadence; a missing or invalid file fails. Reading starts no work and writes no state.
 */
import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir as osHomedir } from 'node:os'
import path from 'node:path'
import { validateUsageLimits } from './settings.mjs'

const CONFIG_ENV = 'STEWARD_CONFIG'
const CONFIG_DIR = '.steward'
const CONFIG_FILENAME = 'config.json'

const TOP_KEYS = ['usageLimits', 'roles']
// `tools` holds what a tool other than Claude Code needs; required only when a choice names one.
const OPTIONAL_TOP_KEYS = ['tools', 'coordinator']
export const USER_ROLES = ['coder', 'reviewer']
const ROLE_KEYS = ['default', 'available']
const CHOICE_KEYS = ['tool', 'model', 'effort']
// A coder's choice also has a `strength` (ST-35/AC-5); a reviewer's has none.
const CODER_CHOICE_KEYS = [...CHOICE_KEYS, 'strength']
const CHOICE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/
// The tools each role may run: the Codex CLI for the reviewer only (ST-32); a Codex coder is ST-15's.
export const ROLE_TOOLS = { coder: ['claude'], reviewer: ['claude', 'codex'] }
export const TOOLS = ['claude', 'codex']
// Each tool's effort levels: Claude Code's `--effort`, and Codex's `model_reasoning_effort`.
export const TOOL_EFFORTS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
}
export const EFFORTS = TOOL_EFFORTS.claude
const TOOL_KEYS = { codex: ['executable'] }

/** Whether `value` is a plain object: not null, not an array. */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** The config path: nonempty `env.STEWARD_CONFIG`, else the invoking OS user's home. */
export function userConfigPath({ env = process.env, homedir = osHomedir() } = {}) {
  const named = env?.[CONFIG_ENV]
  if (typeof named === 'string' && named !== '') return named
  return path.join(homedir, CONFIG_DIR, CONFIG_FILENAME)
}

/** Throws unless `object` has exactly `keys`, naming `name` and the key. */
function checkKeys(filePath, name, object, keys) {
  for (const key of Object.keys(object)) {
    if (!keys.includes(key)) throw new Error(`${filePath}: unrecognised key '${name}.${key}'`)
  }
  for (const key of keys) {
    if (!(key in object)) throw new Error(`${filePath}: missing required key '${name}.${key}'`)
  }
}

/**
 * Validates one choice, `{ tool, model, effort }`, whose tool must be one of `tools`; with
 * `strengthed` (a coder's choice) it also has a `strength`, a positive integer (ST-35/AC-5).
 */
function validateChoice(filePath, name, value, tools, strengthed) {
  if (!isObject(value)) {
    throw new Error(`${filePath}: '${name}' must be an object with 'tool', 'model' and 'effort', got ${JSON.stringify(value)}`)
  }
  checkKeys(filePath, name, value, strengthed ? CODER_CHOICE_KEYS : CHOICE_KEYS)
  const { tool, model, effort, strength } = value
  if (!tools.includes(tool)) {
    throw new Error(`${filePath}: '${name}.tool' must be one of ${JSON.stringify(tools)}, got ${JSON.stringify(tool)}`)
  }
  if (typeof model !== 'string' || model.trim() === '') {
    throw new Error(`${filePath}: '${name}.model' must be a non-empty string, got ${JSON.stringify(model)}`)
  }
  if (!TOOL_EFFORTS[tool].includes(effort)) {
    throw new Error(`${filePath}: '${name}.effort' must be one of ${JSON.stringify(TOOL_EFFORTS[tool])}, got ${JSON.stringify(effort)}`)
  }
  if (!strengthed) return { tool, model, effort }
  if (!Number.isInteger(strength) || strength < 1) {
    throw new Error(`${filePath}: '${name}.strength' must be a positive integer, got ${JSON.stringify(strength)}`)
  }
  return { tool, model, effort, strength }
}

/** Validates one role, `{ default, available }`, whose choices may run any of `tools`. */
function validateRole(filePath, name, value, tools, strengthed) {
  if (!isObject(value)) {
    throw new Error(`${filePath}: '${name}' must be an object with 'default' and 'available', got ${JSON.stringify(value)}`)
  }
  checkKeys(filePath, name, value, ROLE_KEYS)
  const { available: rawAvailable, default: chosen } = value
  const availableName = `${name}.available`
  if (!isObject(rawAvailable) || Object.keys(rawAvailable).length === 0) {
    throw new Error(`${filePath}: '${availableName}' must be a non-empty object of choices, got ${JSON.stringify(rawAvailable)}`)
  }
  const available = {}
  for (const [choice, body] of Object.entries(rawAvailable)) {
    if (!CHOICE_NAME_RE.test(choice)) {
      throw new Error(`${filePath}: '${availableName}.${choice}' is not a choice name matching ${CHOICE_NAME_RE}`)
    }
    available[choice] = validateChoice(filePath, `${availableName}.${choice}`, body, tools, strengthed)
  }
  if (typeof chosen !== 'string' || !Object.hasOwn(available, chosen)) {
    throw new Error(
      `${filePath}: '${name}.default' must name a key of '${availableName}' (${Object.keys(available).join(', ')}), got ${JSON.stringify(chosen)}`,
    )
  }
  return { default: chosen, available }
}

/** Whether `file` names a file that exists: not a directory, and not nothing. */
function isFile(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * Validates `tools` (ST-32/AC-1): an object whose only key is `codex`, itself with exactly
 * `executable`, an absolute path to a file that exists. `used` is the set of tools the choices
 * name; a tool named there must have its entry.
 */
function validateTools(filePath, value, used, fileExists) {
  if (value !== undefined && !isObject(value)) {
    throw new Error(`${filePath}: 'tools' must be an object, got ${JSON.stringify(value)}`)
  }
  const tools = value ?? {}
  for (const key of Object.keys(tools)) {
    if (!Object.hasOwn(TOOL_KEYS, key)) throw new Error(`${filePath}: unrecognised key 'tools.${key}'`)
  }
  for (const tool of Object.keys(TOOL_KEYS)) {
    if (!used.has(tool) && !Object.hasOwn(tools, tool)) continue
    if (!Object.hasOwn(tools, tool)) {
      throw new Error(`${filePath}: missing required key 'tools.${tool}.executable', since a choice's tool is "${tool}"`)
    }
    const entry = tools[tool]
    if (!isObject(entry)) throw new Error(`${filePath}: 'tools.${tool}' must be an object with 'executable', got ${JSON.stringify(entry)}`)
    checkKeys(filePath, `tools.${tool}`, entry, TOOL_KEYS[tool])
    const { executable } = entry
    if (typeof executable !== 'string' || !(path.isAbsolute(executable) || path.win32.isAbsolute(executable))) {
      throw new Error(`${filePath}: 'tools.${tool}.executable' must be an absolute path, got ${JSON.stringify(executable)}`)
    }
    if (!fileExists(executable)) {
      throw new Error(`${filePath}: 'tools.${tool}.executable' names no file that exists: ${executable}`)
    }
  }
  return value === undefined ? undefined : tools
}

/** Validates the optional coordinator cadence without starting a timer or writing state. */
function validateCoordinator(filePath, value) {
  if (value === undefined) return { scanIntervalMinutes: 15 }
  if (!isObject(value)) {
    throw new Error(`${filePath}: 'coordinator' must be an object with 'scanIntervalMinutes', got ${JSON.stringify(value)}`)
  }
  checkKeys(filePath, 'coordinator', value, ['scanIntervalMinutes'])
  const { scanIntervalMinutes } = value
  if (!Number.isSafeInteger(scanIntervalMinutes) || scanIntervalMinutes < 1 ||
      !Number.isSafeInteger(scanIntervalMinutes * 60_000)) {
    throw new Error(`${filePath}: 'coordinator.scanIntervalMinutes' must be a positive integer safely representable in milliseconds, got ${JSON.stringify(scanIntervalMinutes)}`)
  }
  return { scanIntervalMinutes }
}

/**
 * Reads and validates the user config: `{ usageLimits, roles, coordinator }`, where `roles.<role>` is
 * `{ default, available }`, `available` keeping the file's order (each coder choice also has its
 * `strength`, ST-35/AC-5), and `tools` when the file has it. Throws, naming the file and the key
 * with all its parents, on a missing file, invalid JSON, a
 * missing or unknown key, or a value of the wrong form. `exists` says whether a tool's executable
 * names a file, not a directory; injectable for tests.
 */
export async function readUserConfig({ env, homedir, exists = isFile } = {}) {
  const filePath = userConfigPath({ env, homedir })

  let raw
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`${filePath}: file not found`)
    throw err
  }

  let data
  try {
    data = JSON.parse(raw)
  } catch (err) {
    throw new Error(`${filePath}: invalid JSON: ${err.message}`)
  }
  if (!isObject(data)) throw new Error(`${filePath}: must be a JSON object`)

  for (const key of Object.keys(data)) {
    if (!TOP_KEYS.includes(key) && !OPTIONAL_TOP_KEYS.includes(key)) throw new Error(`${filePath}: unrecognised key '${key}'`)
  }
  for (const key of TOP_KEYS) {
    if (!(key in data)) throw new Error(`${filePath}: missing required key '${key}'`)
  }

  const usageLimits = validateUsageLimits(filePath, data.usageLimits)

  if (!isObject(data.roles)) {
    throw new Error(`${filePath}: 'roles' must be an object with 'coder' and 'reviewer', got ${JSON.stringify(data.roles)}`)
  }
  checkKeys(filePath, 'roles', data.roles, USER_ROLES)
  const roles = {}
  for (const role of USER_ROLES) {
    roles[role] = validateRole(filePath, `roles.${role}`, data.roles[role], ROLE_TOOLS[role], role === 'coder')
  }

  const used = new Set(USER_ROLES.flatMap((role) => Object.values(roles[role].available).map((c) => c.tool)))
  const tools = validateTools(filePath, data.tools, used, exists)
  const coordinator = validateCoordinator(filePath, data.coordinator)
  return tools === undefined ? { usageLimits, roles, coordinator } : { usageLimits, roles, tools, coordinator }
}

/**
 * The choice a coder runs for a story whose `model:` is `name` (ST-34/AC-4): that key of
 * `roles.coder.available`, or the coder's `default` when `name` is `null`. Resolves
 * `{ name, tool, model, effort, strength }`, or `null` when `name` is not an available choice.
 */
export function coderChoice(config, name) {
  const { available, default: fallback } = config.roles.coder
  const key = name === null ? fallback : name
  if (typeof key !== 'string' || !Object.hasOwn(available, key)) return null
  return { name: key, ...available[key] }
}
