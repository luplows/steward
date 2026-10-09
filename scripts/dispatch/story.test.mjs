// @vitest-environment node

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertAllowedCiRequest } from './ci.mjs'
import { assertAllowedRequest, parseMarkerComment } from './github.mjs'
import { parseFrontmatter } from './queue.mjs'
import {
  countBlockingVerdicts,
  decideCi,
  decideDispatch,
  decideLand,
  decideRetry,
  decideReview,
  decideVerdict,
  MAX_ROUNDS,
  recordBlocked,
  runStory,
  verdictAtHead,
  withBlocked,
} from './story.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = 'luplows/tower-workshop-paths'
const STORY = 'OQ-9'
const BRANCH = 'story/OQ-9-a-story'
const SHAS = ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => c.repeat(40))
const [H1, H2, H3, H4] = SHAS

function comment(id, verdict, head, { association = 'OWNER', text = 'A finding.' } = {}) {
  const body = `${text}\n\n<!-- agent-review head=${head} verdict=${verdict} -->`
  return { id, authorAssociation: association, body, marker: parseMarkerComment(body) }
}

/**
 * Deps scripted per step. Each queue is consumed in order and an empty one is a
 * test failure, so a run that goes further than the script says fails loudly.
 */
function harness({
  comments = [], labels = [], ci = [], reviews = [], retries = [], lands = [], dispatch,
  redCount = () => 0, draftFails = false, record = { status: 'recorded' }, blockedAt = { blocked: null },
  retryThrows = false, pr = { state: 'open', head: { sha: H1, ref: BRANCH }, base: { ref: 'main' }, draft: false },
} = {}) {
  const calls = []
  const state = { comments: [...comments], labels, pr }
  const next = (queue, name) => {
    if (queue.length === 0) throw new Error(`the run asked for another ${name} than the script has`)
    return queue.shift()
  }
  const deps = {
    dispatchCoder: async (args) => (calls.push(['dispatch', args]), dispatch),
    waitForCi: async (_c, head) => (calls.push(['ci', head]), next(ci, 'ci wait')),
    countRedCiRounds: async () => redCount(),
    reviewPullRequest: async (args) => {
      calls.push(['review', args])
      const entry = next(reviews, 'review')
      if (!entry.verdict) return entry
      const id = state.comments.length + 100
      state.comments.push(comment(id, entry.verdict, entry.head ?? H1, { text: entry.text }))
      return { status: 'recorded', headSha: entry.head ?? H1, verdict: entry.verdict, commentId: id }
    },
    retryStory: async (args) => {
      calls.push(['retry', args])
      if (retryThrows) throw new Error('killed')
      return next(retries, 'retry')
    },
    landPullRequest: async (args) => (calls.push(['land', args]), next(lands, 'landing')),
    convertPullRequestToDraft: async () => {
      calls.push(['draft'])
      if (draftFails) throw new Error('graphql refused')
      return { draft: true, alreadyDraft: false }
    },
    recordBlocked: async (args) => (calls.push(['record', args]), record),
    readBlockedAt: async () => blockedAt,
    listPullRequestComments: async () => state.comments,
    getPullRequestLabels: async () => state.labels,
  }
  const ctx = { repo: REPO, send: async () => state.pr }
  const run = (extra = {}) => runStory({ storyId: STORY, ctx, ciCtx: {}, landCtx: {}, deps, ...extra })
  return { deps, state, calls, run, names: () => calls.map((c) => c[0]) }
}

const opened = { status: 'opened', branch: BRANCH, draft: false, blocked: null, pr: { number: 7, headSha: H1 } }
const green = { result: 'green' }
const red = (conclusion = 'failure', jobNames = ['test']) => ({ result: 'red', conclusion, jobNames, findings: 'CI failed.' })
const retried = (headSha) => ({ status: 'retried', headSha, draft: false, blocked: null })

