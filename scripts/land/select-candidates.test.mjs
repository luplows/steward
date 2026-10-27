import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { selectCandidates } from './select-candidates.mjs'
import { fakeGitHub, pull, REPO, SHA_OF } from './runway-fake.mjs'
import { runRunway } from './runway.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const pr = (number, extra = {}) => ({ number, draft: false, base: { ref: 'main' }, ...extra })
const LIST = [pr(3), pr(4, { draft: true }), pr(5, { base: { ref: 'other' } }), pr(7), pr(9)]

describe('OQ-93/AC-2: select-candidates.mjs', () => {
  it('with no input, leaves out drafts and other bases and keeps the order', () => {
    expect(selectCandidates(LIST)).toEqual([3, 7, 9])
    expect(selectCandidates(LIST, '')).toEqual([3, 7, 9])
  })

  it('names exactly an eligible pull request', () => {
    expect(selectCandidates(LIST, '7')).toEqual([7])
  })

  it('returns no candidates for a draft, another base, or a pull request not in the list', () => {
    expect(selectCandidates(LIST, '4')).toEqual([])
    expect(selectCandidates(LIST, '5')).toEqual([])
    expect(selectCandidates(LIST, '99')).toEqual([])
  })

  it('ST-45/AC-2: takes a ready pull request into a release branch, and none into release/next or feature/x', () => {
    const into = (ref) => ({ base: { ref } })
    const list = [
      pr(3), pr(11, into('release/v0.1.0')), pr(12, into('release/next')), pr(13, into('feature/x')),
      pr(14, { draft: true, ...into('release/v0.1.0') }),
    ]
    expect(selectCandidates(list)).toEqual([3, 11])
    expect(selectCandidates(list, '11')).toEqual([11])
    expect(selectCandidates(list, '12')).toEqual([])
    expect(selectCandidates(list, '13')).toEqual([])
  })

  it.each(['0', '-1', '7 8', '7;x', '07'])('refuses the invalid value %j', (value) => {
    expect(() => selectCandidates(LIST, value)).toThrow(/pr input/)
  })
})

// The `run:` blocks of a workflow: each `run:` line and the lines indented deeper than it.
function runBlocks(yml) {
  const lines = yml.split('\n')
  const blocks = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:- )?run:(.*)$/)
    if (!m) continue
    const indent = m[1].length
    let text = m[2]
    for (let j = i + 1; j < lines.length; j++) {
      const lead = lines[j].match(/^\s*/)[0].length
      if (lines[j].trim() !== '' && lead <= indent) break
      text += `\n${lines[j]}`
    }
    blocks.push(text)
  }
  return blocks
}

describe('OQ-93/AC-3: the input reaches the module only through env', () => {
  const yml = readFileSync(path.join(ROOT, '.github/workflows/land-approved.yml'), 'utf8')

  it('declares the optional pr input', () => {
    expect(yml).toMatch(/workflow_dispatch:\s*\n\s+inputs:\s*\n\s+pr:/)
  })

  it('no run block interpolates an input', () => {
    const blocks = runBlocks(yml)
    expect(blocks.length).toBeGreaterThan(1)
    for (const block of blocks) {
      expect(block).not.toContain('${{ inputs.')
      expect(block).not.toContain('${{ github.event.inputs.')
    }
  })

  it('passes the input as PR_INPUT and the landing step runs runway, which reads PR_INPUT and selects with select-candidates.mjs', () => {
    expect(yml).toMatch(/PR_INPUT: \$\{\{ inputs\.pr \}\}/)
    expect(runBlocks(yml).some((block) => block.includes('node scripts/dispatch/cli.mjs runway'))).toBe(true)
    const sweep = readFileSync(path.join(ROOT, 'scripts/land/runway.mjs'), 'utf8')
    expect(sweep).toContain("prInput: process.env.PR_INPUT ?? ''")
    expect(sweep).toMatch(/import \{[^}]*\bselectCandidates\b[^}]*\} from '\.\/select-candidates\.mjs'/)
  })

  it('ST-42/AC-1: runway given a pull request lands only that one, and given an invalid value lands nothing', () => {
    const named = fakeGitHub({ pulls: [pull(3), pull(7)] })
    expect(runRunway({ repo: REPO, prInput: '7' }, named.deps)).toEqual({ landed: 7 })
    expect(named.merges).toEqual([['7', '--repo', REPO, '--squash', '--match-head-commit', SHA_OF(7)]])

    const unlisted = fakeGitHub({ pulls: [pull(3)] })
    expect(runRunway({ repo: REPO, prInput: '7' }, unlisted.deps)).toEqual({ landed: null })
    expect(unlisted.merges).toEqual([])

    const invalid = fakeGitHub({ pulls: [pull(3)] })
    expect(() => runRunway({ repo: REPO, prInput: '3;x' }, invalid.deps)).toThrow(/pr input/)
    expect(invalid.merges).toEqual([])
  })
})
