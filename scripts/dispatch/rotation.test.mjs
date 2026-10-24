// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_REVIEWS, listLandingPullRequests, parseArgs, runRotation } from './rotation.mjs'

const SHA = (c) => c.repeat(40)
const CHECKED_OUT = SHA('c')

const pr = (number, overrides = {}) =>
  ({ number, headRef: `story/ST-${number}-x`, headSha: SHA('a'), draft: false, authorAssociation: 'OWNER', ...overrides })

const marker = (headSha, verdict, authorAssociation = 'OWNER') =>
  ({ authorAssociation, marker: { kind: 'marker', headSha, verdict } })

/**
 * A rotation with every dependency injected. Nothing here reaches GitHub, git, a reviewer, the
 * pilot or inspection. `calls` lists, in order, what was called: `list`, `review:<n>`, `land:<n>`,
 * `inspection`, ...
 */
function harness({
  lists = [[]], labels = {}, comments = {}, review = async () => ({ status: 'recorded', verdict: 'pass' }),
  land = async () => ({ status: 'merged' }), inspection = async () => 0, settings = {}, checkout,
  worktree, gitStatus = () => '', gitHead = () => CHECKED_OUT, maxReviews, update,
} = {}) {
  const calls = []
  const lines = []
  let listings = 0
  const deps = {
    requireOwnWorktree: async () => {
      calls.push('requireOwnWorktree')
      if (worktree) throw new Error(worktree)
    },
    updateCheckout: async () => {
      calls.push('updateCheckout')
      if (update) throw new Error(update)
      return checkout ?? { status: 'updated', headSha: CHECKED_OUT }
    },
    readSettings: async () => {
      calls.push('readSettings')
      if (settings.throws) throw new Error(settings.throws)
      return { repo: 'o/n', land: true, landWhen: 'all', ...settings }
    },
    createContext: ({ repo }) => ({ repo, kind: 'github' }),
    createLandContext: ({ repo, landing }) => ({ repo, landing, kind: 'land' }),
    createInspectContext: ({ repo }) => ({ repo, kind: 'inspect' }),
    listPullRequests: async () => {
      calls.push('list')
      const next = lists[Math.min(listings, lists.length - 1)]
      listings += 1
      if (next instanceof Error) throw next
      return next.map((p) => ({ ...p }))
    },
    getPullRequestLabels: async (_ctx, number) => labels[number] ?? [],
    listPullRequestComments: async (_ctx, number) => {
      const found = comments[number] ?? []
      return typeof found === 'function' ? found() : found
    },
    reviewPullRequest: async (args) => {
      calls.push(`review:${args.number}`)
      const result = typeof review === 'function' ? await review(args) : review
      return result
    },
    landPullRequest: async (args) => {
      calls.push(`land:${args.number}`)
      return land(args)
    },
    inspection: async (args) => {
      calls.push('inspection')
      return inspection(args)
    },
    git: async (_cwd, args) => {
      calls.push(`git:${args[0]}`)
      return args[0] === 'rev-parse' ? `${gitHead()}\n` : gitStatus()
    },
  }
  const run = () => runRotation({ repoDir: '/wt', maxReviews, deps, out: (line) => lines.push(line) })
  return { run, calls, lines, deps }
}

const reviewsOf = (calls) => calls.filter((c) => c.startsWith('review:'))
const landsOf = (calls) => calls.filter((c) => c.startsWith('land:'))

