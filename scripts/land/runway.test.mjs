import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BREAKER_LIMIT, runRunway, touchesOnlyWorkflows } from './runway.mjs'
import { fakeGitHub, pull, REPO, SHA_OF } from './runway-fake.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const mergeArgs = (number) => [String(number), '--repo', REPO, '--squash', '--match-head-commit', SHA_OF(number)]

describe('ST-42/AC-1: runway lands the oldest ready pull request, once', () => {
  it('ST-42/AC-1: lands the first candidate that is ready, with --squash and --match-head-commit, and stops', () => {
    const { deps, merges, logs } = fakeGitHub({ pulls: [pull(1), pull(2)] })
    expect(runRunway({ repo: REPO }, deps)).toEqual({ landed: 1 })
    expect(merges).toEqual([mergeArgs(1)])
    expect(logs).toContain(`::notice title=Landed::PR #1 merged at ${SHA_OF(1)}`)
  })

  it('ST-42/AC-1: with nothing open, or only drafts and other bases, lands nothing', () => {
    const none = fakeGitHub({ pulls: [] })
    expect(runRunway({ repo: REPO }, none.deps)).toEqual({ landed: null })
    expect(none.logs.at(-1)).toBe('No open non-draft PR against main to try.')
    const skipped = fakeGitHub({ pulls: [pull(1, { draft: true }), pull(2, { base: 'other' })] })
    expect(runRunway({ repo: REPO }, skipped.deps)).toEqual({ landed: null })
    expect(skipped.merges).toEqual([])
  })

  it('ST-42/AC-1: a pull request into a release branch is a candidate, as select-candidates.mjs says', () => {
    const { deps, merges } = fakeGitHub({ pulls: [pull(1, { base: 'release/v1.2.3' })] })
    expect(runRunway({ repo: REPO }, deps)).toEqual({ landed: 1 })
    expect(merges).toEqual([mergeArgs(1)])
  })

  it('ST-42/AC-1: with every candidate skipped, says so and lands nothing', () => {
    const { deps, logs } = fakeGitHub({ pulls: [pull(1, { labels: ['review-blocked'] })] })
    expect(runRunway({ repo: REPO }, deps)).toEqual({ landed: null })
    expect(logs).toContain('PR #1: review-blocked, skipping')
    expect(logs.at(-1)).toBe('No PR ready to land.')
  })

  it('ST-42/AC-1: a merge that gh refuses fails the run', () => {
    const { deps } = fakeGitHub({ pulls: [pull(1)] })
    deps.merge = () => {
      throw new Error('head branch was modified')
    }
    expect(() => runRunway({ repo: REPO }, deps)).toThrow(/head branch was modified/)
  })

  it('ST-42/AC-1: the belt-and-braces re-check names an absent review/agent', () => {
    const { deps, logs, merges } = fakeGitHub({ pulls: [pull(1, { statuses: [] })] })
    runRunway({ repo: REPO }, deps)
    expect(merges).toEqual([])
    expect(logs).toContain(`PR #1: review/agent=absent on ${SHA_OF(1)}, skipping`)
  })

  it('ST-47/AC-2: a review/agent success on the second page of statuses is found, and the pull request lands', () => {
    const others = Array.from({ length: 100 }, (_, i) => ({ context: `other/${i}`, state: 'success', id: 10 + i }))
    const review = { context: 'review/agent', state: 'success', id: 2 }
    const { deps, merges } = fakeGitHub({ pulls: [pull(1, { statuses: [...others, review] })] })
    expect(runRunway({ repo: REPO }, deps)).toEqual({ landed: 1 })
    expect(merges).toEqual([mergeArgs(1)])
  })

  it('ST-47/AC-2: with no review/agent on any page, the pull request is still skipped', () => {
    const others = Array.from({ length: 101 }, (_, i) => ({ context: `other/${i}`, state: 'success', id: 10 + i }))
    const { deps, merges, logs } = fakeGitHub({ pulls: [pull(1, { statuses: others })] })
    expect(runRunway({ repo: REPO }, deps)).toEqual({ landed: null })
    expect(merges).toEqual([])
    expect(logs).toContain(`PR #1: review/agent=absent on ${SHA_OF(1)}, skipping`)
  })

  it('ST-42/AC-1: an unreadable landWhen lands nothing, saying why (ST-54/AC-4 reads it before any pull request)', () => {
    const { deps, merges, logs } = fakeGitHub({ pulls: [pull(1)], landWhen: 'some' })
    expect(runRunway({ repo: REPO }, deps)).toMatchObject({ landed: null })
    expect(merges).toEqual([])
    expect(logs.some((line) => line.startsWith('::error title=Landing refused::') && line.includes('landWhen must be'))).toBe(true)
  })
})

