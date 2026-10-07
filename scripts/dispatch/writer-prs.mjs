#!/usr/bin/env node
/**
 * Reviews and lands open, non-draft pull requests against `main` that the loop
 * did not open itself -- a story Session A refined with the owner and opened
 * from the owner's account (OQ-83). It composes `review.mjs` and `land.mjs`
 * and reimplements neither: it never dispatches a coder and never pushes to
 * a pull request's branch, so a `block` leaves the pull request exactly
 * where the reviewer left it.
 *
 * A candidate is a pull request whose `author_association` is one the gate
 * honours (`review.mjs`'s `HONOURED_ASSOCIATIONS`, the set `review-gate.yml`
 * reads). A draft, or a pull request from anyone else, is skipped before its
 * body is ever read -- no reviewer spend goes on it. A candidate that already
 * carries an honoured verdict at its current head was handled by an earlier
 * call to this function, or, for the loop's own story pull requests, by
 * OQ-48's `story.mjs` cycle; it is left alone here, and is reviewed again
 * only once its head moves.
 *
 * Usage: imported by `loop.mjs`. No CLI of its own -- there is nothing to run
 * standalone that isn't already `loop.mjs`'s job.
 */
import { listOpenPullRequests, listPullRequestComments } from './github.mjs'
import { landPullRequest } from './land.mjs'
import { HONOURED_ASSOCIATIONS, reviewPullRequest } from './review.mjs'

const BASE = 'main'
const PASSING = ['pass', 'pass-with-observations']

/**
 * The latest honoured verdict marker at `headSha`, or `undefined`. Mirrors
 * `story.mjs`'s `verdictAtHead`, against the same `HONOURED_ASSOCIATIONS`
 * (AC-5): the gate's own author-association gate, read from `review.mjs`
 * rather than restated here.
 */
function verdictAtHead(comments, headSha) {
  return comments.findLast((c) =>
    c.marker.kind === 'marker' && c.marker.headSha === headSha && HONOURED_ASSOCIATIONS.includes(c.authorAssociation))
}

/**
 * Reviews and lands every open, non-draft pull request against `main` whose
 * author the gate honours and that has no honoured verdict at its current
 * head (AC-1--AC-4).
 *
 *   ctx      a `github.mjs` context
 *   landCtx  a `land.mjs` context
 *   repoDir  the dispatcher's checkout, handed to `reviewPullRequest` for its
 *            own review worktree (see `review.mjs`)
 *   options  `{ reviewer, land }`: extra options passed through to
 *            `reviewPullRequest` and `landPullRequest` respectively
 *   deps     `{ listOpenPullRequests, listPullRequestComments, reviewPullRequest,
 *            landPullRequest }`, replaceable by a test
 *
 * Resolves `{ landed, report }`. `landed` is true once at least one pull
 * request merges during this call -- the caller re-reads the queue when it
 * is, so a story that pull request just moved to `stories/done/` is seen in
 * the same run (AC-6's second case). `report` has one entry per pull request
 * considered, in listing order: `{ number, outcome, ... }` with `outcome` one
 * of:
 *   - `draft` -- skipped untouched (AC-1)
 *   - `outsider` -- the author's association is not honoured; `authorAssociation`
 *     carries it (AC-4)
 *   - `already-reviewed` -- a verdict already governs this head (AC-1, AC-6)
 *   - `not-recorded` -- `reviewPullRequest` did not record a verdict;
 *     `status` and `reason` carry its own result
 *   - `blocked` -- reviewed and recorded `block`; left as is (AC-3)
 *   - `merged` -- reviewed, passed, and landed (AC-2)
 *   - `land-<status>` -- reviewed and passed, but `landPullRequest` did not
 *     reach `merged`; `status` carries its own result
 */
export async function reviewAndLandWriterPullRequests({ ctx, landCtx, repoDir, options = {}, deps = {} }) {
  const d = { listOpenPullRequests, listPullRequestComments, reviewPullRequest, landPullRequest, ...deps }
  const prs = await d.listOpenPullRequests(ctx, { base: BASE })
  const report = []
  let landed = false

  for (const pr of prs) {
    if (pr.draft) {
      report.push({ number: pr.number, outcome: 'draft' })
      continue
    }
    if (!HONOURED_ASSOCIATIONS.includes(pr.authorAssociation)) {
      report.push({ number: pr.number, outcome: 'outsider', authorAssociation: pr.authorAssociation })
      continue
    }

    const comments = await d.listPullRequestComments(ctx, pr.number)
    if (verdictAtHead(comments, pr.headSha)) {
      report.push({ number: pr.number, outcome: 'already-reviewed' })
      continue
    }

    const result = await d.reviewPullRequest({ number: pr.number, ctx, repoDir, ...options.reviewer })
    if (result.status !== 'recorded') {
      report.push({ number: pr.number, outcome: 'not-recorded', status: result.status, reason: result.reason })
      continue
    }
    if (!PASSING.includes(result.verdict)) {
      report.push({ number: pr.number, outcome: 'blocked' })
      continue
    }

    const land = await d.landPullRequest({ number: pr.number, ctx: landCtx, passedAt: result.headSha, ...options.land })
    report.push({ number: pr.number, outcome: land.status === 'merged' ? 'merged' : `land-${land.status}` })
    if (land.status === 'merged') landed = true
  }

  return { landed, report }
}
