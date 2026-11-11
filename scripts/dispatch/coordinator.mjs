#!/usr/bin/env node
/**
 * `steward coordinator` (ST-58): one local coordinator per OS user, which the invoking OS user
 * starts, inspects and gracefully stops. The design is `docs/agent-workflow-design.md`, Part 3,
 * "Decided so far", "Per-user coordinator foundations and manual independence".
 *
 *   steward coordinator start            start the coordinator in the background, detached
 *   steward coordinator status [--json]  whether it is running, stopping or stopped, and what it is
 *                                        doing
 *   steward coordinator stop             ask it to admit no more work, and to exit once idle
 *
 * The coordinator is a detached process, `coordinator.mjs run <home> <minutes> [<landing-minutes>]`,
 * which `start` launches; `run` is not for people. Its record is
 * `~/.steward/state/coordinator.json`: its process id, its start time, its state, `running` or
 * `stopping`, and the fields `status` shows, which `coordinator-scheduler.mjs` names, and no
 * credentials. Writing the record is how it acknowledges that it is running: `start` reports
 * `started` only once the record names the process it launched.
 * `stop` reaches it through a stop request, the file `~/.steward/state/coordinator.stop`, which the
 * coordinator looks for every `pollMs`. On seeing it the coordinator admits no more work and
 * removes the request; with no admitted work running it removes its record and exits, and otherwise
 * it writes `stopping` into its record and exits once that work has finished. Either change is the
 * acknowledgment `stop` waits for. While it runs, the coordinator schedules automatic reviews of
 * the activated projects (`coordinator-scheduler.mjs`), discovers the pull requests that
 * unattended landing may consider (ST-83), and asks the pilot, `landPullRequest`, to land each one
 * in unattended `once` mode (ST-84), after rechecking it. The pilot and the runway decide; a stop
 * lets an attempt already admitted finish. After each pass of those it admits at most one approved
 * coding handoff (`steward handoff`, ST-93), the oldest eligible, and waits for its coding and its
 * pull request (`handoff-coding.mjs`) before it looks at anything else, so a long coding session
 * delays the scans that come due meanwhile. A stop lets that bounded work finish too, and leaves
 * the handoffs not yet admitted pending for the next start.
 *
 * `start` reads the scan interval, `coordinator.scanIntervalMinutes`, and the optional landing scan
 * interval, `coordinator.landingScanIntervalMinutes`, through `readUserConfig`, and refuses,
 * changing nothing, when that throws. It hands the intervals to the process it launches, so a
 * change takes effect at the next `start`. Without the landing interval, landing discovery shares
 * the review scan.
 *
 * A `start` that finds no coordinator running also moves each handoff the previous one had
 * `admitted` for coding to `interrupted` (`interruptAdmissions`, `handoff-coding.mjs`), with what
 * the coordinator kept for it in `coding-evidence.json`, and says so. That handoff is never coded
 * again automatically, and `start` neither resumes it, nor looks for or stops a surviving worker,
 * nor touches its branch or worktree. A `start` that cannot read or update `handoffs.json` refuses,
 * launching nothing. `status` lists every handoff that is queued, running, completed, stopped or
 * held, from `handoffs.json`, whether or not a coordinator is running, and changes nothing.
 *
 * A `start` that finds no coordinator running first moves each `running` entry in the record of its
 * reviews to `ended` with `interrupted` (`interruptRunning`, `review-admission.mjs`), and says so.
 * That head is not reviewed again automatically; a manual review, or a new head, is how it gets a
 * verdict. `start` looks for no surviving reviewer: one may still post a verdict, which the gate
 * binds to the head reviewed. A `start` that cannot read or update that record of reviews refuses,
 * launching nothing, naming the file and leaving the coordinator's own record and any stop request
 * as they were. `status` reads it to list the heads that are not reviewed again automatically, and
 * changes no entry; `stop` does not read it.
 *
 * Manual commands (`review`, `rotation`, `land` and the rest) never consult the coordinator.
 *
 * The threat model is one member of the crew running one `steward coordinator` command at a time,
 * as the invoking OS user. Whether a recorded process is running is an ordinary liveness check of
 * its process id.
 *
 * Exit code: 0 when the command did what it says, which for `status` is whenever it can read the
 * record; 1 for `already-running` and for anything that failed; 2 for a command line it does not
 * take.
 */
