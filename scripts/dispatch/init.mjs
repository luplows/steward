#!/usr/bin/env node
/**
 * `steward init` (ST-44, ST-56): sets a project up for steward's review gate. Run in the project's
 * checkout, it asks what it needs at the terminal, makes a commit of what the gate needs on a
 * branch of its own, pushes that branch and opens a draft pull request for it, creates the labels
 * steward reads and applies, and says what it left alone. It starts no model session. The design is
 * `docs/agent-workflow-design.md`, Part 3, "Decided so far", "Steward installs in another project
 * as a review gate, through `init`" and "Installation through a reviewable pull request";
 * `docs/settings.md` says what it writes for each key.
 *
 * It overwrites nothing. It captures the commit `origin/main` has after a fetch, makes a worktree
 * of its own beside the checkout (`<checkout>.worktrees/`) on a new branch from that commit, and
 * creates each file there only when `origin/main` does not have it (`flag: 'wx'`); one that is
 * there is named as left. Only the files it created are staged and committed, and the commit is
 * checked to hold nothing else before it is pushed. The caller's checkout is never staged, stashed,
 * reset, cleaned, switched or committed to: its branch, uncommitted work and ignored files may be
 * anything, except a change that touches a file the installation adds (`init-install.mjs`,
 * `findLocalConflicts`), which `init` names and refuses. It neither reads nor writes `storyPrefix`,
 * `stories/` or the project's `package.json` or CI workflows.
 *
 * Every question has a flag, `--yes` takes the default of every question no flag answers, and with
 * no terminal a question with neither is refused, before anything is written (`QUESTIONS`). The
 * `land` question defaults to no: a new installation reviews and does not land unattended, and only
 * a yes at the question or `--land yes` writes `land: true`. `--yes` is not that yes.
 *
 * It does nothing about branch protection: `steward protect` (`protect.mjs`) sets it, as a step of
 * its own once the gate is on `main`, and `init`'s closing message recommends it. It never marks
 * the pull request ready, merges it, requests a landing, or starts anything on a machine.
 *
 * Exit code: 0 when it finished, whatever it left alone, or when nothing was missing and so no pull
 * request was needed; 1 when a write, a git command or a request to GitHub failed, nothing more
 * being written and what was already made left in place and named; 2 when it refused, before it
 * wrote anything: a checkout that is not a git repository or has no commit, an `origin` that is not
 * a GitHub repository or has no `main`, a flag or answer that is wrong, a question with no answer
 * and no terminal, a branch or pull request already there, or a change of the caller's own that
 * touches what the installation adds.
 *
 * Usage:
 *   steward init [--yes] [--ref <40-hex commit>] [--branch <name>] [--pr-title <text>]
 *                [--pr-body-file <path>] [--pr-template <path>] [--<question flag> <answer>]...
 * Examples:
 *   steward init --yes             review only, `land: false`; `steward land <pr-number>` lands one
 *   steward init --yes --land yes  `land: true`: unattended landing explicitly enabled
 */
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir as osHomedir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { ghAuthToken } from './github.mjs'
import { INSPECTION_LABEL, isLabelAlreadyExists } from './inspect.mjs'
import {
  addWorktree,
  assertBranchName,
  assertParentsAreDirectories,
  branchCollisions,
  captureBase,
  checkAdditions,
  commitStaged,
  createBaseReader,
  defaultGit,
  discoverTemplates,
  eachOriginUrl,
  findLocalConflicts,
  openCheckout,
  parentDirectories,
  pushNewBranch,
  readBaseSettings,
  Refusal,
  relevance,
  removeWorktree,
  stageFiles,
  worktreePath,
} from './init-install.mjs'
import { composePullRequestBody } from './init-pr-body.mjs'
import { machineSettingsPath, TOOL_EFFORTS } from './machine-settings.mjs'
import { isRulesFilePath } from './rules-file-path.mjs'
import { readSettings } from './settings.mjs'
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
    // A project that already has a settings file on `main` keeps it, and its checklist is the one
    // it names.
    when: (s) => s.baseRulesFile === null,
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
  {
    id: 'prTemplate',
    flag: '--pr-template',
    prompt:
      "The project has more than one pull request template. Which is the installation pull request's body written from? " +
      'Answer with its path in the repository. It has no default: the crew chooses.',
    default: null,
    choices: (s) => s.templates,
    parse: (text, s) => {
      const value = text.trim()
      if (!s.templates.includes(value)) throw new Refusal(`answer one of: ${s.templates.join(', ')}`)
      return value
    },
    when: (s) => s.templates.length > 1 && !s.bodySupplied,
  },
]

