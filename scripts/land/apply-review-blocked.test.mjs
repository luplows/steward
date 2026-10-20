import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyReviewBlocked, countBlockingVerdicts, decideReviewBlocked, REVIEW_BLOCKED_LABEL, ROUND_BOUND } from './apply-review-blocked.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const GATE = readFileSync(path.join(ROOT, '.github', 'workflows', 'review-gate.yml'), 'utf8')
const SHA = 'a'.repeat(40)

function marker(verdict, headSha = SHA) {
  return `<!-- agent-review head=${headSha} verdict=${verdict} -->`
}

function comment(verdict, authorAssociation = 'OWNER', headSha = SHA) {
  return { body: `findings\n\n${marker(verdict, headSha)}`, authorAssociation }
}

describe('OQ-80/AC-1: counting the round bound', () => {
  it('a pull request with three blocking verdicts from honoured authors is at the bound', () => {
    const comments = [comment('block'), comment('block'), comment('block')]
    expect(countBlockingVerdicts(comments)).toBe(3)
    expect(decideReviewBlocked({ comments, labels: [] })).toEqual({ apply: true, reason: 'bound-reached', count: 3 })
  })

  it('fewer than the bound does not apply the label', () => {
    const comments = [comment('block'), comment('block')]
    expect(decideReviewBlocked({ comments, labels: [] })).toEqual({ apply: false, reason: 'below-bound', count: 2 })
  })

  it('the bound restates OQ-48\'s AC-3 of three and must not drift from story.mjs\'s own MAX_ROUNDS', () => {
    expect(ROUND_BOUND).toBe(3)
    const storyModule = readFileSync(path.join(ROOT, 'scripts', 'dispatch', 'story.mjs'), 'utf8')
    const match = storyModule.match(/export const MAX_ROUNDS = (\d+)/)
    expect(match).not.toBeNull()
    expect(ROUND_BOUND).toBe(Number(match[1]))
  })

  it('a pass or pass-with-observations verdict does not count toward the bound', () => {
    const comments = [comment('block'), comment('block'), comment('pass'), comment('pass-with-observations')]
    expect(countBlockingVerdicts(comments)).toBe(2)
  })

  it('every well-formed block counts, on whatever head it names (design doc, "What the gate enforces": "counts toward the round bound like any other")', () => {
    const olderSha = 'b'.repeat(40)
    const comments = [comment('block', 'OWNER', olderSha), comment('block'), comment('block')]
    expect(countBlockingVerdicts(comments)).toBe(3)
  })

  it('applying the label calls the labels POST endpoint with the one label', () => {
    const calls = []
    const api = (args) => {
      calls.push(args)
      if (args[0].endsWith('/comments')) return [comment('block'), comment('block'), comment('block')].map((c) => JSON.stringify(c)).join('\n')
      if (args[0].endsWith('/labels')) return '[]'
      return ''
    }
    const decision = applyReviewBlocked('luplows/tower-workshop-paths', 42, api)
    expect(decision).toEqual({ apply: true, reason: 'bound-reached', count: 3 })
    const post = calls.find((c) => c[0] === '-X')
    expect(post).toEqual(['-X', 'POST', 'repos/luplows/tower-workshop-paths/issues/42/labels', '-f', `labels[]=${REVIEW_BLOCKED_LABEL}`])
  })
})