import { spawn } from 'node:child_process'
import { existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scheduleReviews } from './coordinator-scheduler.mjs'
import { codeNextHandoff, interruptAdmissions } from './handoff-coding.mjs'
import { codingReport, codingState, describeSource, evidencePath, handoffsPath, keptWhere, readEvidence, readHandoffs, reportLines } from './handoff.mjs'
import { classifyResult, interruptRunning, readReviews, reviewsPath } from './review-admission.mjs'
import { readStateFile, writeStateFile } from './state-file.mjs'
import { readUserConfig, stateDir } from './user-config.mjs'

const MODULE_PATH = fileURLToPath(import.meta.url)
const POLL_MS = 250
const WAIT_MS = 15_000

const USAGE = [
  'usage: steward coordinator start',
  '       steward coordinator status [--json]',
  '       steward coordinator stop',
  '',
  'start   starts this OS user\'s coordinator in the background; it keeps running after this',
  '        terminal closes',
  'status  says whether it is running, stopping or stopped, and what it is doing; --json gives the',
  '        same as JSON',
  'stop    asks it to admit no more work and to exit once the work it admitted has finished',
].join('\n')

/** Where the coordinator's record, and a stop request for it, are under `homedir`. */
export const coordinatorPath = (homedir) => path.join(stateDir({ homedir }), 'coordinator.json')
export const stopRequestPath = (homedir) => path.join(stateDir({ homedir }), 'coordinator.stop')

/** The record in `file`, `{ pid, startedAt, state, ...fields }`, or null when there is none. */
export function readRecord(file) {
  const bad = () => new Error(`${file} is not a coordinator record steward wrote. Stop the coordinator it names, if any, and remove the file.`)
  let data
  try {
    data = readStateFile(file)
  } catch (error) {
    throw error instanceof SyntaxError ? bad() : error
  }
  if (data === undefined) return null
  const { pid, startedAt, state } = data ?? {}
  if (Number.isInteger(pid) && typeof startedAt === 'string' && typeof state === 'string') return data
  throw bad()
}

/** Whether a process with id `pid` is running. */
export function isRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Polls `check` every `pollMs` until it returns other than undefined, or `waitMs` has passed. */
async function waitFor(check, { pollMs, waitMs }) {
  const end = Date.now() + waitMs
  for (;;) {
    let value
    try {
      value = check()
    } catch {
      // A record that cannot be read just now: look again.
    }
    if (value !== undefined) return value
    if (Date.now() >= end) return undefined
    await sleep(pollMs)
  }
}

/**
 * Runs a coordinator in this process for `homedir`: writes its record, with `fields`, then watches
 * for a stop request. Returns `{ record, admit, admitting, report, fail, done }`. `admit(job)` runs
 * `job` (a function returning a promise) as admitted work and returns true, or returns false,
 * starting nothing, once a stop has been acknowledged or `fail` called; `admitting()` says which.
 * `report(fields)` merges `fields` into the record and writes it if they changed anything. A write
 * that fails is not fatal, and the next one replaces it; once the record is removed, `report`
 * writes nothing. `fail(error)` admits nothing more and ends the coordinator with `error` once
 * admitted work has finished. `done` resolves once the coordinator has removed its record, with an
 * error when it stopped because of one.
 */
