import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { parseRules, readRules } from './rules.mjs'

// The readRules tests build git repositories before each test; a slow machine
// needs more than Vitest's default 10 s (hook) and 5 s (test). ST-28/AC-4.
const GIT_TIMEOUT = 30_000

const SEVERAL = `Preamble line.

## Reading the PR body

Applies when: the pull request has a body.

1. The body states what changed.
   It also says why.
2. The body gives real results.

### A subsection

3. A third item, under a subsection.

## Always on

1. No condition here.
`

describe('parseRules', () => {
  it('ST-20/AC-1 reads sections, conditions, items and the preamble', () => {
    const r = parseRules(SEVERAL)
    expect(r.ok).toBe(true)
    expect(r.preamble).toBe('Preamble line.')
    expect(r.sections.map((s) => s.name)).toEqual(['Reading the PR body', 'Always on'])
    expect(r.sections[0].appliesWhen).toBe('the pull request has a body.')
    expect(r.sections[1].appliesWhen).toBeNull()
    expect(r.sections[0].items).toEqual([
      { number: 1, text: 'The body states what changed.\n   It also says why.' },
      { number: 2, text: 'The body gives real results.\n\n### A subsection' },
      { number: 3, text: 'A third item, under a subsection.' },
    ])
    expect(r.sections[1].items).toEqual([{ number: 1, text: 'No condition here.' }])
  })

  it('ST-20/AC-1 a line that is not first does not make a condition', () => {
    const r = parseRules('## S\n\n1. one\nApplies when: not a condition\n')
    expect(r.sections[0].appliesWhen).toBeNull()
    expect(r.sections[0].items[0].text).toBe('one\nApplies when: not a condition')
  })

  it('ST-20/AC-2 a file with no section does not parse', () => {
    const r = parseRules('1. just an item\n')
    expect(r.ok).toBe(false)
    expect(r.problems).toHaveLength(1)
  })

  it('ST-20/AC-2 a section with no item does not parse, and is named', () => {
    const r = parseRules('## Empty\n\nApplies when: always\n\n## Fine\n\n1. x\n')
    expect(r.ok).toBe(false)
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toContain('"Empty"')
  })

  it('ST-20/AC-2 a section numbering two items the same does not parse, and is named', () => {
    const r = parseRules('## Dup\n\n1. a\n2. b\n1. c\n')
    expect(r.ok).toBe(false)
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toContain('"Dup"')
  })

  it('ST-20/AC-2 two sections with the same name do not parse', () => {
    const r = parseRules('## Same\n\n1. a\n\n## Same\n\n1. b\n')
    expect(r.ok).toBe(false)
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toContain('"Same"')
  })

  it('ST-20/AC-2 lists every problem together', () => {
    const r = parseRules('## A\n\n1. a\n1. b\n\n## B\n\n## A\n\n1. c\n')
    expect(r.ok).toBe(false)
    expect(r.problems).toHaveLength(3)
    expect(r.problems.join('\n')).toMatch(/"A".*two items 1/)
    expect(r.problems.join('\n')).toMatch(/"B".*no item/)
    expect(r.problems.join('\n')).toMatch(/"A".*same name/)
  })

  it('ST-28/AC-1 keeps the lead text before the first item, with or without a condition', () => {
    const r = parseRules('## With\n\nApplies when: always.\n\nA lead paragraph.\n\nAnother line.\n\n- a bullet\n\n1. one\n\n## Without\n\n1. two\n\n## Bare lead\n\nLead, no condition.\n1. three\n')
    expect(r.ok).toBe(true)
    expect(r.sections[0].appliesWhen).toBe('always.')
    expect(r.sections[0].lead).toBe('A lead paragraph.\n\nAnother line.\n\n- a bullet')
    expect(r.sections[0].items).toEqual([{ number: 1, text: 'one' }])
    expect(r.sections[1].appliesWhen).toBeNull()
    expect(r.sections[1].lead).toBe('')
    expect(r.sections[2].appliesWhen).toBeNull()
    expect(r.sections[2].lead).toBe('Lead, no condition.')
  })

  it('ST-28/AC-3 gives REVIEW.md "Reading the pull request body" its lead', () => {
    const text = readFileSync(new URL('../../REVIEW.md', import.meta.url), 'utf8')
    const r = parseRules(text)
    expect(r.ok).toBe(true)
    const section = r.sections.find((s) => s.name === 'Reading the pull request body')
    expect(section.lead).toContain('Check the content of each section')
  })

  it('ST-20/AC-4 two sections may each have an item 1, and numbers need not be consecutive', () => {
    const r = parseRules('## A\n\n1. a\n5. b\n\n## B\n\n1. c\n')
    expect(r.ok).toBe(true)
    expect(r.sections[0].items.map((i) => i.number)).toEqual([1, 5])
    expect(r.sections[1].items.map((i) => i.number)).toEqual([1])
  })
})