describe('OQ-80/AC-2: never removed, and not reapplied to a pull request that carries it', () => {
  it('a pull request already carrying the label is left alone, even past the bound', () => {
    const comments = [comment('block'), comment('block'), comment('block'), comment('block')]
    expect(decideReviewBlocked({ comments, labels: [REVIEW_BLOCKED_LABEL] })).toEqual({
      apply: false,
      reason: 'already-applied',
      count: null,
    })
  })

  it('applyReviewBlocked makes no labels request at all when the label is already there', () => {
    const calls = []
    const api = (args) => {
      calls.push(args)
      if (args[0].endsWith('/comments')) return [comment('block'), comment('block'), comment('block')].map((c) => JSON.stringify(c)).join('\n')
      if (args[0].endsWith('/labels')) return JSON.stringify([REVIEW_BLOCKED_LABEL])
      return ''
    }
    applyReviewBlocked('luplows/tower-workshop-paths', 42, api)
    expect(calls.some((c) => c[0] === '-X')).toBe(false)
  })

  it('nothing in this module can build a request that removes a label', () => {
    const calls = []
    const api = (args) => {
      calls.push(args)
      if (args[0].endsWith('/comments')) return [comment('block'), comment('block'), comment('block')].map((c) => JSON.stringify(c)).join('\n')
      if (args[0].endsWith('/labels')) return '[]'
      return ''
    }
    applyReviewBlocked('luplows/tower-workshop-paths', 1, api)
    for (const call of calls) expect(call).not.toContain('DELETE')
  })

  it('the workflow step itself runs unconditionally (if: always()), so a block on the triggering comment still lets the count through', () => {
    const stepAt = GATE.indexOf('name: Apply review-blocked at the round bound')
    expect(stepAt).toBeGreaterThan(-1)
    const stepText = GATE.slice(stepAt, GATE.indexOf('run: node scripts/land/apply-review-blocked.mjs') + 60)
    expect(stepText).toMatch(/if: always\(\)/)
  })

  it('the workflow runs the round-bound step after "Apply verdict from marker", not before', () => {
    const verdictAt = GATE.indexOf('name: Apply verdict from marker')
    const boundAt = GATE.indexOf('name: Apply review-blocked at the round bound')
    expect(verdictAt).toBeGreaterThan(-1)
    expect(boundAt).toBeGreaterThan(verdictAt)
  })
})

describe('OQ-80/AC-3: only markers the gate itself honours are counted', () => {
  it('a malformed marker (missing verdict, short sha) is not counted', () => {
    const comments = [
      { body: '<!-- agent-review head=abc123 verdict=block -->', authorAssociation: 'OWNER' },
      { body: '<!-- agent-review head=' + SHA + ' verdict=blocked -->', authorAssociation: 'OWNER' },
      comment('block'),
      comment('block'),
    ]
    expect(countBlockingVerdicts(comments)).toBe(2)
  })

  it('a well-formed block from an account without write access is not counted', () => {
    const comments = [comment('block', 'CONTRIBUTOR'), comment('block', 'NONE'), comment('block'), comment('block')]
    expect(countBlockingVerdicts(comments)).toBe(2)
  })

  it('the deprecated fail spelling counts the same as block', () => {
    const comments = [comment('fail'), comment('fail'), comment('fail')]
    expect(countBlockingVerdicts(comments)).toBe(3)
  })

  it('the last well-formed marker in a comment wins, as the gate applies it', () => {
    const comments = [
      { body: `${marker('block')}\n${marker('pass')}`, authorAssociation: 'OWNER' },
      comment('block'),
      comment('block'),
    ]
    // The corrected comment ends in pass, so it does not count as a block.
    expect(countBlockingVerdicts(comments)).toBe(2)
  })

  it('the marker pattern is the one review-gate.yml greps with, transcribed', () => {
    expect(GATE).toContain(
      'agent-review[[:space:]]+head=[0-9a-f]{40}[[:space:]]+verdict=(pass-with-observations|pass|block|fail)',
    )
    expect(countBlockingVerdicts([comment('block')])).toBe(1)
  })

  it('the association set is check-author.mjs\'s, kept identical to review-gate.yml by its own test', () => {
    expect(GATE).toContain('OWNER|MEMBER|COLLABORATOR')
  })
})

describe('OQ-80: permissions widened and stated in the workflow', () => {
  it('pull-requests is write, not read, with the cost stated in a comment', () => {
    const permsAt = GATE.indexOf('permissions:')
    const jobsAt = GATE.indexOf('jobs:')
    const permsBlock = GATE.slice(permsAt, jobsAt)
    expect(permsBlock).toMatch(/pull-requests:\s*write/)
    expect(permsBlock).not.toMatch(/pull-requests:\s*read/)
    expect(permsBlock).toMatch(/Widened from `read` to `write`/)
  })
})