describe('OQ-48/AC-2: what each result leads to', () => {
  const stops = (decision, status) => {
    expect(decision.next).toBe('stop')
    if (status) expect(decision.status).toBe(status)
  }

  it('OQ-48/AC-2: coder dispatch continues only on an opened pull request that is not a draft', () => {
    expect(decideDispatch(opened)).toEqual({ next: 'ci' })
    stops(decideDispatch({ ...opened, draft: true }), 'coder-draft')
    stops(decideDispatch({ ...opened, draft: true, blocked: 'why' }), 'coder-draft')
    for (const status of ['branch-exists', 'session-failed', 'nothing-ready', 'a-status-added-later']) {
      stops(decideDispatch({ status, reason: 'r' }), status)
    }
  })

  it('OQ-48/AC-2: CI continues on green, retries a failure, and stops on anything else', () => {
    expect(decideCi(green)).toEqual({ next: 'review' })
    expect(decideCi(red('failure'), 0)).toEqual({ next: 'retry', source: 'ci', round: 1 })
    stops(decideCi(red('failure'), 3), 'ci-round-bound')
    stops(decideCi(red('cancelled')), 'ci-concluded-cancelled')
    stops(decideCi(red('timed_out')), 'ci-concluded-timed_out')
    stops(decideCi({ result: 'timed-out' }), 'ci-wait-timed-out')
    stops(decideCi({ result: 'something-added-later' }), 'ci-unrecognised')
  })

  it('OQ-48/AC-2: a recorded pass lands, a recorded block retries, and every other review status stops', () => {
    expect(decideReview({ status: 'recorded', verdict: 'pass' })).toEqual({ next: 'verdict', verdict: 'pass' })
    for (const status of ['no-verdict', 'malformed-verdict', 'session-failed', 'unrecordable', 'already-reviewed', 'head-moved', 'x-added-later']) {
      stops(decideReview({ status, reason: 'r' }), `review-${status}`)
    }
    const none = { blocks: 0, labels: [] }
    expect(decideVerdict('pass', none)).toEqual({ next: 'land' })
    expect(decideVerdict('pass-with-observations', none)).toEqual({ next: 'land' })
    expect(decideVerdict('block', none)).toEqual({ next: 'retry', source: 'review', round: 1 })
    stops(decideVerdict('block', { blocks: 1, labels: ['review-blocked'] }), 'review-blocked-label')
    stops(decideVerdict('block', { blocks: 3, labels: [] }), 'review-round-bound')
    stops(decideVerdict('something-else', none), 'review-unrecognised')
  })

  it('OQ-48/AC-2: a retry continues on a commit, re-reviews after a review body-replace, and otherwise stops', () => {
    expect(decideRetry(retried(H2), 'ci')).toEqual({ next: 'ci', headSha: H2 })
    expect(decideRetry(retried(H2), 'review')).toEqual({ next: 'ci', headSha: H2 })
    expect(decideRetry({ status: 'body-replaced', draft: false, blocked: null }, 'review')).toEqual({ next: 'review', rereview: true })
    stops(decideRetry({ status: 'body-replaced', draft: false, blocked: null }, 'ci'), 'ci-retry-no-commit')
    stops(decideRetry({ ...retried(H2), blocked: 'why' }, 'review'), 'retry-blocked')
    stops(decideRetry({ ...retried(H2), draft: true }, 'ci'), 'retry-draft')
    stops(decideRetry({ status: 'body-replaced', draft: true }, 'review'), 'retry-draft')
    for (const status of ['session-failed', 'nothing-committed', 'push-failed', 'replace-failed', 'x-added-later']) {
      stops(decideRetry({ status, draft: false, blocked: null }, 'review'), `retry-${status}`)
    }
  })

  it('OQ-48/AC-2: landing finishes only on merged', () => {
    expect(decideLand({ status: 'merged' })).toEqual({ next: 'done' })
    for (const status of ['review-blocked', 'conflict', 'timeout', 'closed', 'x-added-later']) {
      stops(decideLand({ status }), `land-${status}`)
    }
  })

  it('OQ-104/AC-2: a gate-lag landing stops like any other non-merged status', () => {
    stops(decideLand({ status: 'gate-lag' }), 'land-gate-lag')
  })
})

