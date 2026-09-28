/**
 * Helper for the jobs the reviewer's refused shell forms were doing (OQ-92):
 * a command repeated N times, a command's exit code, and a command's sorted
 * output. Run as `node scripts/dispatch/review-tools.mjs <subcommand> -- <command...>`.
 *
 *   repeat <n> -- <command...>       run n times (1 to 10); print each exit code,
 *                                    "<passed>/<n> exited 0", and the tail of any failing run
 *   exit -- <command...>             run once; print its output, then its exit code
 *   sorted [--unique] -- <command...> run once; print its output lines sorted, then its exit code
 *
 * The helper can do nothing the reviewer's allowlist cannot: a command runs
 * only if it matches a `Bash(<prefix>:*)` entry of `reviewerAllowedTools()`
 * and is not `node`. It starts the command with `execFile`, never a shell, so
 * `|`, `;`, `&&` and `>` in arguments are literal. It writes no file. It exits
 * 0 whenever it ran the command, whatever the command's own exit code; a
 * refusal or bad usage exits 2 and starts nothing.
 */

import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { reviewerAllowedTools } from './invocation.mjs'

export const MAX_REPEAT = 10
const TAIL_LINES = 20

export class Refusal extends Error {}

/** The command prefixes of the reviewer's `Bash(<prefix>:*)` entries, without `node`. */
export function allowedPrefixes() {
  const prefixes = []
  for (const entry of reviewerAllowedTools()) {
    const m = /^Bash\((.+):\*\)$/.exec(entry)
    if (m && m[1] !== 'node') prefixes.push(m[1])
  }
  return prefixes
}

/**
 * The program and arguments to start for `argv`, or a thrown `Refusal`. On
 * Windows `npm` and `npx` are started as `execPath` running npm's own CLI
 * script, because `execFile` cannot start the shell script or `.cmd` there.
 */
export function resolveCommand(argv, {
  platform = process.platform,
  execPath = process.execPath,
  exists = existsSync,
} = {}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Refusal('no command given after --')
  const line = argv.join(' ')
  const allowed = allowedPrefixes().some((p) => line === p || line.startsWith(`${p} `))
  if (!allowed) throw new Refusal(`refused: "${argv[0]}" is not an allowed reviewer command: ${line}`)

  const [program, ...rest] = argv
  if (platform === 'win32' && (program === 'npm' || program === 'npx')) {
    const script = path.win32.join(path.win32.dirname(execPath), 'node_modules', 'npm', 'bin', `${program}-cli.js`)
    if (!exists(script)) throw new Refusal(`refused: cannot start ${program} on Windows, ${script} is missing`)
    return { file: execPath, args: [script, ...rest] }
  }
  return { file: program, args: rest }
}

/** Default starter: `execFile`, no shell. Resolves `{ code, output }`, never rejects. */
export function startProcess(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const output = `${stdout ?? ''}${stderr ?? ''}`
      if (!err) return resolve({ code: 0, output })
      if (typeof err.code === 'number') return resolve({ code: err.code, output })
      resolve({ code: 1, output: `${output}${err.message}\n` })
    })
  })
}

const lines = (text) => text.split(/\r?\n/).filter((l, i, all) => l !== '' || i < all.length - 1)

export async function repeat(n, argv, { start = startProcess, ...env } = {}) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_REPEAT) {
    throw new Refusal(`refused: repeat count must be an integer from 1 to ${MAX_REPEAT}, got ${n}`)
  }
  const { file, args } = resolveCommand(argv, env)
  const out = []
  let passed = 0
  for (let i = 1; i <= n; i++) {
    const { code, output } = await start(file, args)
    out.push(`run ${i}: exit ${code}`)
    if (code === 0) passed++
    else out.push(...lines(output).slice(-TAIL_LINES).map((l) => `  | ${l}`))
  }
  out.push(`${passed}/${n} exited 0`)
  return out.join('\n') + '\n'
}

export async function exit(argv, { start = startProcess, ...env } = {}) {
  const { file, args } = resolveCommand(argv, env)
  const { code, output } = await start(file, args)
  return `${output}${output === '' || output.endsWith('\n') ? '' : '\n'}exit code: ${code}\n`
}

export async function sorted(argv, { unique = false, start = startProcess, ...env } = {}) {
  const { file, args } = resolveCommand(argv, env)
  const { code, output } = await start(file, args)
  let sortedLines = lines(output).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (unique) sortedLines = [...new Set(sortedLines)]
  return `${sortedLines.map((l) => `${l}\n`).join('')}exit code: ${code}\n`
}

const USAGE = [
  'usage: node scripts/dispatch/review-tools.mjs repeat <n> -- <command...>',
  '       node scripts/dispatch/review-tools.mjs exit -- <command...>',
  '       node scripts/dispatch/review-tools.mjs sorted [--unique] -- <command...>',
].join('\n')

/** Runs the CLI for `argv` (without node and the script). Resolves `{ code, stdout, stderr }`. */
export async function main(argv, env = {}) {
  const sep = argv.indexOf('--')
  const head = sep === -1 ? argv : argv.slice(0, sep)
  const command = sep === -1 ? [] : argv.slice(sep + 1)
  const [sub, ...flags] = head
  try {
    if (sep === -1) throw new Refusal(`missing "--" before the command\n${USAGE}`)
    if (sub === 'repeat') {
      if (flags.length !== 1 || !/^-?\d+$/.test(flags[0])) throw new Refusal(`repeat takes one count\n${USAGE}`)
      return { code: 0, stdout: await repeat(Number(flags[0]), command, env), stderr: '' }
    }
    if (sub === 'exit') {
      if (flags.length) throw new Refusal(`exit takes no flags\n${USAGE}`)
      return { code: 0, stdout: await exit(command, env), stderr: '' }
    }
    if (sub === 'sorted') {
      if (flags.some((f) => f !== '--unique')) throw new Refusal(`sorted takes only --unique\n${USAGE}`)
      return { code: 0, stdout: await sorted(command, { ...env, unique: flags.includes('--unique') }), stderr: '' }
    }
    throw new Refusal(`unknown subcommand ${JSON.stringify(sub)}\n${USAGE}`)
  } catch (err) {
    if (err instanceof Refusal) return { code: 2, stdout: '', stderr: `${err.message}\n` }
    throw err
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const { code, stdout, stderr } = await main(process.argv.slice(2))
  process.stdout.write(stdout)
  process.stderr.write(stderr)
  process.exitCode = code
}
