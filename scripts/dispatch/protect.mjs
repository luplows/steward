#!/usr/bin/env node
/**
 * `steward protect`: sets branch protection on a project's `main`, as a step of its own that the
 * crew takes once the review gate is on `main`. The design is `docs/agent-workflow-design.md`, Part
 * 3, "Decided so far", the entry on protection apart from `init`. It asks no question: running it
 * is the crew's yes. It starts no model session and changes nothing in any checkout.
 *
 * It reads `main` on GitHub, not the working directory, before it sets anything, and refuses,
 * sending no request but reads, unless `main` holds `steward.config.json`, the checklist that
 * file's `rulesFile` names, `.github/workflows/review-gate.yml` and
 * `.github/workflows/land-approved.yml`. It reads no file's content beyond the `rulesFile` value.
 *
 * Once those are there it makes `main` require `review/agent` with `enforce_admins` on
 * (`PROTECTION_BODY`), keeping any protection the project already has: it adds `review/agent` to
 * the required status checks unless it is there, and turns `enforce_admins` on unless it is on, and
 * changes nothing else. Where `main` has protection with no status checks it rebuilds it with one
 * PUT of every setting it had plus those two. Where GitHub offers none (the plan) or the account
 * cannot set it (admin access) it says so plainly, and that nothing on GitHub then enforces the
 * gate. It reads and writes GitHub with the crew member's own credential, through a context that
 * checks each request against an allowlist (`assertAllowedRequest`) before any network call.
 *
 * Exit code: 0 when protection was set, or was already as it should be; 1 whenever it set none: a
 * refusal by this command, by GitHub, a wrong flag, a repository it cannot name, or any request
 * that failed.
 *
 * Usage:
 *   steward protect [--repo owner/name]
 * The repository is the settings' `repo`, read from the working directory's `steward.config.json`,
 * unless `--repo` gives it, which wins.
 */
import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ghAuthToken } from './github.mjs'
import { isRulesFilePath } from './rules-file-path.mjs'
import { readSettings } from './settings.mjs'

const API = 'https://api.github.com'
const MAIN = 'main'
const GATE_CONTEXT = 'review/agent'
const SETTINGS_FILE = 'steward.config.json'
const GATE_FILES = ['.github/workflows/review-gate.yml', '.github/workflows/land-approved.yml']
const USAGE = 'usage: steward protect [--repo owner/name]'

/** The branch protection `protect` sets on `main`: `review/agent` required, admins included. */
export const PROTECTION_BODY = {
  required_status_checks: { strict: false, contexts: [GATE_CONTEXT] },
  enforce_admins: true,
  required_pull_request_reviews: null,
  restrictions: null,
}

// ------------------------------------------------------------------ GitHub

/** Thrown for a wrong flag or a repository that cannot be named; `main` prints it and exits 1. */
class Refusal extends Error {}

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

const encodePath = (file) => file.split('/').map(encodeURIComponent).join('/')

export const buildGetMain = (repo) => ({ method: 'GET', url: `${repoPath(repo)}/branches/${MAIN}` })
export const buildGetFile = (repo, file) => ({ method: 'GET', url: `${repoPath(repo)}/contents/${encodePath(file)}?ref=${MAIN}` })
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
 * Whether `body` is a protection PUT `protect` may send: `PROTECTION_BODY`, or a rebuild
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