describe('OQ-48/AC-1: one story, in order', () => {
  it('OQ-48/AC-1: dispatch, CI, review, land, and nothing else on a clean run', async () => {
    const h = harness({ dispatch: opened, ci: [green], reviews: [{ verdict: 'pass' }], lands: [{ status: 'merged' }] })
    const result = await h.run()
    expect(result).toMatchObject({ status: 'merged', pr: 7 })
    expect(h.names()).toEqual(['dispatch', 'ci', 'review', 'land'])
    expect(h.calls[1][1]).toBe(H1)
    expect(h.calls[3][1].number).toBe(7)
  })

  it('OQ-48/AC-1: a blocking review goes to the retry, then CI on the new head, then review again', async () => {
    const h = harness({
      dispatch: opened,
      ci: [green, green],
      reviews: [{ verdict: 'block', text: 'Fix the substitution.' }, { verdict: 'pass', head: H2 }],
      retries: [retried(H2)],
      lands: [{ status: 'merged' }],
    })
    expect((await h.run()).status).toBe('merged')
    expect(h.names()).toEqual(['dispatch', 'ci', 'review', 'retry', 'ci', 'review', 'land'])
    expect(h.calls[4][1]).toBe(H2)
    const retry = h.calls[3][1]
    expect(retry).toMatchObject({ source: 'review', prNumber: 7, storyId: STORY })
    expect(retry.findings).toContain('Fix the substitution.')
    expect(retry.findings).not.toContain('agent-review')
  })

  it('OQ-48/AC-1: a red CI is retried, its findings passed, and the run continues from CI on the new head', async () => {
    const h = harness({
      dispatch: opened, ci: [red(), green], redCount: () => 1, reviews: [{ verdict: 'pass', head: H2 }],
      retries: [retried(H2)], lands: [{ status: 'merged' }],
    })
    expect((await h.run()).status).toBe('merged')
    expect(h.names()).toEqual(['dispatch', 'ci', 'retry', 'ci', 'review', 'land'])
    expect(h.calls[2][1]).toMatchObject({ source: 'ci', findings: 'CI failed.' })
  })

  it('OQ-48/AC-1: a review body-replace is re-reviewed on the same head with the re-review option', async () => {
    const h = harness({
      dispatch: opened, ci: [green], reviews: [{ verdict: 'block' }, { verdict: 'pass' }],
      retries: [{ status: 'body-replaced', draft: false, blocked: null }], lands: [{ status: 'merged' }],
    })
    expect((await h.run()).status).toBe('merged')
    expect(h.names()).toEqual(['dispatch', 'ci', 'review', 'retry', 'review', 'land'])
    expect(h.calls[2][1].rereview).toBe(false)
    expect(h.calls[4][1].rereview).toBe(true)
  })

  it('OQ-104/AC-2: landPullRequest is passed passedAt as the head that passed', async () => {
    const h = harness({ dispatch: opened, ci: [green], reviews: [{ verdict: 'pass' }], lands: [{ status: 'merged' }] })
    await h.run()
    const land = h.calls.find((c) => c[0] === 'land')[1]
    expect(land.passedAt).toBe(H1)
  })

  it('OQ-104/AC-2: after a retry moves the head, landPullRequest is passed the new head that passed', async () => {
    const h = harness({
      dispatch: opened,
      ci: [green, green],
      reviews: [{ verdict: 'block', text: 'Fix the substitution.' }, { verdict: 'pass', head: H2 }],
      retries: [retried(H2)],
      lands: [{ status: 'merged' }],
    })
    await h.run()
    const land = h.calls.find((c) => c[0] === 'land')[1]
    expect(land.passedAt).toBe(H2)
  })

  it('OQ-48/AC-1: reviews are spent only on a head whose CI is green', async () => {
    const h = harness({ dispatch: opened, ci: [red('cancelled')] })
    await h.run()
    expect(h.names()).not.toContain('review')
  })
})

describe('OQ-48/AC-3: the review bound is derived, honoured, and never written as a label', () => {
  it('OQ-48/AC-3: counts blocking markers from honoured authors only, across heads', () => {
    const comments = [
      comment(1, 'block', H1),
      comment(2, 'block', H2, { association: 'MEMBER' }),
      comment(3, 'block', H2, { association: 'NONE' }),
      comment(4, 'pass', H3),
      { id: 5, authorAssociation: 'OWNER', body: 'chat', marker: { kind: 'absent' } },
      comment(6, 'block', H3, { association: 'COLLABORATOR' }),
    ]
    expect(countBlockingVerdicts(comments)).toBe(3)
    expect(verdictAtHead(comments, H2).id).toBe(2)
    expect(verdictAtHead(comments, H4)).toBeUndefined()
  })

  it('OQ-48/AC-3: at three blocking verdicts the run stops instead of retrying, and names the findings', async () => {
    const h = harness({
      dispatch: opened, ci: [green],
      comments: [comment(1, 'block', H2), comment(2, 'block', H3)],
      reviews: [{ verdict: 'block' }],
    })
    const result = await h.run()
    expect(result).toMatchObject({ status: 'review-round-bound', stopped: true })
    expect(result.reason).toMatch(/unresolved/)
    expect(result.reason).toContain('A finding.')
    expect(h.names()).not.toContain('retry')
  })

  it('OQ-48/AC-3: a pull request already carrying review-blocked is not retried', async () => {
    const h = harness({ dispatch: opened, ci: [green], reviews: [{ verdict: 'block' }], labels: ['review-blocked'] })
    expect((await h.run()).status).toBe('review-blocked-label')
    expect(h.names()).not.toContain('retry')
  })

  it('OQ-48/AC-3: a run killed after a block resumes with no memory and the bound still holds', async () => {
    // Run 1 records the second block, then dies as it starts the retry.
    const first = harness({
      dispatch: opened, ci: [green], comments: [comment(1, 'block', H2)], reviews: [{ verdict: 'block' }], retryThrows: true,
    })
    await expect(first.run()).rejects.toThrow('killed')
    expect(countBlockingVerdicts(first.state.comments)).toBe(2)

    // Run 2 is a new call with nothing but the pull request: GitHub's comments.
    const second = harness({
      comments: first.state.comments, ci: [green], reviews: [{ verdict: 'block', head: H2 }],
      retries: [retried(H2)], pr: { state: 'open', head: { sha: H1, ref: BRANCH }, draft: false },
    })
    const result = await second.run({ prNumber: 7 })
    // The marker at H1 is the second block, so this retry is round 3 as it would have been.
    expect(second.calls.find((c) => c[0] === 'retry')[1]).toMatchObject({ round: 3, roundsRemaining: 0 })
    // Round 3's head is blocked again: a third block, and there is no fourth retry.
    expect(result.status).toBe('review-round-bound')
    expect(second.calls.filter((c) => c[0] === 'retry')).toHaveLength(1)
  })

  it('OQ-48/AC-3: the bound is three', () => {
    expect(MAX_ROUNDS).toBe(3)
  })
})

