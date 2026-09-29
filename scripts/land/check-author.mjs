#!/usr/bin/env node
// Refuses to land a pull request whose `author_association` is not one
// `.github/workflows/review-gate.yml`'s "Apply verdict from marker" step
// honours for a review marker (REVIEW.md, "The comment must come from an
// account with write access"). The repository is public and forking is
// allowed, so anyone can open a pull request; only a passing review marker
// stands between such a pull request and the sweep, and that marker itself
// only counts from a writer. Without this check the sweep would still land
// an outside pull request that somehow carried a `success` review/agent
// status. OQ-81.
//
// This set is a restatement of review-gate.yml's `case`, kept identical by
// a test (`check-author.test.mjs`, OQ-81/AC-3) that reads both
// `land-approved.yml` and `review-gate.yml`, and also compares against
// `scripts/dispatch/review.mjs`'s `HONOURED_ASSOCIATIONS` (OQ-78/AC-3), so
// all three agree.

export const HONOURED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR']

/** Whether a pull request opened by this GitHub `author_association` may land. */
export function isHonouredAuthor(association) {
  return HONOURED_ASSOCIATIONS.includes(association)
}

// CLI: exits 0 if the association named by the ASSOC env var is honoured, 1
// otherwise. Used from land-approved.yml, once per candidate pull request,
// against that pull request's own `author_association`.
if (process.argv[1]?.endsWith('check-author.mjs')) {
  process.exitCode = isHonouredAuthor(process.env.ASSOC ?? '') ? 0 : 1
}
