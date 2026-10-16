/**
 * The reviewer run through OpenAI's Codex CLI (ST-32), chosen in the machine's settings: a choice
 * whose `tool` is `"codex"` (`machine-settings.mjs`). Two things a Claude reviewer gets elsewhere
 * are done here for Codex:
 *
 * - **Its usage**, read before a session starts, with no model call: `codex app-server` over
 *   stdio JSON-RPC, `initialize` then `account/rateLimits/read` (`docs/agent-workflow-design.md`,
 *   "Trials and measurements", "Codex as reviewer"). Of the answer, only each window's percent and
 *   reset time leave this module.
 * - **Its session**: `codex exec` under `-s read-only`, in the review's checkout, with the
 *   rendered prompt on stdin and its last message written to a file. It is started through
 *   `runSession` (`spawn.mjs`), so it gets the same time limit, stall interval and process-tree
 *   kill as a Claude session, and never a shell.
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { DEFAULT_STALL_MS, DEFAULT_TIMEOUT_MS, killTree, runSession } from './spawn.mjs'

export const CODEX_USAGE_TIMEOUT_MS = 30 * 1000
export const APP_SERVER_ARGS = ['app-server', '--listen', 'stdio://']
// The windows ST-31 checks, by their length in minutes: the 5-hour window and the weekly one.
const SESSION_WINDOW_MINS = 300
const WEEKLY_WINDOW_MINS = 10080

/**
 * The default JSON-RPC exchange: starts `<executable> app-server --listen stdio://` in `cwd`,
 * sends `initialize`, then `initialized` and `account/rateLimits/read`, and stops the process.
 * Resolves `{ ok: true, result }` with that request's result, or `{ ok: false, reason }`: the
 * process failing to start or exiting early, an error answer, or no answer within `timeoutMs`.
 * Never rejects.
 */
export function rateLimitsRpc({ executable, cwd, timeoutMs, spawnFn = spawn }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn(executable, APP_SERVER_ARGS, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, reason: `could not start codex app-server: ${error.message}` })
      return
    }
    let settled = false
    let buffer = ''
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killTree(child, spawnFn).then(() => resolve(value))
    }
    const timer = setTimeout(
      () => finish({ ok: false, reason: `codex app-server gave no rate limits within ${timeoutMs / 1000} seconds` }),
      timeoutMs,
    )
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)

    child.on('error', (error) => finish({ ok: false, reason: `could not start codex app-server: ${error.message}` }))
    child.on('exit', (code) => finish({ ok: false, reason: `codex app-server exited with code ${code} before answering` }))
    child.stdin.on('error', () => {})
    child.stderr.on('data', () => {})
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message?.id === 1) {
          if (message.error) {
            finish({ ok: false, reason: 'codex app-server refused initialize' })
            return
          }
          send({ jsonrpc: '2.0', method: 'initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: null })
        } else if (message?.id === 2) {
          finish(message.error
            ? { ok: false, reason: 'codex app-server answered account/rateLimits/read with an error' }
            : { ok: true, result: message.result })
          return
        }
      }
    })
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'steward', version: '0' } } })
  })
}

/**
 * Reads Codex's usage (ST-32/AC-3), in `readUsage`'s shape (`usage.mjs`), so that `checkUsage`
 * applies the reviewer's limits to it as it does to Claude Code's.
 *
 *   executable  the `codex` executable, `tools.codex.executable` in the machine's settings
 *   cwd         the directory the process runs in
 *   rpc         `({ executable, cwd, timeoutMs })`, resolving `rateLimitsRpc`'s result; injectable
 *   timeoutMs   defaults to `CODEX_USAGE_TIMEOUT_MS`
 *
 * Resolves `{ ok: true, session, weekly }`, each `{ percent, resetsAt }`: `session` from the window
 * whose `windowDurationMins` is 300, `weekly` from the one whose `windowDurationMins` is 10080.
 * Either missing, or a `usedPercent` that is not a finite number, is `{ ok: false, reason }`.
 */