describe('OQ-48/AC-4 and AC-5: CI rounds are bounded, and only a failure is retried', () => {
  it('OQ-48/AC-4: at three red CI rounds the run stops naming the failing jobs, and applies no label', async () => {
    const h = harness({ dispatch: opened, ci: [red('failure', ['lint', 'e2e'])], redCount: () => 3 })
    const result = await h.run()
    expect(result.status).toBe('ci-round-bound')
    expect(result.reason).toContain('lint, e2e')
    expect(h.names()).not.toContain('retry')
    expect(JSON.stringify(h.calls)).not.toContain('review-blocked')
  })

  it('OQ-48/AC-5: a failure is retried, while cancelled, timed_out and timed-out each stop without one', async () => {
    const failure = harness({ dispatch: opened, ci: [red('failure')], retries: [{ status: 'session-failed' }] })
    await failure.run()
    expect(failure.names()).toContain('retry')

    const outcomes = [[red('cancelled'), 'ci-concluded-cancelled'], [red('timed_out'), 'ci-concluded-timed_out'], [{ result: 'timed-out' }, 'ci-wait-timed-out']]
    for (const [ci, status] of outcomes) {
      let counted = 0
      const h = harness({ dispatch: opened, ci: [ci], redCount: () => ++counted })
      const result = await h.run()
      expect(result.status).toBe(status)
      expect(h.names()).not.toContain('retry')
      expect(counted).toBe(0)
    }
  })

  it('OQ-48/AC-4: a body-only retry after red CI stops the story rather than waiting on the same head', async () => {
    const h = harness({ dispatch: opened, ci: [red()], retries: [{ status: 'body-replaced', draft: false, blocked: null }] })
    expect((await h.run()).status).toBe('ci-retry-no-commit')
    expect(h.names().filter((n) => n === 'ci')).toHaveLength(1)
  })
})

describe('OQ-118/AC-5: a setup failure stops the story rather than retrying it', () => {
  const setupFailure = { result: 'red', conclusion: 'failure', jobNames: ['test'], findings: 'CI failed.', setupFailure: true, setupSteps: ['Setup: Playwright browsers'] }

  it('OQ-118/AC-5: decideCi stops before the red-round bound, naming the failed setup step', () => {
    expect(decideCi(setupFailure, 0)).toMatchObject({ next: 'stop', status: 'ci-setup-failed' })
    expect(decideCi(setupFailure, 0).reason).toContain('Setup: Playwright browsers')
    // Even at the bound, a setup failure is still reported as itself, not the bound.
    expect(decideCi(setupFailure, MAX_ROUNDS).status).toBe('ci-setup-failed')
  })

  it('OQ-118/AC-5: the run spawns no coder retry, counts no red round, drafts the pull request and records blocked:', async () => {
    let counted = 0
    const h = harness({ dispatch: opened, ci: [setupFailure], redCount: () => ++counted })
    const result = await h.run()
    expect(result.status).toBe('ci-setup-failed')
    expect(result.reason).toContain('Setup: Playwright browsers')
    expect(h.names()).toEqual(['dispatch', 'ci', 'draft', 'record'])
    expect(h.names()).not.toContain('retry')
    expect(counted).toBe(0)
    expect(h.calls.find((c) => c[0] === 'record')[1].reason).toContain('Setup: Playwright browsers')
    expect(result.record).toMatchObject({ draft: true, recorded: true, failed: [] })
  })
})

