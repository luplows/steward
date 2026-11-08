#!/usr/bin/env node
/**
 * `steward upgrade` (ST-69): moves a project that already has steward installed to another pin of
 * `luplows/steward`, a release (`--to vX.Y.Z`) or any commit (`--ref <full SHA>`), through one
 * draft pull request for the crew to review. It starts no model session. The design is
 * `docs/agent-workflow-design.md`, Part 1, "Upgrade and checklist preflight"; `README.md`,
 * "Upgrading steward in a project", says how to use it.
 *
 * Everything it decides, it decides from GitHub's answers before it clones anything: the target pin
 * must be a tag or a commit of `luplows/steward`; the pin each managed workflow on the project's
 * `main` carries must be one and the same, and a tag or a commit of `luplows/steward`; each
 * installed workflow must be the template of that pin apart from the pin (`workflow-text.mjs`); the
 * target pin must have a template for each. The templates are read from GitHub at each pin
 * (`github-read.mjs`), so nothing is shipped and any commit can be tried. It proposes the
 * templates at the target pin, filled as `init` fills them (`fillPin`), the project's other files
 * as they are, and the changes of `MIGRATIONS` to `steward.config.json`, of which there are none
 * yet. It validates the proposed result with the running package's own `readSettings` and
 * `validateRules`, so it must be run from steward installed at the target pin.
 *
 * It then clones the project's `main` into a new temporary directory, writes only the files it
 * changes, commits them on a new branch, pushes it and opens one draft pull request against
 * `main`, as `init` does. It never merges, marks ready, protects a branch, activates a project,
 * touches the user config or any coordinator, or turns unattended landing on. The clone is kept,
 * and the closing message gives its path. It rolls nothing back.
 *
 * Exit code: 0 when it finished, a no-op included; 1 when a step failed after the clone, with a
 * report of what is left, or GitHub could not be read; 2 when it refused: before any clone, except
 * the choice of the project's pull request template (--pr-template, or several templates), which
 * needs the clone's files, so that refusal leaves the clone, kept and named.
 *
 * Usage:
 *   steward upgrade (--to vX.Y.Z | --ref <40-hex commit>) [--branch <name>] [--pr-template <path>]
 */
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir as osTmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ghAuthToken } from './github.mjs'
import {
  createReadContext,
  readComparison,
  readCommit,
  readFileAt,
  readTagCommit,
} from './github-read.mjs'
import {
  buildCreateDraftPull,
  buildGetRepo,
  buildListOpenPulls,
  createInitContext,
  fillPin,
  findPullRequestTemplates,
  GATE_WORKFLOWS,
  git,
  gitRoot,
  githubSaid,
  INSPECTION_WORKFLOW,
  ok,
  Refusal,
  repoFromRemoteUrl,
  SHA_RE,
  step,
  StepFailure,
} from './init.mjs'
import { isRulesFilePath } from './rules-file-path.mjs'
import { validateRules } from './rules.mjs'
import { readSettings } from './settings.mjs'
import { sameWorkflowApartFromPin } from './workflow-text.mjs'

export const STEWARD_REPO = 'luplows/steward'
const TAG_RE = /^v\d+\.\d+\.\d+$/
const PIN_REFERENCE_RE = /github:luplows\/steward#(\S+)/g
const CONFIG_FILE = 'steward.config.json'
const WORKFLOW_DIR = '.github/workflows'
const TEMPLATE_DIR = 'templates/workflows'
const MANAGED = [...GATE_WORKFLOWS, INSPECTION_WORKFLOW]
const REQUIRED = GATE_WORKFLOWS
const USAGE = [
  'usage: steward upgrade (--to vX.Y.Z | --ref <commit>) [--branch <name>] [--pr-template <path>]',
  `upgrade proposes moving the steward this project installs to a tag (--to) or to a commit (--ref, its full SHA) of ${STEWARD_REPO}, as a draft pull request for the crew to review. It changes nothing else: it merges nothing, starts and stops no coordinator, and never turns unattended landing on.`,
  'Run it from steward installed at the target pin: it validates the result with the steward it is running.',
  'examples: steward upgrade --to v0.2.0',
  '          steward upgrade --ref 0123456789abcdef0123456789abcdef01234567',
].join('\n')
const FLAGS = ['--to', '--ref', '--branch', '--pr-template']

