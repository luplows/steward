#!/usr/bin/env node
// Chooses which open pull requests the landing sweep may try (OQ-93).
//
// Given no `pr` input, every open non-draft pull request against `main`, in the order the
// sweep listed them (created, ascending). Given one, only that pull request, and only if it
// is in that set: a run given a pull request never goes on to another one. The per-pull-request
// checks (review-blocked, the circuit breaker, mergeable_state, review/agent) stay in
// `land-approved.yml` and apply to whatever this returns.
//
// The input arrives through the environment, never interpolated into a shell script, and is
// validated here: anything that is neither empty nor a positive integer without leading zeros
// is refused, so the run fails having merged nothing.
//
// Usage (the workflow): the listing as JSON on stdin, PR_INPUT in the environment;
// prints one number per line.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const PR_INPUT_PATTERN = /^[1-9][0-9]*$/

/** `pulls` is the sweep's listing: objects with `number`, `draft` and `base.ref`. */
export function selectCandidates(pulls, prInput = '') {
  const input = prInput ?? ''
  if (input !== '' && !PR_INPUT_PATTERN.test(input)) {
    throw new Error(`pr input must be empty or a positive integer, got: ${JSON.stringify(input)}`)
  }
  const eligible = pulls.filter((pull) => !pull.draft && pull.base?.ref === 'main').map((pull) => pull.number)
  if (input === '') return eligible
  return eligible.filter((number) => number === Number(input))
}

function main() {
  const pulls = JSON.parse(readFileSync(0, 'utf8'))
  for (const number of selectCandidates(pulls, process.env.PR_INPUT ?? '')) console.log(number)
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