describe('OQ-48/AC-6: the round numbers a retry is given', () => {
  it('OQ-48/AC-6: a review retry gets the block count plus one, and a CI retry the red count plus one', async () => {
    for (const [blocks, round] of [[1, 2], [2, 3]]) {
      const h = harness({
        dispatch: opened, ci: [green],
        comments: Array.from({ length: blocks - 1 }, (_, i) => comment(i + 1, 'block', H3)),
        reviews: [{ verdict: 'block' }], retries: [{ status: 'session-failed' }],
      })
      await h.run()
      expect(h.calls.find((c) => c[0] === 'retry')[1]).toMatchObject({ source: 'review', round, roundsRemaining: 3 - round })
    }
    for (const [reds, round] of [[1, 2], [2, 3]]) {
      const h = harness({ dispatch: opened, ci: [red()], redCount: () => reds, retries: [{ status: 'session-failed' }] })
      await h.run()
      expect(h.calls.find((c) => c[0] === 'retry')[1]).toMatchObject({ source: 'ci', round, roundsRemaining: 3 - round })
    }
  })
})

describe('OQ-48/AC-7: the run never merges and never dispatches a workflow', () => {
  const source = readFileSync(path.join(HERE, 'story.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it('OQ-48/AC-7: the module builds no request of its own and names no merge, dispatch or label-write endpoint', () => {
    expect(source).not.toMatch(/fetch\(|globalThis\.fetch|\/merge|dispatches|\/labels|addLabels|createLandContext\([^)]*\)\.send/)
    expect(source).not.toMatch(/export (async )?function build/)
    // The one landing call is `landPullRequest`, imported from land.mjs.
    expect(source.match(/from '\.\/land\.mjs'/g)).toHaveLength(1)
  })

  it('OQ-48/AC-7 and AC-3: the allowlists of the modules it calls admit no merge, workflow dispatch or label write', () => {
    const base = `https://api.github.com/repos/${REPO}`
    const forbidden = [
      { method: 'PUT', url: `${base}/pulls/7/merge` },
      { method: 'POST', url: `${base}/actions/workflows/land-approved.yml/dispatches`, body: { ref: 'main' } },
      { method: 'POST', url: `${base}/issues/7/labels`, body: { labels: ['review-blocked'] } },
      { method: 'PUT', url: `${base}/issues/7/labels`, body: { labels: [] } },
    ]
    for (const request of forbidden) {
      expect(() => assertAllowedRequest(REPO, request)).toThrow()
      expect(() => assertAllowedCiRequest(REPO, request)).toThrow()
    }
  })

  it('OQ-48/AC-7: a run that ends in a stop calls landing only after a passing verdict', async () => {
    const h = harness({ dispatch: opened, ci: [green], reviews: [{ verdict: 'block' }], comments: [comment(1, 'block', H2), comment(2, 'block', H3)] })
    await h.run()
    expect(h.names()).not.toContain('land')
  })

  it('OQ-48/AC-7: observations on a passing verdict are recorded and not retried', async () => {
    const h = harness({ dispatch: opened, ci: [green], reviews: [{ verdict: 'pass-with-observations' }], lands: [{ status: 'merged' }] })
    expect((await h.run()).status).toBe('merged')
    expect(h.names()).not.toContain('retry')
  })
})