/**
 * The explicit, unambiguous changes a target release makes to a project's `steward.config.json`,
 * in order. Each is `{ id, explanation, applies(config), migrate(config), decision?(config) }`:
 * `migrate` returns the new config (it may not change `land`), `explanation` says why the project's
 * file changes, and `decision`, when it returns text, says a decision of the project's own is
 * needed and that the upgrade made none. There is none yet: no release has needed one.
 */
export const MIGRATIONS = []

// ------------------------------------------------------------------ pure parts

/** The flags of `argv` as `{ to, ref, branch, prTemplate }`; refuses what is wrong. */
export function parseFlags(argv) {
  const values = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const flag = eq === -1 ? arg : arg.slice(0, eq)
    if (!FLAGS.includes(flag)) throw new Refusal(`${arg}: not a flag of upgrade\n${USAGE}`)
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1)
    if (value === undefined || (eq === -1 && value.startsWith('--'))) throw new Refusal(`${flag} needs a value\n${USAGE}`)
    if (Object.hasOwn(values, flag)) throw new Refusal(`${flag} is given twice`)
    values[flag] = value
  }
  const { '--to': to, '--ref': ref } = values
  if (to === undefined && ref === undefined) {
    throw new Refusal(`Give exactly one of --to vX.Y.Z and --ref <full SHA>: neither was given.\n${USAGE}`)
  }
  if (to !== undefined && ref !== undefined) {
    throw new Refusal(`Give exactly one of --to and --ref: both were given (--to ${to}, --ref ${ref}).`)
  }
  if (to !== undefined && !TAG_RE.test(to)) {
    throw new Refusal(`--to ${to}: must be a tag of the form vX.Y.Z (for a commit, use --ref with its full SHA)`)
  }
  if (ref !== undefined && !SHA_RE.test(ref)) {
    throw new Refusal(`--ref ${ref}: must be a commit's full SHA, 40 hexadecimal characters (a tag or a short SHA is refused)`)
  }
  return { to, ref, branch: values['--branch'], prTemplate: values['--pr-template'] }
}

/** `'tag'` for `vX.Y.Z`, `'commit'` for a full SHA, `null` for anything else. */
export function pinKind(pin) {
  if (TAG_RE.test(pin)) return 'tag'
  if (SHA_RE.test(pin)) return 'commit'
  return null
}

/** The pins in the text of a workflow, as written, in order. */
export function pinsIn(text) {
  return [...text.matchAll(PIN_REFERENCE_RE)].map((m) => (SHA_RE.test(m[1]) ? m[1].toLowerCase() : m[1]))
}

/** What a pin is, in a sentence: the release, or the commit, with the version its `package.json` gives. */
export function describePin({ kind, pin, version }) {
  const shown = version === null ? 'package.json version unknown' : `package.json version ${version}`
  if (kind === 'tag') return `release ${pin} (${shown})`
  if (version === '0.0.0') return `development commit ${pin} (${shown})`
  if (version === null) return `commit ${pin} (${shown})`
  return `commit ${pin}, a candidate of version ${version}`
}

/** The draft pull request's title. A commit is never called a release. */
export function pullTitle({ kind, pin, version }) {
  if (kind === 'tag') return `Upgrade steward to release ${pin}`
  const short = pin.slice(0, 12)
  return version === '0.0.0' ? `Upgrade steward to a development commit (${short})` : `Upgrade steward to a candidate of ${version} (commit ${short})`
}

/**
 * Applies `migrations` to the parsed `config`: `{ config, edits, decisions }`, `edits` being the
 * `{ id, explanation }` of each that changed it. A migration that changes `land` throws: an upgrade
 * never changes whether steward lands unattended.
 */
export function planConfig(config, migrations) {
  let current = config
  const edits = []
  const decisions = []
  for (const migration of migrations) {
    const decision = migration.decision?.(current)
    if (decision) decisions.push(decision)
    if (!migration.applies(current)) continue
    const next = migration.migrate(structuredClone(current))
    if (next.land !== config.land) {
      throw new Error(`the migration ${migration.id} changes land: an upgrade never changes whether steward lands unattended`)
    }
    edits.push({ id: migration.id, explanation: migration.explanation })
    current = next
  }
  return { config: current, edits, decisions }
}

/** `text` with the line endings `like` uses. */
const withEndingsOf = (like, text) => {
  const lf = text.replace(/\r\n?/g, '\n')
  return like.includes('\r\n') ? lf.replace(/\n/g, '\r\n') : lf
}

