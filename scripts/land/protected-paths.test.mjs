import { describe, expect, it } from 'vitest'
import { isProtectedPath, protectedPathsChanged } from './protected-paths.mjs'

describe('ST-106/AC-1: the protected paths are a fixed list', () => {
  it.each([
    ['a workflow', '.github/workflows/ci.yml'],
    ['a file nested under workflows', '.github/workflows/sub/x.yml'],
    ['a file under .claude/', '.claude/prompts/coder.md'],
    ['steward.config.json', 'steward.config.json'],
    ['the rulesFile value', 'REVIEW.md'],
  ])('ST-106/AC-1: %s is protected', (_name, file) => {
    expect(isProtectedPath(file, 'REVIEW.md')).toBe(true)
  })

  it('ST-106/AC-1: a checklist named by a rulesFile other than REVIEW.md is protected, and REVIEW.md then is not', () => {
    expect(isProtectedPath('docs/checklist.md', 'docs/checklist.md')).toBe(true)
    expect(isProtectedPath('REVIEW.md', 'docs/checklist.md')).toBe(false)
  })

  it.each([
    ['AGENTS.md', 'AGENTS.md'],
    ['CLAUDE.md', 'CLAUDE.md'],
    ['a path that contains .github/workflows/', 'docs/.github/workflows/x.yml'],
    ['a path that contains .claude/', 'docs/.claude/x.md'],
    ['a sibling of workflows', '.github/workflows-x/a.yml'],
    ['a case-different workflows folder', '.GitHub/Workflows/ci.yml'],
    ['a case-different settings file', 'Steward.config.json'],
    ['a nested steward.config.json', 'sub/steward.config.json'],
    ['a case-different rulesFile', 'review.md'],
    ['the .github folder itself', '.github/pull_request_template.md'],
  ])('ST-106/AC-1: %s is not protected', (_name, file) => {
    expect(isProtectedPath(file, 'REVIEW.md')).toBe(false)
  })
})

describe('ST-106/AC-2: a pull request changes a protected path when any file of its diff is protected', () => {
  it('ST-106/AC-2: returns the protected paths, each once, and none when nothing is protected', () => {
    const files = [
      { filename: 'src/a.js' },
      { filename: '.github/workflows/ci.yml' },
      { filename: 'steward.config.json' },
      { filename: '.github/workflows/ci.yml' },
    ]
    expect(protectedPathsChanged(files, 'REVIEW.md')).toEqual(['.github/workflows/ci.yml', 'steward.config.json'])
    expect(protectedPathsChanged([{ filename: 'src/a.js' }, { filename: 'AGENTS.md' }], 'REVIEW.md')).toEqual([])
    expect(protectedPathsChanged([], 'REVIEW.md')).toEqual([])
  })

  it('ST-106/AC-2: a file moved into a protected folder is detected, by its new path', () => {
    const files = [{ filename: '.github/workflows/ci.yml', previous_filename: 'ci.yml' }]
    expect(protectedPathsChanged(files, 'REVIEW.md')).toEqual(['.github/workflows/ci.yml'])
  })

  it('ST-106/AC-2: a file moved out of a protected folder is detected, by its old path', () => {
    const files = [{ filename: 'docs/ci.yml', previous_filename: '.claude/ci.yml' }]
    expect(protectedPathsChanged(files, 'REVIEW.md')).toEqual(['.claude/ci.yml'])
  })

  it('ST-106/AC-2: a move between two protected paths names both, and a null previous_filename is no path', () => {
    const files = [
      { filename: '.claude/b.md', previous_filename: '.github/workflows/a.yml' },
      { filename: 'REVIEW.md', previous_filename: null },
    ]
    expect(protectedPathsChanged(files, 'REVIEW.md')).toEqual(['.claude/b.md', '.github/workflows/a.yml', 'REVIEW.md'])
  })
})