describe('OQ-48/AC-8: how a stop is recorded', () => {
  it('OQ-48/AC-8: a stop makes the pull request a draft first, then records blocked:, then reports recorded', async () => {
    const h = harness({ dispatch: opened, ci: [red('cancelled')] })
    const result = await h.run()
    expect(h.names()).toEqual(['dispatch', 'ci', 'draft', 'record'])
    expect(h.calls[3][1]).toMatchObject({ branch: BRANCH })
    expect(h.calls[3][1].reason).toContain('cancelled')
    expect(result).toMatchObject({ status: 'ci-concluded-cancelled', pr: 7, record: { draft: true, recorded: true, failed: [] } })
  })

  it('OQ-48/AC-8: a coder that already set blocked: is a draft and gets no second commit', async () => {
    const h = harness({ dispatch: { ...opened, draft: true, blocked: 'the coder asked' }, record: { status: 'already-blocked', blocked: 'the coder asked' } })
    const result = await h.run()
    expect(result.record).toMatchObject({ draft: true, blocked: 'already-blocked', recorded: true })
    expect(h.names()).toEqual(['dispatch', 'draft', 'record'])
  })

  it('OQ-48/AC-8: a pull request that is already a draft is not an error', async () => {
    const h = harness({ dispatch: { ...opened, draft: true } })
    h.deps.convertPullRequestToDraft = async () => ({ draft: true, alreadyDraft: true })
    expect((await h.run()).record).toMatchObject({ draft: true, recorded: true })
  })

  it('OQ-48/AC-8: a failed conversion is reported, and nothing is committed on a pull request still ready', async () => {
    const h = harness({ dispatch: opened, ci: [red('cancelled')], draftFails: true })
    const result = await h.run()
    expect(result.record.recorded).toBe(false)
    expect(result.record.failed).toEqual([{ step: 'draft', reason: 'graphql refused' }])
    expect(h.names()).not.toContain('record')
  })

  it('OQ-48/AC-8: a conversion that reports the pull request still ready is a failure, and nothing is committed', async () => {
    const h = harness({ dispatch: opened, ci: [red('cancelled')] })
    h.deps.convertPullRequestToDraft = async () => ({ draft: false, alreadyDraft: false })
    const result = await h.run()
    expect(result.record).toMatchObject({ draft: false, recorded: false })
    expect(result.record.failed[0].step).toBe('draft')
    expect(h.names()).not.toContain('record')
  })

  it('OQ-48/AC-8: a failed push is reported with what failed, and the draft stands', async () => {
    const h = harness({ dispatch: opened, ci: [red('cancelled')], record: { status: 'push-failed', reason: 'rejected' } })
    const result = await h.run()
    expect(result.record).toMatchObject({ draft: true, recorded: false, failed: [{ step: 'blocked', reason: 'rejected' }] })
  })

  it('OQ-48/AC-8: a stop before a pull request exists records nothing and reports the dispatch\'s status', async () => {
    const h = harness({ dispatch: { status: 'branch-exists', reason: 'already there' } })
    const result = await h.run()
    expect(result).toMatchObject({ status: 'branch-exists', stopped: true })
    expect(result.record).toBeUndefined()
    expect(h.names()).toEqual(['dispatch'])
  })

  it('OQ-48/AC-8: a retry that reports the coder\'s blocked: stops with the pull request a draft', async () => {
    const h = harness({
      dispatch: opened, ci: [green], reviews: [{ verdict: 'block' }],
      retries: [{ status: 'retried', headSha: H2, draft: true, blocked: 'cannot proceed' }], record: { status: 'already-blocked' },
    })
    const result = await h.run()
    expect(result.status).toBe('retry-blocked')
    expect(h.names().slice(-2)).toEqual(['draft', 'record'])
  })
})

