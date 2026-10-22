import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HONOURED_ASSOCIATIONS, isHonouredAuthor } from './check-author.mjs'
import { fakeGitHub, pull, REPO, SHA_OF } from './runway-fake.mjs'
import { runRunway } from './runway.mjs'
import { HONOURED_ASSOCIATIONS as REVIEW_HONOURED_ASSOCIATIONS } from '../dispatch/review.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CHECK_AUTHOR_SCRIPT = path.join(ROOT, 'scripts', 'land', 'check-author.mjs')

describe('OQ-81/AC-2: isHonouredAuthor', () => {
  it('an OWNER pull request is eligible', () => {
    expect(isHonouredAuthor('OWNER')).toBe(true)
  })

  it('a CONTRIBUTOR pull request is skipped', () => {
    expect(isHonouredAuthor('CONTRIBUTOR')).toBe(false)
  })

  it('a NONE pull request is skipped', () => {
    expect(isHonouredAuthor('NONE')).toBe(false)
  })

  it('the CLI exits non-zero for a CONTRIBUTOR association', () => {
    expect(() =>
      execFileSync(process.execPath, [CHECK_AUTHOR_SCRIPT], { env: { ...process.env, ASSOC: 'CONTRIBUTOR' } }),
    ).toThrow()
  })

  it('the CLI exits zero for an OWNER association', () => {
    expect(() =>
      execFileSync(process.execPath, [CHECK_AUTHOR_SCRIPT], { env: { ...process.env, ASSOC: 'OWNER' } }),
    ).not.toThrow()
  })

  it('a skipped pull request followed by an eligible one still lands: runway goes on to the next candidate rather than ending the run', () => {
    const { deps, logs, merges } = fakeGitHub({
      pulls: [pull(1, { association: 'CONTRIBUTOR' }), pull(2, { association: 'OWNER' })],
    })
    expect(runRunway({ repo: REPO }, deps)).toEqual({ landed: 2 })
    expect(logs).toContain("PR #1: opened by an account with association 'CONTRIBUTOR', not a writer, skipping")
    expect(merges).toEqual([['2', '--repo', REPO, '--squash', '--match-head-commit', SHA_OF(2)]])
  })

  it('AC-4: the author check runs before the review-blocked check, so an outside review-blocked PR is still reported as an outside PR', () => {
    const { deps, logs } = fakeGitHub({ pulls: [pull(1, { association: 'NONE', labels: ['review-blocked'] })] })
    runRunway({ repo: REPO }, deps)
    expect(logs).toContain("PR #1: opened by an account with association 'NONE', not a writer, skipping")
    expect(logs.some((line) => line.includes('review-blocked, skipping'))).toBe(false)
  })

  it('AC-4: an outside pull request carrying breaker-override is still skipped, with the breaker tripped', () => {
    const { deps, logs, merges } = fakeGitHub({
      pulls: [pull(1, { association: 'NONE', labels: ['breaker-override'] })],
      blockedCount: 5,
    })
    runRunway({ repo: REPO }, deps)
    expect(merges).toEqual([])
    expect(logs).toContain("PR #1: opened by an account with association 'NONE', not a writer, skipping")
  })
})

describe('OQ-81/AC-3: the same set of associations everywhere', () => {
  const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8')
  const importsIsHonouredAuthor = /import\s*\{[^}]*\bisHonouredAuthor\b[^}]*\}\s*from\s*'\.\/check-author\.mjs'/

  it('apply-verdict.mjs (the gate) and runway.mjs (the runway) read check-author.mjs\'s set, and define none of their own', () => {
    for (const file of ['apply-verdict.mjs', 'runway.mjs']) {
      const source = read('scripts', 'land', file)
      expect(source).toMatch(importsIsHonouredAuthor)
      expect(source).not.toMatch(/OWNER|MEMBER|COLLABORATOR/)
    }
  })

  it('neither workflow file carries a set of associations', () => {
    for (const file of ['review-gate.yml', 'land-approved.yml']) {
      expect(read('.github', 'workflows', file)).not.toMatch(/OWNER|MEMBER|COLLABORATOR/)
    }
  })

  it('check-author.mjs honours owners, members and collaborators', () => {
    expect([...HONOURED_ASSOCIATIONS].sort()).toEqual(['COLLABORATOR', 'MEMBER', 'OWNER'])
  })

  it('review.mjs (OQ-78/AC-3) agrees with check-author.mjs, so all three agree', () => {
    expect([...REVIEW_HONOURED_ASSOCIATIONS].sort()).toEqual([...HONOURED_ASSOCIATIONS].sort())
  })

  it('the runway\'s workflow actually runs runway, which calls check-author.mjs', () => {
    expect(read('.github', 'workflows', 'land-approved.yml')).toContain('node scripts/dispatch/cli.mjs runway')
    expect(read('scripts', 'land', 'runway.mjs')).toContain('isHonouredAuthor(association)')
  })
})