describe('ST-25/AC-1: the command and its arguments', () => {
  it('ST-25/AC-1: --max-reviews defaults to 5 and takes a positive integer; --repo is optional', () => {
    expect(DEFAULT_MAX_REVIEWS).toBe(5)
    expect(parseArgs([])).toEqual({ maxReviews: 5, repo: undefined })
    expect(parseArgs(['--max-reviews', '12', '--repo', 'o/n'])).toEqual({ maxReviews: 12, repo: 'o/n' })
  })

  for (const bad of ['0', '-1', '1.5', 'x', '05', '']) {
    it(`ST-25/AC-1: --max-reviews ${JSON.stringify(bad)} is refused`, () => {
      expect(() => parseArgs(['--max-reviews', bad])).toThrow(/--max-reviews|usage/)
    })
  }

  it('ST-25/AC-1: a flag without its value, and anything else, are refused', () => {
    expect(() => parseArgs(['--max-reviews'])).toThrow(/usage/)
    expect(() => parseArgs(['--repo'])).toThrow(/usage/)
    expect(() => parseArgs(['--max-reviews', '--repo', 'o/n'])).toThrow(/usage/)
    expect(() => parseArgs(['extra'])).toThrow(/usage/)
  })

  it('ST-25/AC-1: the cap given is the cap used', async () => {
    const h = harness({ lists: [[pr(1), pr(2), pr(3)]], maxReviews: 1 })
    await h.run()
    expect(reviewsOf(h.calls)).toEqual(['review:1'])
  })
})

describe('ST-25/AC-2: step 1, the worktree', () => {
  it('ST-25/AC-2: a checkout with a branch is refused before anything is updated, read or listed', async () => {
    const h = harness({ worktree: '/wt has a branch checked out' })
    const result = await h.run()
    expect(h.calls).toEqual(['requireOwnWorktree'])
    expect(result).toMatchObject({ status: 'branch-checked-out', exitCode: 1 })
    expect(h.lines.join('\n')).toContain('/wt has a branch checked out')
  })

  it('ST-25/AC-2: a dirty worktree stops the rotation, doing nothing more', async () => {
    const h = harness({ checkout: { status: 'dirty', paths: ['a.txt', 'b.txt'] }, lists: [[pr(1)]] })
    const result = await h.run()
    expect(h.calls).toEqual(['requireOwnWorktree', 'updateCheckout'])
    expect(result).toMatchObject({ status: 'dirty', exitCode: 1 })
    expect(h.lines.join('\n')).toContain('a.txt, b.txt')
  })

  it('ST-25/AC-2: a worktree that cannot be brought to origin/main stops the rotation', async () => {
    const h = harness({ update: 'fetch failed' })
    const result = await h.run()
    expect(h.calls).toEqual(['requireOwnWorktree', 'updateCheckout'])
    expect(result).toMatchObject({ status: 'update-failed', exitCode: 1 })
  })

  it('ST-25/AC-2: the settings are read after the update, and settings that do not read stop the rotation', async () => {
    const ok = harness({ lists: [[]] })
    await ok.run()
    expect(ok.calls.slice(0, 4)).toEqual(['requireOwnWorktree', 'updateCheckout', 'readSettings', 'list'])
    const bad = harness({ settings: { throws: 'steward.config.json: file not found' } })
    const result = await bad.run()
    expect(bad.calls).toEqual(['requireOwnWorktree', 'updateCheckout', 'readSettings'])
    expect(result).toMatchObject({ status: 'settings-unreadable', exitCode: 1 })
  })

  it('ST-25/AC-2: --repo wins over the settings\' repo', async () => {
    const seen = []
    const h = harness({ lists: [[pr(1)]] })
    h.deps.createContext = ({ repo }) => {
      seen.push(repo)
      return {}
    }
    await runRotation({ repoDir: '/wt', repo: 'other/repo', deps: h.deps, out: () => {} })
    expect(seen).toEqual(['other/repo'])
  })
})