export function runCoordinator({ homedir, pid = process.pid, now = () => new Date(), pollMs = POLL_MS, fields = {} }) {
  const file = coordinatorPath(homedir)
  const stopFile = stopRequestPath(homedir)
  const record = { pid, startedAt: now().toISOString(), state: 'running' }
  let reported = { ...fields }
  writeStateFile(file, { ...record, ...reported })

  let admitting = true
  let state = record.state
  let removed = false
  let admitted = 0
  let failure = null
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  const settle = () => {
    if (admitting || admitted > 0) return
    clearInterval(timer)
    removed = true
    rmSync(file, { force: true })
    finish(failure)
  }
  const fail = (error) => {
    admitting = false
    failure ??= error
    settle()
  }
  const timer = setInterval(() => {
    try {
      if (!admitting || !existsSync(stopFile)) return
      admitting = false
      rmSync(stopFile, { force: true })
      if (admitted > 0) {
        state = 'stopping'
        writeStateFile(file, { ...record, ...reported, state })
      }
    } catch (error) {
      return fail(error)
    }
    settle()
  }, pollMs)

  const admit = (job) => {
    if (!admitting) return false
    admitted += 1
    Promise.resolve().then(job).catch(() => {}).finally(() => {
      admitted -= 1
      settle()
    })
    return true
  }
  const report = (changes) => {
    const next = { ...reported, ...changes }
    if (removed || JSON.stringify(next) === JSON.stringify(reported)) return
    reported = next
    try {
      writeStateFile(file, { ...record, ...reported, state })
    } catch {
      // Not fatal: the record stays as it was, and the next write carries these fields too.
    }
  }
  return { record, admit, admitting: () => admitting, report, fail, done }
}

/** What `status` reports: `{ status, pid?, startedAt?, note? }`. */
function describe(homedir) {
  const record = readRecord(coordinatorPath(homedir))
  if (record === null) return { status: 'stopped' }
  const { pid, startedAt, state, ...fields } = record
  if (!isRunning(pid)) {
    return { status: 'stopped', pid, startedAt, note: 'the previous coordinator ended without removing its record' }
  }
  return { status: state === 'stopping' ? 'stopping' : 'running', pid, startedAt, ...fields }
}

/**
 * The heads the record of reviews counts as model-consuming failures, which are not reviewed again
 * automatically: `{ failedHeads }`, or `{ reviewsProblem }` when it cannot be read, or nothing when
 * there are none. Reads only.
 */
function failedHeads(homedir) {
  let reviews
  try {
    reviews = readReviews(reviewsPath(homedir))
  } catch (error) {
    return { reviewsProblem: error.message }
  }
  const failed = reviews.filter((entry) => entry.state === 'ended' && classifyResult(entry.result) === 'model-consuming-failure')
    .map(({ repo, number, headSha, endedAt, result }) => ({ repo, number, headSha, status: result.status, endedAt }))
  return failed.length > 0 ? { failedHeads: failed } : {}
}

/**
 * The coding work the handoff records show, by state, `{ coding: { queued, running, completed,
 * stopped, held } }` with each handoff as `codingReport` gives it, or `{ handoffsProblem }` when
 * they cannot be read, or nothing when there is none. Reads only.
 */
function codingWork(homedir) {
  let handoffs
  let evidence
  try {
    ;({ handoffs } = readHandoffs(handoffsPath(homedir)))
    evidence = readEvidence(evidencePath(homedir))
  } catch (error) {
    return { handoffsProblem: error.message }
  }
  const coding = { queued: [], running: [], completed: [], stopped: [], held: [] }
  for (const h of handoffs) {
    const state = codingState(h)
    if (state !== null) coding[state].push(codingReport(h, evidence))
  }
  return Object.values(coding).some((list) => list.length > 0) ? { coding } : {}
}

