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

  const WITH_COMMENTS = `Preamble.
<!-- a comment in the preamble -->

<!--
  A comment over
  several lines.
-->
## First

Applies when: always. <!-- trailing comment -->

A lead. <!-- inline --> More lead.

<!-- a comment between the lead and the items -->
1. one<!-- inline in an item -->
   still one
<!-- a comment inside item one
2. not an item
-->
2. two

<!-- ## Hidden heading
1. hidden item
-->

## Second

1. only
`
  const WITHOUT_COMMENTS = `Preamble.

## First

Applies when: always.

A lead.  More lead.

1. one
   still one
2. two

## Second

1. only
`

  it('ST-43/AC-1 a file with comments parses to the same sections as the file without them', () => {
    const withComments = parseRules(WITH_COMMENTS)
    expect(withComments.ok).toBe(true)
    expect(withComments).toEqual(parseRules(WITHOUT_COMMENTS))
    expect(withComments.sections.map((s) => s.name)).toEqual(['First', 'Second'])
    expect(withComments.sections[0].items.map((i) => i.number)).toEqual([1, 2])
    expect(withComments.sections[0].lead).toBe('A lead.  More lead.')
  })

  it('ST-43/AC-1 a commented-out heading and a commented-out item are not parsed', () => {
    const r = parseRules('## A\n\n1. a\n<!-- 2. b -->\n\n<!--\n## Gone\n1. g\n-->\n')
    expect(r.ok).toBe(true)
    expect(r.sections.map((s) => s.name)).toEqual(['A'])
    expect(r.sections[0].items).toEqual([{ number: 1, text: 'a' }])
  })

  it('ST-43/AC-1 a section holding only a commented-out item has no item', () => {
    const r = parseRules('## A\n\n<!-- 1. a -->\n')
    expect(r.ok).toBe(false)
    expect(r.problems[0]).toContain('"A"')
  })

  it('ST-43/AC-1 a comment that is never closed runs to the end of the file', () => {
    const r = parseRules('## A\n\n1. a\n<!-- 2. b\n## B\n1. c\n')
    expect(r.ok).toBe(true)
    expect(r.sections.map((s) => s.name)).toEqual(['A'])
    expect(r.sections[0].items).toEqual([{ number: 1, text: 'a' }])
  })

  it('ST-43/AC-1 a comment in a CRLF file is removed as in any other', () => {
    const r = parseRules('## A\r\n\r\n<!-- c -->\r\n1. a\r\n')
    expect(r.ok).toBe(true)
    expect(r.sections[0].items).toEqual([{ number: 1, text: 'a' }])
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

  async function putOnMain(name, content) {
    const seed = path.join(tmp, 'seed')
    git(seed, 'checkout', '-q', 'main')
    await writeFile(path.join(seed, name), content)
    git(seed, 'add', '.')
    git(seed, 'commit', '-q', '-m', `add ${name}`)
    git(seed, 'push', '-q', 'origin', 'main')
    git(repoDir, 'fetch', '-q', 'origin', 'main')
  }

  it('ST-43/AC-2 the text readRules returns has no comment and keeps every rule', async () => {
    const source = '# Rules\n<!-- note to the crew -->\n\n## A\n\n<!-- where to add -->\n1. a\n2. b <!-- inline -->\n\n## B\n\n1. c\n'
    await putOnMain('COMMENTED.md', source)
    const r = await readRules({ repoDir, base: 'main', rulesFile: 'COMMENTED.md' })
    expect(r.ok).toBe(true)
    expect(r.text).not.toContain('<!--')
    expect(r.text).not.toContain('-->')
    expect(r.text).not.toContain('note to the crew')
    expect(r.text).toBe('# Rules\n\n## A\n\n1. a\n2. b \n\n## B\n\n1. c\n')
    expect(parseRules(r.text)).toEqual(parseRules(source))
  })

  it('ST-43/AC-5 the example as readRules returns it holds none of its placeholders', async () => {
    const raw = readFileSync(EXAMPLE, 'utf8')
    const comments = [...raw.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1])
    expect(comments.length).toBeGreaterThanOrEqual(3)
    await putOnMain('EXAMPLE.md', raw)
    const r = await readRules({ repoDir, base: 'main', rulesFile: 'EXAMPLE.md' })
    expect(r.ok).toBe(true)
    expect(r.text).not.toContain('<!--')
    expect(r.text).not.toContain('-->')
    for (const comment of comments) {
      for (const line of comment.split('\n').map((l) => l.trim()).filter((l) => l.length > 20)) {
        expect(r.text).not.toContain(line)
      }
    }
    expect(r.sections.map((s) => [s.name, s.items.length])).toEqual(EXAMPLE_SECTIONS)
  })
})

