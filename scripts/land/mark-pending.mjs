#!/usr/bin/env node
// Sets `review/agent` pending on a pull request's head commit: the gate's first step, run by
// `review-gate.yml`'s `pending` job whenever a pull request opens or gets a new commit. A new head
// commit always returns the gate to pending, so a verdict cannot outlive the commit it was about
// (`docs/agent-workflow-design.md`, "What the gate enforces").
//
// Usage: steward mark-pending
// Reads GH_TOKEN, REPO (owner/name) and SHA (the head commit) from the environment, as
// review-gate.yml sets them.

import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ghApi } from './gh.mjs'

export const REVIEW_CONTEXT = 'review/agent'
export const PENDING_DESCRIPTION = 'Awaiting agent review'

/** Posts the pending status. `api` takes the argument list after `gh api` and returns stdout. */
export function markPending(repo, sha, api = ghApi) {
  api([
    '-X',
    'POST',
    `repos/${repo}/statuses/${sha}`,
    '-f',
    'state=pending',
    '-f',
    `context=${REVIEW_CONTEXT}`,
    '-f',
    `description=${PENDING_DESCRIPTION}`,
  ])
  return `${REVIEW_CONTEXT} set pending on ${sha}`
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const repo = process.env.REPO
  const sha = process.env.SHA
  if (!repo || !sha) {
    console.error('mark-pending needs REPO and SHA in the environment')
    process.exitCode = 1
  } else {
    try {
      console.log(markPending(repo, sha))
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  }
}
