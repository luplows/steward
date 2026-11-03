#!/usr/bin/env node
/**
 * `steward coordinator` (ST-58): one local coordinator per OS user, which the invoking OS user
 * starts, inspects and gracefully stops. The design is `docs/agent-workflow-design.md`, Part 3,
 * "Decided so far", "Per-user coordinator foundations and manual independence".
 *
 *   steward coordinator start            start the coordinator in the background, detached
 *   steward coordinator status [--json]  whether it is running, stopping or stopped
 *   steward coordinator stop             ask it to admit no more work, and to exit once idle
 *
 * The coordinator is a detached process, `coordinator.mjs run <home>`, which `start` launches;
 * `run` is not for people. Its record is `~/.steward/state/coordinator.json`: its process id, its
 * start time and its state, `running` or `stopping`, and no credentials. Writing the record is how
 * it acknowledges that it is running: `start` reports `started` only once the record names the
 * process it launched. `stop` reaches it through a stop request, the file
 * `~/.steward/state/coordinator.stop`, which the coordinator looks for every `pollMs`. On seeing it
 * the coordinator admits no more work and removes the request; with no admitted work running it
 * removes its record and exits, and otherwise it writes `stopping` into its record and exits once
 * that work has finished. Either change is the acknowledgment `stop` waits for. This story adds no
 * scheduling: the coordinator idles until it is stopped, and only tests admit (simulated) work.
 *
 * A `start` that finds no coordinator running first moves each `running` entry in the record of its
 * reviews to `ended` with `interrupted` (`interruptRunning`, `review-admission.mjs`), and says so.
 * That head is not reviewed again automatically; a manual review, or a new head, is how it gets a
 * verdict. `start` looks for no surviving reviewer: one may still post a verdict, which the gate
 * binds to the head reviewed. A `start` that cannot read or update that record of reviews refuses,
 * launching nothing, naming the file and leaving the coordinator's own record and any stop request
 * as they were. `status` and `stop` do not read it.
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
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { interruptRunning, reviewsPath } from './review-admission.mjs'
import { stateDir } from './user-config.mjs'

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
  'status  says whether it is running, stopping or stopped; --json gives the same as JSON',
  'stop    asks it to admit no more work and to exit once the work it admitted has finished',
].join('\n')

/** Where the coordinator's record, and a stop request for it, are under `homedir`. */
export const coordinatorPath = (homedir) => path.join(stateDir({ homedir }), 'coordinator.json')
export const stopRequestPath = (homedir) => path.join(stateDir({ homedir }), 'coordinator.stop')

/** The record in `file`, `{ pid, startedAt, state }`, or null when there is none. */
export function readRecord(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  try {
    const { pid, startedAt, state } = JSON.parse(raw)
    if (Number.isInteger(pid) && typeof startedAt === 'string' && typeof state === 'string') return { pid, startedAt, state }
  } catch {
    // Reported below.
  }
  throw new Error(`${file} is not a coordinator record steward wrote. Stop the coordinator it names, if any, and remove the file.`)
}

const writeRecord = (file, record) => writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')

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
      // A record caught half written: look again.
    }
    if (value !== undefined) return value
    if (Date.now() >= end) return undefined
    await sleep(pollMs)
  }
}

/**
 * Runs a coordinator in this process for `homedir`: writes its record, then watches for a stop
 * request. Returns `{ record, admit, fail, done }`. `admit(job)` runs `job` (a function returning a
 * promise) as admitted work and returns true, or returns false, starting nothing, once a stop has
 * been acknowledged or `fail` called. `fail(error)` admits nothing more and ends the coordinator
 * with `error` once admitted work has finished. `done` resolves once the coordinator has removed
 * its record, with an error when it stopped because of one.
 */
export function runCoordinator({ homedir, pid = process.pid, now = () => new Date(), pollMs = POLL_MS }) {
  const file = coordinatorPath(homedir)
  const stopFile = stopRequestPath(homedir)
  mkdirSync(path.dirname(file), { recursive: true })
  const record = { pid, startedAt: now().toISOString(), state: 'running' }
  writeRecord(file, record)

  let admitting = true
  let admitted = 0
  let failure = null
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  const settle = () => {
    if (admitting || admitted > 0) return
    clearInterval(timer)
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
      if (admitted > 0) writeRecord(file, { ...record, state: 'stopping' })
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
  return { record, admit, fail, done }
}

/** What `status` reports: `{ status, pid?, startedAt?, note? }`. */
function describe(homedir) {
  const record = readRecord(coordinatorPath(homedir))
  if (record === null) return { status: 'stopped' }
  const { pid, startedAt, state } = record
  if (!isRunning(pid)) {
    return { status: 'stopped', pid, startedAt, note: 'the previous coordinator ended without removing its record' }
  }
  return { status: state === 'stopping' ? 'stopping' : 'running', pid, startedAt }
}

async function start({ homedir, spawnFn, pollMs, waitMs, out, err }) {
  const file = coordinatorPath(homedir)
  const record = readRecord(file)
  if (record !== null && isRunning(record.pid)) {
    err(`already-running: this OS user's coordinator is already running, as process ${record.pid}, started ${record.startedAt}. Nothing was started.`)
    err('To see it: steward coordinator status. To stop it: steward coordinator stop')
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
  if (record !== null) {
    out(`The previous coordinator, process ${record.pid}, started ${record.startedAt}, ended without removing its record; replacing that record.`)
    rmSync(file, { force: true })
  }
  rmSync(stopRequestPath(homedir), { force: true })

  const child = spawnFn(process.execPath, [MODULE_PATH, 'run', homedir], { detached: true, stdio: 'ignore', windowsHide: true })
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
  out('It schedules no work yet. To see it: steward coordinator status. To stop it: steward coordinator stop')
  return 0
}

function status(json, { homedir, out }) {
  const result = describe(homedir)
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

/** The detached coordinator process itself: runs until stopped, then exits. */
async function run(homedir) {
  try {
    const failure = await runCoordinator({ homedir }).done
    return failure ? 1 : 0
  } catch {
    rmSync(coordinatorPath(homedir), { force: true })
    return 1
  }
}

/**
 * Runs `steward coordinator <argv>` and returns its exit code. `homedir`, `spawnFn` (`spawn` from
 * `node:child_process`), the polling interval, how long to wait for an acknowledgment, and the
 * output are injectable.
 */
export async function main(argv, { homedir = osHomedir(), spawnFn = spawn, pollMs = 100, waitMs = WAIT_MS, out = console.log, err = console.error } = {}) {
  const [command, ...rest] = argv
  const ctx = { homedir, spawnFn, pollMs, waitMs, out, err }
  try {
    if (command === 'start' && rest.length === 0) return await start(ctx)
    if (command === 'status' && rest.length === 0) return status(false, ctx)
    if (command === 'status' && rest.length === 1 && rest[0] === '--json') return status(true, ctx)
    if (command === 'stop' && rest.length === 0) return await stop(ctx)
    if (command === 'run' && rest.length === 1) return await run(rest[0])
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
