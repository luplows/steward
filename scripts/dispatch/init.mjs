#!/usr/bin/env node
/**
 * `steward init` (ST-44): sets a project up for steward's review gate. Run in the project's
 * checkout, it asks what it needs at the terminal, writes what the gate needs, creates the labels
 * steward reads and applies, and says what it left alone. It starts no model session, and it
 * commits, stages and pushes nothing: the crew commits what it wrote through a pull request of the
 * project's own. The design is `docs/agent-workflow-design.md`, Part 3, "Decided so far", "Steward
 * installs in another project as a review gate, through `init`"; `docs/settings.md` says what it
 * writes for each key.
 *
 * It overwrites nothing. Every file is created only when it is not there (`flag: 'wx'`), and one
 * that is there is named as left. It neither reads nor writes `storyPrefix`, `stories/` or the
 * project's `package.json` or CI workflows.
 *
 * Every question has a flag, `--yes` takes the default of every question no flag answers, and with
 * no terminal a question with neither is refused, before anything is written (`QUESTIONS`).
 *
 * Exit code: 0 when it finished, whatever it left alone or could not set; 1 when a write or a
 * request to GitHub failed (other than branch protection's refusals, which it reports and goes
 * on from), nothing more being written; 2 when it refused: a checkout that is not a git
 * repository, a flag or answer that is wrong, or a question with no answer and no terminal.
 *
 * Usage:
 *   steward init [--yes] [--ref <40-hex commit>] [--<question flag> <answer>]...
 */
import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir as osHomedir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { ghAuthToken } from './github.mjs'
import { INSPECTION_LABEL, isLabelAlreadyExists } from './inspect.mjs'
import { machineSettingsPath, TOOL_EFFORTS } from './machine-settings.mjs'
import { isRulesFilePath } from './rules-file-path.mjs'
import { BREAKER_OVERRIDE_LABEL, REVIEW_BLOCKED_LABEL } from '../land/runway.mjs'

const API = 'https://api.github.com'
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAIN = 'main'
const GATE_CONTEXT = 'review/agent'
const VERSION_PLACEHOLDER = 'v{{STEWARD_VERSION}}'
const SHA_RE = /^[0-9a-fA-F]{40}$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const UNIT_LINK_KINDS = ['file', 'issue', 'other']

/** The thin workflow files `init` writes: the gate's, the runway's, and (when asked) inspection's. */
export const GATE_WORKFLOWS = ['review-gate.yml', 'land-approved.yml']
export const INSPECTION_WORKFLOW = 'inspection.yml'

/**
 * Every label steward reads or applies today, the one place the code lists them. A later story
 * that adds a label adds it here (`init.test.mjs` compares the names with the constants the gate's,
 * the runway's and inspection's modules hold).
 */
export const LABELS = [
  { name: REVIEW_BLOCKED_LABEL, color: 'b60205', description: 'Steward stopped reviewing this pull request: its reviews blocked it too often' },
  { name: BREAKER_OVERRIDE_LABEL, color: '0e8a16', description: "The crew's word that steward may land past its circuit breaker" },
  { name: INSPECTION_LABEL, color: 'fbca04', description: "Raised by steward's inspection" },
]

/** The branch protection `init` sets on `main`, on a yes: `review/agent` required, admins included. */
export const PROTECTION_BODY = {
  required_status_checks: { strict: false, contexts: [GATE_CONTEXT] },
  enforce_admins: true,
  required_pull_request_reviews: null,
  restrictions: null,
}

// ------------------------------------------------------------------ the questions

/** Thrown for a wrong flag or answer; `main` prints it and exits 2. */
class Refusal extends Error {}

function parseYesNo(text) {
  const t = text.trim().toLowerCase()
  if (['y', 'yes', 'true'].includes(t)) return true
  if (['n', 'no', 'false'].includes(t)) return false
  throw new Refusal('answer yes or no')
}

function parseUnitLinks(text) {
  const t = text.trim().toLowerCase()
  if (t === 'none') return []
  const kinds = t.split(/[\s,]+/).filter((k) => k !== '')
  if (kinds.length === 0) throw new Refusal(`answer any of ${UNIT_LINK_KINDS.join(', ')}, separated by commas, or none`)
  for (const kind of kinds) {
    if (!UNIT_LINK_KINDS.includes(kind)) throw new Refusal(`'${kind}' is not one of ${UNIT_LINK_KINDS.join(', ')}`)
  }
  return [...new Set(kinds)]
}

function parseRulesFile(text) {
  const value = text.trim()
  if (!isRulesFilePath(value)) {
    throw new Refusal(`'${value}' is not a relative path with forward slashes, no '..' segment, and no control character, backtick, '<' or '>'`)
  }
  return value
}

