import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { selectCandidates } from './select-candidates.mjs'

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

  it('passes the input as PR_INPUT and the landing step runs select-candidates.mjs', () => {
    expect(yml).toMatch(/PR_INPUT: \$\{\{ inputs\.pr \}\}/)
    expect(runBlocks(yml).some((block) => block.includes('scripts/land/select-candidates.mjs'))).toBe(true)
  })
})