describe('ST-42/AC-1: the circuit breaker, with its limit of five and its two exemptions', () => {
  it('ST-42/AC-1: the limit is five', () => {
    expect(BREAKER_LIMIT).toBe(5)
  })

  it('ST-42/AC-1: four review-blocked pull requests leave the breaker untripped', () => {
    const { deps, logs, merges } = fakeGitHub({ pulls: [pull(1)], blockedCount: 4 })
    runRunway({ repo: REPO }, deps)
    expect(merges).toEqual([mergeArgs(1)])
    expect(logs.some((line) => line.includes('Circuit breaker tripped'))).toBe(false)
  })

  it('ST-42/AC-1: five trip it with a warning, and a pull request with no exemption is skipped', () => {
    const { deps, logs, merges } = fakeGitHub({ pulls: [pull(1)], blockedCount: 5 })
    expect(runRunway({ repo: REPO }, deps)).toEqual({ landed: null })
    expect(merges).toEqual([])
    expect(logs).toContain(
      '::warning title=Circuit breaker tripped::5 open PRs carry review-blocked; landing only breaker-override or workflow-only PRs.',
    )
    expect(logs).toContain('PR #1: breaker tripped and no exemption, skipping')
  })

  it('ST-42/AC-1: a breaker-override label exempts a pull request', () => {
    const { deps, logs, merges } = fakeGitHub({ pulls: [pull(1, { labels: ['breaker-override'] })], blockedCount: 5 })
    runRunway({ repo: REPO }, deps)
    expect(logs).toContain('PR #1: breaker tripped, but carries breaker-override')
    expect(merges).toEqual([mergeArgs(1)])
  })

  it('ST-42/AC-1: a diff confined to .github/workflows/ exempts a pull request', () => {
    const { deps, logs, merges } = fakeGitHub({ pulls: [pull(1, { files: ['.github/workflows/review-gate.yml'] })], blockedCount: 5 })
    runRunway({ repo: REPO }, deps)
    expect(logs).toContain('PR #1: breaker tripped, but touches only .github/workflows/')
    expect(merges).toEqual([mergeArgs(1)])
  })

  it('ST-42/AC-1: a diff that also touches another file does not', () => {
    const { deps, merges } = fakeGitHub({ pulls: [pull(1, { files: ['.github/workflows/ci.yml', 'README.md'] })], blockedCount: 5 })
    runRunway({ repo: REPO }, deps)
    expect(merges).toEqual([])
  })

  it('ST-42/AC-1: an empty file list is not read as touching only workflows', () => {
    expect(touchesOnlyWorkflows([])).toBe(false)
    expect(touchesOnlyWorkflows(['.github/workflows/a.yml'])).toBe(true)
    expect(touchesOnlyWorkflows(['.github/workflows-x/a.yml'])).toBe(false)
    const { deps, merges } = fakeGitHub({ pulls: [pull(1, { files: [] })], blockedCount: 5 })
    runRunway({ repo: REPO }, deps)
    expect(merges).toEqual([])
  })

  it('ST-42/AC-1: an exempt pull request still needs review/agent success', () => {
    const { deps, merges } = fakeGitHub({
      pulls: [pull(1, { labels: ['breaker-override'], statuses: [{ context: 'review/agent', state: 'pending', id: 1 }] })],
      blockedCount: 5,
    })
    runRunway({ repo: REPO }, deps)
    expect(merges).toEqual([])
  })

  it('ST-42/AC-1: a pull request carrying review-blocked is skipped even with breaker-override', () => {
    const { deps, merges } = fakeGitHub({ pulls: [pull(1, { labels: ['review-blocked', 'breaker-override'] })], blockedCount: 5 })
    runRunway({ repo: REPO }, deps)
    expect(merges).toEqual([])
  })
})

describe('ST-42/AC-1: the command', () => {
  it('ST-42/AC-1: without REPO, exits non-zero and says so, touching nothing', () => {
    const env = { ...process.env }
    delete env.REPO
    let failure
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'land', 'runway.mjs')], { env, encoding: 'utf8', stdio: 'pipe' })
    } catch (error) {
      failure = error
    }
    expect(failure.status).toBe(1)
    expect(failure.stderr).toContain('runway needs REPO')
  })
})
