import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { deleteMergedHeads, ghApi, LIST_PROJECTION } from './delete-merged-heads.mjs'

const REPO = 'luplows/tower-workshop-paths'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function pr(number, ref, sha, extra = {}) {
  return {
    number,
    merged_at: '2026-09-18T16:22:00Z',
    head: { ref, sha, repo: { full_name: REPO } },
    base: { ref: 'main' },
    ...extra,
  }
}

// A fake `gh api`: `tips` maps ref -> sha for branches that exist on origin.
function fakeApi(closed, tips, { failDelete = false } = {}) {
  const deleted = []
  const api = (args) => {
    const url = args[0]
    if (args[0] === '-X') {
      if (failDelete) throw new Error('HTTP 422')
      deleted.push(args[2].replace(`repos/${REPO}/git/refs/heads/`, ''))
      return ''
    }
    if (url.startsWith(`repos/${REPO}/pulls?`)) return JSON.stringify(closed)
    const ref = url.replace(`repos/${REPO}/git/ref/heads/`, '')
    if (!(ref in tips)) throw new Error('HTTP 404')
    return `${tips[ref]}\n`
  }
  return { api, deleted }
}

describe('deleteMergedHeads', () => {
  it('OQ-52/AC-1 - deletes the head branch of a merged PR that is still on origin', () => {
    const { api, deleted } = fakeApi([pr(98, 'story/OQ-49-x', 'aaa')], { 'story/OQ-49-x': 'aaa' })
    expect(deleteMergedHeads(REPO, api)).toEqual([{ pr: 98, ref: 'story/OQ-49-x', outcome: 'deleted' }])
    expect(deleted).toEqual(['story/OQ-49-x'])
  })

  it('OQ-52/AC-1 - the landing workflow runs the deletion after the merge step, even when the merge step fails', () => {
    const yml = readFileSync(path.join(ROOT, '.github/workflows/land-approved.yml'), 'utf8')
    const mergeAt = yml.indexOf('gh pr merge')
    const cleanupAt = yml.indexOf('run: node scripts/land/delete-merged-heads.mjs')
    expect(mergeAt).toBeGreaterThan(-1)
    expect(cleanupAt).toBeGreaterThan(mergeAt)
    expect(yml.slice(yml.lastIndexOf('- name:', cleanupAt), cleanupAt)).toMatch(/if: always\(\)/)
  })

  it('OQ-52/AC-2 - a branch that is already gone is not an error', () => {
    const { api, deleted } = fakeApi([pr(98, 'story/gone', 'aaa')], {})
    expect(deleteMergedHeads(REPO, api)).toEqual([])
    expect(deleted).toEqual([])
  })

  it('OQ-52/AC-2 - a branch that cannot be deleted is reported, not thrown', () => {
    const { api } = fakeApi([pr(98, 'story/x', 'aaa')], { 'story/x': 'aaa' }, { failDelete: true })
    const [result] = deleteMergedHeads(REPO, api)
    expect(result.outcome).toMatch(/^not deleted/)
  })

  it('OQ-52/AC-2 - failing to list PRs at all is reported, not thrown', () => {
    const api = () => {
      throw new Error('HTTP 500')
    }
    expect(deleteMergedHeads(REPO, api)[0].outcome).toMatch(/could not list/)
  })

  it('OQ-52/AC-2 - the cleanup step in the workflow cannot fail the run', () => {
    const yml = readFileSync(path.join(ROOT, '.github/workflows/land-approved.yml'), 'utf8')
    const step = yml.slice(yml.lastIndexOf('- name:', yml.indexOf('run: node scripts/land/delete-merged-heads.mjs')))
    expect(step).toMatch(/continue-on-error: true/)
  })

  it('OQ-52/AC-4 - deletes leftover heads of earlier merged PRs, not only the latest', () => {
    const { api, deleted } = fakeApi(
      [pr(129, 'story/OQ-74-a', 'a1'), pr(127, 'story/OQ-75-b', 'b1'), pr(114, 'story/OQ-65-c', 'c1')],
      { 'story/OQ-74-a': 'a1', 'story/OQ-75-b': 'b1', 'story/OQ-65-c': 'c1' },
    )
    deleteMergedHeads(REPO, api)
    expect(deleted).toEqual(['story/OQ-74-a', 'story/OQ-75-b', 'story/OQ-65-c'])
  })

  it('OQ-52/AC-4 - never touches unmerged PRs, forks, the base branch, or a branch that has moved', () => {
    const closed = [
      pr(1, 'story/unmerged', 'u1', { merged_at: null }),
      pr(2, 'fork-branch', 'f1', { head: { ref: 'fork-branch', sha: 'f1', repo: { full_name: 'someone/else' } } }),
      pr(3, 'main', 'm1'),
      pr(4, 'story/reused', 'old'),
    ]
    const { api, deleted } = fakeApi(closed, {
      'story/unmerged': 'u1',
      'fork-branch': 'f1',
      main: 'm1',
      'story/reused': 'new-work',
    })
    const results = deleteMergedHeads(REPO, api)
    expect(deleted).toEqual([])
    expect(results).toEqual([
      { pr: 4, ref: 'story/reused', outcome: 'kept: branch has moved since the merge' },
    ])
  })

  it('OQ-52/AC-1 - ghApi survives a response larger than the 1 MiB default buffer', () => {
    const big = (cmd, argv, opts) =>
      execFileSync(process.execPath, ['-e', "process.stdout.write('x'.repeat(2 * 1024 * 1024))"], opts)
    expect(ghApi(['anything'], big)).toHaveLength(2 * 1024 * 1024)
  })

  it('OQ-52/AC-1 - the listing request projects only the fields the script reads', () => {
    const seenArgs = []
    const api = (args) => {
      seenArgs.push(args)
      return '[]'
    }
    deleteMergedHeads(REPO, api)
    expect(seenArgs[0]).toContain('--jq')
    expect(seenArgs[0]).toContain(LIST_PROJECTION)
  })

  it('OQ-52/AC-4 - two merged PRs sharing a ref name: the one matching the tip is deleted even if an older one is met first', () => {
    const { api, deleted } = fakeApi(
      [pr(114, 'story/OQ-65-s', 'old'), pr(131, 'story/OQ-65-s', 'new')],
      { 'story/OQ-65-s': 'new' },
    )
    const results = deleteMergedHeads(REPO, api)
    expect(deleted).toEqual(['story/OQ-65-s'])
    expect(results).toEqual([
      { pr: 114, ref: 'story/OQ-65-s', outcome: 'kept: branch has moved since the merge' },
      { pr: 131, ref: 'story/OQ-65-s', outcome: 'deleted' },
    ])
  })
})