describe('OQ-48/AC-8: recordBlocked, against a real repository', () => {
  const originalEnv = { ...process.env }
  let root
  let repoDir

  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })

  beforeAll(() => {
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test'
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com'
    root = mkdtempSync(path.join(tmpdir(), 'tw-story-test-'))
    const origin = path.join(root, 'origin.git')
    git(root, 'init', '--bare', '-b', 'main', origin)
    repoDir = path.join(root, 'clone')
    git(root, 'clone', origin, repoDir)
    mkdirSync(path.join(repoDir, 'stories'), { recursive: true })
    const story = (blocked) => `---\nid: OQ-9\ntitle: A story\ntier: normal\nkind: product\ndepends_on: []\nmodel: sonnet\nblocked: ${blocked}\n---\n\n## Intent\n\nx\n`
    writeFileSync(path.join(repoDir, 'stories', 'OQ-9-a-story.md'), story('null'))
    git(repoDir, 'add', '.')
    git(repoDir, 'commit', '-m', 'main')
    git(repoDir, 'push', 'origin', 'main')
    for (const [name, blocked, done] of [['story/OQ-9-a-story', 'null', false], ['story/OQ-9-b-story', 'null', true], ['story/OQ-9-c-story', '"the coder asked"', true]]) {
      git(repoDir, 'checkout', '-b', name, 'main')
      const file = `${name.replace('story/', '')}.md`
      if (done) git(repoDir, 'rm', '-q', 'stories/OQ-9-a-story.md')
      mkdirSync(path.join(repoDir, 'stories', done ? 'done' : ''), { recursive: true })
      writeFileSync(path.join(repoDir, 'stories', done ? 'done' : '', file), `${story(blocked)}work on ${name}\n`)
      git(repoDir, 'add', '.')
      git(repoDir, 'commit', '-m', `work on ${name}`)
      git(repoDir, 'push', 'origin', name)
      git(repoDir, 'checkout', 'main')
      git(repoDir, 'branch', '-D', name)
    }
  })

  afterAll(() => {
    process.env = originalEnv
    rmSync(root, { recursive: true, force: true })
  })

  const tipOf = (branch) => git(repoDir, 'ls-remote', 'origin', `refs/heads/${branch}`).split(/\s/)[0]

  it('OQ-48/AC-8: commits one change on top of the branch\'s tip on origin, pushed, wherever the story file is', async () => {
    for (const [branch, where] of [['story/OQ-9-a-story', 'stories'], ['story/OQ-9-b-story', 'stories/done']]) {
      const before = tipOf(branch)
      const result = await recordBlocked({ repoDir, branch, reason: 'ci-round-bound: 3 red "rounds"\nwith a newline' })
      expect(result.status).toBe('recorded')
      const after = tipOf(branch)
      expect(after).toBe(result.headSha)
      expect(git(repoDir, 'rev-list', '--count', `${before}..${after}`).trim()).toBe('1')
      expect(git(repoDir, 'rev-parse', `${after}^`).trim()).toBe(before)
      const file = `${where}/${branch.replace('story/', '')}.md`
      const { data } = parseFrontmatter(git(repoDir, 'show', `${after}:${file}`), file)
      expect(data.blocked).toBe('ci-round-bound: 3 red "rounds" with a newline')
      // main's copy is untouched, and the run leaves no local branch behind.
      expect(git(repoDir, 'show', 'origin/main:stories/OQ-9-a-story.md')).toContain('blocked: null')
      expect(git(repoDir, 'branch', '--list', branch).trim()).toBe('')
    }
  }, 30_000)

  it('OQ-48/AC-8: commits nothing when the coder\'s own blocked: is already on the branch', async () => {
    const branch = 'story/OQ-9-c-story'
    const before = tipOf(branch)
    expect(await recordBlocked({ repoDir, branch, reason: 'ignored' })).toMatchObject({ status: 'already-blocked', blocked: 'the coder asked' })
    expect(tipOf(branch)).toBe(before)
  })

  it('OQ-48/AC-8: withBlocked keeps everything else in the story and parses back', () => {
    const source = '---\nid: OQ-9\ntitle: t\ntier: normal\nkind: product\ndepends_on: []\nmodel: sonnet\nblocked: null\n---\n\nbody blocked: null\n'
    const out = withBlocked(source, 'a: "quoted" \\ reason')
    expect(parseFrontmatter(out, 'x.md').data.blocked).toBe('a: "quoted" \\ reason')
    expect(out.endsWith('\n\nbody blocked: null\n')).toBe(true)
    expect(existsSync(root)).toBe(true)
  })
})

