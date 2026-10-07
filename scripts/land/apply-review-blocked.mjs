#!/usr/bin/env node
// Applies `review-blocked` once a pull request's blocking verdict markers reach the round
// bound (OQ-80's AC-1), so land-approved.yml's circuit breaker counts a signal
// review-gate.yml produces on every pull request -- including one no dispatcher ran --
// rather than one applied only when somebody remembers.
//
// Runs from review-gate.yml's "verdict" job, after every marker-bearing comment. It
// recomputes from every comment on the pull request, not only the one that triggered this
// run: REVIEW.md ("the block still counts toward the round bound like any other") counts a
// well-formed `block` (or the deprecated `fail`) from a write-access author on any head, so
// a round can complete without the triggering comment itself being the third.
//
// `isHonouredAuthor` comes from `check-author.mjs`, already kept identical to
// review-gate.yml's `case` by a test there. The marker pattern below is the same
// transcription `github.mjs`'s `WELL_FORMED_RE` keeps of that step's grep; a test here
// checks it against the workflow too.
//
// The label is applied once and never removed or reapplied (AC-2): a pull request that
// already carries it is left exactly as it is, and nothing here ever calls the
// labels-removal endpoint.
//
// Usage: node scripts/land/apply-review-blocked.mjs
// Reads GH_TOKEN, REPO (owner/name) and PR (number) from the environment, as
// review-gate.yml sets them.

import { execFileSync } from 'node:child_process'
import { isHonouredAuthor } from './check-author.mjs'

export const ROUND_BOUND = 3 // OQ-48's AC-3 sets this; restated here and must not drift from it.
export const REVIEW_BLOCKED_LABEL = 'review-blocked'

// Transcribes the "Apply verdict from marker" step's grep: a well-formed marker lies on one
// line, and the last one in a comment wins.
const MARKER_RE =
  /<!--[^\S\n]*agent-review[^\S\n]+head=[0-9a-f]{40}[^\S\n]+verdict=(pass-with-observations|pass|block|fail)[^\S\n]*-->/g

function lastVerdict(body) {
  const matches = [...(body ?? '').matchAll(MARKER_RE)]
  return matches.length === 0 ? null : matches[matches.length - 1][1]
}

/** How many comments carry a well-formed blocking verdict from an honoured author (AC-3). */
export function countBlockingVerdicts(comments) {
  return comments.filter((c) => {
    if (!isHonouredAuthor(c.authorAssociation)) return false
    const verdict = lastVerdict(c.body)
    return verdict === 'block' || verdict === 'fail'
  }).length
}

/** Whether to apply the label: at the bound, and only if it is not already there (AC-1, AC-2). */
export function decideReviewBlocked({ comments, labels }) {
  if (labels.includes(REVIEW_BLOCKED_LABEL)) return { apply: false, reason: 'already-applied', count: null }
  const count = countBlockingVerdicts(comments)
  if (count < ROUND_BOUND) return { apply: false, reason: 'below-bound', count }
  return { apply: true, reason: 'bound-reached', count }
}

export function ghApi(args, run = execFileSync) {
  return run('gh', ['api', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
}

function parseNdjson(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

/**
 * Reads the pull request's comments and labels, decides, and applies the label if the
 * decision says to. `api` is injectable for tests; it takes the argument list after `gh api`
 * and returns stdout, or throws.
 */
export function applyReviewBlocked(repo, pr, api = ghApi) {
  const comments = parseNdjson(
    api([
      `repos/${repo}/issues/${pr}/comments`,
      '--paginate',
      '--jq',
      '.[] | {body: .body, authorAssociation: .author_association}',
    ]),
  )
  const labels = JSON.parse(api([`repos/${repo}/issues/${pr}/labels`, '--jq', '[.[].name]']))
  const decision = decideReviewBlocked({ comments, labels })
  if (decision.apply) api(['-X', 'POST', `repos/${repo}/issues/${pr}/labels`, '-f', `labels[]=${REVIEW_BLOCKED_LABEL}`])
  return decision
}

if (process.argv[1]?.endsWith('apply-review-blocked.mjs')) {
  const repo = process.env.REPO
  const pr = process.env.PR
  if (!repo || !pr) {
    console.log('::warning title=review-blocked check skipped::REPO or PR is not set')
  } else {
    const decision = applyReviewBlocked(repo, pr)
    console.log(
      decision.apply
        ? `review-blocked applied: ${decision.count} blocking verdicts recorded`
        : `review-blocked not applied (${decision.reason}${decision.count === null ? '' : `: ${decision.count}`})`,
    )
  }
}
