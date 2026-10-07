// @vitest-environment node

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { reviewAndLandWriterPullRequests } from './writer-prs.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

const pr = (number, overrides = {}) =>
  ({ number, headRef: `story/OQ-${number}-x`, headSha: SHA_A, draft: false, authorAssociation: 'OWNER', ...overrides })

function neverCalled(name) {
  return async () => { throw new Error(`${name} must not be called`) }
}

describe('OQ-83/AC-1: a draft pull request is skipped before anything else is read', () => {
  it('OQ-83/AC-1: a draft is reported as draft, with no comments read and no review run', async () => {
    const result = await reviewAndLandWriterPullRequests({
      ctx: {}, landCtx: {}, repoDir: '/x',
      deps: {
        listOpenPullRequests: async () => [pr(1, { draft: true })],
        listPullRequestComments: neverCalled('listPullRequestComments'),
        reviewPullRequest: neverCalled('reviewPullRequest'),
        landPullRequest: neverCalled('landPullRequest'),
      },
    })
    expect(result).toEqual({ landed: false, report: [{ number: 1, outcome: 'draft' }] })
  })
})

describe('OQ-83/AC-4: an outsider\'s pull request is never reviewed', () => {
  for (const association of ['CONTRIBUTOR', 'NONE']) {
    it(`OQ-83/AC-4: a ${association} pull request is ignored, its body never read into a reviewer prompt`, async () => {
      const result = await reviewAndLandWriterPullRequests({
        ctx: {}, landCtx: {}, repoDir: '/x',
        deps: {
          listOpenPullRequests: async () => [pr(2, { authorAssociation: association })],
          listPullRequestComments: neverCalled('listPullRequestComments'),
          reviewPullRequest: neverCalled('reviewPullRequest'),
          landPullRequest: neverCalled('landPullRequest'),
        },
      })
      expect(result).toEqual({ landed: false, report: [{ number: 2, outcome: 'outsider', authorAssociation: association }] })
    })
  }
})

describe('OQ-83/AC-1, AC-6: a pull request already carrying a verdict at its head is not reviewed again', () => {
  it('OQ-83/AC-1, AC-6: an honoured marker at the current head skips review.mjs entirely', async () => {
    const result = await reviewAndLandWriterPullRequests({
      ctx: {}, landCtx: {}, repoDir: '/x',
      deps: {
        listOpenPullRequests: async () => [pr(3, { headSha: SHA_B })],
        listPullRequestComments: async () => [
          { authorAssociation: 'MEMBER', marker: { kind: 'marker', headSha: SHA_B, verdict: 'pass' } },
        ],
        reviewPullRequest: neverCalled('reviewPullRequest'),
        landPullRequest: neverCalled('landPullRequest'),
      },
    })
    expect(result).toEqual({ landed: false, report: [{ number: 3, outcome: 'already-reviewed' }] })
  })

  it('OQ-83/AC-1: a marker at a different (stale) head does not suppress review', async () => {
    let reviewed = false
    const result = await reviewAndLandWriterPullRequests({
      ctx: {}, landCtx: {}, repoDir: '/x',
      deps: {
        listOpenPullRequests: async () => [pr(4, { headSha: SHA_B })],
        listPullRequestComments: async () => [
          { authorAssociation: 'MEMBER', marker: { kind: 'marker', headSha: SHA_A, verdict: 'block' } },
        ],
        reviewPullRequest: async () => { reviewed = true; return { status: 'recorded', verdict: 'block', headSha: SHA_B, commentId: 9 } },
        landPullRequest: neverCalled('landPullRequest'),
      },
    })
    expect(reviewed).toBe(true)
    expect(result.report).toEqual([{ number: 4, outcome: 'blocked' }])
  })
})

