#!/usr/bin/env node
// Reads a review marker out of a pull request comment and sets `review/agent` from it: the gate's
// second step, run by `review-gate.yml`'s `verdict` job for every comment that carries
// `<!-- agent-review`. See `docs/agent-workflow-design.md`, "What the gate enforces".
//
//  - Only a comment from an honoured author (`check-author.mjs`) counts: anyone can comment on a
//    public repository, so an unprivileged marker must not be able to clear the gate.
//  - The last well-formed marker in the comment wins (`github.mjs`'s `parseMarkerComment`, the
//    parser the dispatcher counts rounds with), so a corrected verdict supersedes an earlier one in
//    the same comment. A marker is well-formed only on one line, with a full 40-character head.
//  - A marker about a commit that is no longer the pull request's head is stale and changes
//    nothing: a verdict about an older commit says nothing about this one.
//  - `pass` and `pass-with-observations` set `success`; only `block` sets `failure`. `fail` is the
//    deprecated spelling of `block`, still honoured because a marker the gate does not recognise is
//    ignored, which would leave a pull request pending forever with a valid-looking verdict on it.
//  - After a `failure` the command exits non-zero. The status is already set, so the gate does not
//    depend on it: failing the run is how the block gets noticed, since GitHub's Actions failure
//    notifications fire on a failed run.
//
// Usage: steward apply-verdict
// Reads GH_TOKEN, REPO (owner/name), PR (number), BODY, ASSOC and COMMENT_URL from the environment,
// as review-gate.yml sets them. The comment's fields arrive through the environment and are never
// interpolated into a shell script: on a public repository a comment is attacker-controlled.

import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseMarkerComment } from '../dispatch/github.mjs'
import { isHonouredAuthor } from './check-author.mjs'
import { ghApi } from './gh.mjs'
import { REVIEW_CONTEXT } from './mark-pending.mjs'

const STATUSES = {
  pass: { state: 'success', description: 'Agent review passed' },
  'pass-with-observations': { state: 'success', description: 'Agent review passed with observations' },
  block: { state: 'failure', description: 'Agent review found blocking items' },
}

/**
 * Applies the verdict. Returns `{ outcome, state?, head?, messages }`, `outcome` being
 * `ignored-author`, `no-marker`, `stale` or `posted`; `messages` are the workflow annotations to
 * print. `api` takes the argument list after `gh api` and returns stdout, or throws.
 */
export function applyVerdict({ repo, pr, body, assoc, commentUrl }, api = ghApi) {
  if (!isHonouredAuthor(assoc)) {
    return {
      outcome: 'ignored-author',
      messages: [`::notice title=Marker ignored::Author association '${assoc}' lacks write access; status untouched.`],
    }
  }

  const marker = parseMarkerComment(body)
  if (marker.kind !== 'marker') {
    return {
      outcome: 'no-marker',
      messages: [
        '::notice title=Marker ignored::No well-formed marker (needs a full 40-char head sha and verdict=pass|pass-with-observations|block).',
      ],
    }
  }

  const head = api([`repos/${repo}/pulls/${pr}`, '--jq', '.head.sha']).trim()
  if (marker.headSha !== head) {
    return {
      outcome: 'stale',
      messages: [`::notice title=Stale marker::Marker targets ${marker.headSha} but head is ${head}; status left as it is.`],
    }
  }

  const { state, description } = STATUSES[marker.verdict]
  api([
    '-X',
    'POST',
    `repos/${repo}/statuses/${head}`,
    '-f',
    `state=${state}`,
    '-f',
    `context=${REVIEW_CONTEXT}`,
    '-f',
    `description=${description}`,
    '-f',
    `target_url=${commentUrl}`,
  ])
  const messages = [`${REVIEW_CONTEXT} set ${state} on ${head}`]
  if (state === 'failure') {
    messages.push(`::error title=Review blocked::Agent review found blocking items on ${head}. See ${commentUrl}`)
  }
  return { outcome: 'posted', state, head, messages }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const { REPO: repo, PR: pr, BODY: body = '', ASSOC: assoc = '', COMMENT_URL: commentUrl = '' } = process.env
  if (!repo || !pr) {
    console.error('apply-verdict needs REPO and PR in the environment')
    process.exitCode = 1
  } else {
    try {
      const result = applyVerdict({ repo, pr, body, assoc, commentUrl })
      for (const message of result.messages) console.log(message)
      if (result.state === 'failure') process.exitCode = 1
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  }
}
