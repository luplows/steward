#!/usr/bin/env node
/**
 * Checks steward's no-AI-attribution rule (ST-100; `AGENTS.md`, "Every pull request") on a pull
 * request: no commit in its range, base to head, has a `Co-Authored-By:` trailer, and its body has
 * no "Generated with" line. Commits already on `main` are outside the range and are not checked.
 *
 * What counts as a trailer is git's trailer parsing, not a text search: a commit is a finding when
 * `git log -1 --format=%(trailers:key=Co-Authored-By,unfold)` returns a line for it, whatever its
 * value (the same parsing as `git interpret-trailers --parse`). Examples run through that command:
 * a final-paragraph `Co-Authored-By:` with an empty value is a trailer; one beside a
 * `Signed-off-by:` line after a line of prose is a trailer; one on a line of its own in an earlier
 * paragraph, or one of five lines in a final paragraph of prose, is not. A merge commit in the range
 * is checked on its own message like any other.
 *
 * A "Generated with" line is a line of the body whose first letter begins the words "Generated
 * with", after any leading marks such as a bullet or the robot emoji Claude Code writes.
 * The `Coder:` line is neither and is never a finding.
 *
 * CI runs this on the events that start a run of `ci.yml` for a pull request (opened, a push to it,
 * reopened); editing only the body afterwards starts none, so an edited body is checked on the next
 * such run. The body is attacker-chosen text: the CLI takes it from the environment variable
 * `STEWARD_PR_BODY` (`ci.yml` sets it), never from an argument or an interpolated command.
 *
 * Usage:
 *   STEWARD_PR_BODY=<body> node scripts/dispatch/attribution-check.mjs <base-sha> <head-sha>
 *
 * Run from a checkout where both commits are reachable (`ci.yml` fetches full history). Exit code 0
 * when nothing was found; 1 otherwise, with each finding printed.
 */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const generatedWithRe = /^[^\p{L}\p{N}]*generated with\b/iu

/** Lines of `body` that are a "Generated with" line, as `{ line, text }` with 1-based lines. */
export function generatedWithLines(body) {
  const found = []
  body.split(/\r?\n/).forEach((text, index) => {
    if (generatedWithRe.test(text)) found.push({ line: index + 1, text: text.trim() })
  })
  return found
}

const git = async (cwd, ...args) =>
  (await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout

/**
 * Returns `{ ok: true }` or `{ ok: false, findings }`, each finding a string naming the commit or
 * the body. `body` is the pull request's body, as data.
 */
export async function checkAttribution({ cwd, base, head, body }) {
  const findings = []
  const shas = (await git(cwd, 'rev-list', `${base}..${head}`)).split('\n').filter(Boolean)
  for (const sha of shas) {
    const trailers = (
      await git(cwd, 'log', '-1', '--format=%(trailers:key=Co-Authored-By,unfold)', sha)
    )
      .split('\n')
      .filter((line) => line.trim() !== '')
    for (const trailer of trailers) {
      findings.push(`commit ${sha.slice(0, 12)}: has a Co-Authored-By: trailer (${trailer.trim()})`)
    }
  }
  for (const { line, text } of generatedWithLines(body)) {
    findings.push(`pull request body, line ${line}: a "Generated with" line (${text})`)
  }
  return findings.length ? { ok: false, findings } : { ok: true }
}

// --------------------------------------------------------------------- CLI

async function main(argv, env) {
  const [base, head] = argv
  if (!base || !head) {
    throw new Error('usage: STEWARD_PR_BODY=<body> node scripts/dispatch/attribution-check.mjs <base-sha> <head-sha>')
  }
  if (env.STEWARD_PR_BODY === undefined) {
    throw new Error('STEWARD_PR_BODY is not set: the pull request body must reach this check')
  }
  const result = await checkAttribution({ cwd: process.cwd(), base, head, body: env.STEWARD_PR_BODY })
  if (!result.ok) {
    for (const finding of result.findings) console.error(finding)
    console.error('No AI attribution: see AGENTS.md, "Every pull request".')
    process.exitCode = 1
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).catch((error) => {
    console.error(error.stack || error.message)
    process.exitCode = 1
  })
}
