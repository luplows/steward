// The `gh` calls the gate's and the runway's commands (`mark-pending.mjs`, `apply-verdict.mjs`,
// `runway.mjs`) make. Each takes an injectable `run`, so a test replaces the process.

import { execFileSync } from 'node:child_process'

// An unprojected listing of 100 pull requests is about 2 MB, over Node's default 1 MiB.
const MAX_BUFFER = 64 * 1024 * 1024

/** `gh api <args>`: the argument list after `gh api` in, stdout out; throws if `gh` fails. */
export function ghApi(args, run = execFileSync) {
  return run('gh', ['api', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER })
}

/** `gh <args>` for the commands that are not `api`: the argument list in, stdout out. */
export function gh(args, run = execFileSync) {
  return run('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER })
}

/** One JSON value per non-empty line, as `gh api --paginate --jq` prints a projection. */
export function parseNdjson(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}