function parseInteger(min, max) {
  return (text) => {
    const t = text.trim()
    const n = /^[0-9]+$/.test(t) ? Number(t) : NaN
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      throw new Refusal(`answer a whole number from ${min}${max === Infinity ? ' up' : ` to ${max}`}`)
    }
    return n
  }
}

const parseChoice = (...choices) => (text) => {
  const t = text.trim().toLowerCase()
  if (!choices.includes(t)) throw new Refusal(`answer one of ${choices.join(', ')}`)
  return t
}

const parseCodexEffort = (text) => {
  const t = text.trim().toLowerCase()
  if (!TOOL_EFFORTS.codex.includes(t)) throw new Refusal(`answer one of ${TOOL_EFFORTS.codex.join(', ')}`)
  return t
}

function parseNonEmpty(text) {
  const t = text.trim()
  if (t === '') throw new Refusal('answer with a non-empty value')
  return t
}

/**
 * Each question: the `id` its answer is kept under, the `flag` that answers it, the `prompt`, its
 * `default` as the text a person would type (`null` for a question with no default, which `--yes`
 * does not cover), `parse`, and `when(state)` saying whether it is asked at all.
 */
export const QUESTIONS = [
  {
    id: 'unitLinks',
    flag: '--unit-links',
    prompt:
      'Which links to its unit may a pull request carry? Any of file, issue and other, separated by commas, or none. ' +
      "`other` covers a tracker steward cannot read yet: its link is passed to the reviewer unread.",
    default: 'file,issue',
    parse: parseUnitLinks,
  },
  {
    id: 'rulesFile',
    flag: '--rules-file',
    prompt: "Where is the project's checklist, the file of rules a pull request is reviewed against? An example is written there if the file is missing.",
    default: 'REVIEW.md',
    parse: parseRulesFile,
  },
  {
    id: 'land',
    flag: '--land',
    prompt: 'Should steward land pull requests that pass? (no: steward reviews and the project merges)',
    default: 'yes',
    parse: parseYesNo,
  },
  {
    id: 'inspectAfterHours',
    flag: '--inspect-after-hours',
    prompt: 'How many hours may a pull request stay pending or holding before inspection raises it?',
    default: '24',
    parse: parseInteger(1, Infinity),
  },
  {
    id: 'inspection',
    flag: '--inspection',
    prompt: "Add inspection's workflow, which raises a merge without a passing verdict, or a stalled review, as an issue?",
    default: 'yes',
    parse: parseYesNo,
  },
  {
    id: 'protectMain',
    flag: '--protect-main',
    prompt: 'Set branch protection on main, requiring the review/agent check?',
    default: 'no',
    parse: parseYesNo,
  },
  {
    id: 'coderSessionLimit',
    flag: '--coder-session-limit',
    prompt: "At what share of the plan's 5-hour usage (1 to 100) does steward start no coder session?",
    default: '70',
    parse: parseInteger(1, 100),
    when: (s) => s.machineMissing,
  },
  {
    id: 'coderWeeklyLimit',
    flag: '--coder-weekly-limit',
    prompt: "At what share of the plan's weekly usage (1 to 100) does steward start no coder session?",
    default: '75',
    parse: parseInteger(1, 100),
    when: (s) => s.machineMissing,
  },
  {
    id: 'reviewerSessionLimit',
    flag: '--reviewer-session-limit',
    prompt: "At what share of the plan's 5-hour usage (1 to 100) does steward start no reviewer session?",
    default: '90',
    parse: parseInteger(1, 100),
    when: (s) => s.machineMissing,
  },
  {
    id: 'reviewerWeeklyLimit',
    flag: '--reviewer-weekly-limit',
    prompt: "At what share of the plan's weekly usage (1 to 100) does steward start no reviewer session?",
    default: '90',
    parse: parseInteger(1, 100),
    when: (s) => s.machineMissing,
  },
  {
    id: 'reviewer',
    flag: '--reviewer',
    prompt: 'Review on Claude (opus), or on the Codex CLI (claude or codex)?',
    default: 'claude',
    parse: parseChoice('claude', 'codex'),
    when: (s) => s.machineMissing && s.codexExecutable !== null,
  },
  {
    id: 'codexModel',
    flag: '--codex-model',
    prompt: "Which model does the Codex reviewer run (as Codex names it)? It has no default.",
    default: null,
    parse: parseNonEmpty,
    when: (s) => s.machineMissing && s.answers.reviewer === 'codex',
  },
  {
    id: 'codexEffort',
    flag: '--codex-effort',
    prompt: `Which effort does the Codex reviewer run at (${TOOL_EFFORTS.codex.join(', ')})? It has no default.`,
    default: null,
    parse: parseCodexEffort,
    when: (s) => s.machineMissing && s.answers.reviewer === 'codex',
  },
]

// `--yes`, `--ref`, and `--codex-path` (where `codex` is when it is not on the PATH) are not questions.
const OTHER_FLAGS = ['--yes', '--ref', '--codex-path']
const USAGE = `usage: steward init [--yes] [--ref <commit>] [--codex-path <path>] ${QUESTIONS.map((q) => `[${q.flag} <answer>]`).join(' ')}`