/** The file a `GET .../contents/<path>?ref=main` rest names, decoded, or `null` when it is not one. */
function contentsFile(rest) {
  const match = /^\/contents\/([^?#]+)\?ref=main$/.exec(rest)
  if (!match) return null
  let file
  try {
    file = match[1].split('/').map(decodeURIComponent).join('/')
  } catch {
    return null
  }
  return encodePath(file) === match[1] ? file : null
}

/** Throws unless `request` is one of the operations `protect` performs; runs before any network call. */
export function assertAllowedRequest(repo, request) {
  const prefix = repoPath(repo)
  const url = typeof request?.url === 'string' ? request.url : ''
  const rest = url.startsWith(`${prefix}/`) ? url.slice(prefix.length) : null
  const refuse = () => {
    throw new Error(`refusing a request outside the operations protect performs: ${request?.method} ${url}`)
  }
  if (rest === null) refuse()
  const { method, body } = request
  const protection = `/branches/${MAIN}/protection`
  if (method === 'GET' && rest === `/branches/${MAIN}` && body === undefined) return
  if (method === 'GET' && body === undefined) {
    const file = contentsFile(rest)
    if (file !== null && (file === SETTINGS_FILE || GATE_FILES.includes(file) || isRulesFilePath(file))) return
  }
  if (method === 'GET' && rest === protection && body === undefined) return
  if (method === 'PUT' && rest === protection && isProtectionPut(body)) return
  if (method === 'POST' && rest === `${protection}/required_signatures` && body === undefined) return
  if (method === 'POST' && rest === `${protection}/required_status_checks/contexts` && sameJson(body, [GATE_CONTEXT])) return
  if (method === 'POST' && rest === `${protection}/enforce_admins` && body === undefined) return
  refuse()
}

/** The context requests are sent through; `fetch` and `getToken` are injectable, the token read on first use. */
export function createProtectContext({ repo, fetch = globalThis.fetch, getToken = ghAuthToken }) {
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

// What GitHub's error messages say, for the two refusals protect reports and does not treat as a
// failure. Transcribed from GitHub's documentation and reports, not checked against a live response:
// a message that matches neither stops protect with a failure, so a wrong match here stops it rather
// than reporting a refusal that was something else.
const PLAN_RE = /upgrade to github pro|make this repository public/i
const ADMIN_RE = /must have admin rights|resource not accessible by (?:integration|personal access token)/i

/**
 * `'plan'` (GitHub offers no protection on the plan) or `'admin'` (the account lacks admin access),
 * read from a 403 or 404's message and not from the status alone; `null` for any other failure,
 * such as a rate limit's 403, which stops protect.
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
 * nothing else. Resolves `true` when protection is as it should be, and `false` where GitHub offers
 * none (the plan) or the account cannot set it (admin access), which it says plainly; any other
 * failure throws.
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
    return true
  }
  const kind = protectionRefusal(set)
  if (kind === null) throw new HttpError(request, set.status, set.body)
  return refused(kind, out)
}

/**
 * The protection `main` already has: adds what the gate needs of it and keeps the rest. With status
 * checks on, `review/agent` is added through the contexts endpoint and `enforce_admins` through its
 * own. With none on, protect does not rely on a request that switches them on alone, so the protection is
 * rebuilt by one PUT of every setting it has (`rebuildProtectionBody`) plus `review/agent` and
 * `enforce_admins`; `required_signatures`, which that PUT does not carry, is turned on again after
 * it when it was on.
 */
async function keepProtection(ctx, protection, out) {
  const checks = protection?.required_status_checks
  const required = [...(checks?.contexts ?? []), ...(checks?.checks ?? []).map((c) => c.context)]
  const adminsOn = protection?.enforce_admins?.enabled === true
  out(`branch protection on ${MAIN}: already there, so the project's own is kept`)
  // Each step is sent and judged alone: a refusal (plan, admin) ends protect's work on protection, and
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
  return true
}

function refused(kind, out) {
  out(
    kind === 'plan'
      ? `branch protection on ${MAIN}: not set. GitHub offers none for this repository on its plan (a private repository on GitHub Free has none).`
      : `branch protection on ${MAIN}: not set. This account cannot set it on this repository (it needs admin access).`,
  )
  out('  Nothing on GitHub then enforces the gate: a merge without a passing review is not stopped. Inspection, if added, raises one after the fact.')
  return false
}

// ------------------------------------------------------------------ what main must hold

const isMissing = (response) => response.status === 404

/**
 * Reads `main` on GitHub for what protection needs there. Resolves `{ hasMain: false }` with no
 * `main`; otherwise `{ hasMain: true, missing }`, `missing` listing, in words for the person
 * running `protect`, each of the four that is not there. A read that fails any other way throws.
 */
export async function readMain(ctx) {
  const branch = buildGetMain(ctx.repo)
  const found = await ctx.send(branch)
  if (isMissing(found)) return { hasMain: false, missing: [] }
  if (!ok(found)) throw new HttpError(branch, found.status, found.body)

  const present = async (file) => {
    const request = buildGetFile(ctx.repo, file)
    const response = await ctx.send(request)
    if (isMissing(response)) return { found: false }
    if (!ok(response)) throw new HttpError(request, response.status, response.body)
    // A folder where a file should be answers with a list.
    return { found: !Array.isArray(response.body), body: response.body }
  }

  const missing = []
  const settings = await present(SETTINGS_FILE)
  if (!settings.found) {
    missing.push(SETTINGS_FILE)
    missing.push("the project's checklist: it cannot be named, since steward.config.json is missing")
  } else {
    const rulesFile = rulesFileOf(settings.body)
    if (rulesFile === null) {
      missing.push("the project's checklist: it cannot be named, since the rulesFile in steward.config.json is not a path")
    } else if (!(await present(rulesFile)).found) {
      missing.push(rulesFile)
    }
  }
  for (const file of GATE_FILES) if (!(await present(file)).found) missing.push(file)
  return { hasMain: true, missing }
}

/** The `rulesFile` of a `steward.config.json` as GitHub's contents API returns it, or `null` unless it is a path. */
function rulesFileOf(body) {
  try {
    if (body?.encoding !== 'base64' || typeof body.content !== 'string') return null
    const value = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'))?.rulesFile
    return isRulesFilePath(value) ? value : null
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ the command

/** The repository from `argv` (`--repo owner/name`), or `null` when it is not given. Refuses any other flag. */
export function parseFlags(argv) {
  let repo = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const flag = eq === -1 ? arg : arg.slice(0, eq)
    if (flag !== '--repo') throw new Refusal(`${arg}: not a flag of protect\n${USAGE}`)
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1)
    if (value === undefined || (eq === -1 && value.startsWith('--'))) throw new Refusal(`--repo needs a value\n${USAGE}`)
    if (repo !== null) throw new Refusal('--repo is given twice')
    if (!/^[\w.-]+\/[\w.-]+$/.test(value)) throw new Refusal(`--repo ${value}: must be owner/name\n${USAGE}`)
    repo = value
  }
  return repo
}

/**
 * Runs the command and returns its exit code. Everything it reads from outside is injectable:
 * `cwd`, `fetch`, `getToken` and the output.
 */
export async function main(
  argv,
  { cwd = process.cwd(), fetch = globalThis.fetch, getToken = ghAuthToken, out = console.log, err = console.error } = {},
) {
  try {
    return await run(argv, { cwd, fetch, getToken, out })
  } catch (error) {
    err(error instanceof Refusal ? error.message : `protect stopped: ${error.message}`)
    return 1
  }
}

async function run(argv, { cwd, fetch, getToken, out }) {
  let repo = parseFlags(argv)
  if (repo === null) {
    try {
      repo = (await readSettings(cwd)).repo
    } catch (error) {
      throw new Refusal(
        `protect does not know which repository to protect: ${error.message}\n` +
          'Run it where the project\'s steward.config.json is, or give the repository with --repo owner/name.',
      )
    }
  }
  const ctx = createProtectContext({ repo, fetch, getToken })

  const onMain = await readMain(ctx)
  if (!onMain.hasMain) {
    out(`Branch protection was not set, and nothing on GitHub was changed: found no ${MAIN} branch on ${repo}.`)
    out(`Set the project up with steward init, merge its pull request into ${MAIN}, then run steward protect again.`)
    return 1
  }
  if (onMain.missing.length > 0) {
    out(`Branch protection was not set, and nothing on GitHub was changed: ${MAIN} on ${repo} does not hold what the gate needs.`)
    out('Missing:')
    for (const item of onMain.missing) out(`  ${item}`)
    out(`Add them to ${MAIN} through a pull request, merged as the project normally merges, then run steward protect again.`)
    return 1
  }

  return (await protectMain(ctx, out)) ? 0 : 1
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
