/** Shared review admission rules for rotations and automatic PR/head work. */
import { HONOURED_ASSOCIATIONS } from '../land/check-author.mjs'
import { isLandingBase } from '../land/release-branch.mjs'
import { getPullRequestLabels, listPullRequestComments } from './github.mjs'

export { HONOURED_ASSOCIATIONS }
export const FULL_HEAD_SHA = /^[0-9a-f]{40}$/

/** The latest honoured marker at this head, or undefined. */
export function verdictAtHead(comments, headSha) {
  return comments.findLast((c) =>
    c.marker.kind === 'marker' && c.marker.headSha === headSha && HONOURED_ASSOCIATIONS.includes(c.authorAssociation))
}

/** Checked before a rotation's cap, without further GitHub reads. */
export function reviewAuthorRefusal(pr) {
  if (pr.draft) return { status: 'draft', reason: 'a draft' }
  if (!HONOURED_ASSOCIATIONS.includes(pr.authorAssociation)) {
    return { status: 'outsider', reason: `outsider (${pr.authorAssociation})` }
  }
  return null
}

/** Checked after a rotation's cap. No comments are read for a labelled PR. */
export async function reviewHeadRefusal({ ctx, pr, deps = {} }) {
  const labels = await (deps.getPullRequestLabels ?? getPullRequestLabels)(ctx, pr.number)
  if (labels.includes('review-blocked')) return { status: 'review-blocked', reason: 'labelled review-blocked' }
  const comments = await (deps.listPullRequestComments ?? listPullRequestComments)(ctx, pr.number)
  const existing = verdictAtHead(comments, pr.headSha)
  return existing ? { status: 'already-reviewed', reason: 'a verdict is already at its head', existing } : null
}

/** Automatic work must still be open and on a supported base at execution time. */
export function reviewTargetRefusal(pr) {
  if (pr.state !== 'open') return { status: 'not-open', reason: 'no longer open' }
  if (!isLandingBase(pr.baseRef)) return { status: 'unsupported-base', reason: `unsupported base (${pr.baseRef})` }
  if (typeof pr.headSha !== 'string' || !FULL_HEAD_SHA.test(pr.headSha)) {
    return { status: 'invalid-head', reason: 'the pull request has no full head SHA' }
  }
  return reviewAuthorRefusal(pr)
}
