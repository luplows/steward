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
 * no terminal a question with neither is refused, before anything is written (`QUESTIONS`). The
 * `land` question defaults to no: a new installation reviews and does not land unattended, and only
 * a yes at the question or `--land yes` writes `land: true`. `--yes` is not that yes.
 *
 * It does nothing about branch protection: `steward protect` (`protect.mjs`) sets it, as a step of
 * its own once the gate is on `main`, and `init`'s closing message recommends it.
 *
 * Exit code: 0 when it finished, whatever it left alone; 1 when a write or a request to GitHub
 * failed, nothing more being written; 2 when it refused: a checkout that is not a git repository, a
 * flag or answer that is wrong, or a question with no answer and no terminal.
 *
 * Usage:
 *   steward init [--yes] [--ref <40-hex commit>] [--<question flag> <answer>]...
 * Examples:
 *   steward init --yes             review only, `land: false`; `steward land <pr-number>` lands one
 *   steward init --yes --land yes  `land: true`: unattended landing explicitly enabled
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
import { userConfigPath, TOOL_EFFORTS } from './user-config.mjs'
import { isRulesFilePath } from './rules-file-path.mjs'
import { BREAKER_OVERRIDE_LABEL, REVIEW_BLOCKED_LABEL } from '../land/runway.mjs'

const API = 'https://api.github.com'
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
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
    prompt:
      'Should steward land pull requests unattended, merging each one that passes review without anyone asking for it? ' +
      '(no: steward reviews, the project merges, and you can still ask steward to land one pull request with `steward land <pr-number>`)',
    default: 'no',
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
    id: 'coderSessionLimit',
    flag: '--coder-session-limit',
    prompt: "At what share of the plan's 5-hour usage (1 to 100) does steward start no coder session?",
    default: '70',
    parse: parseInteger(1, 100),
    when: (s) => s.userConfigMissing,
  },
  {
    id: 'coderWeeklyLimit',
    flag: '--coder-weekly-limit',
    prompt: "At what share of the plan's weekly usage (1 to 100) does steward start no coder session?",
    default: '75',
    parse: parseInteger(1, 100),
    when: (s) => s.userConfigMissing,
  },
  {
    id: 'reviewerSessionLimit',
    flag: '--reviewer-session-limit',
    prompt: "At what share of the plan's 5-hour usage (1 to 100) does steward start no reviewer session?",
    default: '90',
    parse: parseInteger(1, 100),
    when: (s) => s.userConfigMissing,
  },
  {
    id: 'reviewerWeeklyLimit',
    flag: '--reviewer-weekly-limit',
    prompt: "At what share of the plan's weekly usage (1 to 100) does steward start no reviewer session?",
    default: '90',
    parse: parseInteger(1, 100),
    when: (s) => s.userConfigMissing,
  },
  {
    id: 'reviewer',
    flag: '--reviewer',
    prompt: 'Review on Claude (opus), or on the Codex CLI (claude or codex)?',
    default: 'claude',
    parse: parseChoice('claude', 'codex'),
    when: (s) => s.userConfigMissing && s.codexExecutable !== null,
  },
  {
    id: 'codexModel',
    flag: '--codex-model',
    prompt: "Which model does the Codex reviewer run (as Codex names it)? It has no default.",
    default: null,
    parse: parseNonEmpty,
    when: (s) => s.userConfigMissing && s.answers.reviewer === 'codex',
  },
  {
    id: 'codexEffort',
    flag: '--codex-effort',
    prompt: `Which effort does the Codex reviewer run at (${TOOL_EFFORTS.codex.join(', ')})? It has no default.`,
    default: null,
    parse: parseCodexEffort,
    when: (s) => s.userConfigMissing && s.answers.reviewer === 'codex',
  },
]

