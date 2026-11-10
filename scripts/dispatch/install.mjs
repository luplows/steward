/**
 * The project's `setup` command, which prepares a fresh checkout for a coder session (ST-7). It is
 * given the environment and directory explicitly and reads neither from the process: the command
 * runs the checked-out project's own scripts (for `npm ci`, its `package.json` lifecycle scripts),
 * which are code under review or code the coder is about to write, so it gets the session's
 * credential-free environment, never the dispatcher's own.
 *
 * `setup` is the project's setting (`settings.mjs`): `null`, or `{ command, timeoutMinutes }`.
 * `null` runs nothing. The command is run through the platform's shell, as one string with no
 * argument array (an array beside `shell: true` is Node's DEP0190). A command still running after
 * its time limit is stopped with its whole process tree (`killTree`, as `spawn.mjs` stops a
 * session) and the install rejects.
 *
 * Resolves on success; rejects with the last lines of the command's output when it fails, and
 * with the limit it overran when it was stopped.
 */
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { killTree } from './spawn.mjs'

const MINUTE_MS = 60_000
const OUTPUT_LINES = 20
// Output is kept as the last 65536 characters (UTF-16 code units, not bytes): enough to hold the
// last lines of a noisy command without keeping all of its output.
const OUTPUT_KEEP = 64 * 1024
// The longest delay `setTimeout` honours; a longer one is clamped to 1 ms. A limit beyond it is
// waited out in steps of at most this long.
const MAX_TIMER_MS = 2 ** 31 - 1

/**
 *   cwd, env     where the command runs and the environment it gets
 *   setup        the project's `setup` setting
 *   timeoutMs    replaces the limit taken from `setup.timeoutMinutes`; for tests
 *   spawnFn      `child_process.spawn`; injectable for tests. It also starts `taskkill` on Windows
 *   platform     `process.platform`; injectable for tests
 */
export async function installDependencies({
  cwd, env, setup, timeoutMs, spawnFn = spawn, platform = process.platform,
}) {
  if (setup === null || setup === undefined) return
  const { command, timeoutMinutes } = setup
  const limitMs = timeoutMs ?? timeoutMinutes * MINUTE_MS
  const limit = timeoutMs === undefined
    ? `${timeoutMinutes} minute${timeoutMinutes === 1 ? '' : 's'}`
    : `${timeoutMs} ms`

  await new Promise((resolve, reject) => {
    let output = ''
    let settled = false
    let timer
    let stopped = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const fail = (message) => {
      const tail = output.trim().split(/\r?\n/).slice(-OUTPUT_LINES).join('\n')
      settle(reject, new Error(`setup failed in ${cwd}: ${message}${tail ? `\n${tail}` : ''}`))
    }

    let child
    try {
      // The command is one string: the shell interprets it, and no argument array goes beside
      // `shell: true`. Off Windows the child leads its own process group, so `killTree` can stop
      // the group; on Windows `detached` would mean a new console.
      child = spawnFn(command, {
        cwd, env, shell: true, windowsHide: true, detached: platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      fail(error.message)
      return
    }

    // One decoder per stream, so a character split across two chunks is decoded whole.
    const collectFrom = (stream) => {
      const decoder = new StringDecoder('utf8')
      stream?.on('data', (chunk) => {
        const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
        output = (output + text).slice(-OUTPUT_KEEP)
      })
    }
    collectFrom(child.stdout)
    collectFrom(child.stderr)

    const stop = () => {
      stopped = true
      // A timeout that leaves a process running is a leak, not a timeout: reject once the kill
      // has been carried out.
      killTree(child, spawnFn).then(() => {
        if (!settled) fail(`\`${command}\` was stopped after its limit of ${limit}`)
      })
    }
    // A limit longer than `setTimeout` can hold is waited out in steps, so it is never cut short.
    const arm = (remainingMs) => {
      const step = Math.min(remainingMs, MAX_TIMER_MS)
      timer = setTimeout(() => (remainingMs > step ? arm(remainingMs - step) : stop()), step)
    }
    arm(limitMs)

    child.on('error', (error) => fail(error.message))
    child.on('close', (code, signal) => {
      // Once stopped at the limit, the rejection below names the limit, not the kill.
      if (stopped) return
      if (code === 0) settle(resolve)
      else fail(signal ? `\`${command}\` was ended by ${signal}` : `\`${command}\` exited ${code}`)
    })
  })
}
