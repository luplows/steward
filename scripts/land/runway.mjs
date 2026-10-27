#!/usr/bin/env node
// The runway: lands at most one pull request, run by `land-approved.yml`. It decides
// nothing about review: every condition below was already established by CI and by an independent
// reviewer, and this only notices that they hold, and acts. `docs/agent-workflow-design.md`, "What
// the gate enforces" and "GitHub mechanics", say why each rule is there.
//
// One pull request per run. Given a `PR_INPUT`, only that one is considered, and if it does not land
// the run lands nothing (OQ-93). Given none, oldest first, so a pull request cannot be starved by
// newer ones. GitHub recomputes mergeability asynchronously, so a second merge in the same run would
// be decided on a `mergeable_state` read before the first one landed.
//
// Authorization comes first, before any pull request is looked at (ST-54). Two kinds, from the
// `MODE_INPUT`. Unattended (the default, and what a dispatch naming only a pull request is) is the
// project's standing permission: the runway reads `land` from `steward.config.json` on `main`, and
// merges nothing unless it is exactly `true`, whatever the caller's own settings said. Manual is
// one explicit request by a person with write access: it needs `EVENT_NAME` `workflow_dispatch`, a
// `PR_INPUT`, a full 40-character `HEAD_INPUT`, and an `ACTOR` (from the workflow's event context,
// never an input) whom GitHub says has write, maintain or admin permission on the repository. It
// is valid with either value of `land`, authorizes only that pull request at that head, and never
// falls back to another. It changes only the `land` restriction: every condition below holds in
// both. A missing, malformed or unreadable `land` or `landWhen`, an unknown mode, missing scope, a
// head that is not 40 hex characters or is not the pull request's head, an unqualified actor and an
// unreadable permission each refuse the merge, with the reason in the log and a failed run.
//
// In the order of the workflow this replaced:
//  1. The circuit breaker. Once `BREAKER_LIMIT` open pull requests carry `review-blocked`,
//     something systemic is wrong, and landing more only spreads it. A tripped breaker narrows what
//     may land: a pull request carrying `breaker-override`, or one whose diff is confined to
//     `.github/workflows/`, may still land, or the pull request that fixes the jam would be a trap
//     escapable only by an administrator's merge. Neither exemption bypasses review.
//  2. Which pull requests to try: `select-candidates.mjs`. An invalid `PR_INPUT` throws, and the run
//     fails having merged nothing.
//  3. For each candidate, in order: its author's association (`check-author.mjs`, before the
//     breaker's exemptions, so an outside pull request carrying `breaker-override` is still
//     skipped); `review-blocked`; the breaker; the checks the project's `landWhen` names
//     (`checks-green.mjs`, the function the pilot, `scripts/dispatch/land.mjs`, uses); a direct
//     re-check that `review/agent` is `success` on the head, for the day branch protection lapses
//     (it once silently went missing); then `gh pr merge --squash --match-head-commit`, which
//     refuses the merge if anything was pushed since the checks. Anything that skips a candidate
//     goes on to the next one; a merge ends the run.
//
// `landWhen` is read from the project's `steward.config.json` on `main` through the API, so the
// command needs no checkout of the project.
//
// Usage: steward runway
// Reads GH_TOKEN, REPO (owner/name), MODE_INPUT, PR_INPUT, HEAD_INPUT, EVENT_NAME and ACTOR from the
// environment, as land-approved.yml sets them.

import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isHonouredAuthor } from './check-author.mjs'
import { assertLandWhen, runwayDecision } from './checks-green.mjs'
import { gh, ghApi, parseNdjson } from './gh.mjs'
import { REVIEW_CONTEXT } from './mark-pending.mjs'
import { PR_INPUT_PATTERN, selectCandidates } from './select-candidates.mjs'