/** The draft pull request's body: what the upgrade proposes, how it was validated, what is left. */
export function pullBody({ installed, target, sameCommit, changed, edits, decisions, validation, land, rulesFile, template }) {
  const pinText = (p) => `\`${p.pin}\``
  const lines = [
    '## Steward upgrade',
    '',
    `This draft pull request proposes moving the steward this project installs from ${pinText(installed)} to ${pinText(target)}. ` +
      '`steward upgrade` made it. The project is not upgraded until it merges.',
    '',
    `- Installed: ${describePin(installed)}`,
    `- Target: ${describePin(target)}`,
    sameCommit
      ? '- Only the pin changes: both pins name the same commit of steward, so every managed workflow differs from before only in its pin.'
      : '- Each managed workflow is steward\'s template at the target pin, with the target pin filled in.',
    '',
    'Managed files changed:',
    ...changed.map((rel) => `- \`${rel}\``),
    '',
    'Project-owned changes:',
    ...(edits.length === 0
      ? [`- none: \`${CONFIG_FILE}\` and \`${rulesFile}\` are left as they are.`]
      : edits.map((e) => `- \`${CONFIG_FILE}\`: ${e.explanation} (${e.id})`)),
    '',
    'Validation:',
    ...validation.map((line) => `- ${line}`),
    '',
    'Unresolved actions:',
    ...(decisions.length === 0 ? ['- none'] : decisions.map((d) => `- ${d}`)),
    '',
    'After this pull request merges, by hand:',
    `- Check the pin in effect: every reference to \`github:luplows/steward#\` in \`${WORKFLOW_DIR}/\` on \`main\` names \`${target.pin}\`.`,
    '- `steward upgrade` changed nothing on any machine. A coordinator running for this project keeps running the steward it was started from: stop it, and start it again from steward installed at the target pin, when the crew wants that machine on it.',
    `- Landing is as \`${CONFIG_FILE}\` already had it (\`land\` is ${land}); the upgrade did not change it. Turning unattended landing on is the crew's own settings pull request.`,
    "- Merge this pull request as the project normally merges, once the crew has reviewed it and filled in the project's template below.",
    '',
    '---',
    '',
    template,
  ]
  return lines.join('\n')
}

// ------------------------------------------------------------------ the command

const keptLine = (clone) => `upgrade's copy of the project is kept at ${clone}: remove that folder when you are done with it.`

/** What `main` prints for a failure after the clone: which step, what was said, what is left, what next. */
export function failureReport(error, progress) {
  const lines =
    error instanceof StepFailure
      ? [`upgrade stopped: ${error.step} failed. ${error.who} said: ${error.message}`]
      : [`upgrade stopped: ${error.message}`]
  if (progress.clone === null) return lines
  lines.push('What exists now:')
  lines.push(`  upgrade's copy of the project, at ${progress.clone}`)
  if (progress.branch !== null) {
    if (progress.pushed) lines.push(`  the branch ${progress.branch} on GitHub`)
    else if (progress.pushAttempted) {
      lines.push(`  the branch ${progress.branch} in that copy, and perhaps on GitHub: the push failed, and whether it changed GitHub is not known`)
    } else lines.push(`  the branch ${progress.branch} in that copy only: nothing was pushed`)
    if (progress.pullAttempted) {
      lines.push('  perhaps a pull request: opening it failed, and whether GitHub created it is not known')
    } else lines.push('  no pull request: none was opened')
  }
  lines.push('Nothing was rolled back or removed.')
  if (progress.pushAttempted) {
    lines.push(
      `What to check: the branch on GitHub (git ls-remote --heads origin ${progress.branch}) and the open pull requests from ${progress.branch}.`,
    )
    lines.push(
      `What to do next: if the branch is there and no pull request is, open the pull request from ${progress.branch} on GitHub by hand, or delete that branch on GitHub ` +
        `(git push origin --delete ${progress.branch}) and run upgrade again.`,
    )
  } else {
    lines.push(`What to do next: fix what ${error instanceof StepFailure ? error.who : 'upgrade'} reported, and run upgrade again.`)
  }
  lines.push(`Remove ${progress.clone} when you are done with it.`)
  return lines
}

/**
 * Runs the command and returns its exit code. Everything it reads from outside is injectable:
 * `cwd`, `fetch` and `getToken` (every GitHub answer), `tmpRoot` (where the clone and the folder
 * validation uses are made), `cloneUrl` (the URL Git uses for `origin`'s URL: only tests pass one),
 * `migrations` and the output.
 */