describe('OQ-83/AC-2: pass or pass-with-observations lands the pull request through land.mjs', () => {
  for (const verdict of ['pass', 'pass-with-observations']) {
    it(`OQ-83/AC-2: a ${verdict} verdict is landed, and reported merged`, async () => {
      const calls = { review: [], land: [] }
      const result = await reviewAndLandWriterPullRequests({
        ctx: {}, landCtx: {}, repoDir: '/x',
        deps: {
          listOpenPullRequests: async () => [pr(5)],
          listPullRequestComments: async () => [],
          reviewPullRequest: async (args) => { calls.review.push(args); return { status: 'recorded', verdict, headSha: SHA_A, commentId: 1 } },
          landPullRequest: async (args) => { calls.land.push(args); return { status: 'merged', pr: args.number, headSha: args.passedAt } },
        },
      })
      expect(result).toEqual({ landed: true, report: [{ number: 5, outcome: 'merged' }] })
      expect(calls.review).toEqual([{ number: 5, ctx: {}, repoDir: '/x' }])
      expect(calls.land).toEqual([{ number: 5, ctx: {}, passedAt: SHA_A }])
    })
  }

  it('OQ-83/AC-2: a pass whose landing does not reach merged is reported with land.mjs\'s own status', async () => {
    const result = await reviewAndLandWriterPullRequests({
      ctx: {}, landCtx: {}, repoDir: '/x',
      deps: {
        listOpenPullRequests: async () => [pr(6)],
        listPullRequestComments: async () => [],
        reviewPullRequest: async () => ({ status: 'recorded', verdict: 'pass', headSha: SHA_A, commentId: 1 }),
        landPullRequest: async () => ({ status: 'conflict', pr: 6, headSha: SHA_A }),
      },
    })
    expect(result).toEqual({ landed: false, report: [{ number: 6, outcome: 'land-conflict' }] })
  })
})

describe('OQ-83/AC-3: a block is recorded and left -- no land, no coder, no push', () => {
  it('OQ-83/AC-3: a block verdict never calls land.mjs', async () => {
    const result = await reviewAndLandWriterPullRequests({
      ctx: {}, landCtx: {}, repoDir: '/x',
      deps: {
        listOpenPullRequests: async () => [pr(7)],
        listPullRequestComments: async () => [],
        reviewPullRequest: async () => ({ status: 'recorded', verdict: 'block', headSha: SHA_A, commentId: 1 }),
        landPullRequest: neverCalled('landPullRequest'),
      },
    })
    expect(result).toEqual({ landed: false, report: [{ number: 7, outcome: 'blocked' }] })
  })

  it('OQ-83/AC-3: writer-prs.mjs never imports coder.mjs, so it has no means to dispatch one', () => {
    const source = readFileSync(path.join(here, 'writer-prs.mjs'), 'utf8')
    expect(source).not.toMatch(/coder\.mjs/)
  })
})

describe('OQ-83: a review.mjs result that is not recorded leaves the pull request untouched', () => {
  it('a no-verdict result is reported as not-recorded, and nothing is landed', async () => {
    const result = await reviewAndLandWriterPullRequests({
      ctx: {}, landCtx: {}, repoDir: '/x',
      deps: {
        listOpenPullRequests: async () => [pr(8)],
        listPullRequestComments: async () => [],
        reviewPullRequest: async () => ({ status: 'no-verdict', headSha: SHA_A, summary: 'could not review' }),
        landPullRequest: neverCalled('landPullRequest'),
      },
    })
    expect(result).toEqual({ landed: false, report: [{ number: 8, outcome: 'not-recorded', status: 'no-verdict', reason: undefined }] })
  })
})

describe('OQ-83: several pull requests are considered in listing order, independently', () => {
  it('a draft, an outsider, a block, and a pass are each handled on their own', async () => {
    const result = await reviewAndLandWriterPullRequests({
      ctx: {}, landCtx: {}, repoDir: '/x',
      deps: {
        listOpenPullRequests: async () => [
          pr(10, { draft: true }),
          pr(11, { authorAssociation: 'CONTRIBUTOR' }),
          pr(12),
          pr(13),
        ],
        listPullRequestComments: async () => [],
        reviewPullRequest: async ({ number }) =>
          (number === 12
            ? { status: 'recorded', verdict: 'block', headSha: SHA_A, commentId: 1 }
            : { status: 'recorded', verdict: 'pass', headSha: SHA_A, commentId: 2 }),
        landPullRequest: async ({ number }) => ({ status: 'merged', pr: number, headSha: SHA_A }),
      },
    })
    expect(result).toEqual({
      landed: true,
      report: [
        { number: 10, outcome: 'draft' },
        { number: 11, outcome: 'outsider', authorAssociation: 'CONTRIBUTOR' },
        { number: 12, outcome: 'blocked' },
        { number: 13, outcome: 'merged' },
      ],
    })
  })
})