const EXAMPLE = new URL('../../templates/review-checklist.md', import.meta.url)

// The sections of the example checklist and their item counts (ST-43/AC-3).
const EXAMPLE_SECTIONS = [
  ['Reading the pull request body', 1],
  ['Every pull request', 3],
  ['Changes to code', 1],
  ['Integrity', 4],
  ['Conformance to the unit', 3],
]

describe('the example checklist', () => {
  const raw = readFileSync(EXAMPLE, 'utf8')
  const stripped = raw.replace(/<!--[\s\S]*?-->/g, '')
  const r = parseRules(raw)
  const section = (name) => r.sections.find((s) => s.name === name)

  it('ST-43/AC-3 holds exactly the sections of the story, with their item counts, in order', () => {
    expect(r.ok).toBe(true)
    expect(r.sections.map((s) => [s.name, s.items.length])).toEqual(EXAMPLE_SECTIONS)
    for (const s of r.sections) {
      expect(s.items.map((i) => i.number)).toEqual(s.items.map((_, n) => n + 1))
    }
  })

  it('ST-43/AC-3 keeps the conditions of "Changes to code" and "Conformance to the unit"', () => {
    expect(section('Reading the pull request body').appliesWhen).toBeNull()
    expect(section('Every pull request').appliesWhen).toBeNull()
    expect(section('Integrity').appliesWhen).toBeNull()
    expect(section('Changes to code').appliesWhen).toBe(
      'the diff changes code, tests, workflow files or prompts.',
    )
    expect(section('Conformance to the unit').appliesWhen).toBe(
      'the pull request implements a unit.',
    )
  })

  it('ST-43/AC-3 "Reading the pull request body" names the Unit: line and the three sections', () => {
    const body = section('Reading the pull request body')
    expect(body.lead).toContain('`Unit:` line')
    for (const name of ['What changed', 'Verification', 'Docs check']) {
      expect(body.lead).toContain(`**${name}**`)
    }
    expect(body.items[0].text).toContain('`Unit:` line')
  })

  it('ST-43/AC-3 "Conformance to the unit" has completeness, fidelity and containment', () => {
    expect(section('Conformance to the unit').items.map((i) => i.text.split(' ')[0])).toEqual([
      '**Completeness**',
      '**Fidelity**',
      '**Containment**',
    ])
  })

  it('ST-43/AC-3 takes the items it keeps verbatim from REVIEW.md', () => {
    const review = parseRules(readFileSync(new URL('../../REVIEW.md', import.meta.url), 'utf8'))
    const kept = (name, from, to) => {
      const text = review.sections.find((s) => s.name === name).items[from - 1].text
      expect(section(name).items[to - 1].text).toBe(text)
    }
    kept('Every pull request', 1, 1)
    kept('Every pull request', 2, 2)
    kept('Changes to code', 1, 1)
    for (const n of [1, 2, 3, 4]) kept('Integrity', n, n)
  })

  it('ST-43/AC-4 leaves out what is one project\'s choice', () => {
    for (const word of ['README.md', 'coverage', 'stories/', 'ST-', 'AGENTS.md', 'story-containment']) {
      expect(raw).not.toContain(word)
    }
    expect(stripped).not.toMatch(/\btick/i)
  })

  it('ST-43/AC-5 has placeholders in the preamble, in a section and in the pull request body', () => {
    const comments = [...raw.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => ({
      text: m[1],
      at: m.index,
    }))
    const firstSection = raw.indexOf('\n## ')
    const bodySection = raw.indexOf('\n## Reading the pull request body')
    const nextSection = raw.indexOf('\n## ', bodySection + 1)
    // Before the first section: where a project adds its own sections.
    expect(comments.some((c) => c.at < firstSection && /sections/.test(c.text))).toBe(true)
    // In "Reading the pull request body": naming the project's own template and sections.
    expect(
      comments.some((c) => c.at > bodySection && c.at < nextSection && /template/.test(c.text)),
    ).toBe(true)
    // In a later section: where a project adds its own items.
    expect(comments.some((c) => c.at > nextSection && /items/.test(c.text))).toBe(true)
  })

  it('ST-43/AC-6 holds rules only, nothing on how steward runs a review', () => {
    for (const word of ['verdict', 'marker', 'workflow enforces', 'review/agent', 'Coder:']) {
      expect(stripped).not.toContain(word)
    }
    expect(stripped).not.toMatch(/\bgate\b/i)
  })
})