describe('OQ-48/AC-9: resuming an existing pull request', () => {
  const resume = (h) => h.run({ prNumber: 7 })
  const untouched = (h) => {
    for (const name of ['dispatch', 'draft', 'record', 'retry', 'land', 'ci', 'review']) expect(h.names()).not.toContain(name)
  }

  it('OQ-48/AC-9: with no verdict marker at the head it continues from CI and never dispatches the coder', async () => {
    const h = harness({ ci: [green], reviews: [{ verdict: 'pass' }], lands: [{ status: 'merged' }] })
    expect((await resume(h)).status).toBe('merged')
    expect(h.names()).toEqual(['ci', 'review', 'land'])
  })

  it('OQ-48/AC-9: an honoured passing marker at the head goes to landing', async () => {
    const h = harness({ comments: [comment(1, 'pass-with-observations', H1)], lands: [{ status: 'merged' }] })
    expect((await resume(h)).status).toBe('merged')
    expect(h.names()).toEqual(['land'])
  })

  it('OQ-48/AC-9: an honoured block at the head goes to a review retry with its findings', async () => {
    const h = harness({ comments: [comment(1, 'block', H1, { text: 'Fix it.' })], retries: [{ status: 'session-failed' }] })
    await resume(h)
    expect(h.names().slice(0, 2)).toEqual(['retry', 'draft'])
    expect(h.calls[0][1]).toMatchObject({ source: 'review', round: 2 })
    expect(h.calls[0][1].findings).toContain('Fix it.')
  })

  it('OQ-48/AC-9: a marker for another head, or from an author the gate does not honour, is not a verdict', async () => {
    const h = harness({
      comments: [comment(1, 'pass', H2), comment(2, 'pass', H1, { association: 'NONE' })],
      ci: [green], reviews: [{ verdict: 'pass' }], lands: [{ status: 'merged' }],
    })
    await resume(h)
    expect(h.names()).toEqual(['ci', 'review', 'land'])
  })

  it('OQ-48/AC-9: a draft is reported as already stopped and nothing is changed', async () => {
    const h = harness({ pr: { state: 'open', head: { sha: H1, ref: BRANCH }, draft: true } })
    expect(await resume(h)).toMatchObject({ status: 'already-stopped', stopped: true })
    untouched(h)
  })

  it('OQ-48/AC-9: blocked: at the head is reported as already stopped and nothing is changed', async () => {
    const h = harness({ blockedAt: { blocked: 'why' }, comments: [comment(1, 'pass', H1)] })
    expect(await resume(h)).toMatchObject({ status: 'already-stopped' })
    untouched(h)
  })

  it('OQ-48/AC-9: an unreadable story file on an open pull request stops it as a draft, like any other stop', async () => {
    const h = harness({ blockedAt: { unreadable: 'no story file' } })
    const result = await resume(h)
    expect(result).toMatchObject({ status: 'story-unreadable', pr: 7, record: { draft: true } })
    expect(h.names()).toContain('draft')
  })

  it('OQ-48/AC-9: a pull request that is closed, or on another story\'s branch, stops with its own status', async () => {
    const closed = harness({ pr: { state: 'closed', head: { sha: H1, ref: BRANCH }, draft: false } })
    expect(await resume(closed)).toMatchObject({ status: 'pr-not-open' })
    const wrong = harness({ pr: { state: 'open', head: { sha: H1, ref: 'story/OQ-10-other' }, draft: false } })
    expect(await resume(wrong)).toMatchObject({ status: 'wrong-branch' })
    for (const h of [closed, wrong]) untouched(h)
  })
})

// --------------------------------------------------- OQ-128: id prefix from settings

/** A directory holding only a `steward.config.json` with the given `storyPrefix`. */
function withSettings(storyPrefix, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tw-story-settings-'))
  writeFileSync(path.join(dir, 'steward.config.json'), JSON.stringify({ repo: REPO, storyPrefix }))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

describe('OQ-128/AC-2: runStory takes its story-id check from settings\' storyPrefix', () => {
  it('refuses OQ-3 with the "requires a story id" error, under a project whose settings say ST', () =>
    withSettings('ST', async (dir) => {
      await expect(runStory({ storyId: 'OQ-3', repoDir: dir, ctx: {}, ciCtx: {}, landCtx: {} }))
        .rejects.toThrow('runStory requires a story id of the form ST-<n>, got "OQ-3"')
    }))

  it('accepts ST-3, going on past the story-id check, under the same settings', () =>
    withSettings('ST', async (dir) => {
      // Reaching dispatchCoder (rather than the story-id error) shows ST-3 passed the check.
      const calls = []
      const result = await runStory({
        storyId: 'ST-3', repoDir: dir, ctx: {}, ciCtx: {}, landCtx: {},
        deps: { dispatchCoder: async (args) => (calls.push(args), { status: 'nothing-ready' }) },
      })
      expect(calls).toHaveLength(1)
      expect(result).toMatchObject({ status: 'nothing-ready' })
    }))
})

// --------------------------------------------------- OQ-123: project root, not engine root

describe('OQ-123: the project root is the working directory, not the engine root', () => {
  const source = readFileSync(path.join(HERE, 'story.mjs'), 'utf8')

  it('OQ-123/AC-1: DISPATCHER_ROOT is gone from the module', () => {
    expect(source).not.toMatch(/DISPATCHER_ROOT/)
  })

  it('OQ-123/AC-2: the default repoDir reads settings from the current working directory', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tw-story-cwd-'))
    try {
      const filePath = path.join(dir, 'steward.config.json')
      let threw
      try {
        execFileSync('node', [path.join(HERE, 'story.mjs')], { cwd: dir, encoding: 'utf8' })
      } catch (error) {
        threw = error
      }
      expect(threw).toBeTruthy()
      // Engine root (this checkout) has its own steward.config.json; the error
      // naming `dir`'s path proves settings came from the working directory
      // (the project root), not from the engine's own.
      expect(threw.stderr).toContain(filePath)
      expect(threw.stderr).toContain('file not found')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
