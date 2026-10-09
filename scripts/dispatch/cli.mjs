#!/usr/bin/env node
/**
 * One entry point for every dispatch command (OQ-131), so a project running
 * the workflow as a dependency has a single front door and this repository's
 * own package can point `bin` at it:
 *
 *   node scripts/dispatch/cli.mjs <command> [arguments]
 *
 * Each command is run by starting its module as its own process with the
 * same argv, never by importing and re-driving it -- that is how it ends up
 * with exactly that module's output and exit code, since it *is* that
 * module's `node scripts/dispatch/<module>.mjs ...` invocation, just started
 * from here. Running a module directly still works; this adds a front door,
 * it does not replace the back one.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const DISPATCH_DIR = path.dirname(fileURLToPath(import.meta.url))
const SCRIPTS_DIR = path.resolve(DISPATCH_DIR, '..')

export const COMMANDS = {
  loop: path.join(DISPATCH_DIR, 'loop.mjs'),
  story: path.join(DISPATCH_DIR, 'story.mjs'),
  coder: path.join(DISPATCH_DIR, 'coder.mjs'),
  review: path.join(DISPATCH_DIR, 'review.mjs'),
  land: path.join(DISPATCH_DIR, 'land.mjs'),
  queue: path.join(DISPATCH_DIR, 'queue.mjs'),
  lint: path.join(SCRIPTS_DIR, 'lint-stories.mjs'),
  verdicts: path.join(SCRIPTS_DIR, 'report', 'review-verdicts.mjs'),
}

function usage() {
  return `usage: node scripts/dispatch/cli.mjs <command> [arguments]\n\ncommands: ${Object.keys(COMMANDS).join(', ')}`
}

export function main(argv) {
  const [command, ...rest] = argv
  const modulePath = COMMANDS[command]
  if (!modulePath) {
    console.error(usage())
    process.exitCode = 1
    return
  }
  const result = spawnSync(process.execPath, [modulePath, ...rest], { stdio: 'inherit' })
  process.exitCode = result.status === null ? 1 : result.status
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2))
}