describe('ST-16/AC-2: only blocks recorded since the latest removal count', () => {
  const at = (minute) => `2026-10-08T10:${String(minute).padStart(2, '0')}:00Z`
  const block = (minute) => ({ ...comment('block'), createdAt: at(minute) })
  const removal = (minute) => ({ createdAt: at(minute) })
  const decide = (comments, events, labels = []) => decideReviewBlocked({ comments, labels, events })

  it('ST-16/AC-2: no removal and three honoured blocks: applied', () => {
    expect(decide([block(1), block(2), block(3)], [])).toEqual({ apply: true, reason: 'bound-reached', count: 3 })
  })

  it('ST-16/AC-2: removed after three blocks, then two more: not applied', () => {
    const comments = [block(1), block(2), block(3), block(5), block(6)]
    expect(decide(comments, [removal(4)])).toEqual({ apply: false, reason: 'below-bound', count: 2 })
  })

  it('ST-16/AC-2: removed after three blocks, then three more: applied', () => {
    const comments = [block(1), block(2), block(3), block(5), block(6), block(7)]
    expect(decide(comments, [removal(4)])).toEqual({ apply: true, reason: 'bound-reached', count: 3 })
  })

  it('ST-16/AC-2: removed twice: only blocks after the second removal count', () => {
    const comments = [block(1), block(2), block(3), block(5), block(6), block(7), block(9), block(10)]
    expect(decide(comments, [removal(4), removal(8)])).toEqual({ apply: false, reason: 'below-bound', count: 2 })
    expect(decide(comments, [removal(8), removal(4)]).count).toBe(2)
  })

  it("ST-16/AC-2: a block whose created_at equals the removal's does not count", () => {
    const comments = [block(4), block(5), block(6)]
    expect(decide(comments, [removal(4)])).toEqual({ apply: false, reason: 'below-bound', count: 2 })
  })

  it('ST-16/AC-2: a label already present is left as it is', () => {
    const comments = [block(1), block(2), block(3)]
    expect(decide(comments, [], [REVIEW_BLOCKED_LABEL])).toEqual({ apply: false, reason: 'already-applied', count: null })
  })
})

describe('ST-16/AC-1 and AC-3: applyReviewBlocked reads the events and never removes a label', () => {
  const run = (comments, events) => {
    const calls = []
    const api = (args) => {
      calls.push(args)
      if (args[0].endsWith('/comments')) return comments.map((c) => JSON.stringify(c)).join('\n')
      if (args[0].endsWith('/events')) return events.map((e) => JSON.stringify(e)).join('\n')
      if (args[0].endsWith('/labels')) return '[]'
      return ''
    }
    return { calls, decision: applyReviewBlocked('luplows/steward', 7, api) }
  }
  const block = (t) => ({ ...comment('block'), createdAt: t })

  it("ST-16/AC-3: it requests the pull request's issue events, all pages, and never calls the labels-removal endpoint", () => {
    const { calls } = run([block('2026-10-08T10:01:00Z')], [])
    const events = calls.find((c) => c[0] === 'repos/luplows/steward/issues/7/events')
    expect(events).toBeDefined()
    expect(events).toContain('--paginate')
    expect(events.join(' ')).toContain('unlabeled')
    expect(events.join(' ')).toContain(REVIEW_BLOCKED_LABEL)
    expect(calls.some((c) => c.includes('DELETE') || c.some((a) => /labels\/[^/]+$/.test(a)))).toBe(false)
  })

  it("ST-16/AC-1: the comments request reads each comment's created_at", () => {
    const { calls } = run([], [])
    expect(calls.find((c) => c[0].endsWith('/comments')).join(' ')).toContain('created_at')
  })

  it('ST-16/AC-1: blocks before the latest removal event are not counted', () => {
    const comments = ['01', '02', '03', '05', '06'].map((m) => block(`2026-10-08T10:${m}:00Z`))
    const { decision, calls } = run(comments, [{ createdAt: '2026-10-08T10:04:00Z' }])
    expect(decision).toEqual({ apply: false, reason: 'below-bound', count: 2 })
    expect(calls.some((c) => c[0] === '-X')).toBe(false)
  })

  it('ST-16/AC-1: with no removal event every comment counts', () => {
    const comments = ['01', '02', '03'].map((m) => block(`2026-10-08T10:${m}:00Z`))
    expect(run(comments, []).decision).toEqual({ apply: true, reason: 'bound-reached', count: 3 })
  })
})

describe('ST-16/AC-4: review-gate.yml reads issue events', () => {
  it('permissions add issues: read, with a comment naming the events request', () => {
    const permsBlock = GATE.slice(GATE.indexOf('permissions:'), GATE.indexOf('jobs:'))
    expect(permsBlock).toMatch(/issues:\s*read/)
    expect(permsBlock).toMatch(/issue events \(ST-16's AC-1\)/)
  })
})