export async function main(
  argv,
  {
    cwd = process.cwd(),
    fetch = globalThis.fetch,
    getToken = ghAuthToken,
    tmpRoot = osTmpdir(),
    cloneUrl = (url) => url,
    migrations = MIGRATIONS,
    out = console.log,
    err = console.error,
  } = {},
) {
  const progress = { clone: null, branch: null, pushAttempted: false, pushed: false, pullAttempted: false }
  try {
    return await run(argv, { cwd, fetch, getToken, tmpRoot, cloneUrl, migrations, out }, progress)
  } catch (error) {
    if (error instanceof Refusal) {
      err(error.message)
      if (progress.clone !== null) err(keptLine(progress.clone))
      return 2
    }
    for (const line of failureReport(error, progress)) err(line)
    return 1
  }
}

/** Refuses unless GitHub reads the project with the credential upgrade uses. */
async function checkCredential(ctx) {
  let response
  try {
    response = await ctx.send(buildGetRepo(ctx.repo))
  } catch (error) {
    throw new Refusal(`upgrade could not reach GitHub with your credential: ${error.message}. Sign in with \`gh auth login\` and run upgrade again. Nothing was written.`)
  }
  if (!ok(response)) {
    throw new Refusal(
      `GitHub did not let your credential read ${ctx.repo} (${githubSaid(response)}). Sign in with \`gh auth login\` as an account ` +
        'that can write to it, and run upgrade again. Nothing was written.',
    )
  }
}

