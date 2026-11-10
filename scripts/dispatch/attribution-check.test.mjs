// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkAttribution, generatedWithLines } from './attribution-check.mjs'

const git = (cwd, ...args) => execFileSync(
  'git',
  ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8' },
).trim()

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'attribution-check.mjs')
const TEST_TIMEOUT = 30_000
const TRAILER = 'Co-Authored-By: Some Model <noreply@example.com>'

let repo
let n = 0

const commit = (message, file = 'f.txt') => {
  n += 1
  writeFileSync(path.join(repo, file), `${n}\n`)
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '--cleanup=verbatim', '-m', message)
  return git(repo, 'rev-parse', 'HEAD')
}

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'tw-attribution-test-'))
  git(repo, 'init', '-q', '-b', 'main')
  commit('base')
})

afterAll(() => rmSync(repo, { recursive: true, force: true }))

/** Builds a branch from main with the given commit messages; returns { base, head }. */
const branch = (name, messages) => {
  git(repo, 'checkout', '-q', '-b', name, 'main')
  const base = git(repo, 'rev-parse', 'HEAD')
  for (const message of messages) commit(message)
  return { base, head: git(repo, 'rev-parse', 'HEAD') }
}

const ROOT = path.join(path.dirname(SCRIPT), '..', '..')

describe('attribution wiring', () => {
  it('ST-100/AC-4: the committed project setting hides the default commit and pull request attribution', () => {
    const settings = JSON.parse(readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'))
    expect(settings).toEqual({ attribution: { commit: '', pr: '' } })
  })

  it('ST-100/AC-3: ci.yml runs the check on a pull request, with the body through env', () => {
    const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
    const step = ci.slice(ci.indexOf('- name: Check for AI attribution'))
    expect(step).toContain("if: github.event_name == 'pull_request'")
    expect(step).toContain('STEWARD_PR_BODY: ${{ github.event.pull_request.body }}')
    expect(step.indexOf('env:')).toBeLessThan(step.indexOf('STEWARD_PR_BODY'))
    const run = step.split('\n').find((line) => line.trim().startsWith('run:'))
    expect(run).toContain('attribution-check.mjs')
    expect(run).not.toContain('${{')
  })
})

describe('attribution check', () => {
  it('ST-100/AC-3: a clean range passes', async () => {
    const { base, head } = branch('clean', ['one', 'two\n\nA body.\n\nCoder: model=x'])
    expect(await checkAttribution({ cwd: repo, base, head, body: 'Fine.' })).toEqual({ ok: true })
  }, TEST_TIMEOUT)

  it('ST-100/AC-3: a trailer in one commit of several fails, naming that commit', async () => {
    const { base, head } = branch('one-bad', ['one', `two\n\nWhat it does.\n\n${TRAILER}`, 'three'])
    const bad = git(repo, 'rev-parse', 'HEAD~1')
    const result = await checkAttribution({ cwd: repo, base, head, body: '' })
    expect(result.ok).toBe(false)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toContain(bad.slice(0, 12))
  }, TEST_TIMEOUT)

  it('ST-100/AC-3: a trailer in a merge commit\'s own message fails', async () => {
    const { base } = branch('merge-bad', ['one'])
    git(repo, 'checkout', '-q', '-b', 'side', base)
    commit('side commit', 'side.txt')
    git(repo, 'checkout', '-q', 'merge-bad')
    git(repo, 'merge', '-q', '--no-ff', 'side', '-m', `Merge side\n\n${TRAILER}`)
    const head = git(repo, 'rev-parse', 'HEAD')
    const result = await checkAttribution({ cwd: repo, base, head, body: '' })
    expect(result.ok).toBe(false)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toContain(head.slice(0, 12))
  }, TEST_TIMEOUT)

  it('ST-100/AC-3: a commit already in the base is not checked', async () => {
    git(repo, 'checkout', '-q', 'main')
    const old = commit(`old\n\n${TRAILER}`)
    const { base, head } = branch('after-old', ['clean'])
    expect(base).toBe(old)
    expect(await checkAttribution({ cwd: repo, base, head, body: '' })).toEqual({ ok: true })
    git(repo, 'checkout', '-q', 'main')
  }, TEST_TIMEOUT)

  it('ST-100/AC-3: a body with a "Generated with" line fails, and one without passes', async () => {
    const { base, head } = branch('body', ['one'])
    const without = await checkAttribution({ cwd: repo, base, head, body: '## What changed\n\nStuff.\n' })
    expect(without).toEqual({ ok: true })
    for (const line of [
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
      'Generated with Claude Code',
      '- generated with a tool',
    ]) {
      const result = await checkAttribution({ cwd: repo, base, head, body: `## What changed\n\nStuff.\n\n${line}\r\n` })
      expect(result.ok).toBe(false)
      expect(result.findings).toHaveLength(1)
      expect(result.findings[0]).toContain('line 5')
    }
  }, TEST_TIMEOUT)

  it('ST-100/AC-3: the Coder: line is not a finding', async () => {
    const { base, head } = branch('coder', ['one\n\nCoder: model=claude-sonnet-5'])
    const body = 'Unit: stories/x.md\n\nCoder: model=claude-sonnet-5 effort=high\n'
    expect(await checkAttribution({ cwd: repo, base, head, body })).toEqual({ ok: true })
  }, TEST_TIMEOUT)

  it('ST-100/AC-3: a trailer-like line in a commit body that is not a trailer passes', async () => {
    const { base, head } = branch('not-trailer', [
      `one\n\nThe rule bans a\n${TRAILER}\nline in the message, so this paragraph is not trailers.\n\nMore prose, and the end.`,
      `two\n\nNote that ${TRAILER} is quoted mid-sentence\nand here is prose\nthat follows it\nand more prose.`,
    ])
    expect(await checkAttribution({ cwd: repo, base, head, body: '' })).toEqual({ ok: true })
  }, TEST_TIMEOUT)

  it('ST-100/AC-3: a Co-Authored-By: trailer with an empty or whitespace-only value fails', async () => {
    for (const [name, value] of [['empty', ''], ['blank', '   ']]) {
      const { base, head } = branch(`value-${name}`, [`one\n\nWhat it does.\n\nCo-Authored-By:${value}`])
      const result = await checkAttribution({ cwd: repo, base, head, body: '' })
      expect(result.ok).toBe(false)
      expect(result.findings).toHaveLength(1)
    }
  }, TEST_TIMEOUT)

  it('ST-100/AC-3: a trailer in a final paragraph that also holds prose and another trailer fails', async () => {
    const { base, head } = branch('mixed', [
      'one\n\nWhat it does.\n\nProse here.\nSigned-off-by: T <t@example.com>\nCo-Authored-By: Some Model <m@example.com>',
    ])
    const result = await checkAttribution({ cwd: repo, base, head, body: '' })
    expect(result.ok).toBe(false)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toContain('Some Model')
  }, TEST_TIMEOUT)

  it('ST-100/AC-3: prose about the phrase inside a sentence is not a "Generated with" line', () => {
    expect(generatedWithLines('The body has no "Generated with" line.\nNot generated with it.')).toEqual([])
  })

  it('ST-100/AC-3: the CLI exits 1 on a finding, reading the body from the environment only', async () => {
    const { base, head } = branch('cli', ['one'])
    const run = (body) => {
      try {
        execFileSync('node', [SCRIPT, base, head], {
          cwd: repo, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, STEWARD_PR_BODY: body },
        })
        return 0
      } catch (error) {
        return error.status
      }
    }
    expect(run('Fine.')).toBe(0)
    expect(run('"; touch pwned; "\nGenerated with Claude Code')).toBe(1)
    expect(run('$(touch pwned)')).toBe(0)
    const noEnv = { ...process.env }
    delete noEnv.STEWARD_PR_BODY
    expect(() => execFileSync('node', [SCRIPT, base, head], { cwd: repo, stdio: 'pipe', env: noEnv })).toThrow()
  }, TEST_TIMEOUT)
})
