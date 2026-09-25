/**
 * The dependency install both dispatched sessions start from (OQ-78): `npm ci`,
 * which is what CI runs. It is given the environment and directory explicitly
 * and reads neither from the process: the install runs the checked-out
 * `package.json`'s scripts, which are code under review or code the coder is
 * about to write, so it gets the session's credential-free environment, never
 * the dispatcher's own.
 *
 * Resolves on success; rejects with the install's own output on failure.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function installDependencies({ cwd, env }) {
  try {
    // On Windows `npm` is `npm.cmd`, which Node will not spawn without a shell.
    // The command line is fixed, so the shell interpolates nothing.
    await execFileAsync('npm', ['ci'], {
      cwd, env, shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    const output = `${error.stderr ?? ''}${error.stdout ?? ''}`.trim().split(/\r?\n/).slice(-20).join('\n')
    throw new Error(`npm ci failed in ${cwd}: ${error.message}${output ? `\n${output}` : ''}`)
  }
}