// `--yes`, `--ref`, and `--codex-path` (where `codex` is when it is not on the PATH) are not questions.
const OTHER_FLAGS = ['--yes', '--ref', '--codex-path']
const USAGE = [
  `usage: steward init [--yes] [--ref <commit>] [--codex-path <path>] ${QUESTIONS.map((q) => `[${q.flag} <answer>]`).join(' ')}`,
  'Unattended landing is off unless you turn it on: --yes takes the default of --land, which is no, and only --land yes (or a yes at the question) turns it on.',
  'With land false, `steward land <pr-number>` asks steward to land one pull request that has passed review.',
  'examples: steward init --yes                 review only; the project merges',
  '          steward init --yes --land yes      also let steward land pull requests that pass, unattended',
].join('\n')

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
/** Throws unless `request` is one of the operations `init` performs; runs before any network call. */
export function assertAllowedRequest(repo, request) {
  const prefix = repoPath(repo)
  const url = typeof request?.url === 'string' ? request.url : ''
  const rest = url.startsWith(`${prefix}/`) ? url.slice(prefix.length) : null
  const refuse = () => {
    throw new Error(`refusing a request outside the operations init performs: ${request?.method} ${url}`)
  }
  if (rest === null) refuse()
  const { method, body } = request
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

/** The body of the user config from the answers; the Claude choices are fixed, the Codex one asked. */
export function userConfigBody(answers, codexExecutable) {
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

/**
 * What the person is told about landing, from what happened to `steward.config.json`: `'wrote'`,
 * `'left'` (a file was already there) or `null` (none, with no GitHub repository to name in it).
 */
export function landingNotes(settingsResult, answers, flags) {
  if (settingsResult === 'left') {
    return [
      'An existing steward.config.json governs its own landing authorization: init did not read it or change its land setting, ' +
        'so whether steward lands unattended is whatever that file already says.',
    ]
  }
  if (settingsResult === null) {
    return ['With no steward.config.json there is no landing setting: steward lands nothing unattended until the file has land set to true.']
  }
  if (answers.land === true) {
    return [
      'steward.config.json has land set to true: unattended landing was explicitly enabled, so steward may merge a pull request ' +
        'that has passed review without anyone asking for that one. Landing one on request, with `steward land <pr-number>`, works as well.',
    ]
  }
  const notes = [
    'steward.config.json has land set to false: steward can review pull requests but will not land any unattended. ' +
      'To land one that has passed review, ask for it: `steward land <pr-number>`, which goes through the same review gate.',
    'To allow unattended landing later, set land to true in steward.config.json through a pull request of the project.',
  ]
  if (flags.yes && flags.values['--land'] === undefined) {
    notes.push('--yes took the default for the landing question, no: it does not consent to unattended landing.')
  }
  return notes
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

  const configPath = userConfigPath({ env, homedir })
  const userConfigMissing = !existsSync(configPath)
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
  if (userConfigMissing && codexExecutable === null && flags.values['--reviewer'] === 'codex') {
    throw new Refusal('--reviewer codex: `codex` is not on the PATH; give its path with --codex-path')
  }

  const { answers, missing } = await gather({ flags, state: { userConfigMissing, codexExecutable }, terminal })
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
    return result
  }

  // The project's settings: 'wrote', 'left' (a file already there governs itself), or null.
  let settingsResult = null
  if (repo !== null) settingsResult = await report('steward.config.json', json(settingsBody(repo, answers)))
  else if (existsSync(path.join(root, 'steward.config.json'))) {
    out('left steward.config.json: already there')
    settingsResult = 'left'
  } else out(`did not write steward.config.json: ${why}`)

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

  // GitHub: the labels.
  if (repo === null) {
    out('labels: not created, since there is no GitHub repository to create them in')
  } else {
    await ensureLabels(createInitContext({ repo, fetch, getToken }), out)
  }

  // The user config, only when the file is missing.
  if (userConfigMissing) {
    await mkdir(path.dirname(configPath), { recursive: true })
    try {
      await writeFile(configPath, json(userConfigBody(answers, codexExecutable)), { flag: 'wx' })
      out(`wrote ${configPath}: the user config`)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      out(`left ${configPath}: already there`)
    }
  } else {
    out(`left ${configPath}: the user config is already there, not read`)
  }

  for (const line of landingNotes(settingsResult, answers, flags)) out(line)
  out("Nothing was committed, staged or pushed. Commit what was written, and open a pull request of the project's own for it.")
  out(
    'Merge that pull request as the project normally merges: the gate cannot review the pull request that installs it. ' +
      'Merging it starts nothing on any machine: running steward on a machine is a separate step.',
  )
  out('Steward is then set up. To have GitHub stop a merge that has not passed review, run `steward protect` once it has merged.')
  return 0
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