export const BREAKER_LIMIT = 5
export const REVIEW_BLOCKED_LABEL = 'review-blocked'
export const BREAKER_OVERRIDE_LABEL = 'breaker-override'
export const WORKFLOWS_DIR = '.github/workflows/'
export const SETTINGS_PATH = 'steward.config.json'
export const BASE_BRANCH = 'main'
export const MODE_UNATTENDED = 'unattended'
export const MODE_MANUAL = 'manual'
/** The collaborator permissions of an actor whose manual request is honoured. */
export const MANUAL_PERMISSIONS = ['admin', 'maintain', 'write']
export const HEAD_PATTERN = /^[0-9a-f]{40}$/
/** A GitHub login: letters, digits and single hyphens, at most 39, so it cannot reshape a request path. */
export const ACTOR_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

const PAGE = 'per_page=100'

const labelNames = (pull) => (pull.labels ?? []).map((label) => label.name)

/** Whether a changed-file list is non-empty and holds nothing outside `.github/workflows/`. */
export function touchesOnlyWorkflows(changedFiles) {
  return changedFiles.length > 0 && changedFiles.every((name) => name.startsWith(WORKFLOWS_DIR))
}

/**
 * Reads `steward.config.json` on `main` and returns `{ land, landWhen }` with `land` checked to be a
 * boolean; `landWhen` is returned as read, for the caller to check. Throws, saying why, when the
 * file cannot be read or parsed, is not an object, or has no boolean `land`.
 */
function readAuthorization(api, repo) {
  let settings
  try {
    settings = JSON.parse(api(['-H', 'Accept: application/vnd.github.raw+json', `repos/${repo}/contents/${SETTINGS_PATH}?ref=${BASE_BRANCH}`]))
  } catch (error) {
    throw new Error(`${SETTINGS_PATH} on ${BASE_BRANCH} cannot be read: ${error.message}`)
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`${SETTINGS_PATH} on ${BASE_BRANCH} is not an object`)
  }
  if (typeof settings.land !== 'boolean') {
    throw new Error(`${SETTINGS_PATH} on ${BASE_BRANCH}: land must be true or false, got ${JSON.stringify(settings.land)}`)
  }
  return { land: settings.land, landWhen: settings.landWhen }
}

/**
 * Decides the authorization (ST-54) from the inputs and the project's `main`, before any pull
 * request is looked at. Returns `{ mode, landWhen }` or `{ refusal }`; the reason names what failed.
 */
function authorize({ repo, modeInput, prInput, headInput, eventName, actor }, api, log) {
  const mode = modeInput === '' ? MODE_UNATTENDED : modeInput
  if (mode !== MODE_UNATTENDED && mode !== MODE_MANUAL) {
    return { refusal: `unknown mode ${JSON.stringify(mode)}; it must be "${MODE_UNATTENDED}" or "${MODE_MANUAL}"` }
  }
  if (mode === MODE_MANUAL) {
    if (eventName !== 'workflow_dispatch') return { refusal: `a manual landing needs a workflow_dispatch event, got ${JSON.stringify(eventName)}` }
    if (!PR_INPUT_PATTERN.test(prInput)) return { refusal: `a manual landing needs one positive pull request number, got ${JSON.stringify(prInput)}` }
    if (!HEAD_PATTERN.test(headInput)) return { refusal: `a manual landing needs a full 40-character head SHA, got ${JSON.stringify(headInput)}` }
    if (!ACTOR_PATTERN.test(actor)) return { refusal: `a manual landing needs a qualified actor from the workflow event, got ${JSON.stringify(actor)}` }
  } else if (headInput !== '') {
    return { refusal: 'an unattended landing takes no head; a head belongs to a manual request, which names its mode' }
  }

  let settings
  try {
    settings = readAuthorization(api, repo)
    assertLandWhen(settings.landWhen)
  } catch (error) {
    return { refusal: error.message }
  }

  if (mode === MODE_UNATTENDED) {
    if (!settings.land) return { refusal: `standing authorization absent: land is false in ${SETTINGS_PATH} on ${BASE_BRANCH}` }
    log(`Standing authorization: land is true in ${SETTINGS_PATH} on ${BASE_BRANCH}.`)
    return { mode, landWhen: settings.landWhen }
  }

  let permission
  try {
    permission = JSON.parse(api([`repos/${repo}/collaborators/${actor}/permission`, '--jq', '.permission | tojson']))
  } catch (error) {
    return { refusal: `the permission of ${actor} on ${repo} cannot be read: ${error.message}` }
  }
  if (!MANUAL_PERMISSIONS.includes(permission)) {
    return { refusal: `${actor} has ${JSON.stringify(permission)} permission on ${repo}; a manual landing needs ${MANUAL_PERMISSIONS.join(', ')}` }
  }
  log(`Manual authorization: ${actor} has ${permission} permission on ${repo}; land is ${settings.land} in ${SETTINGS_PATH} on ${BASE_BRANCH}.`)
  return { mode, landWhen: settings.landWhen }
}

