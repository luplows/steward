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
// Reads GH_TOKEN, REPO (owner/name) and PR_INPUT from the environment, as land-approved.yml sets them.

import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isHonouredAuthor } from './check-author.mjs'
import { runwayDecision } from './checks-green.mjs'
import { gh, ghApi, parseNdjson } from './gh.mjs'
import { REVIEW_CONTEXT } from './mark-pending.mjs'
import { selectCandidates } from './select-candidates.mjs'

export const BREAKER_LIMIT = 5
export const REVIEW_BLOCKED_LABEL = 'review-blocked'
export const BREAKER_OVERRIDE_LABEL = 'breaker-override'
export const WORKFLOWS_DIR = '.github/workflows/'
export const SETTINGS_PATH = 'steward.config.json'
export const BASE_BRANCH = 'main'

const PAGE = 'per_page=100'

const labelNames = (pull) => (pull.labels ?? []).map((label) => label.name)

/** Whether a changed-file list is non-empty and holds nothing outside `.github/workflows/`. */
export function touchesOnlyWorkflows(changedFiles) {
  return changedFiles.length > 0 && changedFiles.every((name) => name.startsWith(WORKFLOWS_DIR))
}

/**
 * Runs the runway. `deps.api` takes the argument list after `gh api` and returns stdout; `deps.merge`
 * takes the argument list after `gh pr merge`; `deps.log` prints a line. Returns `{ landed }`: the
 * number of the pull request merged, or null. Throws on an invalid `prInput`, or when `gh` fails.
 */
export function runRunway({ repo, prInput = '' }, deps = {}) {
  const api = deps.api ?? ghApi
  const merge = deps.merge ?? ((args) => gh(['pr', 'merge', ...args]))
  const log = deps.log ?? ((line) => console.log(line))

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
    const landWhen = JSON.parse(
      api(['-H', 'Accept: application/vnd.github.raw+json', `repos/${repo}/contents/${SETTINGS_PATH}?ref=${BASE_BRANCH}`]),
    ).landWhen
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
      runRunway({ repo, prInput: process.env.PR_INPUT ?? '' })
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  }
}