/** The project's validation of a proposed `steward.config.json` text by `readSettings`: problems, or none. */
async function settingsProblems(configText, tmpRoot) {
  const dir = await mkdtemp(path.join(tmpRoot, 'steward-upgrade-check-'))
  try {
    await writeFile(path.join(dir, CONFIG_FILE), configText)
    await readSettings(dir)
    return []
  } catch (error) {
    return [`${CONFIG_FILE}: ${String(error.message).replace(`${path.join(dir, CONFIG_FILE)}: `, '')}`]
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function run(argv, { cwd, fetch, getToken, tmpRoot, cloneUrl, migrations, out }, progress) {
  const flags = parseFlags(argv)

  const root = gitRoot(cwd)
  if (root === null) throw new Refusal(`${cwd} is not in a git repository: run upgrade in the project's checkout`)
  let url
  try {
    url = git(root, ['remote', 'get-url', 'origin'])
  } catch {
    throw new Refusal('This checkout has no `origin` remote. upgrade works through a pull request on the GitHub repository `origin` names: add that remote and run upgrade again. Nothing was written.')
  }
  const repo = repoFromRemoteUrl(url)
  if (repo === null) {
    throw new Refusal(`The \`origin\` remote, ${url}, is not a GitHub repository. upgrade works through a pull request on GitHub: run it in a checkout whose \`origin\` is the project on GitHub. Nothing was written.`)
  }

  const ctx = createInitContext({ repo, fetch, getToken })
  await checkCredential(ctx)

  // GitHub's answers, before anything is cloned, branched or pushed.
  const steward = createReadContext({
    repo: STEWARD_REPO,
    git: true,
    contentPaths: (p) => p === 'package.json' || MANAGED.some((file) => p === `${TEMPLATE_DIR}/${file}`),
    fetch,
    getToken,
  })
  let rulesPath = null
  const project = createReadContext({
    repo,
    git: false,
    contentPaths: (p) => p === CONFIG_FILE || p === rulesPath || MANAGED.some((file) => p === `${WORKFLOW_DIR}/${file}`),
    fetch,
    getToken,
  })

  // The target: a tag or a commit of steward.
  const targetPin = flags.to ?? flags.ref.toLowerCase()
  const targetCommit = flags.to !== undefined ? await readTagCommit(steward, flags.to) : await readCommit(steward, targetPin)
  if (targetCommit === null) {
    throw new Refusal(
      flags.to !== undefined
        ? `--to ${flags.to}: there is no tag ${flags.to} in ${STEWARD_REPO}. Nothing was cloned, branched or pushed.`
        : `--ref ${flags.ref}: there is no commit ${targetPin} in ${STEWARD_REPO}. Nothing was cloned, branched or pushed.`,
    )
  }
  const versionAt = async (commit) => {
    const text = await readFileAt(steward, 'package.json', commit)
    try {
      const { version } = JSON.parse(text)
      return typeof version === 'string' ? version : null
    } catch {
      return null
    }
  }
  const target = { kind: flags.to !== undefined ? 'tag' : 'commit', pin: targetPin, commit: targetCommit, version: await versionAt(targetCommit) }
  if (target.version === null) {
    throw new Refusal(`${targetPin}: package.json at ${targetCommit} of ${STEWARD_REPO} gives no version. Nothing was cloned, branched or pushed.`)
  }

  // What is installed: the managed workflows on the project's main, and the one pin they carry.
  const present = new Map()
  const findings = []
  for (const file of MANAGED) {
    const rel = `${WORKFLOW_DIR}/${file}`
    const text = await readFileAt(project, rel, 'main')
    if (text === null) {
      if (REQUIRED.includes(file)) findings.push(`${rel}: missing on main`)
      continue
    }
    const pins = pinsIn(text)
    if (pins.length === 0) findings.push(`${rel}: carries no reference to github:luplows/steward#<pin>`)
    present.set(file, { rel, text, pins })
  }
  const distinct = [...new Set([...present.values()].flatMap((w) => w.pins))]
  if (distinct.length > 1) {
    findings.push(`the managed workflows carry different pins: ${[...present.values()].map((w) => `${w.rel} has ${[...new Set(w.pins)].join(', ') || 'none'}`).join('; ')}`)
  }
  let installed = null
  if (findings.length === 0) {
    const pin = distinct[0]
    const kind = pinKind(pin)
    const commit = kind === 'tag' ? await readTagCommit(steward, pin) : kind === 'commit' ? await readCommit(steward, pin) : null
    if (commit === null) {
      findings.push(`the pin ${pin} is not a tag (vX.Y.Z) or a full commit SHA that exists in ${STEWARD_REPO}`)
    } else {
      installed = { kind, pin, commit, version: await versionAt(commit) }
    }
  }
  if (findings.length > 0) {
    throw new Refusal(
      `The steward this project installs cannot be identified from main:\n${findings.map((f) => `  ${f}`).join('\n')}\n` +
        'Reconcile these by hand, through a pull request of the project. Nothing was cloned, branched or pushed.',
    )
  }

  // No-ops.
  if (installed.pin === target.pin) {
    out(`${repo} is already on ${describePin(installed)}: nothing to upgrade. upgrade made no clone, branch, commit, push or pull request.`)
    return 0
  }
  if (installed.kind === 'tag' && target.kind === 'commit' && installed.commit === target.commit) {
    out(`${repo} is already on release ${installed.pin}, whose commit is ${target.pin}: nothing to upgrade. upgrade made no clone, branch, commit, push or pull request.`)
    return 0
  }
  const sameCommit = installed.commit === target.commit
  if (!sameCommit) {
    const status = await readComparison(steward, installed.commit, target.commit)
    if (status === 'behind') {
      throw new Refusal(
        `${target.pin} is behind the installed ${installed.pin}: that would be a downgrade, and upgrade does not downgrade. Nothing was cloned, branched or pushed.`,
      )
    }
    if (!['ahead', 'diverged', 'identical'].includes(status)) {
      throw new Error(`GitHub's comparison of ${installed.commit} with ${target.commit} gave ${JSON.stringify(status)}, not ahead, behind, diverged or identical`)
    }
  }

  // The installed workflows are steward's own at the installed pin, apart from the pin.
  const customized = []
  for (const { rel, text } of present.values()) {
    const template = await readFileAt(steward, `${TEMPLATE_DIR}/${path.posix.basename(rel)}`, installed.commit)
    if (template === null) customized.push(`${rel}: steward has no template of that name at ${installed.pin}`)
    else if (!sameWorkflowApartFromPin(text, template)) customized.push(`${rel}: differs from steward's template at ${installed.pin} by more than the pin`)
  }
  if (customized.length > 0) {
    throw new Refusal(
      `These managed workflows are not steward's own at the pin they carry, so upgrade will not replace them:\n${customized.map((f) => `  ${f}`).join('\n')}\n` +
        "Reconcile each by hand: bring it back to steward's template at the installed pin, or make the change in it that the target pin's template has, through a pull request of the project, and run upgrade again. " +
        'upgrade does not merge them. Nothing was cloned, branched or pushed.',
    )
  }

  // The proposal: the templates at the target pin.
  const changes = new Map()
  const missingAtTarget = []
  for (const { rel, text } of present.values()) {
    const template = await readFileAt(steward, `${TEMPLATE_DIR}/${path.posix.basename(rel)}`, target.commit)
    if (template === null) {
      missingAtTarget.push(rel)
      continue
    }
    let filled
    try {
      filled = fillPin(template, target.pin)
    } catch (error) {
      throw new Refusal(`${rel}: steward's template at ${target.pin} cannot be filled by this version of upgrade: ${error.message}. Nothing was cloned, branched or pushed.`)
    }
    changes.set(rel, withEndingsOf(text, filled))
  }
  if (missingAtTarget.length > 0) {
    throw new Refusal(
      `steward has no template at ${target.pin} for ${missingAtTarget.join(', ')}: the target does not carry ${missingAtTarget.length === 1 ? 'that workflow' : 'those workflows'}. Nothing was cloned, branched or pushed.`,
    )
  }

  // The project's own settings and rules, from main.
  const configText = await readFileAt(project, CONFIG_FILE, 'main')
  if (configText === null) throw new Refusal(`${CONFIG_FILE}: missing on main, so the upgrade cannot be validated. Nothing was cloned, branched or pushed.`)
  let config
  try {
    config = JSON.parse(configText)
  } catch (error) {
    throw new Refusal(`${CONFIG_FILE}: not valid JSON (${error.message}); repair it by hand first. Nothing was cloned, branched or pushed.`)
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Refusal(`${CONFIG_FILE}: must be a JSON object; repair it by hand first. Nothing was cloned, branched or pushed.`)
  }
  const plan = sameCommit ? { config, edits: [], decisions: [] } : planConfig(config, migrations)
  const proposedConfigText = plan.edits.length === 0 ? configText : `${JSON.stringify(plan.config, null, 2)}\n`
  if (plan.edits.length > 0) changes.set(CONFIG_FILE, proposedConfigText)

  // The proposed result, validated as the running package reads it.
  const problems = await settingsProblems(proposedConfigText, tmpRoot)
  const rulesFile = plan.config.rulesFile
  let rulesText = null
  if (isRulesFilePath(rulesFile)) {
    // Read at the path without its `.` segments (`./REVIEW.md`); the configured value stays as written.
    rulesPath = rulesFile.split('/').filter((s) => s !== '.').join('/')
    rulesText = await readFileAt(project, rulesPath, 'main')
    if (rulesText === null) problems.push(`${rulesFile}: the review rules file is missing on main`)
    else {
      const rules = validateRules(rulesFile, rulesText)
      if (!rules.ok) problems.push(...rules.problems)
    }
  }
  if (problems.length > 0) {
    throw new Refusal(
      `The proposed upgrade is not valid, so it is not reported as validated and no pull request is opened:\n${problems.map((p) => `  ${p}`).join('\n')}\n` +
        'Repair the file by hand, through a pull request of the project, and run upgrade again. Nothing was cloned, branched or pushed.',
    )
  }

  // The branch, before the clone.
  const branch = flags.branch ?? `steward/upgrade-${target.pin.slice(0, 12)}`
  try {
    git(root, ['check-ref-format', '--branch', branch])
  } catch {
    throw new Refusal(`--branch ${branch}: not a name Git takes for a branch.`)
  }
  if (branch === 'main' || branch.startsWith('release/')) {
    throw new Refusal(`--branch ${branch}: upgrade commits on a branch of its own, never on main or a release branch.`)
  }
  const onOrigin = await step(`looking for the branch ${branch} on GitHub`, 'Git', () =>
    git(root, ['ls-remote', '--heads', cloneUrl(url), `refs/heads/${branch}`]),
  )
  if (onOrigin !== '') {
    throw new Refusal(`The branch ${branch} is already on GitHub. Delete it there if it is an earlier upgrade's, or choose another name with --branch, and run upgrade again. Nothing was cloned or pushed.`)
  }
  const open = await step(`looking for an open pull request from ${branch}`, 'GitHub', async () => {
    const response = await ctx.send(buildListOpenPulls(repo, branch))
    if (!ok(response)) throw new Error(githubSaid(response))
    return Array.isArray(response.body) ? response.body : []
  })
  if (open.length > 0) {
    throw new Refusal(`A pull request is already open from ${branch}: ${open[0].html_url}. Close it, or choose another name with --branch, and run upgrade again. Nothing was cloned or pushed.`)
  }

  // The clone: the files changed here, and no others.
  progress.clone = await mkdtemp(path.join(tmpRoot, 'steward-upgrade-'))
  const clone = progress.clone
  out(`Copying ${repo}'s main from GitHub into ${clone}. Your own checkout is not changed.`)
  await step("copying the project's main from GitHub", 'Git', () =>
    git(clone, ['clone', '--quiet', '--branch', 'main', '--single-branch', cloneUrl(url), '.']),
  )
  const base = await step("reading main's commit", 'Git', () => git(clone, ['rev-parse', 'HEAD']))
  const templates = findPullRequestTemplates(clone).filter((rel) => !rel.endsWith('/'))
  let bodyTemplate = null
  if (flags.prTemplate !== undefined) {
    if (!templates.includes(flags.prTemplate)) {
      throw new Refusal(`--pr-template ${flags.prTemplate}: not one of the project's pull request templates (${templates.length === 0 ? 'it has none' : templates.join(', ')}).`)
    }
    bodyTemplate = flags.prTemplate
  } else if (templates.length > 1) {
    throw new Refusal(`The project has several pull request templates: ${templates.join(', ')}. Choose the one the pull request follows with --pr-template <path>, and run upgrade again.`)
  } else {
    bodyTemplate = templates[0] ?? null
  }
  await step(`making the branch ${branch}`, 'Git', () => git(clone, ['checkout', '--quiet', '-b', branch]))
  progress.branch = branch

  const changed = [...changes.keys()].sort()
  for (const rel of changed) {
    await step(`writing ${rel}`, 'The file system', async () => {
      const file = path.join(clone, ...rel.split('/'))
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, changes.get(rel))
    })
    out(`wrote ${rel}`)
  }
  const title = pullTitle(target)
  const commit = await step('committing the upgrade', 'Git', () => {
    git(clone, ['add', '--', ...changed])
    const staged = git(clone, ['diff', '--cached', '--name-only']).split('\n').filter((l) => l !== '').sort()
    if (JSON.stringify(staged) !== JSON.stringify(changed)) throw new Error(`staged ${staged.join(', ')}, not the files upgrade changes: ${changed.join(', ')}`)
    git(clone, ['commit', '--quiet', '-m', title, '-m', `Changed by steward upgrade:\n${changed.map((rel) => `- ${rel}`).join('\n')}`])
    return git(clone, ['rev-parse', 'HEAD'])
  })
  progress.pushAttempted = true
  await step(`pushing the branch ${branch} to GitHub`, 'Git', () =>
    git(clone, ['push', '--quiet', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]),
  )
  progress.pushed = true

  const templateText = bodyTemplate === null ? '' : await readFile(path.join(clone, ...bodyTemplate.split('/')), 'utf8')
  const body = pullBody({
    installed,
    target,
    sameCommit,
    changed: [...changes.keys()].filter((rel) => rel !== CONFIG_FILE).sort(),
    edits: plan.edits,
    decisions: plan.decisions,
    validation: [
      `\`${CONFIG_FILE}\` meets the settings requirements of the steward that ran \`steward upgrade\` (\`readSettings\`).`,
      `\`${rulesFile}\` parses with the reviewer's parser (\`validateRules\`).`,
      'Both were checked on the proposed result, before this pull request was opened. Neither check runs the workflows.',
    ],
    land: plan.config.land,
    rulesFile,
    template: templateText,
  })
  progress.pullAttempted = true
  const pull = await step('opening the draft pull request', 'GitHub', async () => {
    const response = await ctx.send(buildCreateDraftPull(repo, { branch, title, body }))
    if (!ok(response)) throw new Error(githubSaid(response))
    return response.body
  })

  out('The upgrade is on GitHub as a draft pull request, for the crew to review:')
  out(`  repository: ${repo}`)
  out(`  from: ${describePin(installed)}`)
  out(`  to: ${describePin(target)}`)
  out(`  branch: ${branch}`)
  out(`  base commit: ${base} (main, as upgrade copied it)`)
  out(`  upgrade commit: ${commit}`)
  out(`  pull request: ${pull?.html_url}`)
  out('Validated with the steward running this command: run it from steward installed at the target pin.')
  out('upgrade did not merge it, mark it ready, change protection, activate the project or touch any coordinator. A coordinator is stopped and started again by hand.')
  out(`Your own checkout was not changed. ${keptLine(clone)}`)
  return 0
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
