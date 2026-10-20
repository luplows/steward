#!/usr/bin/env node
/**
 * Whether the checks a project's `landWhen` setting names are green on a head (ST-24). The pilot,
 * `scripts/dispatch/land.mjs`, and the runway, `.github/workflows/land-approved.yml`, both decide
 * this with `checksGreen`, so they cannot differ. GitHub's `mergeable_state` is no help on a
 * repository without branch protection, where it says nothing about which checks are required.
 *
 * `review/agent` is neither required nor waited for here, whatever `landWhen` says: the pilot and
 * the runway each check it themselves, and it is `pending` while the review that this gate
 * follows is still running.
 *
 * CLI, as the runway calls it: reads one JSON object from standard input,
 * `{ checkRuns, statuses, landWhen, mergeableState }`, and exits 0 printing `ok` when the pull
 * request may be landed on these checks, or exits 1 printing why not. Anything it cannot read exits
 * 2, which the runway also treats as not landable.
 */
import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const LAND_WHEN_ALL = 'all-checks'
/** The status neither read nor required here: see the header. */
export const REVIEW_CONTEXT = 'review/agent'
/** Conclusions of a finished check run that count as green. */
const GREEN_CONCLUSIONS = ['success', 'neutral', 'skipped']
/**
 * `mergeable_state`s in which GitHub would merge a pull request whose named checks are green:
 * `unstable` is a failing or pending check that no rule requires, and `has_hooks` is a merge that
 * only has commit status hooks to run.
 */
export const MERGEABLE_STATES = ['clean', 'unstable', 'has_hooks']

/** Throws unless `landWhen` is `"all-checks"` or a non-empty array of distinct, non-empty strings. */
export function assertLandWhen(landWhen) {
  const list = Array.isArray(landWhen) ? landWhen : null
  const ok =
    landWhen === LAND_WHEN_ALL ||
    (list !== null &&
      list.length > 0 &&
      list.every((name) => typeof name === 'string' && name !== '') &&
      new Set(list).size === list.length)
  if (!ok) {
    throw new Error(
      `landWhen must be "${LAND_WHEN_ALL}" or a non-empty array of distinct, non-empty strings, got ${JSON.stringify(landWhen)}`,
    )
  }
  return landWhen
}

/** The latest of each name: the highest `id`, or the later one in the list where ids are absent. */
function latestByName(items, nameOf) {
  const latest = new Map()
  for (const item of items) {
    const name = nameOf(item)
    const held = latest.get(name)
    const newer = typeof item.id === 'number' && typeof held?.id === 'number' ? item.id >= held.id : true
    if (held === undefined || newer) latest.set(name, item)
  }
  return latest
}

function runState(run) {
  if (run.status !== 'completed') return 'waiting'
  return GREEN_CONCLUSIONS.includes(run.conclusion) ? 'green' : 'failing'
}

function statusState(status) {
  if (status.state === 'success') return 'green'
  return status.state === 'pending' ? 'waiting' : 'failing'
}

/**
 * `checkRuns` are the head's check runs (`{ name, status, conclusion, id }`), `statuses` its commit
 * statuses (`{ context, state, id }`). Returns `{ green: true }`, or `{ green: false, waiting,
 * failing }`: the names not yet finished and the names that failed. A name that is both a check
 * run and a status is green only when both are.
 */
export function checksGreen({ checkRuns, statuses, landWhen }) {
  assertLandWhen(landWhen)
  if (!Array.isArray(checkRuns) || !Array.isArray(statuses)) {
    throw new Error('checkRuns and statuses must each be an array')
  }
  const states = new Map()
  const note = (name, state) => states.set(name, [...(states.get(name) ?? []), state])
  for (const [name, run] of latestByName(checkRuns, (r) => r.name)) note(name, runState(run))
  for (const [name, status] of latestByName(statuses, (s) => s.context)) note(name, statusState(status))
  states.delete(REVIEW_CONTEXT)

  const required = landWhen === LAND_WHEN_ALL ? [...states.keys()] : landWhen.filter((n) => n !== REVIEW_CONTEXT)
  const waiting = []
  const failing = []
  for (const name of required) {
    const own = states.get(name)
    if (own === undefined || (own.includes('waiting') && !own.includes('failing'))) waiting.push(name)
    else if (own.includes('failing')) failing.push(name)
  }
  return waiting.length === 0 && failing.length === 0 ? { green: true } : { green: false, waiting, failing }
}

/**
 * What a `mergeable_state` means once the named checks are green: `landable`, `conflict`,
 * `github-blocked` (GitHub requires something `landWhen` does not name, and would refuse the
 * merge), or `unknown` (GitHub has not finished computing it, or reports a state not listed here).
 */
export function mergeableOutcome(mergeableState) {
  if (mergeableState === 'dirty') return 'conflict'
  if (mergeableState === 'blocked') return 'github-blocked'
  if (MERGEABLE_STATES.includes(mergeableState)) return 'landable'
  return 'unknown'
}

/** The runway's whole decision, in order: a conflict, then the named checks, then GitHub's own state. */
export function runwayDecision({ checkRuns, statuses, landWhen, mergeableState }) {
  if (mergeableOutcome(mergeableState) === 'conflict') return { land: false, reason: `mergeable_state=${mergeableState}, a conflict` }
  const checks = checksGreen({ checkRuns, statuses, landWhen })
  if (!checks.green) {
    return { land: false, reason: `checks not green: waiting [${checks.waiting.join(', ')}], failing [${checks.failing.join(', ')}]` }
  }
  const outcome = mergeableOutcome(mergeableState)
  if (outcome === 'github-blocked') {
    return { land: false, reason: `mergeable_state=${mergeableState} with the checks landWhen names green: GitHub requires something landWhen does not name` }
  }
  if (outcome === 'unknown') return { land: false, reason: `mergeable_state=${mergeableState}, not yet known` }
  return { land: true }
}

async function main() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  let input
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const decision = runwayDecision(input)
    console.log(decision.land ? 'ok' : decision.reason)
    process.exitCode = decision.land ? 0 : 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 2
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main()
}
