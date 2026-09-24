/**
 * Runs one coder or reviewer session and says how it ended (OQ-65). It joins
 * the three dispatch modules and reimplements none of them: `invocation.mjs`
 * (OQ-74) builds the argument list, environment and prompt, this module starts
 * the process and watches it, and `outcome.mjs` (OQ-75) classifies the raw
 * record it leaves behind.
 *
 * It performs no GitHub operation: no pull request, no status, no label. Those
 * are `github.mjs`'s (OQ-68). A spawn's result is never a statement about the
 * repository -- a session that hit its limit after opening its PR is `died`,
 * and only looking at the repository says otherwise.
 *
 * The process is started directly, never through a shell. On the owner's
 * machines `claude` on PATH is a `/bin/sh` shim that `child_process.spawn`
 * cannot start, and a shell would push the prompt through `cmd.exe` quoting.
 * The prompt goes on stdin because it exceeds `CreateProcess`'s 32,767
 * characters as well as `cmd.exe`'s 8 KB.
 *
 * Stopping a session stops its whole process tree, not just the child: a
 * session's own subprocesses (a test run, a `node -e`) would otherwise outlive
 * it, and a timeout that leaves a process running is a leak, not a timeout.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { buildInvocation } from './invocation.mjs'
import { classifySession, validateRawRecord } from './outcome.mjs'

// docs/agent-workflow-design.md, "What a spawn actually costs": the slowest
// measured spawn was 16 minutes, and the timeout is to sit well clear of it.
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

// `--output-format json` writes nothing until the session ends, so a healthy
// session is silent for its whole run (up to 16 minutes measured). The stall
// interval has to exceed that or it kills sessions that are working; it exists
// to catch one that neither finishes nor dies before the timeout does.
export const DEFAULT_STALL_MS = 20 * 60 * 1000

const REAL_BINARY = path.join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')

/**
 * The real `claude` binary, found without a shell. `claude` on PATH is a shim,
 * so this looks for the npm-installed package beside each PATH entry and under
 * `%APPDATA%\npm`. Throws when none exists: resolution failing is an error,
 * not something to work around by reaching for a shell.
 *
 *   env      the environment to read PATH and APPDATA from
 *   exists   file-existence check; injectable for tests
 */
export function resolveClaudeExecutable({ env = process.env, exists = existsSync } = {}) {
  if (env.CLAUDE_EXECUTABLE) {
    if (!exists(env.CLAUDE_EXECUTABLE)) {
      throw new Error(`CLAUDE_EXECUTABLE does not exist: ${env.CLAUDE_EXECUTABLE}`)
    }
    return env.CLAUDE_EXECUTABLE
  }
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)
  const roots = [
    ...(env.APPDATA ? [path.join(env.APPDATA, 'npm')] : []),
    ...dirs,
    ...dirs.map((dir) => path.join(dir, '..', 'lib')),
  ]
  const candidates = roots.map((root) => path.join(root, REAL_BINARY))
  const found = candidates.find((candidate) => exists(candidate))
  if (!found) {
    throw new Error(
      `could not resolve the claude binary (${REAL_BINARY}); looked in ${candidates.length} location(s). ` +
      'Set CLAUDE_EXECUTABLE to its path.',
    )
  }
  return found
}

const IS_WINDOWS = process.platform === 'win32'

/**
 * Kills `child` and every process descended from it, and resolves once the
 * kill has been carried out. On Windows that is `taskkill /T /F`, started
 * directly like everything else here; it walks the tree by parent pid, which
 * reaches descendants started outside the child's job object. Elsewhere the
 * child leads its own process group (see `runSession`), and the group is
 * signalled. Either way the child itself is also killed directly, as a
 * fallback if the tree kill found nothing to do or could not run.
 */
function killTree(child, spawnFn) {
  const killChild = () => { child.kill('SIGKILL') }
  if (!IS_WINDOWS) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // Already gone, or no group to signal; the direct kill below covers it.
    }
    killChild()
    return Promise.resolve()
  }
  const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  return new Promise((resolve) => {
    const done = () => { killChild(); resolve() }
    let killer
    try {
      killer = spawnFn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch {
      done()
      return
    }
    killer.on('error', done)
    killer.on('exit', done)
  })
}