/** The flags of `argv` as `{ yes, values }`, `values` mapping a flag to its text. */
export function parseFlags(argv) {
  const known = new Set([...OTHER_FLAGS, ...QUESTIONS.map((q) => q.flag)])
  const values = {}
  let yes = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const flag = eq === -1 ? arg : arg.slice(0, eq)
    if (!known.has(flag)) throw new Refusal(`${arg}: not a flag of init\n${USAGE}`)
    if (flag === '--yes') {
      if (eq !== -1) throw new Refusal(`--yes takes no value\n${USAGE}`)
      yes = true
      continue
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1)
    if (value === undefined || (eq === -1 && value.startsWith('--'))) throw new Refusal(`${flag} needs a value\n${USAGE}`)
    if (Object.hasOwn(values, flag)) throw new Refusal(`${flag} is given twice`)
    values[flag] = value
  }
  return { yes, values }
}

/**
 * Answers every question that applies. A question is answered by its flag; otherwise, under `yes`,
 * by its default; otherwise at the terminal. With no terminal, a question none of these answers is
 * collected as missing, and the result names every one, so that the caller refuses naming them all
 * and writes nothing. Resolves `{ answers, missing }`.
 */
export async function gather({ flags, state, terminal }) {
  const answers = {}
  const missing = []
  const here = { ...state, answers }
  for (const q of QUESTIONS) {
    if (!q.when || q.when(here)) {
      const given = flags.values[q.flag]
      if (given !== undefined) {
        try {
          answers[q.id] = q.parse(given)
        } catch (error) {
          if (!(error instanceof Refusal)) throw error
          throw new Refusal(`${q.flag} ${given}: ${error.message}`)
        }
      } else if (flags.yes && q.default !== null) {
        answers[q.id] = q.parse(q.default)
      } else if (terminal.isTTY) {
        for (;;) {
          const reply = (await terminal.question(`${q.prompt}${q.default === null ? '' : ` [${q.default}]`} `)).trim()
          try {
            answers[q.id] = q.parse(reply === '' && q.default !== null ? q.default : reply)
            break
          } catch (error) {
            if (!(error instanceof Refusal)) throw error
            terminal.write(`${error.message}\n`)
          }
        }
      } else {
        missing.push(q)
      }
    }
  }
  return { answers, missing }
}

// ------------------------------------------------------------------ git and the files

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

/** The checkout's root, or `null` when `cwd` is not in a git repository. */
function gitRoot(cwd) {
  try {
    return path.resolve(git(cwd, ['rev-parse', '--show-toplevel']))
  } catch {
    return null
  }
}

const ORIGIN_RE = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git@)github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/

/** `owner/name` from an `https` or an `ssh` URL of a GitHub repository, or `null`. */
export function repoFromRemoteUrl(url) {
  const match = ORIGIN_RE.exec(String(url).trim())
  return match ? `${match[1]}/${match[2]}` : null
}

/** The `origin` remote's repository, or `{ repo: null, why }`. */
function originRepo(root) {
  let url
  try {
    url = git(root, ['remote', 'get-url', 'origin'])
  } catch {
    return { repo: null, why: 'the checkout has no `origin` remote' }
  }
  const repo = repoFromRemoteUrl(url)
  return repo ? { repo } : { repo: null, why: `the \`origin\` remote, ${url}, is not a GitHub repository steward can read` }
}

const isFile = (file) => {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/** Whether `file` may be executed: on POSIX its executable bit, which Windows has no counterpart of. */
const isExecutable = (file, platform) => {
  if (platform === 'win32') return true
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The absolute path of the first file named `name` on the PATH that can be executed, or `null`. On
 * Windows each of PATHEXT's extensions is tried, as written (the file system ignores case there); on
 * POSIX the name is tried as it is, and the file must have an executable bit.
 */
export function findOnPath(name, env = process.env, platform = process.platform) {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter((d) => d !== '')
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD').split(';').filter((e) => e !== '') : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`)
      if (isFile(candidate) && isExecutable(candidate, platform)) return path.resolve(candidate)
    }
  }
  return null
}

/** Where a project's pull request template may be, as GitHub reads it (case-insensitively). */
const TEMPLATE_DIRS = ['', 'docs', '.github']

/**
 * The project's pull request templates, as paths relative to `root`: `pull_request_template.md` in
 * the root, `docs/` or `.github/`, and each file of a `PULL_REQUEST_TEMPLATE/` directory in any of
 * them.
 */