export async function readCodexUsage({ executable, cwd, rpc = rateLimitsRpc, timeoutMs = CODEX_USAGE_TIMEOUT_MS }) {
  if (typeof cwd !== 'string' || cwd === '') throw new Error('readCodexUsage requires a cwd')
  let answer
  try {
    answer = await rpc({ executable, cwd, timeoutMs })
  } catch (error) {
    return { ok: false, reason: `could not read Codex's usage: ${error.message}` }
  }
  if (!answer.ok) return { ok: false, reason: answer.reason }

  const limits = answer.result?.rateLimits
  const windows = [limits?.primary, limits?.secondary].filter((w) => w !== null && typeof w === 'object')
  const found = {}
  for (const [name, minutes] of [['session', SESSION_WINDOW_MINS], ['weekly', WEEKLY_WINDOW_MINS]]) {
    const window = windows.find((w) => w.windowDurationMins === minutes)
    if (!window) return { ok: false, reason: `Codex's rate limits have no ${minutes}-minute (${name}) window` }
    if (typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) {
      return { ok: false, reason: `Codex's ${minutes}-minute window has no numeric usedPercent` }
    }
    found[name] = { percent: window.usedPercent, resetsAt: window.resetsAt }
  }
  return { ok: true, session: found.session, weekly: found.weekly }
}

/** The `codex exec` arguments for a reviewer (ST-32/AC-2); the prompt goes on stdin (`-`). */
export function codexReviewerArgs({ checkout, model, effort, outputFile }) {
  for (const [name, value] of [['checkout', checkout], ['model', model], ['effort', effort], ['outputFile', outputFile]]) {
    if (typeof value !== 'string' || value === '') throw new Error(`codexReviewerArgs requires ${name}`)
  }
  return [
    'exec', '-s', 'read-only', '-C', checkout, '-m', model, '-c', `model_reasoning_effort="${effort}"`,
    '--json', '-o', outputFile, '--ephemeral', '-',
  ]
}

/**
 * Runs one Codex reviewer session (ST-32/AC-2), in `spawnSession`'s result shape, so that
 * `reviewPullRequest` handles it as it handles a Claude one.
 *
 *   executable  the `codex` executable
 *   cwd         the review's checkout; the session runs there and `-C` names it
 *   model, effort  the choice's
 *   prompt      the rendered reviewer prompt, written to stdin
 *   env         the session's environment (`coderEnv`'s: no GitHub credential)
 *   outputFile  where Codex writes its last message: in the review's scratch directory
 *   run         `runSession`; injectable for tests
 *   readText    reads `outputFile`; injectable for tests
 *
 * Resolves `{ classification: { outcome, reason }, output: { result } }`. `completed` means the
 * process exited 0, unstopped, and left a last message; its text is `output.result`.
 */
export async function spawnCodexReviewer({
  executable, cwd, model, effort, prompt, env, outputFile,
  timeoutMs = DEFAULT_TIMEOUT_MS, stallMs = DEFAULT_STALL_MS, run = runSession,
  readText = (file) => readFile(file, 'utf8'),
}) {
  const args = codexReviewerArgs({ checkout: cwd, model, effort, outputFile })
  const { record } = await run({ role: 'reviewer', executable, cwd, args, env, prompt, timeoutMs, stallMs })
  const failed = (outcome, reason) => ({ classification: { outcome, reason }, output: null, record })
  if (record.stoppedFor === 'timeout') return failed('timed-out', 'stopped for exceeding its time limit')
  if (record.stoppedFor === 'stall') return failed('stalled', 'stopped for producing no output within the interval')
  if (record.signal !== null) return failed('died', `terminated by signal ${record.signal}`)
  if (record.exitCode !== 0) return failed('died', `exit code ${record.exitCode}`)
  let text
  try {
    text = await readText(outputFile)
  } catch (error) {
    return failed('malformed-output', `no last message in ${outputFile}: ${error.message}`)
  }
  if (text.trim() === '') return failed('malformed-output', `the last message in ${outputFile} is empty`)
  return { classification: { outcome: 'completed', reason: 'codex exec exited 0 with a last message' }, output: { result: text }, record }
}
