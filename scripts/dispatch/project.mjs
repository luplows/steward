#!/usr/bin/env node
/**
 * `steward project` (ST-57): which installed projects steward may review unattended on this
 * machine, for the invoking OS user. Installing steward (`steward init`) grants no such permission;
 * only `steward project activate` does. The design is `docs/agent-workflow-design.md`, Part 3,
 * "Decided so far", "Per-user coordinator foundations and manual independence".
 *
 *   steward project activate <checkout-path>   check origin's main, and record it
 *   steward project list                       the activated repositories and their checkouts
 *   steward project deactivate <owner/name>    remove that repository's record
 *
 * Of the caller's checkout, `activate` reads only its root and `origin`'s URL, and writes nothing
 * there. It checks the installation in a clone of steward's own, the owned checkout at
 * `~/.steward/state/checkouts/<owner>/<name>`, detached at `origin`'s `main`: cloned when absent,
 * fetched and checked out when present. The records are kept in `~/.steward/state/projects.json`,
 * one per repository. Deactivation removes the record and keeps the owned checkout for reuse;
 * nothing here deletes an owned checkout. None of these commands starts a review or a coordinator.
 *
 * The threat model is one member of the crew running one command at a time from an ordinary
 * checkout: Git runs as the person's own configuration makes it run, and a Git command that fails
 * is reported with what Git said.
 *
 * Exit code: 0 when the command did what it says; 1 when it did not (a check failed, Git failed,
 * the records file is malformed, or the repository to deactivate has no record); 2 for a command
 * line it does not take.
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir as osHomedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { git, gitRoot, repoFromRemoteUrl } from './init.mjs'
import { readSettings, REPO_RE } from './settings.mjs'
import { stateDir } from './user-config.mjs'

export const GATE_WORKFLOW = '.github/workflows/review-gate.yml'
const RECORD_KEYS = ['repo', 'checkout', 'ownedCheckout']

const USAGE = [
  'usage: steward project activate <checkout-path>',
  '       steward project list',
  '       steward project deactivate <owner/name>',
  '',
  'activate    lets steward review that checkout\'s GitHub repository unattended on this machine,',
  '            once steward is installed on origin\'s main there',
  'list        the activated repositories, their checkouts, and any checkout that is missing',
  'deactivate  takes that permission away again; the owned checkout of it is kept',
].join('\n')

/** Where the records are, and where the owned checkout of `repo` is, under `home`. */
export const projectsPath = (homedir) => path.join(stateDir({ homedir }), 'projects.json')
export const ownedCheckoutPath = (homedir, repo) => path.join(stateDir({ homedir }), 'checkouts', ...repo.split('/'))

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
/** Whether `dir` is the root of a Git checkout: it has a `.git`. */
const isCheckout = (dir) => existsSync(path.join(dir, '.git'))
const isDirectory = (dir) => {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * The records in `file`: `[]` when there is no file, else its `projects`, each
 * `{ repo, checkout, ownedCheckout }`. Throws, naming the file and what is wrong, on anything else:
 * a malformed file is never read as permission for any project.
 */
export async function readProjects(file) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const bad = (what) => new Error(`${file} is malformed: ${what}. Fix or remove it; until then no project counts as activated.`)
  let data
  try {
    data = JSON.parse(raw)
  } catch (error) {
    throw bad(`it is not valid JSON (${error.message})`)
  }
  if (!isObject(data) || Object.keys(data).join() !== 'projects' || !Array.isArray(data.projects)) {
    throw bad('it must be an object whose only key, "projects", is a list')
  }
  const seen = new Set()
  data.projects.forEach((record, i) => {
    if (!isObject(record) || Object.keys(record).sort().join() !== [...RECORD_KEYS].sort().join()) {
      throw bad(`record ${i + 1} must have exactly ${RECORD_KEYS.join(', ')}`)
    }
    if (typeof record.repo !== 'string' || !REPO_RE.test(record.repo)) throw bad(`record ${i + 1}'s repo is not owner/name`)
    for (const key of ['checkout', 'ownedCheckout']) {
      if (typeof record[key] !== 'string' || !path.isAbsolute(record[key])) throw bad(`record ${i + 1}'s ${key} is not an absolute path`)
    }
    if (seen.has(record.repo)) throw bad(`${record.repo} has more than one record`)
    seen.add(record.repo)
  })
  return data.projects
}

