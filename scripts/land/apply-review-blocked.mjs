#!/usr/bin/env node
// Applies `review-blocked` once a pull request's blocking verdict markers reach the round
// bound (OQ-80's AC-1), so land-approved.yml's circuit breaker counts a signal
// review-gate.yml produces on every pull request -- including one no dispatcher ran --
// rather than one applied only when somebody remembers.
//
// Runs from review-gate.yml's "verdict" job, after every marker-bearing comment. It
// recomputes from every comment on the pull request, not only the one that triggered this
// run: the design doc's "What the gate enforces" ("the block still counts toward the round
// bound like any other") counts a well-formed `block` (or the deprecated `fail`) from a
// write-access author on any head, so a round can complete without the triggering comment
// itself being the third.
//
// `isHonouredAuthor` comes from `check-author.mjs`, already kept identical to
// review-gate.yml's `case` by a test there. Markers are read with `github.mjs`'s
// `parseMarkerComment`, the parser `story.mjs` counts rounds with, so the two cannot disagree
// about which comments are blocks; a test here checks the marker pattern against the workflow.
//
// This module never removes the label (OQ-80's AC-2): a pull request that already carries it
// is left exactly as it is, and nothing here ever calls the labels-removal endpoint. A member
// of the crew removing it by hand means "I have seen the cost, proceed" (ST-16), so once it
// has been removed, only blocks recorded after the latest removal count towards applying it
// again; the removals are read from the pull request's `unlabeled` events.
//
// Usage: node scripts/land/apply-review-blocked.mjs
// Reads GH_TOKEN, REPO (owner/name) and PR (number) from the environment, as
// review-gate.yml sets them.

import { execFileSync } from 'node:child_process'
import { isHonouredAuthor } from './check-author.mjs'
import { parseMarkerComment } from '../dispatch/github.mjs'

export const ROUND_BOUND = 3 // OQ-48's AC-3 sets this; restated here and must not drift from it.
export const REVIEW_BLOCKED_LABEL = 'review-blocked'

/**
 * When the label was last removed: the latest `createdAt` among `events` (ST-16's AC-1), as
 * milliseconds, or null if it never was. `events` are the pull request's `unlabeled` events for
 * this label, each `{createdAt}`.
 */
export function latestRemoval(events) {
  const times = events.map((e) => Date.parse(e.createdAt)).filter((t) => !Number.isNaN(t))
  return times.length === 0 ? null : Math.max(...times)
}

/**
 * How many comments carry a well-formed blocking verdict from an honoured author (AC-3). With a
 * `since` (milliseconds), only comments created strictly later count (ST-16's AC-1).
 */
export function countBlockingVerdicts(comments, since = null) {
  return comments.filter((c) => {
    if (since !== null && !(Date.parse(c.createdAt) > since)) return false
    if (!isHonouredAuthor(c.authorAssociation)) return false
    const marker = parseMarkerComment(c.body)
    return marker.kind === 'marker' && marker.verdict === 'block'
  }).length
}

/**
 * Whether to apply the label: at the bound, counting only blocks recorded since the latest
 * removal of it, and only if it is not already there (OQ-80's AC-1, AC-2; ST-16's AC-1).
 */
export function decideReviewBlocked({ comments, labels, events = [] }) {
  if (labels.includes(REVIEW_BLOCKED_LABEL)) return { apply: false, reason: 'already-applied', count: null }
  const count = countBlockingVerdicts(comments, latestRemoval(events))
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
 * Reads the pull request's comments, labels and events, decides, and applies the label if the
 * decision says to. `api` is injectable for tests; it takes the argument list after `gh api`
 * and returns stdout, or throws.
 */
export function applyReviewBlocked(repo, pr, api = ghApi) {
  const comments = parseNdjson(
    api([
      `repos/${repo}/issues/${pr}/comments`,
      '--paginate',
      '--jq',
      '.[] | {body: .body, authorAssociation: .author_association, createdAt: .created_at}',
    ]),
  )
  const events = parseNdjson(
    api([
      `repos/${repo}/issues/${pr}/events`,
      '--paginate',
      '--jq',
      `.[] | select(.event == "unlabeled" and .label.name == "${REVIEW_BLOCKED_LABEL}") | {createdAt: .created_at}`,
    ]),
  )
  const labels = JSON.parse(api([`repos/${repo}/issues/${pr}/labels`, '--jq', '[.[].name]']))
  const decision = decideReviewBlocked({ comments, labels, events })
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