/**
 * Runs the runway. `deps.api` takes the argument list after `gh api` and returns stdout; `deps.merge`
 * takes the argument list after `gh pr merge`; `deps.log` prints a line. `modeInput`,
 * `prInput`, `headInput`, `eventName` and `actor` are the workflow's inputs and event context.
 * Returns `{ landed }`: the number of the pull request merged, or null; with `refused`, the reason,
 * when the authorization (or, for a manual landing, the pull request's head) refuses the merge.
 * Throws on an invalid `prInput` for an unattended landing, or when `gh` fails.
 */
export function runRunway({ repo, prInput = '', modeInput = '', headInput = '', eventName = '', actor = '' }, deps = {}) {
  const api = deps.api ?? ghApi
  const merge = deps.merge ?? ((args) => gh(['pr', 'merge', ...args]))
  const log = deps.log ?? ((line) => console.log(line))

  // Raw values are quoted, so that an input cannot add a line, or a workflow command, to the log.
  const who = `mode=${JSON.stringify(modeInput || MODE_UNATTENDED)} actor=${JSON.stringify(actor)} PR=${JSON.stringify(prInput)} authorized head=${JSON.stringify(headInput)}`
  const refuse = (reason) => {
    log(`::error title=Landing refused::${who}: ${reason}`)
    return { landed: null, refused: reason }
  }
  const authorization = authorize({ repo, modeInput, prInput, headInput, eventName, actor }, api, log)
  if (authorization.refusal) return refuse(authorization.refusal)
  const { mode, landWhen } = authorization
  const manual = mode === MODE_MANUAL
  log(`Landing authorized: ${who}`)

  const blockedPrs = JSON.parse(
    api([
      `repos/${repo}/pulls?state=open&${PAGE}`,
      '--jq',
      `[.[] | select([.labels[].name] | index("${REVIEW_BLOCKED_LABEL}"))] | length`,
    ]),
  )
  const breakerTripped = blockedPrs >= BREAKER_LIMIT
  if (breakerTripped) {
    log(
      `::warning title=Circuit breaker tripped::${blockedPrs} open PRs carry ${REVIEW_BLOCKED_LABEL}; landing only ${BREAKER_OVERRIDE_LABEL} or workflow-only PRs.`,
    )
  }

  const pulls = JSON.parse(
    api([
      `repos/${repo}/pulls?state=open&sort=created&direction=asc&${PAGE}`,
      '--jq',
      '[.[] | {number, draft, base: {ref: .base.ref}}]',
    ]),
  )
  const candidates = selectCandidates(pulls, prInput)
  if (candidates.length === 0) {
    log(`No open non-draft PR against ${BASE_BRANCH} to try.`)
    return { landed: null }
  }

  for (const pr of candidates) {
    const pull = JSON.parse(api([`repos/${repo}/pulls/${pr}`]))
    const sha = pull.head.sha
    if (manual && sha !== headInput) {
      return refuse(`PR #${pr} is at ${sha}, not the authorized head ${headInput}; a new request is needed`)
    }
    const mergeableState = pull.mergeable_state ?? 'unknown'

    // Honoured associations: check-author.mjs's, which apply-verdict.mjs's marker reading shares.
    const association = pull.author_association ?? ''
    if (!isHonouredAuthor(association)) {
      log(`PR #${pr}: opened by an account with association '${association}', not a writer, skipping`)
      continue
    }

    if (labelNames(pull).includes(REVIEW_BLOCKED_LABEL)) {
      log(`PR #${pr}: ${REVIEW_BLOCKED_LABEL}, skipping`)
      continue
    }

    if (breakerTripped) {
      if (labelNames(pull).includes(BREAKER_OVERRIDE_LABEL)) {
        log(`PR #${pr}: breaker tripped, but carries ${BREAKER_OVERRIDE_LABEL}`)
      } else {
        const changed = parseNdjson(api([`repos/${repo}/pulls/${pr}/files?${PAGE}`, '--paginate', '--jq', '.[].filename | tojson']))
        if (touchesOnlyWorkflows(changed)) {
          log(`PR #${pr}: breaker tripped, but touches only ${WORKFLOWS_DIR}`)
        } else {
          log(`PR #${pr}: breaker tripped and no exemption, skipping`)
          continue
        }
      }
    }

    // The checks the project's `landWhen` names, in place of `mergeable_state` `clean`, which says
    // nothing about which checks are required on a repository without branch protection. A
    // conflict, a `blocked` state and an `unknown` one (GitHub has not finished computing it, as
    // straight after a merge) skip too; see checks-green.mjs. Anything it cannot read skips.
    const checkRuns = parseNdjson(
      api([`repos/${repo}/commits/${sha}/check-runs?${PAGE}`, '--paginate', '--jq', '.check_runs[] | {name, status, conclusion, id}']),
    )
    const statuses = parseNdjson(
      api([`repos/${repo}/commits/${sha}/status?${PAGE}`, '--paginate', '--jq', '.statuses[] | {context, state, id}']),
    )
    let decision
    try {
      decision = runwayDecision({ checkRuns, statuses, landWhen, mergeableState })
    } catch (error) {
      decision = { land: false, reason: error.message }
    }
    if (!decision.land) {
      log(`PR #${pr}: not landable on ${sha}: ${decision.reason}, skipping`)
      continue
    }

    // Belt and braces: check `review/agent` directly, in case branch protection has lapsed. It is
    // read from `statuses` above, which has every page of the head's statuses: a read of the
    // first page only would miss a `review/agent` on a later one.
    const verdicts = statuses
      .filter((status) => status.context === REVIEW_CONTEXT)
      .map((status) => status.state)
      .join('\n')
    if (verdicts !== 'success') {
      log(`PR #${pr}: ${REVIEW_CONTEXT}=${verdicts || 'absent'} on ${sha}, skipping`)
      continue
    }

    // --match-head-commit refuses the merge if anything was pushed between the checks above and this
    // call. A push would have reset review/agent to pending anyway; this closes the window rather
    // than trusting it to be narrow.
    log(`Landing PR #${pr}: ${who}, merging at ${sha}`)
    merge([String(pr), '--repo', repo, '--squash', '--match-head-commit', sha])
    log(`::notice title=Landed::PR #${pr} merged at ${sha}`)
    return { landed: pr }
  }

  log('No PR ready to land.')
  return { landed: null }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const repo = process.env.REPO
  if (!repo) {
    console.error('runway needs REPO in the environment')
    process.exitCode = 1
  } else {
    try {
      const result = runRunway({
        repo,
        prInput: process.env.PR_INPUT ?? '',
        modeInput: process.env.MODE_INPUT ?? '',
        headInput: process.env.HEAD_INPUT ?? '',
        eventName: process.env.EVENT_NAME ?? '',
        actor: process.env.ACTOR ?? '',
      })
      if (result.refused) process.exitCode = 1
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  }
}