async function writeProjects(file, projects) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ projects }, null, 2)}\n`, 'utf8')
}

/** What is wrong with the installation in `owned`, for `repo`: an empty list when nothing is. */
export async function installationProblems(owned, repo) {
  const problems = []
  try {
    const settings = await readSettings(owned)
    if (settings.repo !== repo) {
      problems.push(`steward.config.json names the repository ${settings.repo}, not ${repo}`)
    }
    if (!existsSync(path.join(owned, ...settings.rulesFile.split('/')))) {
      problems.push(`the checklist steward.config.json names, ${settings.rulesFile}, is not there`)
    }
  } catch (error) {
    problems.push(`steward.config.json is missing or not valid: ${error.message.replace(`${path.join(owned, 'steward.config.json')}: `, '')}`)
  }
  if (!existsSync(path.join(owned, ...GATE_WORKFLOW.split('/')))) problems.push(`${GATE_WORKFLOW} is not there`)
  return problems
}

async function activate(given, { cwd, homedir, cloneUrl, out, err }) {
  const root = gitRoot(path.resolve(cwd, given))
  if (root === null) {
    err(`${given} is not a Git checkout. Give the path of a checkout of the project. Nothing was activated.`)
    return 1
  }
  let url
  try {
    url = git(root, ['remote', 'get-url', 'origin'])
  } catch {
    err(`${root} has no \`origin\` remote. Steward activates the GitHub repository \`origin\` names. Nothing was activated.`)
    return 1
  }
  const repo = repoFromRemoteUrl(url)
  if (repo === null) {
    err(`${root}'s \`origin\`, ${url}, is not a GitHub repository. Nothing was activated.`)
    return 1
  }

  const file = projectsPath(homedir)
  const projects = await readProjects(file)
  const owned = ownedCheckoutPath(homedir, repo)
  try {
    if (isCheckout(owned)) {
      out(`Updating the owned checkout of ${repo}, at ${owned}, to origin's main. Your checkout is not changed.`)
      git(owned, ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'])
    } else {
      out(`Copying ${repo}'s main from GitHub into the owned checkout, at ${owned}. Your checkout is not changed.`)
      await mkdir(path.dirname(owned), { recursive: true })
      git(path.dirname(owned), ['clone', '--quiet', '--no-checkout', '--branch', 'main', '--single-branch', cloneUrl(url), owned])
    }
    git(owned, ['checkout', '--quiet', '--detach', 'refs/remotes/origin/main'])
  } catch (error) {
    err(`${repo} was not activated: Git could not bring the owned checkout to origin's main. Git said: ${error.message}`)
    if (isDirectory(owned)) err(`The owned checkout is kept at ${owned} for the next attempt.`)
    return 1
  }

  const problems = await installationProblems(owned, repo)
  if (problems.length > 0) {
    err(`${repo} was not activated: steward is not installed on origin's main. On main:`)
    for (const problem of problems) err(`  - ${problem}`)
    err('Nothing was recorded. Install steward with `steward init`, merge its pull request, and run this again.')
    err(`The owned checkout is kept at ${owned} for the next attempt.`)
    return 1
  }

  const record = { repo, checkout: root, ownedCheckout: owned }
  const again = projects.some((p) => p.repo === repo)
  await writeProjects(file, again ? projects.map((p) => (p.repo === repo ? record : p)) : [...projects, record])
  const commit = git(owned, ['rev-parse', '--short', 'HEAD'])
  out(`${again ? `${repo} was already activated; its record is updated.` : `Activated ${repo}.`} Unattended review of it is now permitted on this machine.`)
  out(`  your checkout:       ${root} (not changed)`)
  out(`  the owned checkout:  ${owned}, at origin's main (${commit})`)
  out(`  record:              ${file}`)
  out(`Nothing was started. To take the permission away: steward project deactivate ${repo}`)
  return 0
}

async function list({ homedir, out }) {
  const file = projectsPath(homedir)
  const projects = await readProjects(file)
  if (projects.length === 0) {
    out(`No project is activated (${file} lists none).`)
    return 0
  }
  out(`Activated on this machine (${file}):`)
  for (const { repo, checkout, ownedCheckout } of projects) {
    out(repo)
    out(`  checkout:            ${checkout}${isCheckout(checkout) ? '' : '  (missing: no Git checkout is there now)'}`)
    out(`  the owned checkout:  ${ownedCheckout}${isCheckout(ownedCheckout) ? '' : '  (missing: activating the project again clones it)'}`)
  }
  return 0
}

async function deactivate(repo, { homedir, out, err }) {
  if (!REPO_RE.test(repo)) {
    err(`${repo}: give the repository as owner/name, as \`steward project list\` shows it.`)
    return 2
  }
  const file = projectsPath(homedir)
  const projects = await readProjects(file)
  const record = projects.find((p) => p.repo === repo)
  if (record === undefined) {
    err(`${repo} is not activated: ${file} has no record of it. Nothing was changed.`)
    return 1
  }
  await writeProjects(file, projects.filter((p) => p !== record))
  out(`Deactivated ${repo}: its record is removed from ${file}, so unattended review of it is no longer permitted on this machine.`)
  out(`The owned checkout is kept at ${record.ownedCheckout} for reuse; remove it by hand if you no longer want it.`)
  out('Your checkout is not changed, and a review already under way may finish.')
  return 0
}

/**
 * Runs `steward project <argv>` and returns its exit code. `cwd`, `homedir`, `cloneUrl` (the URL
 * Git clones for `origin`'s URL: only tests pass one, to reach a local repository) and the output
 * are injectable.
 */
export async function main(argv, { cwd = process.cwd(), homedir = osHomedir(), cloneUrl = (url) => url, out = console.log, err = console.error } = {}) {
  const [command, ...rest] = argv
  const ctx = { cwd, homedir, cloneUrl, out, err }
  try {
    if (command === 'activate' && rest.length === 1) return await activate(rest[0], ctx)
    if (command === 'list' && rest.length === 0) return await list(ctx)
    if (command === 'deactivate' && rest.length === 1) return await deactivate(rest[0], ctx)
  } catch (error) {
    err(error.message)
    return 1
  }
  err(USAGE)
  return 2
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