export function findPullRequestTemplates(root) {
  const found = []
  for (const dir of TEMPLATE_DIRS) {
    let entries
    try {
      entries = readdirSync(path.join(root, dir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const lower = entry.name.toLowerCase()
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (lower === 'pull_request_template.md' && !entry.isDirectory()) found.push(rel)
      if (lower === 'pull_request_template' && entry.isDirectory()) {
        const inside = readdirSync(path.join(root, rel), { withFileTypes: true }).filter((e) => e.isFile())
        if (inside.length === 0) found.push(`${rel}/`)
        for (const file of inside) found.push(`${rel}/${file.name}`)
      }
    }
  }
  return found
}

/** Creates `rel` under `root` with `content` only when it is not there. Resolves `'wrote'` or `'left'`. */
async function writeNew(root, rel, content) {
  const target = path.join(root, ...rel.split('/'))
  await mkdir(path.dirname(target), { recursive: true })
  try {
    await writeFile(target, content, { flag: 'wx' })
    return 'wrote'
  } catch (error) {
    if (error.code === 'EEXIST') return 'left'
    throw error
  }
}

// ------------------------------------------------------------------ GitHub

/** An error for a response outside what a request expected: carries `status` and `body`. */
class HttpError extends Error {
  constructor(request, status, body) {
    super(`${request.method} ${request.url} failed with ${status}${body?.message ? `: ${body.message}` : ''}`)
    this.status = status
    this.body = body
  }
}

function repoPath(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error(`repo must be "owner/name", got: ${repo}`)
  return `${API}/repos/${repo}`
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const labelNames = () => LABELS.map((l) => l.name)

export const buildGetLabel = (repo, name) => ({ method: 'GET', url: `${repoPath(repo)}/labels/${encodeURIComponent(name)}` })
export const buildCreateLabel = (repo, label) => ({ method: 'POST', url: `${repoPath(repo)}/labels`, body: { ...label } })
export const buildGetProtection = (repo) => ({ method: 'GET', url: `${repoPath(repo)}/branches/${MAIN}/protection` })
export const buildSetProtection = (repo) => ({ method: 'PUT', url: `${repoPath(repo)}/branches/${MAIN}/protection`, body: PROTECTION_BODY })
export const buildAddRequiredCheck = (repo) => ({
  method: 'POST',
  url: `${repoPath(repo)}/branches/${MAIN}/protection/required_status_checks/contexts`,
  body: [GATE_CONTEXT],
})
export const buildEnableEnforceAdmins = (repo) => ({ method: 'POST', url: `${repoPath(repo)}/branches/${MAIN}/protection/enforce_admins` })

export const buildRebuildProtection = (repo, body) => ({ method: 'PUT', url: `${repoPath(repo)}/branches/${MAIN}/protection`, body })
export const buildEnableRequiredSignatures = (repo) => ({
  method: 'POST',
  url: `${repoPath(repo)}/branches/${MAIN}/protection/required_signatures`,
})

const GATE_CHECKS = { strict: false, contexts: [GATE_CONTEXT] }
// The PUT's optional booleans, each read from the GET's `{ enabled }`.
const PROTECTION_FLAGS = [
  'required_linear_history',
  'allow_force_pushes',
  'allow_deletions',
  'block_creations',
  'required_conversation_resolution',
  'lock_branch',
  'allow_fork_syncing',
]
const REVIEW_BOOLEANS = ['dismiss_stale_reviews', 'require_code_owner_reviews', 'require_last_push_approval']
const ACTORS = ['users', 'teams', 'apps']
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStrings = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s !== '')
const onlyKeys = (o, keys) => isObj(o) && Object.keys(o).every((k) => keys.includes(k))
const actorsOk = (o) => onlyKeys(o, ACTORS) && ACTORS.every((k) => o[k] === undefined || isStrings(o[k]))

/**
 * Whether `body` is a protection PUT `init` may send: `PROTECTION_BODY`, or a rebuild
 * (`rebuildProtectionBody`): `review/agent` required with strict off, `enforce_admins` true, the
 * reviews and restrictions null or of the PUT's shape, and no key beyond the PUT's.
 */
export function isProtectionPut(body) {
  if (!onlyKeys(body, ['required_status_checks', 'enforce_admins', 'required_pull_request_reviews', 'restrictions', ...PROTECTION_FLAGS])) return false
  if (!sameJson(body.required_status_checks, GATE_CHECKS) || body.enforce_admins !== true) return false
  if (!('required_pull_request_reviews' in body) || !('restrictions' in body)) return false
  const reviews = body.required_pull_request_reviews
  if (reviews !== null) {
    const keys = ['dismissal_restrictions', 'bypass_pull_request_allowances', 'required_approving_review_count', ...REVIEW_BOOLEANS]
    if (!onlyKeys(reviews, keys)) return false
    if (reviews.dismissal_restrictions !== undefined && !actorsOk(reviews.dismissal_restrictions)) return false
    if (reviews.bypass_pull_request_allowances !== undefined && !actorsOk(reviews.bypass_pull_request_allowances)) return false
    if (reviews.required_approving_review_count !== undefined && !Number.isInteger(reviews.required_approving_review_count)) return false
    if (REVIEW_BOOLEANS.some((k) => reviews[k] !== undefined && typeof reviews[k] !== 'boolean')) return false
  }
  const { restrictions } = body
  if (restrictions !== null && !(onlyKeys(restrictions, ACTORS) && ACTORS.every((k) => isStrings(restrictions[k])))) return false
  return PROTECTION_FLAGS.every((k) => body[k] === undefined || typeof body[k] === 'boolean')
}

/** GitHub's actors, `{ users: [{ login }], teams: [{ slug }], apps: [{ slug }] }`, as the PUT's login and slug arrays. */
function actorsForPut(actors) {
  const out = {}
  for (const [kind, field] of [['users', 'login'], ['teams', 'slug'], ['apps', 'slug']]) {
    if (Array.isArray(actors?.[kind])) out[kind] = actors[kind].map((a) => a[field])
  }
  return out
}

/**
 * The PUT that rebuilds protection read as `protection` (GitHub's GET shape) with `review/agent`
 * required and `enforce_admins` on, keeping every other setting the PUT carries: the pull request
 * reviews with each of their fields, the restrictions, and each of `PROTECTION_FLAGS` the GET
 * reports (an `{ enabled }` object in the GET, a boolean in the PUT). The status checks the project
 * had are not kept, since it had none. `required_signatures` is not a field of the PUT; see
 * `keepProtection`.
 */
export function rebuildProtectionBody(protection) {
  const reviews = protection?.required_pull_request_reviews
  const body = {
    required_status_checks: { ...GATE_CHECKS },
    enforce_admins: true,
    required_pull_request_reviews: null,
    restrictions: null,
  }
  if (isObj(reviews)) {
    const kept = {}
    if (isObj(reviews.dismissal_restrictions)) kept.dismissal_restrictions = actorsForPut(reviews.dismissal_restrictions)
    if (isObj(reviews.bypass_pull_request_allowances)) kept.bypass_pull_request_allowances = actorsForPut(reviews.bypass_pull_request_allowances)
    if (Number.isInteger(reviews.required_approving_review_count)) kept.required_approving_review_count = reviews.required_approving_review_count
    for (const k of REVIEW_BOOLEANS) if (typeof reviews[k] === 'boolean') kept[k] = reviews[k]
    body.required_pull_request_reviews = kept
  }
  if (isObj(protection?.restrictions)) {
    const actors = actorsForPut(protection.restrictions)
    body.restrictions = { users: actors.users ?? [], teams: actors.teams ?? [], apps: actors.apps ?? [] }
  }
  for (const k of PROTECTION_FLAGS) if (typeof protection?.[k]?.enabled === 'boolean') body[k] = protection[k].enabled
  return body
}

/** Throws unless `request` is one of the operations `init` performs; runs before any network call. */
export function assertAllowedRequest(repo, request) {
  const prefix = repoPath(repo)
  const url = typeof request?.url === 'string' ? request.url : ''
  const rest = url.startsWith(`${prefix}/`) ? url.slice(prefix.length) : null
  const refuse = () => {
    throw new Error(`refusing a request outside the operations init.mjs performs: ${request?.method} ${url}`)
  }
  if (rest === null) refuse()
  const { method, body } = request
  const protection = `/branches/${MAIN}/protection`
  if (method === 'GET' && rest === protection && body === undefined) return
  if (method === 'PUT' && rest === protection && isProtectionPut(body)) return
  if (method === 'POST' && rest === `${protection}/required_signatures` && body === undefined) return
  if (method === 'POST' && rest === `${protection}/required_status_checks/contexts` && sameJson(body, [GATE_CONTEXT])) return
  if (method === 'POST' && rest === `${protection}/enforce_admins` && body === undefined) return
  const labelGet = /^\/labels\/([^/?#]+)$/.exec(rest)
  if (method === 'GET' && labelGet && body === undefined && labelNames().includes(decodeURIComponent(labelGet[1]))) return
  if (method === 'POST' && rest === '/labels' && LABELS.some((l) => sameJson(body, l))) return
  refuse()
}

/** The context requests are sent through; `fetch` and `getToken` are injectable, the token read on first use. */
export function createInitContext({ repo, fetch = globalThis.fetch, getToken = ghAuthToken }) {
  repoPath(repo)
  let token
  return {
    repo,
    /** Resolves `{ status, body }` for any response; throws only on a request that is not allowed or a network failure. */
    async send(request) {
      assertAllowedRequest(repo, request)
      token ??= await getToken()
      const response = await fetch(request.url, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      })
      const text = await response.text()
      let body = null
      try {
        body = text === '' ? null : JSON.parse(text)
      } catch {
        body = null
      }
      return { status: response.status, body }
    },
  }
}

/** Creates each label of `LABELS` the repository does not have, printing each created or found. */
export async function ensureLabels(ctx, out) {
  for (const label of LABELS) {
    const found = await ctx.send(buildGetLabel(ctx.repo, label.name))
    if (found.status >= 200 && found.status < 300) {
      out(`label ${label.name}: found, left as it is`)
      continue
    }
    if (found.status !== 404) throw new HttpError(buildGetLabel(ctx.repo, label.name), found.status, found.body)
    const request = buildCreateLabel(ctx.repo, label)
    const created = await ctx.send(request)
    if (isLabelAlreadyExists(created)) {
      // Another run created it between the read and the write: GitHub says it exists, which is what
      // was wanted. Any other failure, a 422 with another error among them, stops init.
      out(`label ${label.name}: found, left as it is`)
      continue
    }
    if (created.status < 200 || created.status >= 300) throw new HttpError(request, created.status, created.body)
    out(`label ${label.name}: created`)
  }
}

// What GitHub's error messages say, for the two refusals AC-10 lets init go on from. Transcribed from
// GitHub's documentation and reports, not checked against a live response: a message that matches
// neither stops init, so a wrong match here stops it rather than letting it go on.
const PLAN_RE = /upgrade to github pro|make this repository public/i
const ADMIN_RE = /must have admin rights|resource not accessible by (?:integration|personal access token)/i

/**
 * `'plan'` (GitHub offers no protection on the plan) or `'admin'` (the account lacks admin access),
 * read from a 403 or 404's message and not from the status alone; `null` for any other failure,
 * such as a rate limit's 403, which stops init.
 */
function protectionRefusal({ status, body }) {
  if (status !== 403 && status !== 404) return null
  const message = body?.message ?? ''
  if (PLAN_RE.test(message)) return 'plan'
  if (ADMIN_RE.test(message)) return 'admin'
  return null
}

const ok = (response) => response.status >= 200 && response.status < 300

/**
 * Makes `main` require `review/agent` with `enforce_admins` on, keeping the project's own protection.
 * With none there, it sets `PROTECTION_BODY`. With some there, it adds `review/agent` to the required
 * status checks unless it is required, and turns `enforce_admins` on unless it is on, and changes
 * nothing else. Where GitHub offers none (the plan) or the account cannot set it (admin access), it
 * says so plainly and returns; any other failure throws.
 */
export async function protectMain(ctx, out) {
  const read = buildGetProtection(ctx.repo)
  const existing = await ctx.send(read)
  if (ok(existing)) return keepProtection(ctx, existing.body, out)
  const notProtected = existing.status === 404 && /branch not protected/i.test(existing.body?.message ?? '')
  if (!notProtected) {
    const kind = protectionRefusal(existing)
    if (kind === null) throw new HttpError(read, existing.status, existing.body)
    return refused(kind, out)
  }
  const request = buildSetProtection(ctx.repo)
  const set = await ctx.send(request)
  if (ok(set)) {
    out(`branch protection on ${MAIN}: set. It requires ${GATE_CONTEXT}, with enforce_admins on.`)
    out("  The project's own CI checks are the crew's to add to it.")
    return
  }
  const kind = protectionRefusal(set)
  if (kind === null) throw new HttpError(request, set.status, set.body)
  return refused(kind, out)
}

/**
 * The protection `main` already has: adds what the gate needs of it and keeps the rest. With status
 * checks on, `review/agent` is added through the contexts endpoint and `enforce_admins` through its
 * own. With none on, init does not rely on a request that switches them on alone, so the protection is
 * rebuilt by one PUT of every setting it has (`rebuildProtectionBody`) plus `review/agent` and
 * `enforce_admins`; `required_signatures`, which that PUT does not carry, is turned on again after
 * it when it was on.
 */
async function keepProtection(ctx, protection, out) {
  const checks = protection?.required_status_checks
  const required = [...(checks?.contexts ?? []), ...(checks?.checks ?? []).map((c) => c.context)]
  const adminsOn = protection?.enforce_admins?.enabled === true
  out(`branch protection on ${MAIN}: already there, so the project's own is kept`)
  // Each step is sent and judged alone: a refusal (plan, admin) ends init's work on protection, and
  // any other failure throws.
  const steps = []
  if (!isObj(checks)) {
    steps.push([
      buildRebuildProtection(ctx.repo, rebuildProtectionBody(protection)),
      `required no status checks, so rebuilt it with every setting it had, adding ${GATE_CONTEXT} as a required status check and enforce_admins on`,
    ])
    if (protection?.required_signatures?.enabled === true) {
      steps.push([buildEnableRequiredSignatures(ctx.repo), 'turned required signatures on again, which the rebuild does not carry'])
    }
  } else {
    if (required.includes(GATE_CONTEXT)) out(`  ${GATE_CONTEXT} is already required`)
    else steps.push([buildAddRequiredCheck(ctx.repo), `added ${GATE_CONTEXT} to its required status checks`])
    if (adminsOn) out('  enforce_admins is already on')
    else steps.push([buildEnableEnforceAdmins(ctx.repo), 'turned enforce_admins on'])
  }
  for (const [request, said] of steps) {
    const response = await ctx.send(request)
    if (!ok(response)) {
      const kind = protectionRefusal(response)
      if (kind === null) throw new HttpError(request, response.status, response.body)
      return refused(kind, out)
    }
    out(`  ${said}`)
  }
  out("  Everything else in it is as it was. The project's own CI checks are the crew's to add.")
}

function refused(kind, out) {
  out(
    kind === 'plan'
      ? `branch protection on ${MAIN}: not set. GitHub offers none for this repository on its plan (a private repository on GitHub Free has none).`
      : `branch protection on ${MAIN}: not set. This account cannot set it on this repository (it needs admin access).`,
  )
  out('  Nothing on GitHub then enforces the gate: a merge without a passing review is not stopped. Inspection, if added, raises one after the fact.')
}

// ------------------------------------------------------------------ the files' content

/** The text of a thin workflow file with the tag placeholder filled with `pin`: `v<version>`, or a commit. */
export function fillPin(text, pin) {
  const filled = text.replaceAll(VERSION_PLACEHOLDER, () => pin)
  if (/\{\{[A-Z_]+\}\}/.test(filled)) throw new Error('a workflow file keeps a placeholder after the tag is filled')
  return filled
}

/** The body of the project's `steward.config.json`, with a value for every key `readSettings` requires. */
export function settingsBody(repo, answers) {
  return {
    repo,
    setup: null,
    check: null,
    landWhen: 'all-checks',
    land: answers.land,
    unitLinks: answers.unitLinks,
    rulesFile: answers.rulesFile,
    inspectAfterHours: answers.inspectAfterHours,
  }
}

/** The body of the machine's settings from the answers; the Claude choices are fixed, the Codex one asked. */
export function machineSettingsBody(answers, codexExecutable) {
  const claudeReviewers = {
    opus: { tool: 'claude', model: 'opus', effort: 'high' },
    sonnet: { tool: 'claude', model: 'sonnet', effort: 'high' },
  }
  const codex = answers.reviewer === 'codex'
  const body = {
    usageLimits: {
      coder: { session: answers.coderSessionLimit, weekly: answers.coderWeeklyLimit },
      reviewer: { session: answers.reviewerSessionLimit, weekly: answers.reviewerWeeklyLimit },
    },
    roles: {
      coder: {
        default: 'sonnet',
        available: {
          sonnet: { tool: 'claude', model: 'sonnet', effort: 'medium', strength: 1 },
          opus: { tool: 'claude', model: 'opus', effort: 'high', strength: 2 },
        },
      },
      reviewer: codex
        ? {
            default: 'codex',
            available: { codex: { tool: 'codex', model: answers.codexModel, effort: answers.codexEffort }, ...claudeReviewers },
          }
        : { default: 'opus', available: claudeReviewers },
    },
  }
  if (codex) body.tools = { codex: { executable: codexExecutable } }
  return body
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

// ------------------------------------------------------------------ the command

/** A terminal on the process's stdin and stdout; `question` reads one line. */
function processTerminal() {
  let rl = null
  return {
    isTTY: Boolean(process.stdin.isTTY),
    write: (text) => process.stdout.write(text),
    question(prompt) {
      rl ??= createInterface({ input: process.stdin, output: process.stdout })
      return rl.question(prompt)
    },
    close: () => rl?.close(),
  }
}

/**
 * Runs the command and returns its exit code. Everything it reads from outside is injectable:
 * `cwd`, `env`, `homedir`, `fetch`, `getToken`, the `terminal` (`{ isTTY, question, write }`),
 * `findExecutable` (where `codex` is on the PATH), `exists` (whether a path names a file), the
 * steward package's root (`packageRoot`, where its `package.json` and `templates/` are) and the
 * output.
 */
export async function main(
  argv,
  {
    cwd = process.cwd(),
    env = process.env,
    homedir = osHomedir(),
    fetch = globalThis.fetch,
    getToken = ghAuthToken,
    terminal = processTerminal(),
    findExecutable = (name) => findOnPath(name, env),
    exists = isFile,
    packageRoot = PACKAGE_ROOT,
    out = console.log,
    err = console.error,
  } = {},
) {
  try {
    return await run(argv, { cwd, env, homedir, fetch, getToken, terminal, findExecutable, exists, packageRoot, out })
  } catch (error) {
    if (error instanceof Refusal) {
      err(error.message)
      return 2
    }
    err(`init stopped: ${error.message}`)
    return 1
  } finally {
    terminal.close?.()
  }
}

async function run(argv, { cwd, env, homedir, fetch, getToken, terminal, findExecutable, exists, packageRoot, out }) {
  const flags = parseFlags(argv)

  // Everything that can refuse comes before the first write.
  const root = gitRoot(cwd)
  if (root === null) throw new Refusal(`${cwd} is not in a git repository: run init in the project's checkout`)

  const ref = flags.values['--ref']
  if (ref !== undefined && !SHA_RE.test(ref)) {
    throw new Refusal(`--ref ${ref}: must be a commit's full SHA, 40 hexadecimal characters (a tag or a short SHA is refused)`)
  }
  const { version } = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new Error(`${path.join(packageRoot, 'package.json')}: 'version' must be a version such as 0.1.0, got ${JSON.stringify(version)}`)
  }
  const pin = ref?.toLowerCase() ?? `v${version}`

  const machinePath = machineSettingsPath({ env, homedir })
  const machineMissing = !existsSync(machinePath)
  let codexExecutable = null
  const codexPath = flags.values['--codex-path']
  if (codexPath !== undefined) {
    if (!(path.isAbsolute(codexPath) || path.win32.isAbsolute(codexPath)) || !exists(codexPath)) {
      throw new Refusal(`--codex-path ${codexPath}: must be the absolute path of a file that exists`)
    }
    codexExecutable = codexPath
  } else {
    codexExecutable = findExecutable('codex')
  }
  if (machineMissing && codexExecutable === null && flags.values['--reviewer'] === 'codex') {
    throw new Refusal('--reviewer codex: `codex` is not on the PATH; give its path with --codex-path')
  }

  const { answers, missing } = await gather({ flags, state: { machineMissing, codexExecutable }, terminal })
  if (missing.length > 0) {
    throw new Refusal(
      `init asks ${missing.length === 1 ? 'a question' : 'questions'} it has no terminal to ask and no answer for. ` +
        `Answer with the flag${missing.length === 1 ? '' : 's'}, or pass --yes for the defaults (none covers a question with no default):\n` +
        missing.map((q) => `  ${q.flag}: ${q.prompt}${q.default === null ? ' (no default)' : ` (default ${q.default})`}`).join('\n') +
        '\nNothing was written.',
    )
  }

  const { repo, why } = originRepo(root)
  const report = async (rel, content) => {
    const result = await writeNew(root, rel, content)
    out(result === 'wrote' ? `wrote ${rel}` : `left ${rel}: already there`)
  }

  // The project's settings.
  if (repo === null) out(`did not write steward.config.json: ${why}`)
  else await report('steward.config.json', json(settingsBody(repo, answers)))

  // The example checklist, byte for byte.
  await report(answers.rulesFile, await readFile(path.join(packageRoot, 'templates', 'review-checklist.md')))

  // The thin workflow files, pinned.
  const workflows = answers.inspection ? [...GATE_WORKFLOWS, INSPECTION_WORKFLOW] : GATE_WORKFLOWS
  for (const file of workflows) {
    const text = await readFile(path.join(packageRoot, 'templates', 'workflows', file), 'utf8')
    await report(`.github/workflows/${file}`, fillPin(text, pin))
  }
  if (answers.inspection) {
    out(
      "  Inspection's first run may raise, as issues, earlier merges and commits on main within its window that had no passing verdict. " +
        'The crew closes each once.',
    )
  }

  // The pull request template, only when the project has none.
  const templates = findPullRequestTemplates(root)
  if (templates.length === 0) {
    await report('.github/pull_request_template.md', await readFile(path.join(packageRoot, 'templates', 'pull_request_template.md')))
  } else {
    for (const rel of templates) {
      out(`left ${rel}: the project's pull request template`)
      if (rel.endsWith('/')) continue
      const text = await readFile(path.join(root, ...rel.split('/')), 'utf8')
      if (!/^[ \t]*Unit:/m.test(text)) {
        out(`  ${rel} has no Unit: line; steward finds a pull request's unit by that line, so add one`)
      }
    }
  }

  // GitHub: the labels, and branch protection on a yes.
  if (repo === null) {
    out('labels: not created, since there is no GitHub repository to create them in')
    if (answers.protectMain) out(`branch protection on ${MAIN}: not set, since there is no GitHub repository to set it on`)
  } else {
    const ctx = createInitContext({ repo, fetch, getToken })
    await ensureLabels(ctx, out)
    if (answers.protectMain) await protectMain(ctx, out)
    else out(`branch protection on ${MAIN}: not asked to set it, left as it is`)
  }

  // The machine's settings, only when the file is missing.
  if (machineMissing) {
    await mkdir(path.dirname(machinePath), { recursive: true })
    try {
      await writeFile(machinePath, json(machineSettingsBody(answers, codexExecutable)), { flag: 'wx' })
      out(`wrote ${machinePath}: the machine's settings`)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      out(`left ${machinePath}: already there`)
    }
  } else {
    out(`left ${machinePath}: the machine's settings are already there, not read`)
  }

  out('Nothing was committed, staged or pushed. Commit what was written through a pull request of the project\'s own.')
  return 0
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
