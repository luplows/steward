import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HONOURED_ASSOCIATIONS, isHonouredAuthor } from './check-author.mjs'
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

  it('the CLI (as land-approved.yml invokes it) exits non-zero for a CONTRIBUTOR association', () => {
    expect(() =>
      execFileSync(process.execPath, [CHECK_AUTHOR_SCRIPT], { env: { ...process.env, ASSOC: 'CONTRIBUTOR' } }),
    ).toThrow()
  })

  it('the CLI (as land-approved.yml invokes it) exits zero for an OWNER association', () => {
    expect(() =>
      execFileSync(process.execPath, [CHECK_AUTHOR_SCRIPT], { env: { ...process.env, ASSOC: 'OWNER' } }),
    ).not.toThrow()
  })

  it('a skipped pull request followed by an eligible one still lands: land-approved.yml continues the per-PR loop on failure, rather than exiting or breaking it', () => {
    const landing = readFileSync(path.join(ROOT, '.github', 'workflows', 'land-approved.yml'), 'utf8')
    // Pins the exact word land-approved.yml runs when check-author.mjs fails a candidate. If that
    // word were `exit 0` or `break` instead of `continue`, a CONTRIBUTOR PR ahead of an eligible
    // OWNER one would stop the sweep instead of moving on to it -- this fails in that case.
    const match = landing.match(
      /if ! ASSOC="\$\{association\}" node scripts\/land\/check-author\.mjs; then\s*\n\s*echo "PR #\$\{pr\}: opened by an account with association '\$\{association\}', not a writer, skipping"\s*\n\s*(\w+)\s*\n\s*fi/,
    )
    expect(match).not.toBeNull()
    expect(match[1]).toBe('continue')

    // That `continue` must be inside the same `for pr in ...; do ... done` loop that tries every
    // candidate, or it would do nothing to reach a later PR.
    const loopStart = landing.indexOf('for pr in ${candidates}; do')
    const loopEnd = landing.indexOf('\n          done', loopStart)
    expect(loopStart).toBeGreaterThan(-1)
    expect(landing.indexOf('check-author.mjs')).toBeGreaterThan(loopStart)
    expect(landing.indexOf('check-author.mjs')).toBeLessThan(loopEnd)
  })

  it('AC-4: the author check runs before the review-blocked check, so an outside review-blocked PR is still reported as an outside PR', () => {
    const landing = readFileSync(path.join(ROOT, '.github', 'workflows', 'land-approved.yml'), 'utf8')
    const authorAt = landing.indexOf('check-author.mjs')
    const blockedAt = landing.indexOf("index(\"review-blocked\")", authorAt)
    expect(authorAt).toBeGreaterThan(-1)
    expect(blockedAt).toBeGreaterThan(authorAt)
  })
})

describe('OQ-81/AC-3: the same set of associations everywhere', () => {
  const gate = readFileSync(path.join(ROOT, '.github', 'workflows', 'review-gate.yml'), 'utf8')
  const gateStep = gate.slice(gate.indexOf('name: Apply verdict from marker'))
  const gateHonoured = gateStep.match(/case "\$\{ASSOC\}" in\s+([A-Z|]+)\)/)[1].split('|')

  const landing = readFileSync(path.join(ROOT, '.github', 'workflows', 'land-approved.yml'), 'utf8')
  const landingHonoured = landing.match(/Honoured associations \(must match review-gate\.yml's ASSOC case\): ([A-Z|]+)/)[1].split('|')

  it('land-approved.yml names the same set review-gate.yml honours', () => {
    expect([...landingHonoured].sort()).toEqual([...gateHonoured].sort())
  })

  it('check-author.mjs honours the same set review-gate.yml honours', () => {
    expect([...HONOURED_ASSOCIATIONS].sort()).toEqual([...gateHonoured].sort())
  })

  it('review.mjs (OQ-78/AC-3) agrees with check-author.mjs, so all three agree', () => {
    expect([...REVIEW_HONOURED_ASSOCIATIONS].sort()).toEqual([...HONOURED_ASSOCIATIONS].sort())
  })

  it('land-approved.yml actually calls check-author.mjs', () => {
    expect(landing).toContain('scripts/land/check-author.mjs')
  })
})