async function start({ homedir, env, spawnFn, pollMs, waitMs, out, err }) {
  const file = coordinatorPath(homedir)
  const record = readRecord(file)
  if (record !== null && isRunning(record.pid)) {
    err(`already-running: this OS user's coordinator is already running, as process ${record.pid}, started ${record.startedAt}. Nothing was started.`)
    err('To see it: steward coordinator status. To stop it: steward coordinator stop')
    return 1
  }
  let intervalMinutes
  let landingMinutes
  try {
    ;({ scanIntervalMinutes: intervalMinutes, landingScanIntervalMinutes: landingMinutes } = (await readUserConfig({ env, homedir })).coordinator)
  } catch (error) {
    err(`The coordinator did not start: it could not read its scan interval from the user config. ${error.message}`)
    err('Nothing was started.')
    return 1
  }
  let interrupted
  try {
    interrupted = interruptRunning({ homedir })
  } catch (error) {
    err(`The coordinator did not start: it could not read or update its record of reviews, ${reviewsPath(homedir)}. ${error.message}`)
    err('Nothing was started.')
    return 1
  }
  for (const { repo, number, headSha } of interrupted) {
    out(`interrupted: the previous coordinator ended without writing how its review of ${repo} pull request #${number}, head ${headSha}, ended. It counts as failed, and this head will not be reviewed again automatically. A manual review of it, or a new head, is how it gets a verdict.`)
  }
  let interruptedHandoffs
  try {
    interruptedHandoffs = interruptAdmissions({ homedir })
  } catch (error) {
    err(`The coordinator did not start: it could not read or update its approved handoffs, ${handoffsPath(homedir)}. ${error.message}`)
    err('Nothing was started.')
    return 1
  }
  for (const { id, repo, source, admission } of interruptedHandoffs) {
    const where = admission?.branch ?? `${repo}'s branches`
    out(`interrupted: the previous coordinator ended without writing how its coding of ${id}, ${describeSource(source)} of ${repo}, ended. It is not coded again automatically, and nothing was resumed, stopped or removed. Inspect ${where} on ${repo}, any pull request from it, and any worktree it left (\`git worktree list\` in the project's owned checkout). \`steward handoff list\` shows it.`)
  }
  if (record !== null) {
    out(`The previous coordinator, process ${record.pid}, started ${record.startedAt}, ended without removing its record; replacing that record.`)
    rmSync(file, { force: true })
  }
  rmSync(stopRequestPath(homedir), { force: true })

  const child = spawnFn(process.execPath, [MODULE_PATH, 'run', homedir, String(intervalMinutes), ...(landingMinutes === undefined ? [] : [String(landingMinutes)])], { detached: true, stdio: 'ignore', windowsHide: true })
  let exited = false
  child.on('exit', () => { exited = true })
  child.on('error', () => { exited = true })
  const acknowledged = await waitFor(() => {
    if (exited) return null
    const now = readRecord(file)
    return now !== null && now.pid === child.pid ? now : undefined
  }, { pollMs, waitMs })
  if (!acknowledged) {
    if (!exited && child.pid !== undefined && isRunning(child.pid)) process.kill(child.pid)
    err(`The coordinator did not start: ${exited ? 'the process ended before it wrote its record' : `it wrote no record within ${waitMs / 1000} seconds, and was stopped`}. Nothing is running.`)
    return 1
  }
  child.unref()
  out(`started: this OS user's coordinator is running in the background, as process ${acknowledged.pid}, started ${acknowledged.startedAt}.`)
  out(`Its record is ${file}. It keeps running after this terminal closes.`)
  out(`It reviews the activated projects' eligible pull requests, one at a time, and scans for new ones every ${intervalMinutes} minutes.`)
  out(`It also lists, every ${landingMinutes ?? intervalMinutes} minutes${landingMinutes === undefined ? ', on the same scan' : ''}, the pull requests of projects whose settings have land true that unattended landing may consider, and asks the pilot to land each, one at a time. The pilot and the runway decide whether it lands.`)
  out('To see it: steward coordinator status. To stop it: steward coordinator stop')
  return 0
}

