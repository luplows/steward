/**
 * Reusable review-only work for the coordinator. Discovery reports every open PR on a
 * supported base, in number order, including refusals. Execution accepts exactly one
 * repository/PR/full-head identity and returns the reviewer's result unchanged.
 * No scheduler, reservation, landing, coding or inspection is run here.
 */
import { isLandingBase } from '../land/release-branch.mjs'
import { createContext, listOpenPullRequests } from './github.mjs'
import { createInspectContext, listReleaseBranches } from './inspect.mjs'
import { FULL_HEAD_SHA, reviewHeadRefusal, reviewTargetRefusal } from './review-eligibility.mjs'
import { reviewPullRequest } from './review.mjs'

/** Shared with rotation; inspection's release-ref reader performs discovery only. */
export async function listLandingPullRequests({ ctx, inspectCtx }) {
  const bases = ['main', ...(await listReleaseBranches(inspectCtx))].filter(isLandingBase)
  const all = []
  for (const base of bases) {
    all.push(...(await listOpenPullRequests(ctx, { base })).map((pr) => ({ ...pr, baseRef: base, state: 'open' })))
  }
  return all
}

/**
 * Returns [{ repo, number, expectedHeadSha, status, reason?, existing? }]. Only `eligible`
 * entries may be scheduled. Read failures throw; they never become eligible candidates.
 * Contexts and read dependencies are injectable for offline tests.
 */
export async function listReviewCandidates({ ctx, inspectCtx = createInspectContext({ repo: ctx.repo }), deps = {} }) {
  const prs = await (deps.listPullRequests ?? listLandingPullRequests)({ ctx, inspectCtx })
  const candidates = []
  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    const refusal = reviewTargetRefusal(pr) ?? await reviewHeadRefusal({ ctx, pr, deps })
    candidates.push({ repo: ctx.repo, number: pr.number, expectedHeadSha: pr.headSha, ...(refusal ?? { status: 'eligible' }) })
  }
  return candidates
}

/**
 * Attempts this candidate only, even if it is refused or its head moved. The reviewer
 * re-reads eligibility and the expected SHA at its execution boundary. `reviewOptions`
 * provides the existing session/usage test seams; it cannot override the work identity,
 * request a re-review or choose a model on the crew's behalf.
 */
export async function reviewCandidate({ candidate, repoDir, ctx = createContext({ repo: candidate.repo }), reviewOptions = {} }) {
  if (ctx.repo !== candidate.repo) throw new Error('candidate repository differs from the GitHub context')
  if (!Number.isSafeInteger(candidate.number) || candidate.number <= 0) throw new Error('candidate PR number must be a positive integer')
  if (typeof candidate.expectedHeadSha !== 'string' || !FULL_HEAD_SHA.test(candidate.expectedHeadSha)) {
    return { status: 'invalid-expected-head', reason: 'expectedHeadSha must be a full lowercase 40-character SHA' }
  }
  return reviewPullRequest({
    ...reviewOptions, ctx, repoDir, number: candidate.number, expectedHeadSha: candidate.expectedHeadSha,
    rereview: false, choice: undefined,
  })
}