// `--yes`, `--ref`, `--codex-path` (where `codex` is when it is not on the PATH) and the flags that
// shape the installation pull request are not questions (`--pr-template` is one only when the
// project has several).
const OTHER_FLAGS = ['--yes', '--ref', '--codex-path', '--branch', '--pr-title', '--pr-body-file']
const USAGE = [
  `usage: steward init [--yes] [--ref <commit>] [--codex-path <path>] [--branch <name>] [--pr-title <text>] [--pr-body-file <path>] ${QUESTIONS.map((q) => `[${q.flag} <answer>]`).join(' ')}`,
  'init commits its files on a new branch (steward/install, or --branch), pushes it and opens a draft pull request against main; it changes nothing in your checkout.',
  '--pr-title replaces the title (Install Steward review gate); --pr-body-file uses a file as the whole body; --pr-template names the template to write the body from when the project has several.',
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
          answers[q.id] = q.parse(given, here)
        } catch (error) {
          if (!(error instanceof Refusal)) throw error
          throw new Refusal(`${q.flag} ${given}: ${error.message}`)
        }
      } else if (flags.yes && q.default !== null) {
        answers[q.id] = q.parse(q.default, here)
      } else if (terminal.isTTY) {
        for (;;) {
          const reply = (await terminal.question(`${promptOf(q, here)}${q.default === null ? '' : ` [${q.default}]`} `)).trim()
          try {
            answers[q.id] = q.parse(reply === '' && q.default !== null ? q.default : reply, here)
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

const ORIGIN_RE = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git@)github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/

/** `owner/name` from an `https` or an `ssh` URL of a GitHub repository, or `null`. */
export function repoFromRemoteUrl(url) {
  const match = ORIGIN_RE.exec(String(url).trim())
  return match ? `${match[1]}/${match[2]}` : null
}

/**
 * The `origin` remote's repository, or `{ repo: null, why }`. The URL as configured is read first
 * and the URL after git's `insteadOf` rewriting second, so that an alias that expands to GitHub
 * counts.
 */
function originRepo(run, root) {
  const { found, url } = eachOriginUrl(run, root, repoFromRemoteUrl)
  if (found) return { repo: found }
  if (url === null) return { repo: null, why: 'the checkout has no `origin` remote' }
  return { repo: null, why: `the \`origin\` remote, ${url}, is not a GitHub repository steward can read` }
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
    const detail = [body?.message, ...(Array.isArray(body?.errors) ? body.errors.map((e) => e?.message) : [])]
      .filter((m) => typeof m === 'string' && m !== '')
      .join('; ')
    super(
      `${request.method} ${request.url} failed with ${status}${detail === '' ? '' : `: ${detail}`}` +
        (status === 401 ? ' (GitHub did not accept the sign-in: run `gh auth login` and try again)' : ''),
    )
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
/** The branch every installation pull request is opened against. */
const BASE_BRANCH = 'main'

export const buildGetLabel = (repo, name) => ({ method: 'GET', url: `${repoPath(repo)}/labels/${encodeURIComponent(name)}` })
export const buildCreateLabel = (repo, label) => ({ method: 'POST', url: `${repoPath(repo)}/labels`, body: { ...label } })
/**
 * The open pull requests of the repository whose head is `branch` of the same repository and whose
 * base is `main`.
 */
export const buildListOpenPulls = (repo, branch) => ({
  method: 'GET',
  url: `${repoPath(repo)}/pulls?state=open&head=${encodeURIComponent(`${repo.split('/')[0]}:${branch}`)}&base=${BASE_BRANCH}&per_page=100`,
})
/**
 * The one pull request `init` creates: a draft from `branch` of the same repository into `main`.
 */
export const buildCreatePull = (repo, { title, body, branch }) => ({
  method: 'POST',
  url: `${repoPath(repo)}/pulls`,
  body: { title, body, head: branch, base: BASE_BRANCH, draft: true },
})

/**
 * Whether `body` is exactly the body of a draft pull request from a branch of the repository into
 * `main`.
 */
function isDraftPullBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false
  const keys = Object.keys(body).sort()
  return (
    sameJson(keys, ['base', 'body', 'draft', 'head', 'title']) &&
    body.base === BASE_BRANCH &&
    body.draft === true &&
    typeof body.title === 'string' &&
    typeof body.body === 'string' &&
    typeof body.head === 'string' &&
    body.head !== '' &&
    !body.head.includes(':')
  )
}

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
  const pulls = new RegExp(`^/pulls\\?state=open&head=([^&]+)&base=${BASE_BRANCH}&per_page=100$`).exec(rest)
  if (method === 'GET' && pulls && body === undefined) {
    let head = ''
    try {
      head = decodeURIComponent(pulls[1])
    } catch {
      refuse()
    }
    // Only a branch of the installation's own repository: `owner:branch` with the repository's
    // owner.
    const owner = repo.split('/')[0]
    if (head.startsWith(`${owner}:`) && head.length > owner.length + 1) return
  }
  if (method === 'POST' && rest === '/pulls' && isDraftPullBody(body)) return
  refuse()
}

/** The context requests are sent through; `fetch` and `getToken` are injectable, the token read on first use. */
export function createInitContext({ repo, fetch = globalThis.fetch, getToken = ghAuthToken }) {
  repoPath(repo)
  let token
  return {
    repo,
    /** Reads the token now, so that a sign-in that fails does so before anything is written. */
    async ready() {
      token ??= await getToken()
    },
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

/** The open pull request from `branch` into `main` in the repository, or `null`. */
export async function findOpenPull(ctx, branch) {
  const request = buildListOpenPulls(ctx.repo, branch)
  const response = await ctx.send(request)
  if (response.status < 200 || response.status >= 300) throw new HttpError(request, response.status, response.body)
  if (!Array.isArray(response.body)) throw new Error('GitHub did not answer the request for open pull requests with a list')
  const same = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
  return (
    response.body.find(
      (p) => p?.state === 'open' && p.head?.ref === branch && same(p.head?.repo?.full_name, ctx.repo) && p.base?.ref === BASE_BRANCH,
    ) ?? null
  )
}

/**
 * Creates the draft pull request and resolves `{ url, number }` once GitHub's answer confirms it: a
 * created, open, draft pull request from `branch` into `main`. Any other answer throws, carrying
 * the pull request's `url` when GitHub gave one, so that the report can name it.
 */
export async function createDraftPull(ctx, { title, body, branch }) {
  const request = buildCreatePull(ctx.repo, { title, body, branch })
  const response = await ctx.send(request)
  if (response.status < 200 || response.status >= 300) throw new HttpError(request, response.status, response.body)
  const pr = response.body
  const url = typeof pr?.html_url === 'string' ? pr.html_url : null
  const confirmed = response.status === 201 && url !== null && pr.draft === true && pr.state === 'open' && pr.head?.ref === branch && pr.base?.ref === BASE_BRANCH
  if (!confirmed) {
    const error = new Error(
      `GitHub answered ${response.status} but did not confirm an open draft pull request from ${branch} into ${BASE_BRANCH}` +
        `${pr?.draft === false ? ' (it reports a pull request that is not a draft)' : ''}`,
    )
    error.pullUrl = url
    throw error
  }
  return { url, number: pr.number }
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

/**
 * What the person is told about landing, from what happened to `steward.config.json`: `'wrote'`
 * (the installation adds it) or `'left'` (`origin/main` already has one).
 */
export function landingNotes(settingsResult, answers, flags) {
  if (settingsResult === 'left') {
    return [
      'An existing steward.config.json governs its own landing authorization: init did not read it or change its land setting, ' +
        'so whether steward lands unattended is whatever that file already says.',
    ]
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

/** The branch the installation is made on unless `--branch` names another. */
const DEFAULT_BRANCH = 'steward/install'
const DEFAULT_TITLE = 'Install Steward review gate'
const COMMIT_MESSAGE = 'Install Steward review gate'

/** What each phase of the installation is called in a report of where it stopped. */
const PHASES = {
  worktree: 'creating the installation worktree',
  write: 'writing the installation files',
  stage: 'staging the installation files',
  check: 'checking the installation diff',
  commit: 'committing the installation',
  verify: 'checking the installation commit',
  push: 'pushing the branch to origin',
  pull: 'opening the draft pull request',
  labels: 'creating the labels',
  machine: "writing the machine's settings",
}

/**
 * Thrown when a step after the first effect fails; its message is the whole report, and `main`
 * exits 1 with it.
 */
class InstallFailure extends Error {}

const quoted = (p) => (/\s/.test(p) ? `"${p}"` : p)

/**
 * The report of a failure: what stopped, what was already made and is left in place, and what the
 * person does next. Nothing is retried, deleted or rolled back; a push or a pull request that may
 * have happened without the answer arriving is to be looked at on GitHub before anything is
 * repeated.
 */
function failureReport({ error, phase, created, worktree, branch, repo, pullUrl }) {
  const lines = [`init stopped: ${error.message}`, `It stopped while ${PHASES[phase]}.`]
  lines.push(
    created.length === 0
      ? 'Nothing had been created yet.'
      : ['Already created, and left as it is (nothing is deleted or rolled back):', ...created.map((c) => `  ${c}`)].join('\n'),
  )
  const wt = worktree === null ? null : quoted(worktree)
  const beforePush = ['worktree', 'write', 'stage', 'check', 'commit', 'verify'].includes(phase)
  if (beforePush && wt === null) {
    lines.push(
      'Nothing was pushed and no pull request was opened, and your checkout is as it was.',
      `Fix the cause above and run init again. Look first at git worktree list and git branch --list ${branch}, in case git made part of what it was asked for.`,
    )
  } else if (beforePush) {
    lines.push(
      'Nothing was pushed and no pull request was opened.',
      `The worktree ${worktree} is kept for you to inspect: git -C ${wt} status`,
      `To finish by hand once the cause is fixed: stage and commit the files there, run git -C ${wt} push origin ${branch}, and open a draft pull request against main from ${branch}.`,
    )
  } else if (phase === 'push') {
    lines.push(
      'Whether origin received the branch is not certain. Check before anything else: git ls-remote --heads origin ' + branch,
      `If it lists the branch, do not push again: look at what is there first. If it does not, push by hand: git -C ${wt} push origin ${branch}, then open a draft pull request against main from ${branch}.`,
    )
  } else if (phase === 'pull') {
    lines.push(
      `The branch ${branch} is on origin.` + (pullUrl ? ` GitHub gave the address ${pullUrl}: look at it.` : ''),
      `Whether the pull request exists is not certain unless GitHub confirmed it. Look at https://github.com/${repo}/pulls for one from ${branch} before opening another; if there is none, open a draft pull request against main from ${branch}.`,
    )
  } else {
    lines.push(
      ...(pullUrl ? [`The installation pull request is open: ${pullUrl}`] : []),
      "The labels and the machine's settings are separate from the pull request: they are not part of it, and neither is rolled back.",
      'Run init again once the installation has merged: it creates only what is missing, and opens no pull request when nothing is.',
    )
  }
  return lines.join('\n')
}

/**
 * Runs the command and returns its exit code. Everything it reads from outside is injectable:
 * `cwd`, `env`, `homedir`, `fetch`, `getToken`, the `terminal` (`{ isTTY, question, write }`),
 * `findExecutable` (where `codex` is on the PATH), `exists` (whether a path names a file), the
 * steward package's root (`packageRoot`, where its `package.json` and `templates/` are), the runner
 * of every git command (`git`, which takes the folder and the argument array and gives
 * `{ status, stdout, stderr }`) and the output.
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
    git = defaultGit,
    out = console.log,
    err = console.error,
  } = {},
) {
  try {
    return await run(argv, { cwd, env, homedir, fetch, getToken, terminal, findExecutable, exists, packageRoot, git, out })
  } catch (error) {
    if (error instanceof Refusal) {
      err(error.message)
      return 2
    }
    if (error instanceof InstallFailure) {
      err(error.message)
      return 1
    }
    err(`init stopped: ${error.message}`)
    return 1
  } finally {
    terminal.close?.()
  }
}

/** The question's prompt, with the choices it offers when it has them. */
const promptOf = (q, state) => (q.choices ? `${q.prompt} (${q.choices(state).join(', ')})` : q.prompt)

async function run(argv, { cwd, env, homedir, fetch, getToken, terminal, findExecutable, exists, packageRoot, git: runGit, out }) {
  const flags = parseFlags(argv)

  // Everything that can refuse comes before the first write.
  const root = openCheckout(runGit, cwd)
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

  const { repo, why } = originRepo(runGit, root)
  if (repo === null) {
    throw new Refusal(`${why}: init opens its pull request on the project's GitHub repository, so give this checkout an \`origin\` that names one`)
  }

  const branch = flags.values['--branch'] ?? DEFAULT_BRANCH
  assertBranchName(runGit, root, branch)
  const title = flags.values['--pr-title'] ?? DEFAULT_TITLE
  if (title.trim() === '') throw new Refusal('--pr-title needs a title')
  let suppliedBody = null
  const bodyFile = flags.values['--pr-body-file']
  if (bodyFile !== undefined) {
    if (flags.values['--pr-template'] !== undefined) {
      throw new Refusal('--pr-body-file uses its file as the whole body, so there is no template to choose: give --pr-body-file or --pr-template, not both')
    }
    try {
      suppliedBody = await readFile(path.resolve(cwd, bodyFile), 'utf8')
    } catch (error) {
      throw new Refusal(`--pr-body-file ${bodyFile}: cannot be read (${error.code ?? error.message})`)
    }
  }

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

  // Signing in, and the commit `origin/main` has now: the base of the installation.
  const ctx = createInitContext({ repo, fetch, getToken })
  try {
    await ctx.ready()
  } catch (error) {
    throw new Error(`could not sign in to GitHub (${error.message}); run \`gh auth login\` and try again`)
  }
  let base
  try {
    base = captureBase(runGit, root)
  } catch (error) {
    if (error instanceof Refusal) throw error
    throw new Error(`could not read origin (${error.message})`)
  }
  const reader = createBaseReader(runGit, root, base)
  const baseSettings = readBaseSettings(reader, isRulesFilePath)
  const baseRulesFile = baseSettings.present ? baseSettings.rulesFile : null
  if (baseRulesFile !== null && flags.values['--rules-file'] !== undefined) {
    let given
    try {
      given = parseRulesFile(flags.values['--rules-file'])
    } catch (error) {
      if (!(error instanceof Refusal)) throw error
      throw new Refusal(`--rules-file ${flags.values['--rules-file']}: ${error.message}`)
    }
    if (given !== baseRulesFile) {
      throw new Refusal(
        `--rules-file ${given} conflicts with steward.config.json on origin/main, whose rulesFile is ${baseRulesFile}: ` +
          'init keeps that file as it is, so drop the flag, or change the file through a pull request of the project first',
      )
    }
  }

  const discovered = discoverTemplates((dir) => reader.list(dir))
  const usableTemplates = discovered.filter((t) => !t.endsWith('/'))
  const emptyTemplates = discovered.filter((t) => t.endsWith('/'))

  const state = { machineMissing, codexExecutable, baseRulesFile, templates: usableTemplates, bodySupplied: suppliedBody !== null }
  const { answers, missing } = await gather({ flags, state, terminal })
  if (missing.length > 0) {
    throw new Refusal(
      `init asks ${missing.length === 1 ? 'a question' : 'questions'} it has no terminal to ask and no answer for. ` +
        `Answer with the flag${missing.length === 1 ? '' : 's'}, or pass --yes for the defaults (none covers a question with no default):\n` +
        missing.map((q) => `  ${q.flag}: ${promptOf(q, { ...state, answers })}${q.default === null ? ' (no default)' : ` (default ${q.default})`}`).join('\n') +
        '\nNothing was written.',
    )
  }

  // The pull request's body skeleton: the project's template (chosen when it has several), or
  // steward's.
  let chosenTemplate = null
  if (suppliedBody === null) {
    const wanted = flags.values['--pr-template']
    if (wanted !== undefined && !usableTemplates.includes(wanted)) {
      throw new Refusal(
        `--pr-template ${wanted}: not one of the project's pull request templates` +
          (usableTemplates.length === 0 ? ' (it has none)' : `: ${usableTemplates.join(', ')}`),
      )
    }
    chosenTemplate = wanted ?? answers.prTemplate ?? (usableTemplates.length === 1 ? usableTemplates[0] : null)
  }
  const templateTexts = reader.texts(usableTemplates)
  let skeleton = ''
  if (suppliedBody === null) {
    if (chosenTemplate === null) {
      skeleton = await readFile(path.join(packageRoot, 'templates', 'pull_request_template.md'), 'utf8')
    } else {
      skeleton = templateTexts.get(chosenTemplate)
      if (skeleton === null) {
        throw new Refusal(
          `${chosenTemplate} on origin/main is a symbolic link, so the body cannot be written from it: ` +
            'choose another template with --pr-template, or give the whole body with --pr-body-file',
        )
      }
    }
  }

  // What the installation adds, from the base and the answers: each target is created only if the
  // base lacks it.
  const rulesTarget = baseRulesFile ?? answers.rulesFile
  const workflows = answers.inspection ? [...GATE_WORKFLOWS, INSPECTION_WORKFLOW] : GATE_WORKFLOWS
  const targets = []
  const target = (group, rel, content, note) => targets.push({ group, rel, content, note, present: false })
  target('settings', 'steward.config.json', baseSettings.present ? null : json(settingsBody(repo, answers)), "the project's steward settings")
  target(
    'checklist',
    rulesTarget,
    await readFile(path.join(packageRoot, 'templates', 'review-checklist.md')),
    baseSettings.present
      ? "the example checklist at the path the project's settings name, for the crew to replace with its own rules"
      : 'the example checklist that pull requests are reviewed against, for the crew to replace with its own rules',
  )
  const WORKFLOW_NOTES = {
    'review-gate.yml': 'the review gate, which turns a review verdict into the `review/agent` status',
    'land-approved.yml': 'the landing workflow, the only thing that merges',
    'inspection.yml': 'inspection, which raises a merge without a passing verdict as an issue',
  }
  for (const file of workflows) {
    const text = await readFile(path.join(packageRoot, 'templates', 'workflows', file), 'utf8')
    target('workflow', `.github/workflows/${file}`, fillPin(text, pin), WORKFLOW_NOTES[file])
  }
  if (usableTemplates.length === 0) {
    target(
      'template',
      '.github/pull_request_template.md',
      await readFile(path.join(packageRoot, 'templates', 'pull_request_template.md')),
      'a pull request template, since the project had none',
    )
  }
  // Which of them `origin/main` has, and whether the directories above the others are directories
  // there.
  const onBase = reader.entries([...targets.map((t) => t.rel), ...parentDirectories(targets.map((t) => t.rel))])
  for (const t of targets) t.present = onBase.has(t.rel)
  const toWrite = targets.filter((t) => !t.present)
  assertParentsAreDirectories(onBase, toWrite.map((t) => t.rel))

  // The caller's own changes, layer by layer, against what the installation adds.
  const conflicts = findLocalConflicts(runGit, root, base, relevance({ rulesFile: rulesTarget, workflows }))
  if (conflicts.length > 0) {
    throw new Refusal(
      "init cannot install while this checkout has changes of its own to what the installation adds:\n" +
        conflicts.map((c) => `  ${c.path}: ${c.what}`).join('\n') +
        "\nResolve each one yourself (commit it, move it elsewhere or remove it), or run init from another checkout of the project. " +
        'init did not touch your work, and nothing was written.',
    )
  }

  // A branch or pull request of that name already there is never reused: it is named, and init
  // stops.
  const worktree = toWrite.length === 0 ? null : worktreePath(root, branch)
  if (worktree !== null) {
    let found
    try {
      found = branchCollisions(runGit, root, branch, worktree)
    } catch (error) {
      throw new Error(`could not ask origin about the branch ${branch} (${error.message})`)
    }
    const open = await findOpenPull(ctx, branch)
    if (open !== null) found.push(`a pull request from ${branch} into main is already open: ${open.html_url}`)
    if (found.length > 0) {
      throw new Refusal(
        `init will not use the branch name ${branch}, since it is taken:\n` +
          found.map((f) => `  ${f}`).join('\n') +
          '\ninit never reuses, moves, adds to or deletes an existing branch or pull request, and nothing was written. ' +
          'Finish or close the existing one yourself, or run init with --branch and another name.',
      )
    }
  }

  // ------------------------------------------------------------ effects begin here
  const created = []
  let phase = 'worktree'
  let pullUrl = null
  const settingsResult = baseSettings.present ? 'left' : 'wrote'
  const expected = new Map()
  const labelOut = (line) => {
    out(line)
    const made = /^label (.+): created$/.exec(line)
    if (made) created.push(`label ${made[1]}`)
  }
  try {
    if (worktree !== null) {
      out(`Installing into ${repo} from origin/main at ${base}, on the new branch ${branch}.`)
      addWorktree(runGit, root, branch, worktree, base)
      created.push(`worktree ${worktree}`, `local branch ${branch} (made from ${base})`)
    }

    phase = 'write'
    const place = async (t) => {
      if (t.present) {
        out(`left ${t.rel}: already there`)
        return
      }
      const result = await writeNew(worktree, t.rel, t.content)
      out(result === 'wrote' ? `wrote ${t.rel}` : `left ${t.rel}: already there`)
      if (result === 'wrote') expected.set(t.rel, t.content)
    }
    for (const t of targets.filter((x) => x.group === 'settings' || x.group === 'checklist')) await place(t)
    for (const t of targets.filter((x) => x.group === 'workflow')) await place(t)
    if (answers.inspection) {
      out(
        "  Inspection's first run may raise, as issues, earlier merges and commits on main within its window that had no passing verdict. " +
          'The crew closes each once.',
      )
    }
    for (const dir of emptyTemplates) out(`left ${dir}: an empty directory, which counts as no usable pull request template`)
    if (usableTemplates.length === 0) {
      for (const t of targets.filter((x) => x.group === 'template')) await place(t)
    } else {
      for (const rel of usableTemplates) {
        out(`left ${rel}: the project's pull request template`)
        if (templateTexts.get(rel) !== null && !/^[ \t]*Unit:/m.test(templateTexts.get(rel))) {
          out(`  ${rel} has no Unit: line; steward finds a pull request's unit by that line, so add one`)
        }
      }
    }

    let commit = null
    if (worktree !== null) {
      if (expected.size === 0) throw new Error('no file was written, though the base lacks some')
      phase = 'stage'
      stageFiles(runGit, worktree, [...expected.keys()])
      phase = 'check'
      const staged = checkAdditions(runGit, worktree, ['--cached', base], expected)
      if (staged.length > 0) throw new Error(`what is staged is not only the installation's additions (${staged.join('; ')})`)
      if (expected.has('steward.config.json')) {
        const read = await readSettings(worktree)
        if (read.repo !== repo) throw new Error(`the settings read back name ${read.repo}, not ${repo}`)
      }
      phase = 'commit'
      const made = commitStaged(runGit, worktree, COMMIT_MESSAGE)
      commit = made.commit
      created.push(`commit ${commit}`)
      phase = 'verify'
      if (made.parent !== base) throw new Error(`the commit's parent is ${made.parent}, not ${base}`)
      const committed = checkAdditions(runGit, worktree, [base, commit], expected)
      if (committed.length > 0) throw new Error(`the commit is not only the installation's additions (${committed.join('; ')})`)

      phase = 'push'
      pushNewBranch(runGit, worktree, branch)
      created.push(`branch ${branch} on origin`)
      out(`Pushed ${branch} to origin.`)

      phase = 'pull'
      const count = expected.size
      const facts = {
        repo,
        branch,
        baseSha: base,
        pin: ref ? `at commit ${pin}` : `${pin}`,
        workflowsAdded: [...expected.keys()].some((rel) => rel.startsWith('.github/workflows/')),
        added: targets.filter((t) => expected.has(t.rel)).map((t) => ({ rel: t.rel, note: t.note })),
        preserved: [...targets.filter((t) => t.present).map((t) => t.rel), ...usableTemplates],
        emptyTemplates,
        land: expected.has('steward.config.json') ? answers.land : null,
        checks: [
          `Base: fetched \`origin/main\` and started the branch from its commit \`${base}\`. Passed.`,
          `Diff: the staged changes, and then the commit, were compared with that commit path by path. They add exactly the ${count} file${count === 1 ? '' : 's'} listed above, each with the content steward generated, and change nothing else. The commit's only parent is that commit. Passed.`,
          ...(expected.has('steward.config.json') ? ['Settings: `steward.config.json` was read back and accepted by steward. Passed.'] : []),
        ],
      }
      const body = suppliedBody ?? composePullRequestBody({ skeleton, facts })
      try {
        const pull = await createDraftPull(ctx, { title, body, branch })
        pullUrl = pull.url
        created.push(`draft pull request ${pullUrl}`)
      } catch (error) {
        pullUrl = error.pullUrl ?? null
        if (pullUrl !== null) created.push(`pull request ${pullUrl} (GitHub did not confirm it as a draft)`)
        throw error
      }
      out(`Opened the draft pull request ${pullUrl}`)
      try {
        removeWorktree(runGit, root, worktree)
        created.splice(created.indexOf(`worktree ${worktree}`), 1)
        out(`Removed the worktree ${worktree}; the branch ${branch} is kept.`)
      } catch (error) {
        out(`Kept the worktree ${worktree} (git would not remove it: ${error.message}). Remove it yourself when you are done with it.`)
      }
    } else {
      out('No installation pull request is needed: everything steward installs is already on origin/main, so no branch, commit or pull request was made.')
    }

    // GitHub: the labels, separate from the pull request.
    phase = 'labels'
    await ensureLabels(ctx, labelOut)

    // The machine's settings, only when the file is missing.
    phase = 'machine'
    if (machineMissing) {
      await mkdir(path.dirname(machinePath), { recursive: true })
      try {
        await writeFile(machinePath, json(machineSettingsBody(answers, codexExecutable)), { flag: 'wx' })
        created.push(`machine settings ${machinePath}`)
        out(`wrote ${machinePath}: the machine's settings`)
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        out(`left ${machinePath}: already there`)
      }
    } else {
      out(`left ${machinePath}: the machine's settings are already there, not read`)
    }

    if (commit !== null) {
      out('The installation pull request is open for the crew:')
      out(`  repository: ${repo}`)
      out(`  branch: ${branch}`)
      out('  base: main')
      out(`  commit: ${commit}`)
      out(`  pull request: ${pullUrl}`)
    }
    for (const line of landingNotes(settingsResult, answers, flags)) out(line)
    if (commit !== null) {
      out(
        'The pull request is a draft. The crew reviews and merges it through the project\'s existing process: a fresh install cannot be reviewed ' +
          'by the gate it introduces, and where the project already has a gate, its rules still apply, since init bypasses none.',
      )
      out('Merging it starts nothing on any machine: running steward on a machine is a separate step.')
      out('Steward is then set up. To have GitHub stop a merge that has not passed review, run `steward protect` once it has merged.')
    } else {
      out('To have GitHub stop a merge that has not passed review, run `steward protect`.')
    }
    return 0
  } catch (error) {
    throw new InstallFailure(failureReport({ error, phase, created, worktree: created.some((c) => c.startsWith('worktree ')) ? worktree : null, branch, repo, pullUrl }))
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