/** The lines `status` adds to its first, for the fields in `result`. */
function statusLines({ intervalMinutes, landingScanIntervalMinutes, nextScanAt, nextLandingScanAt, landingCandidates, active, landingActive, lastLanding, lastOutcome, usage, recordsProblem, projectProblems, landingProblems, failedHeads: failed, reviewsProblem, codingActive, lastCoding, codingProblem, coding, handoffsProblem }) {
  const pull = ({ repo, number, headSha }) => `${repo} pull request #${number}, head ${headSha ?? 'unknown'}`
  const lines = []
  if (intervalMinutes !== undefined) lines.push(`Scan interval: ${intervalMinutes} minutes.`)
  if (landingScanIntervalMinutes !== undefined) lines.push(`Landing scan interval: ${landingScanIntervalMinutes} minutes.`)
  if (nextScanAt) lines.push(`Next scan: ${nextScanAt}.`)
  if (nextLandingScanAt) lines.push(`Next landing scan: ${nextLandingScanAt}.`)
  if (active) lines.push(`Reviewing: ${pull(active)}.`)
  if (landingActive) lines.push(`Landing: ${pull(landingActive)}.`)
  if (codingActive) lines.push(`Coding: ${codingActive.handoffId} of ${codingActive.repo}, on branch ${codingActive.branch}, since ${codingActive.admittedAt}. No scan runs until it ends.`)
  if (landingCandidates?.length > 0) {
    lines.push('Landing candidates found by the latest landing scan:')
    for (const candidate of landingCandidates) lines.push(`  ${pull(candidate)}`)
  }
  if (lastLanding) {
    const { status: ended, triggers, reason, at, discoveredHeadSha } = lastLanding
    // Only `merged` says the pilot saw the merge. A result carrying a positive `triggers` count sent
    // a dispatch; `threw` carries none, and does not say whether one was sent.
    const sent = ended !== 'merged' && triggers > 0 ? ' (the landing workflow was dispatched; a merge is not confirmed)' : ''
    lines.push(`Last landing: ${pull(lastLanding)}: ${ended}${sent}${discoveredHeadSha ? `; discovered at head ${discoveredHeadSha}` : ''}, at ${at}${reason ? `: ${reason}` : ''}.`)
  }
  if (lastOutcome) {
    const { status: ended, counted, reason, at } = lastOutcome
    lines.push(`Last outcome: ${pull(lastOutcome)}: ${ended}${counted ? ` (${counted})` : ''}, at ${at}${reason ? `: ${reason}` : ''}.`)
  }
  if (lastCoding) {
    const { repo, handoffId, status: ended, reason, branch, pr, at } = lastCoding
    lines.push(`Last coding: ${handoffId ? `${handoffId} of ${repo}: ` : ''}${ended}${branch ? `, branch ${branch}` : ''}${pr ? `, pull request #${pr.number}` : ''}, at ${at}${reason ? `: ${reason}` : ''}.`)
  }
  if (lastCoding?.evidence) {
    const known = lastCoding.evidence
    const kept = known.retained ? keptWhere(known.retained) : null
    lines.push(`  Known of it: ${[`outcome ${known.outcome}`, known.branch && `branch ${known.branch}`, known.headSha && `head ${known.headSha}`, known.pr && `pull request #${known.pr.number} ${known.pr.url}`, kept && `work kept at ${kept}`].filter(Boolean).join(', ')}.`)
  }
  if (codingProblem) lines.push(`No handoff is coded: ${codingProblem}`)
  if (usage) lines.push(`No more reviews until the next scan: ${usage.status}: ${usage.reason}.`)
  if (recordsProblem) lines.push(`No automatic review starts: the project records cannot be read: ${recordsProblem}`)
  for (const { repo, reason } of projectProblems ?? []) lines.push(`${repo}: no review until a later scan: ${reason}`)
  for (const { repo, reason } of landingProblems ?? []) lines.push(`${repo}: no landing candidates from this project until a later scan: ${reason}`)
  if (failed) {
    lines.push('Not reviewed again automatically, as a review of the head failed; a manual review, or a new head, is how it gets a verdict:')
    for (const head of failed) lines.push(`  ${pull(head)}: ${head.status}, at ${head.endedAt}`)
  }
  if (reviewsProblem) lines.push(`The record of reviews cannot be read: ${reviewsProblem}`)
  if (handoffsProblem) lines.push(`The approved handoffs cannot be read: ${handoffsProblem}`)
  for (const [state, list] of Object.entries(coding ?? {})) {
    for (const entry of list) {
      lines.push(`Coding ${state}: ${entry.id}, ${entry.unit} of ${entry.repo}, version ${entry.version}.`)
      for (const detail of reportLines(entry)) lines.push(`  ${detail}`)
    }
  }
  return lines
}

function status(json, { homedir, out }) {
  const result = { ...describe(homedir), ...failedHeads(homedir), ...codingWork(homedir) }
  if (json) {
    out(JSON.stringify(result))
    return 0
  }
  const { status: state, pid, startedAt, note } = result
  if (state === 'stopped') {
    out(note ? `stopped: ${note} (process ${pid}, started ${startedAt}). steward coordinator start replaces it.` : 'stopped: no coordinator is running for this OS user.')
  } else if (state === 'stopping') {
    out(`stopping: the coordinator, process ${pid}, started ${startedAt}, admits no more work and exits once the work it admitted has finished.`)
  } else {
    out(`running: the coordinator is process ${pid}, started ${startedAt}. To stop it: steward coordinator stop`)
  }
  for (const line of statusLines(result)) out(line)
  return 0
}

async function stop({ homedir, pollMs, waitMs, out, err }) {
  const before = describe(homedir)
  if (before.status === 'stopped') {
    out(before.note ? `stopped: ${before.note} (process ${before.pid}); there is nothing to stop.` : 'stopped: no coordinator is running for this OS user; there is nothing to stop.')
    return 0
  }
  if (before.status === 'running') {
    writeFileSync(stopRequestPath(homedir), `${new Date().toISOString()}\n`, 'utf8')
    const file = coordinatorPath(homedir)
    const after = await waitFor(() => {
      const record = readRecord(file)
      if (record === null || record.pid !== before.pid || !isRunning(record.pid)) return 'stopped'
      return record.state === 'stopping' ? 'stopping' : undefined
    }, { pollMs, waitMs })
    if (after === undefined) {
      err(`The coordinator, process ${before.pid}, did not acknowledge the stop request within ${waitMs / 1000} seconds. The request is left at ${stopRequestPath(homedir)}; run steward coordinator status to see whether it has stopped.`)
      return 1
    }
    if (after === 'stopped') {
      out(`stopped: the coordinator, process ${before.pid}, had no work running; it has removed its record and exited.`)
      return 0
    }
  }
  out(`stopping: the coordinator, process ${before.pid}, admits no more work. It exits once the work it admitted has finished; this does not wait for that.`)
  out('To see when it has stopped: steward coordinator status')
  return 0
}

/** The detached coordinator process itself: schedules reviews until stopped, then exits. */
async function run(homedir, intervalMinutes, landingMinutes) {
  try {
    const landingFields = landingMinutes === undefined ? {} : { landingScanIntervalMinutes: landingMinutes }
    const coordinator = runCoordinator({ homedir, fields: { intervalMinutes, ...landingFields } })
    scheduleReviews({
      homedir, coordinator, intervalMinutes, landing: { intervalMinutes: landingMinutes, attempt: {} },
      coding: { turn: (args) => codeNextHandoff({ homedir, ...args }) },
    })
    const failure = await coordinator.done
    return failure ? 1 : 0
  } catch {
    rmSync(coordinatorPath(homedir), { force: true })
    return 1
  }
}

/**
 * Runs `steward coordinator <argv>` and returns its exit code. `homedir`, `env` (what the user
 * config's path is read from), `spawnFn` (`spawn` from `node:child_process`), the polling interval,
 * how long to wait for an acknowledgment, and the output are injectable.
 */
export async function main(argv, { homedir = osHomedir(), env = process.env, spawnFn = spawn, pollMs = 100, waitMs = WAIT_MS, out = console.log, err = console.error } = {}) {
  const [command, ...rest] = argv
  const ctx = { homedir, env, spawnFn, pollMs, waitMs, out, err }
  try {
    if (command === 'start' && rest.length === 0) return await start(ctx)
    if (command === 'status' && rest.length === 0) return status(false, ctx)
    if (command === 'status' && rest.length === 1 && rest[0] === '--json') return status(true, ctx)
    if (command === 'stop' && rest.length === 0) return await stop(ctx)
    if (command === 'run' && (rest.length === 2 || rest.length === 3)) return await run(rest[0], Number(rest[1]), rest.length === 3 ? Number(rest[2]) : undefined)
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