/**
 * Starts `executable` with `args`, writes `prompt` to its stdin, and watches
 * it until it ends or is stopped.
 *
 *   role        'coder' | 'reviewer', recorded on the raw record
 *   executable  path to a real executable; never resolved through a shell
 *   args, env, prompt
 *   timeoutMs   hard limit on the whole session
 *   stallMs     terminate when no stdout or stderr arrives for this long
 *   spawnFn     `child_process.spawn`; injectable for tests
 *
 * Resolves `{ record, pid }` once the child has exited. `record` is the raw
 * record `outcome.mjs` defines, and is validated against it before returning.
 * When the session is stopped, its whole process tree has been killed and the
 * child has exited by the time this resolves. Rejects if the process cannot be
 * started.
 */
export function runSession({
  role, executable, args = [], env, prompt, timeoutMs, stallMs, spawnFn = spawn,
}) {
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) throw new Error('runSession requires a positive timeoutMs')
  if (!(Number.isFinite(stallMs) && stallMs > 0)) throw new Error('runSession requires a positive stallMs')
  if (typeof prompt !== 'string') throw new Error('runSession requires a prompt string')

  return new Promise((resolve, reject) => {
    const child = spawnFn(executable, args, {
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Outside Windows, a group of its own is what lets `killTree` reach the
      // child's descendants. The cost is that a Ctrl-C at the dispatcher's
      // terminal no longer reaches the session; the timeout still does. On
      // Windows `detached` would mean a new console.
      detached: !IS_WINDOWS,
    })

    let stdout = ''
    let stoppedFor = null
    let settled = false
    let stallTimer = null
    let treeKilled = Promise.resolve()

    const clearTimers = () => {
      clearTimeout(timeoutTimer)
      clearTimeout(stallTimer)
    }
    const stop = (reason) => {
      if (stoppedFor !== null || settled) return
      stoppedFor = reason
      clearTimers()
      treeKilled = killTree(child, spawnFn)
    }
    const armStall = () => {
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => stop('stall'), stallMs)
    }
    const timeoutTimer = setTimeout(() => stop('timeout'), timeoutMs)
    armStall()

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk; armStall() })
    child.stderr.on('data', armStall)

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimers()
      reject(error)
    })

    child.on('exit', (exitCode, signal) => {
      if (settled) return
      settled = true
      clearTimers()
      // Take what the pipes already hold, then release them: a grandchild that
      // inherited a pipe would otherwise keep `close` from ever firing.
      const record = { role, exitCode, signal, stdout, stoppedFor }
      setImmediate(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        // The child can exit before `taskkill` has finished with its
        // descendants; a stopped session is not reported until it has.
        treeKilled.then(() => {
          try {
            validateRawRecord(record)
            resolve({ record, pid: child.pid })
          } catch (error) {
            reject(error)
          }
        })
      })
    })

    // A child that dies before reading its stdin raises EPIPE; the exit
    // handler reports that, so the write error itself is not the story.
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
  })
}

/**
 * Builds a session with `buildInvocation`, runs it, and classifies it.
 * Takes `buildInvocation`'s options (role, promptTemplate, story, branch, pr,
 * retry, baseEnv, emptyGhConfigDir, model, effort, maxBudgetUsd) plus:
 *
 *   executable  the binary to start; resolved by `resolveClaudeExecutable`
 *               when omitted
 *   timeoutMs, stallMs  default to `DEFAULT_TIMEOUT_MS`, `DEFAULT_STALL_MS`
 *   run         `runSession`; injectable for tests
 *
 * Returns `{ classification, output, record }`: `classification` is
 * `classifySession`'s result unaltered, `output` is the parsed JSON the
 * session emitted (`classification.envelope`), `record` is the raw record.
 */
export async function spawnSession(options) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, stallMs = DEFAULT_STALL_MS, run = runSession } = options
  const executable = options.executable ?? resolveClaudeExecutable({ env: options.baseEnv ?? process.env })
  const { args, env, prompt } = buildInvocation(options)
  const { record } = await run({ role: options.role, executable, args, env, prompt, timeoutMs, stallMs })
  const classification = classifySession(record)
  return { classification, output: classification.envelope, record }
}
