/**
 * Reads the plan's usage before a coder or a reviewer session starts, and says
 * whether the role may start one (ST-31). Claude Code reports the usage with
 * no model call: `claude -p /usage --output-format stream-json --verbose`
 * emits a message carrying `usage_report.rate_limits.limits`, one row per
 * window (`docs/agent-workflow-design.md`, "Trials and measurements",
 * "Reading the plan's usage from a script").
 *
 * The process is started directly, never through a shell, so the `/usage`
 * argument is not rewritten into a path. Of what the report holds, only each
 * window's `percent` and `resetsAt` leave this module.
 *
 * `readUsage` never throws on a bad report: every way the usage cannot be
 * read is `{ ok: false, reason }`, and `checkUsage` turns that into a refusal
 * to start anything.
 */
import { execFile } from 'node:child_process'
import { resolveClaudeExecutable } from './spawn.mjs'

export const USAGE_ARGS = ['-p', '/usage', '--output-format', 'stream-json', '--verbose']
export const USAGE_TIMEOUT_MS = 30 * 1000

/** The default process runner: `{ exitCode, stdout, timedOut }`, never rejecting. */
export function runUsageProcess({ executable, args, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      { cwd, shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (!error) {
          resolve({ exitCode: 0, stdout, timedOut: false })
          return
        }
        resolve({
          exitCode: typeof error.code === 'number' ? error.code : null,
          stdout: stdout ?? '',
          timedOut: error.killed === true,
        })
      },
    )
  })
}

/** The `usage_report` of the first stream message that carries one, or null. */
function findUsageReport(stdout) {
  for (const line of stdout.split('\n')) {
    const text = line.trim()
    if (!text.startsWith('{')) continue
    let message
    try {
      message = JSON.parse(text)
    } catch {
      continue
    }
    const report = message?.usage_report ?? message?.message?.usage_report
    if (report !== undefined && report !== null) return report
  }
  return null
}

function windowFrom(row) {
  return { percent: row.percent, resetsAt: row.resets_at }
}

/**
 * Reads the plan's usage.
 *
 *   cwd         the directory the process runs in; required
 *   executable  defaults to `resolveClaudeExecutable()`
 *   run         `({ executable, args, cwd, timeoutMs })` resolving
 *               `{ exitCode, stdout, timedOut }`; injectable for tests
 *   timeoutMs   defaults to `USAGE_TIMEOUT_MS`
 *
 * Resolves `{ ok: true, session, weekly }`, each `{ percent, resetsAt }`:
 * `session` from the row whose `kind` is `session`, `weekly` from the row with
 * the highest `percent` among those whose `group` is `weekly`. Resolves
 * `{ ok: false, reason }` otherwise.
 */
export async function readUsage({ cwd, executable, run = runUsageProcess, timeoutMs = USAGE_TIMEOUT_MS }) {
  if (typeof cwd !== 'string' || cwd === '') throw new Error('readUsage requires a cwd')
  let result
  try {
    result = await run({ executable: executable ?? resolveClaudeExecutable(), args: USAGE_ARGS, cwd, timeoutMs })
  } catch (error) {
    return { ok: false, reason: `could not run /usage: ${error.message}` }
  }
  if (result.timedOut) return { ok: false, reason: `/usage timed out after ${timeoutMs / 1000} seconds` }
  if (result.exitCode !== 0) return { ok: false, reason: `/usage exited with code ${result.exitCode}` }

  const report = findUsageReport(result.stdout ?? '')
  if (report === null) return { ok: false, reason: 'no message of the /usage output carries usage_report' }
  const limits = report.rate_limits?.limits
  if (!Array.isArray(limits)) return { ok: false, reason: 'usage_report carries no rate_limits' }

  const session = limits.find((row) => row?.kind === 'session')
  const weeklyRows = limits.filter((row) => row?.group === 'weekly')
  if (!session) return { ok: false, reason: 'usage_report has no session row' }
  if (weeklyRows.length === 0) return { ok: false, reason: 'usage_report has no weekly row' }
  const weekly = weeklyRows.reduce((top, row) => (row.percent > top.percent ? row : top))
  return { ok: true, session: windowFrom(session), weekly: windowFrom(weekly) }
}

/**
 * The refusal a role gets, or null when it may start a session. `limits` is
 * the role's `{ session, weekly }` from the settings' `usageLimits`; `read` is
 * `readUsage`'s shape of call. The first window at or over its limit is named,
 * `session` before `weekly`. `extra` (a story's id) is added to the status.
 */
export async function checkUsage({ read, cwd, limits, extra = {} }) {
  const usage = await read({ cwd })
  if (!usage.ok) return { status: 'usage-unknown', ...extra, reason: usage.reason }
  for (const window of ['session', 'weekly']) {
    const { percent, resetsAt } = usage[window]
    if (percent >= limits[window]) {
      return { status: 'over-usage', ...extra, window, percent, limit: limits[window], resetsAt }
    }
  }
  return null
}