describe('ST-25/AC-3: steps 2 and 3, the listing and the reviews', () => {
  it('ST-25/AC-3: lists once in step 2, reviews oldest first and stops at the cap', async () => {
    const h = harness({
      lists: [[pr(9), pr(3), pr(7), pr(5)]], maxReviews: 2, settings: { land: false },
      review: async () => ({ status: 'recorded', verdict: 'block' }),
    })
    const result = await h.run()
    expect(reviewsOf(h.calls)).toEqual(['review:3', 'review:5'])
    expect(h.calls.filter((c) => c === 'list')).toHaveLength(1)
    expect(result).toMatchObject({ status: 'finished', exitCode: 0 })
    expect(h.lines.join('\n')).toMatch(/#7 not reviewed: the cap of 2 reviews was reached/)
    expect(h.lines.join('\n')).toMatch(/#9 not reviewed: the cap/)
  })

  it('ST-25/AC-3: a draft, an outsider, a review-blocked one and one with a verdict at its head are skipped, and nothing else is', async () => {
    const h = harness({
      lists: [[
        pr(1, { draft: true }), pr(2, { authorAssociation: 'CONTRIBUTOR' }), pr(3), pr(4), pr(5), pr(6, { authorAssociation: 'NONE' }),
      ]],
      labels: { 3: ['review-blocked'] },
      comments: { 4: [marker(SHA('a'), 'block')], 5: [marker(SHA('b'), 'pass')] },
      settings: { land: false },
    })
    await h.run()
    expect(reviewsOf(h.calls)).toEqual(['review:5'])
    const text = h.lines.join('\n')
    expect(text).toMatch(/#1 skipped: a draft/)
    expect(text).toMatch(/#2 skipped: outsider \(CONTRIBUTOR\)/)
    expect(text).toMatch(/#3 skipped: labelled review-blocked/)
    expect(text).toMatch(/#4 skipped: a verdict is already at its head/)
    expect(text).toMatch(/#6 skipped: outsider \(NONE\)/)
  })

  it('ST-25/AC-3: a verdict from an author the gate does not honour is not a verdict', async () => {
    const h = harness({
      lists: [[pr(4)]], comments: { 4: [marker(SHA('a'), 'pass', 'CONTRIBUTOR')] }, settings: { land: false },
    })
    await h.run()
    expect(reviewsOf(h.calls)).toEqual(['review:4'])
  })

  it('ST-25/AC-3: a pull request is a candidate whoever opened it, the loop\'s own branch included', async () => {
    const h = harness({ lists: [[pr(2, { headRef: 'story/ST-2-y' }), pr(3, { headRef: 'feature/z' })]], settings: { land: false } })
    await h.run()
    expect(reviewsOf(h.calls)).toEqual(['review:2', 'review:3'])
  })

  it('ST-25/AC-3: the review is handed the pull request, the context and the rotation\'s worktree, and no choice', async () => {
    const seen = []
    const h = harness({ lists: [[pr(2)]], settings: { land: false }, review: async (args) => {
      seen.push(args)
      return { status: 'recorded', verdict: 'pass' }
    } })
    await h.run()
    expect(seen).toEqual([{ number: 2, ctx: { repo: 'o/n', kind: 'github' }, repoDir: '/wt' }])
  })

  it('ST-25/AC-3: a review-blocked pull request with a passing verdict at its head is still passed to the pilot, which says review-blocked', async () => {
    const h = harness({
      lists: [[pr(3)]], labels: { 3: ['review-blocked'] }, comments: { 3: [marker(SHA('a'), 'pass')] },
      land: async () => ({ status: 'review-blocked' }),
    })
    await h.run()
    expect(reviewsOf(h.calls)).toEqual([])
    expect(landsOf(h.calls)).toEqual(['land:3'])
    expect(h.lines.join('\n')).toMatch(/#3 skipped: labelled review-blocked; landing: review-blocked/)
  })

  it('ST-25/AC-3: a listing that fails stops the rotation', async () => {
    const h = harness({ lists: [new Error('GET failed: 500')] })
    const result = await h.run()
    expect(result).toMatchObject({ status: 'listing-failed', exitCode: 1 })
    expect(h.calls).not.toContain('inspection')
  })

  it('ST-25/AC-3: the listing covers main and each release branch, and no other base', async () => {
    const sent = []
    const ctx = {
      repo: 'o/n',
      send: async (request) => {
        sent.push(request.url)
        const base = /base=([^&]+)/.exec(request.url)[1]
        return [{ number: base === 'main' ? 1 : 2, head: { ref: 'r', sha: SHA('a') }, draft: false, author_association: 'OWNER' }]
      },
    }
    const inspectCtx = {
      repo: 'o/n',
      send: async () => [{ ref: 'refs/heads/release/v0.1.0' }, { ref: 'refs/heads/release/next' }, { ref: 'refs/heads/release/v1.0.0' }],
    }
    const prs = await listLandingPullRequests({ ctx, inspectCtx })
    expect(prs.map((p) => p.number)).toEqual([1, 2, 2])
    expect(sent.map((u) => decodeURIComponent(/base=([^&]+)/.exec(u)[1]))).toEqual(['main', 'release/v0.1.0', 'release/v1.0.0'])
  })
})

describe('ST-25/AC-4: step 4, landing', () => {
  it('ST-25/AC-4: lands, one at a time and with once, each pull request with a passing verdict at its head, one that passed in an earlier rotation included', async () => {
    const seen = []
    const h = harness({
      lists: [[pr(1), pr(2, { headSha: SHA('b') }), pr(3)]],
      comments: {
        1: [marker(SHA('a'), 'pass')], // passed in an earlier rotation
        2: [marker(SHA('b'), 'pass-with-observations')],
        3: [marker(SHA('a'), 'block')],
      },
      land: async (args) => {
        seen.push(args)
        return { status: 'merged' }
      },
    })
    const result = await h.run()
    expect(reviewsOf(h.calls)).toEqual([])
    expect(landsOf(h.calls)).toEqual(['land:1', 'land:2'])
    expect(seen.map((a) => [a.once, a.passedAt, a.ctx.landing])).toEqual([[true, SHA('a'), true], [true, SHA('b'), true]])
    expect(h.lines.join('\n')).toMatch(/#3 skipped: a verdict is already at its head; not landed: no passing verdict at its head/)
    expect(result.exitCode).toBe(0)
  })

  it('ST-25/AC-4: each pull request step 2 listed is read again for step 4, so a verdict at the current head is the one that counts', async () => {
    const h = harness({
      lists: [[pr(1)], [pr(1, { headSha: SHA('b') })]],
      comments: { 1: [marker(SHA('a'), 'pass')] },
    })
    await h.run()
    expect(h.calls.filter((c) => c === 'list')).toHaveLength(2)
    expect(landsOf(h.calls)).toEqual([])
  })

  it('ST-25/AC-4: a pull request that appears after step 2, even with a passing verdict, is not landed in this rotation', async () => {
    const h = harness({
      lists: [[pr(1)], [pr(1), pr(2)]],
      comments: { 1: [marker(SHA('a'), 'pass')], 2: [marker(SHA('a'), 'pass')] },
    })
    const result = await h.run()
    expect(landsOf(h.calls)).toEqual(['land:1'])
    expect(h.lines.join('\n')).not.toMatch(/#2 /)
    expect(result).toMatchObject({ status: 'finished', exitCode: 0 })
  })

  it('ST-25/AC-4: a pull request step 2 listed that has since closed is printed as not landed, and the rotation goes on', async () => {
    const h = harness({
      lists: [[pr(1), pr(2)], [pr(2)]],
      comments: { 1: [marker(SHA('a'), 'pass')], 2: [marker(SHA('a'), 'pass')] },
    })
    const result = await h.run()
    expect(landsOf(h.calls)).toEqual(['land:2'])
    expect(h.lines).toContain('#1 skipped: a verdict is already at its head; not landed: no longer open')
    expect(h.calls).toContain('inspection')
    expect(result).toMatchObject({ status: 'finished', exitCode: 0 })
  })

  it('ST-25/AC-4: a pull request reviewed and passed in this rotation is landed in it', async () => {
    let posted = false
    const h = harness({
      lists: [[pr(1)]],
      comments: { 1: () => (posted ? [marker(SHA('a'), 'pass')] : []) },
      review: async () => {
        posted = true
        return { status: 'recorded', verdict: 'pass' }
      },
    })
    await h.run()
    expect(h.calls.filter((c) => /^(review|land)/.test(c))).toEqual(['review:1', 'land:1'])
  })

  it('ST-25/AC-4: with land false nothing is landed, and the pull requests are not read again', async () => {
    const h = harness({
      lists: [[pr(1)]], comments: { 1: [marker(SHA('a'), 'pass')] }, settings: { land: false },
    })
    const result = await h.run()
    expect(landsOf(h.calls)).toEqual([])
    expect(h.calls.filter((c) => c === 'list')).toHaveLength(1)
    expect(h.lines.join('\n')).toMatch(/#1 skipped: a verdict is already at its head; not landed: landing is off/)
    expect(result.exitCode).toBe(0)
  })

  it('ST-25/AC-4: the pilot is given a land context built from the settings\' land and landWhen', async () => {
    const seen = []
    const h = harness({ lists: [[pr(1)]], comments: { 1: [marker(SHA('a'), 'pass')] }, settings: { landWhen: ['test'] } })
    h.deps.createLandContext = (args) => {
      seen.push(args)
      return args
    }
    await h.run()
    expect(seen).toEqual([{ repo: 'o/n', landing: true, landWhen: ['test'] }])
  })
})

describe('ST-25/AC-4a: inspection', () => {
  it('ST-25/AC-4a: runs once, after the landings, and its output is printed', async () => {
    const h = harness({
      lists: [[pr(1), pr(2)]], comments: { 1: [marker(SHA('a'), 'pass')], 2: [marker(SHA('a'), 'pass')] },
      inspection: async ({ repo, cwd, out }) => {
        out('0 findings: 0 opened, 0 already raised')
        expect([repo, cwd]).toEqual(['o/n', '/wt'])
        return 0
      },
    })
    const result = await h.run()
    expect(h.calls.filter((c) => /^(land|inspection)/.test(c))).toEqual(['land:1', 'land:2', 'inspection'])
    expect(h.lines).toContain('0 findings: 0 opened, 0 already raised')
    expect(h.lines).toContain('inspection exit code: 0')
    expect(result).toMatchObject({ status: 'finished', exitCode: 0 })
  })

  it('ST-25/AC-4a: runs when landing is off', async () => {
    const h = harness({ settings: { land: false } })
    await h.run()
    expect(h.calls).toContain('inspection')
  })

  it('ST-25/AC-4a: a non-zero exit code of inspection is printed and leaves the rotation\'s exit code as it was', async () => {
    for (const code of [1, 2]) {
      const h = harness({ lists: [[pr(1)]], comments: { 1: [marker(SHA('a'), 'pass')] }, inspection: async () => code })
      const result = await h.run()
      expect(h.lines).toContain(`inspection exit code: ${code}`)
      expect(landsOf(h.calls)).toEqual(['land:1'])
      expect(result).toMatchObject({ status: 'finished', exitCode: 0 })
    }
  })

  it('ST-25/AC-4a: an error inside inspection is printed and leaves the rotation\'s exit code as it was', async () => {
    const h = harness({
      lists: [[pr(1)]], comments: { 1: [marker(SHA('a'), 'pass')] },
      inspection: async () => {
        throw new Error('inspection broke')
      },
    })
    const result = await h.run()
    expect(h.lines).toContain('inspection error: inspection broke')
    expect(h.lines.join('\n')).toMatch(/#1 .*landing: merged/)
    expect(result).toMatchObject({ status: 'finished', exitCode: 0 })
  })
})

describe('ST-25/AC-5: step 5, the lines and the exit code', () => {
  it('ST-25/AC-5: prints one line per pull request considered, with its number and outcome, and exits 0', async () => {
    const h = harness({
      lists: [[pr(1, { draft: true }), pr(2), pr(3)]],
      comments: { 3: [marker(SHA('a'), 'pass')] },
      review: async () => ({ status: 'recorded', verdict: 'block' }),
    })
    const result = await h.run()
    const perPullRequest = h.lines.filter((line) => /^#\d+ /.test(line))
    expect(perPullRequest).toEqual([
      '#1 skipped: a draft; not landed: no passing verdict at its head',
      '#2 reviewed: recorded (block); not landed: no passing verdict at its head',
      '#3 skipped: a verdict is already at its head; landing: merged',
    ])
    expect(result).toEqual({ status: 'finished', exitCode: 0, lines: h.lines })
  })

  it('ST-25/AC-5: an outcome from a script that is not a failure of the rotation is printed and the rotation goes on', async () => {
    const statuses = {
      1: { status: 'no-verdict', summary: 'the head moved' },
      2: { status: 'over-usage', reason: 'weekly 95 over 90' },
      3: { status: 'head-moved', reason: 'moved' },
      4: { status: 'session-failed', reason: 'timed out' },
    }
    const h = harness({
      lists: [[pr(1), pr(2), pr(3), pr(4)]], settings: { land: false }, review: async ({ number }) => statuses[number],
    })
    const result = await h.run()
    expect(reviewsOf(h.calls)).toHaveLength(4)
    expect(h.lines.join('\n')).toMatch(/#2 reviewed: over-usage \(weekly 95 over 90\)/)
    expect(result.exitCode).toBe(0)
  })
})

describe('ST-25/AC-5a: a script error stops the rotation', () => {
  it('ST-25/AC-5a: a review that throws names the pull request and the step, and nothing more is reviewed or landed', async () => {
    const h = harness({
      lists: [[pr(1), pr(2)]], comments: { 2: [marker(SHA('a'), 'pass')] },
      review: async ({ number }) => {
        if (number === 1) throw new Error('boom')
        return { status: 'recorded', verdict: 'pass' }
      },
    })
    const result = await h.run()
    expect(reviewsOf(h.calls)).toEqual(['review:1'])
    expect(landsOf(h.calls)).toEqual([])
    expect(h.calls).not.toContain('inspection')
    expect(result).toMatchObject({ status: 'script-error', exitCode: 1 })
    expect(h.lines.join('\n')).toMatch(/step 3, the review of #1 threw: boom/)
  })

  it('ST-25/AC-5a: a landing that throws names the pull request and the step, and lands nothing more', async () => {
    const h = harness({
      lists: [[pr(1), pr(2)]], comments: { 1: [marker(SHA('a'), 'pass')], 2: [marker(SHA('a'), 'pass')] },
      land: async () => {
        throw new Error('send failed')
      },
    })
    const result = await h.run()
    expect(landsOf(h.calls)).toEqual(['land:1'])
    expect(h.calls).not.toContain('inspection')
    expect(result).toMatchObject({ status: 'script-error', exitCode: 1 })
    expect(h.lines.join('\n')).toMatch(/step 4, landing #1 threw: send failed/)
  })

  it('ST-25/AC-5a: a status that is neither recorded nor merged is that pull request\'s outcome, and the rotation goes on', async () => {
    const h = harness({
      lists: [[pr(1), pr(2), pr(3)]],
      review: async ({ number }) => (number === 1 ? { status: 'malformed-verdict', reason: 'twice' } : { status: 'recorded', verdict: 'block' }),
      comments: { 3: [marker(SHA('a'), 'pass')] },
      land: async () => ({ status: 'conflict' }),
    })
    const result = await h.run()
    expect(reviewsOf(h.calls)).toEqual(['review:1', 'review:2'])
    expect(landsOf(h.calls)).toEqual(['land:3'])
    expect(result.exitCode).toBe(0)
  })
})

describe('ST-25/AC-5b: a worktree changed by a review stops the rotation', () => {
  it('ST-25/AC-5b: a HEAD that is not the commit step 1 checked out is found after the first review, before any landing', async () => {
    const h = harness({
      lists: [[pr(1), pr(2), pr(3)]], comments: { 3: [marker(SHA('a'), 'pass')] }, gitHead: () => SHA('d'),
    })
    const result = await h.run()
    expect(reviewsOf(h.calls)).toEqual(['review:1'])
    expect(landsOf(h.calls)).toEqual([])
    expect(h.calls).not.toContain('inspection')
    expect(h.calls.slice(h.calls.indexOf('review:1'))).toEqual(['review:1', 'git:rev-parse', 'git:status'])
    expect(result).toMatchObject({ status: 'worktree-changed', exitCode: 1 })
    expect(h.lines.join('\n')).toMatch(/review of #1 came before a change/)
  })

  it('ST-25/AC-5b: anything git status prints is a change too', async () => {
    const h = harness({ lists: [[pr(1), pr(2)]], gitStatus: () => ' M .claude/prompts/reviewer.md\n' })
    const result = await h.run()
    expect(reviewsOf(h.calls)).toEqual(['review:1'])
    expect(result.status).toBe('worktree-changed')
    expect(h.lines.join('\n')).toContain('reviewer.md')
  })

  it('ST-25/AC-5b: the check is made after each review, and an unchanged worktree lets the rotation go on', async () => {
    const h = harness({ lists: [[pr(1), pr(2)]], settings: { land: false } })
    await h.run()
    expect(h.calls.filter((c) => c.startsWith('git:'))).toEqual(['git:rev-parse', 'git:status', 'git:rev-parse', 'git:status'])
  })

  it('ST-25/AC-5b: a change found after the second review is attributed to the second', async () => {
    let reviewed = 0
    const h = harness({
      lists: [[pr(1), pr(2)]],
      review: async () => {
        reviewed += 1
        return { status: 'recorded', verdict: 'block' }
      },
      gitStatus: () => (reviewed >= 2 ? '?? stray\n' : ''),
    })
    const result = await h.run()
    expect(result.status).toBe('worktree-changed')
    expect(h.lines.join('\n')).toMatch(/review of #2 came before/)
  })
})

describe('ST-25/AC-5c: a reviewer that could not review stops the rotation', () => {
  it('ST-25/AC-5c: cannot-review on the first of two pull requests stops before the second is reviewed and before any landing', async () => {
    const h = harness({
      lists: [[pr(1), pr(2), pr(3)]], comments: { 3: [marker(SHA('a'), 'pass')] },
      review: async () => ({ status: 'cannot-review', summary: 'the reviewer printed no verdict' }),
    })
    const result = await h.run()
    expect(reviewsOf(h.calls)).toEqual(['review:1'])
    expect(landsOf(h.calls)).toEqual([])
    expect(h.calls).not.toContain('inspection')
    expect(result).toMatchObject({ status: 'cannot-review', exitCode: 1 })
    expect(h.lines.join('\n')).toMatch(/#1 reviewed: cannot-review/)
    expect(h.lines.join('\n')).toContain('the reviewer printed no verdict')
  })
})

describe('ST-25/AC-5d: a refusal that holds for every pull request ends the reviewing, not the rotation', () => {
  for (const status of ['rules-unreadable', 'choice-unavailable']) {
    it(`ST-25/AC-5d: ${status} on the first of two pull requests: the second is not reviewed, a third that passed earlier is landed, inspection runs`, async () => {
      const h = harness({
        lists: [[pr(1), pr(2), pr(3)]], comments: { 3: [marker(SHA('a'), 'pass')] },
        review: async () => ({ status, reason: `${status} because` }),
      })
      const result = await h.run()
      expect(reviewsOf(h.calls)).toEqual(['review:1'])
      expect(landsOf(h.calls)).toEqual(['land:3'])
      expect(h.calls).toContain('inspection')
      expect(result).toMatchObject({ status: 'finished', exitCode: 0 })
      const text = h.lines.join('\n')
      expect(text).toContain(`#1 reviewed: ${status} (${status} because)`)
      expect(text).toContain(`#2 not reviewed: reviewing ended at #1 (${status})`)
    })
  }

  for (const status of ['over-usage', 'usage-unknown', 'reviewer-unavailable']) {
    it(`ST-25/AC-5d: ${status} on the first is that pull request's outcome, and the second is still reviewed`, async () => {
      const h = harness({
        lists: [[pr(1), pr(2)]], settings: { land: false },
        review: async ({ number }) => (number === 1 ? { status, reason: 'why' } : { status: 'recorded', verdict: 'pass' }),
      })
      const result = await h.run()
      expect(reviewsOf(h.calls)).toEqual(['review:1', 'review:2'])
      expect(result).toMatchObject({ status: 'finished', exitCode: 0 })
      expect(h.lines.join('\n')).toContain(`#1 reviewed: ${status} (why)`)
    })
  }
})

describe('ST-25/AC-5e: every result of the pilot is printed, and landing goes on', () => {
  const results = [
    [{ status: 'merged' }, 'merged'],
    [{ status: 'sweep-pending' }, 'sweep-pending'],
    [{ status: 'closed' }, 'closed'],
    [{ status: 'head-moved', newHeadSha: SHA('9') }, `head-moved (new head: ${SHA('9')})`],
    [{ status: 'landing-off' }, 'landing-off'],
    [{ status: 'draft' }, 'draft'],
    [{ status: 'review-blocked' }, 'review-blocked'],
    [{ status: 'review-failed' }, 'review-failed'],
    [{ status: 'conflict' }, 'conflict'],
    [{ status: 'checks-failed', failing: ['test', 'lint'] }, 'checks-failed (failing: test, lint)'],
    [{ status: 'github-blocked' }, 'github-blocked'],
    [{ status: 'not-landable', reason: 'checks-pending', waiting: ['test'] }, 'not-landable (reason: checks-pending; waiting: test)'],
  ]
  for (const [result, printed] of results) {
    it(`ST-25/AC-5e: ${result.status} on the first pull request is printed with its fields, and the second is still landed`, async () => {
      const h = harness({
        lists: [[pr(1), pr(2)]], comments: { 1: [marker(SHA('a'), 'pass')], 2: [marker(SHA('a'), 'pass')] },
        land: async ({ number }) => (number === 1 ? result : { status: 'merged' }),
      })
      const final = await h.run()
      expect(landsOf(h.calls)).toEqual(['land:1', 'land:2'])
      expect(h.lines).toContain(`#1 skipped: a verdict is already at its head; landing: ${printed}`)
      expect(h.lines).toContain('#2 skipped: a verdict is already at its head; landing: merged')
      expect(final).toMatchObject({ status: 'finished', exitCode: 0 })
    })
  }
})

describe('ST-25/AC-6: the rest of the behaviour', () => {
  it('ST-25/AC-6: a review that records no verdict leaves the pull request to the next rotation: nothing is landed for it', async () => {
    const h = harness({
      lists: [[pr(1)]], review: async () => ({ status: 'no-verdict', summary: 'head moved' }),
    })
    const result = await h.run()
    expect(landsOf(h.calls)).toEqual([])
    expect(h.lines.join('\n')).toContain('#1 reviewed: no-verdict (head moved); not landed: no passing verdict at its head')
    expect(result.exitCode).toBe(0)
  })

  it('ST-25/AC-6: a rotation stores nothing: two rotations over the same state print the same lines', async () => {
    const make = () => harness({ lists: [[pr(1), pr(2)]], comments: { 2: [marker(SHA('a'), 'pass')] } })
    const a = make()
    const b = make()
    await a.run()
    await b.run()
    expect(a.lines).toEqual(b.lines)
  })
})
