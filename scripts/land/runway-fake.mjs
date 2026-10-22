// A fake of what `runway.mjs` reads from GitHub, for the tests of that command and of the rules
// it carries (`check-author.test.mjs`, `checks-green.test.mjs`, `select-candidates.test.mjs`).
// Not a test itself.

export const REPO = 'owner/project'
export const SHA_OF = (number) => String(number).padStart(40, 'c')

const GREEN_RUN = { name: 'test', status: 'completed', conclusion: 'success', id: 1 }
const REVIEW_PASSED = { context: 'review/agent', state: 'success', id: 2 }

/** One open pull request as the fake serves it; every field may be overridden. */
export function pull(number, overrides = {}) {
  return {
    number,
    draft: false,
    base: 'main',
    sha: SHA_OF(number),
    association: 'OWNER',
    labels: [],
    mergeableState: 'clean',
    files: ['src/a.js'],
    checkRuns: [GREEN_RUN],
    statuses: [REVIEW_PASSED],
    ...overrides,
  }
}

const lines = (items) => items.map((item) => JSON.stringify(item)).join('\n')

/**
 * `{ deps, calls, logs, merges }`: `deps` for `runRunway`. `pulls` are served oldest first.
 * `blockedCount` overrides the number of open pull requests the fake says carry `review-blocked`.
 * `calls` records each argument list given to `api`.
 */
export function fakeGitHub({ pulls = [], blockedCount = null, landWhen = 'all-checks' } = {}) {
  const calls = []
  const logs = []
  const merges = []
  const byNumber = (n) => pulls.find((p) => p.number === Number(n))
  const bySha = (sha) => pulls.find((p) => p.sha === sha)

  const api = (args) => {
    calls.push(args)
    const url = args.find((a) => a.startsWith('repos/')) ?? ''
    const path = url.replace(`repos/${REPO}/`, '').split('?')[0]
    if (url.includes('/contents/')) return JSON.stringify({ landWhen })
    if (path === 'pulls' && url.includes('sort=created')) {
      return JSON.stringify(pulls.map((p) => ({ number: p.number, draft: p.draft, base: { ref: p.base } })))
    }
    if (path === 'pulls') {
      return String(blockedCount ?? pulls.filter((p) => p.labels.includes('review-blocked')).length)
    }
    let match = path.match(/^pulls\/(\d+)\/files$/)
    if (match) return lines(byNumber(match[1]).files)
    match = path.match(/^pulls\/(\d+)$/)
    if (match) {
      const p = byNumber(match[1])
      return JSON.stringify({
        head: { sha: p.sha },
        mergeable_state: p.mergeableState,
        author_association: p.association,
        labels: p.labels.map((name) => ({ name })),
      })
    }
    match = path.match(/^commits\/([0-9a-f]{40})\/check-runs$/)
    if (match) return lines(bySha(match[1]).checkRuns)
    match = path.match(/^commits\/([0-9a-f]{40})\/status$/)
    if (match) {
      const p = bySha(match[1])
      // As GitHub does: a read without `--paginate` gets one page of `per_page` statuses, 30 when
      // the request names none.
      const perPage = Number(/per_page=(\d+)/.exec(url)?.[1] ?? 30)
      return args.includes('--paginate')
        ? lines(p.statuses)
        : JSON.stringify({ statuses: p.statuses.slice(0, perPage) })
    }
    throw new Error(`unexpected gh api call: ${args.join(' ')}`)
  }

  return {
    deps: { api, merge: (args) => merges.push(args), log: (line) => logs.push(line) },
    calls,
    logs,
    merges,
  }
}