describe('readRules', { timeout: GIT_TIMEOUT }, () => {
  let tmp
  let repoDir
  const git = (cwd, ...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd,
      encoding: 'utf8',
    })

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'rules-test-'))
    const origin = path.join(tmp, 'origin.git')
    const seed = path.join(tmp, 'seed')
    repoDir = path.join(tmp, 'repo')
    await mkdir(origin)
    await mkdir(seed)
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin)
    git(seed, 'init', '-q', '-b', 'main')
    git(seed, 'remote', 'add', 'origin', origin)
    await writeFile(path.join(seed, 'README.md'), 'x\n')
    git(seed, 'add', '.')
    git(seed, 'commit', '-q', '-m', 'base')
    git(seed, 'push', '-q', 'origin', 'main')
    git(seed, 'checkout', '-q', '-b', 'feature')
    await writeFile(path.join(seed, 'RULES.md'), '## A\n\n1. a\n')
    git(seed, 'add', '.')
    git(seed, 'commit', '-q', '-m', 'add rules on the branch only')
    git(seed, 'push', '-q', 'origin', 'feature')
    git(tmp, 'clone', '-q', origin, repoDir)
    git(repoDir, 'fetch', '-q', 'origin', 'feature')
    git(repoDir, 'checkout', '-q', 'feature')
  }, GIT_TIMEOUT)

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  }, GIT_TIMEOUT)

  it('ST-20/AC-3 reports a file present at a branch head but not on main as missing', async () => {
    expect(await readRules({ repoDir, base: 'feature', rulesFile: 'RULES.md' })).toMatchObject({
      ok: true,
    })
    const r = await readRules({ repoDir, base: 'main', rulesFile: 'RULES.md' })
    expect(r.ok).toBe(false)
    expect(r.problems[0]).toContain('RULES.md')
    expect(r.problems[0]).toContain('origin/main')
  })

  it('ST-20/AC-3 reads and parses a file on main, and names the path when it does not parse', async () => {
    const seed = path.join(tmp, 'seed')
    git(seed, 'checkout', '-q', 'main')
    await writeFile(path.join(seed, 'GOOD.md'), '## A\n\n1. a\n')
    await writeFile(path.join(seed, 'BAD.md'), 'no sections\n')
    git(seed, 'add', '.')
    git(seed, 'commit', '-q', '-m', 'rules')
    git(seed, 'push', '-q', 'origin', 'main')
    git(repoDir, 'fetch', '-q', 'origin', 'main')

    const good = await readRules({ repoDir, base: 'main', rulesFile: 'GOOD.md' })
    expect(good.ok).toBe(true)
    // ST-21/AC-2: the file's text comes back with the parse, for the reviewer's prompt.
    expect(good.text).toBe('## A\n\n1. a\n')
    expect(good.sections[0].items).toEqual([{ number: 1, text: 'a' }])

    const bad = await readRules({ repoDir, base: 'main', rulesFile: 'BAD.md' })
    expect(bad.ok).toBe(false)
    expect(bad.problems[0]).toContain('BAD.md')
  })

  it('ST-20/AC-3 does not throw when repoDir is not a repository', async () => {
    const r = await readRules({ repoDir: tmp, base: 'main', rulesFile: 'RULES.md' })
    expect(r.ok).toBe(false)
  })
})
