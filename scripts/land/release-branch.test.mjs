import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isLandingBase, isReleaseBranch, RELEASE_BRANCH_RE } from './release-branch.mjs'

describe('ST-45/AC-1: one definition of a release branch\'s name', () => {
  it('ST-45/AC-1: release/v0.1.0 and release/v12.0.3 are release branches', () => {
    expect(isReleaseBranch('release/v0.1.0')).toBe(true)
    expect(isReleaseBranch('release/v12.0.3')).toBe(true)
  })

  it('ST-45/AC-1: release/0.1.0, release/v0.1, release/v0.1.0-rc, release/v0.1.0/x and main are not', () => {
    for (const name of ['release/0.1.0', 'release/v0.1', 'release/v0.1.0-rc', 'release/v0.1.0/x', 'main']) {
      expect(isReleaseBranch(name), name).toBe(false)
    }
  })

  it('ST-45/AC-1: nor is a part with a leading zero, or anything that is not a string', () => {
    expect(isReleaseBranch('release/v01.0.0')).toBe(false)
    expect(isReleaseBranch(undefined)).toBe(false)
    expect(RELEASE_BRANCH_RE.test('release/v0.1.0\n')).toBe(false)
  })

  it('ST-45/AC-1: a landing base is main or a release branch, and nothing else', () => {
    expect(isLandingBase('main')).toBe(true)
    expect(isLandingBase('release/v0.1.0')).toBe(true)
    expect(isLandingBase('release/next')).toBe(false)
    expect(isLandingBase('feature/x')).toBe(false)
  })
})

describe('ST-45/AC-4: CI checks a pull request into a release branch, and a push to one, as for main', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const lines = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8').split(/\r?\n/)
  // The `branches:` line directly under a trigger's own key, in the `on:` block.
  const branchesOf = (trigger) => {
    const at = lines.indexOf(`  ${trigger}:`)
    return at === -1 ? undefined : lines[at + 1].match(/^ {4}branches: \[(.*)\]$/)?.[1]
  }

  it('ST-45/AC-4: both the pull_request and the push trigger name main and the release branches', () => {
    expect(branchesOf('pull_request')).toBe("main, 'release/v*'")
    expect(branchesOf('push')).toBe("main, 'release/v*'")
  })

  it('ST-45/AC-4: the story containment step still compares against the pull request\'s own base', () => {
    expect(lines.join('\n')).toContain('${{ github.event.pull_request.base.sha }}')
  })
})
