// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  buildStory,
  deriveStatus,
  dispatchable,
  isOpenQuestionsEmpty,
  isStoryFilename,
  loadQueue,
  orderStories,
  parseFrontmatter,
  parseSections,
} from './queue.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const queueScript = path.join(here, 'queue.mjs')

function frontmatter({ id, title = 'A test story', tier = 'normal', dependsOn = [], blocked = null }) {
  const blockedLine = blocked === null ? 'null' : `"${blocked}"`
  return [
    '---',
    `id: ${id}`,
    `title: ${title}`,
    `tier: ${tier}`,
    'kind: workflow',
    `depends_on: [${dependsOn.join(', ')}]`,
    'model: sonnet',
    `blocked: ${blockedLine}`,
    '---',
    '',
  ].join('\n')
}

function storySource(opts, { openQuestions = '*(none)*' } = {}) {
  return `${frontmatter(opts)}\n## Intent\n\nSomething.\n\n## Open questions\n\n${openQuestions}\n`
}

let tmpRoot

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'queue-test-'))
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

async function writeStory(dir, filename, source) {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, filename), source, 'utf8')
}

describe('OQ-49/AC-1: filename filtering', () => {
  it('matches OQ-<n>-<slug>.md and nothing else', () => {
    expect(isStoryFilename('OQ-49-read-story-queue.md')).toBe(true)
    expect(isStoryFilename('OQ-5-x.md')).toBe(true)
    expect(isStoryFilename('README.md')).toBe(false)
    expect(isStoryFilename('_TEMPLATE.md')).toBe(false)
    expect(isStoryFilename('OQ-49.md')).toBe(false)
    expect(isStoryFilename('notes.md')).toBe(false)
    expect(isStoryFilename('OQ-abc-slug.md')).toBe(false)
    expect(isStoryFilename('OQ-49-slug.md.bak')).toBe(false)
  })

  it('loadQueue ignores README.md and _TEMPLATE.md sitting beside real stories', async () => {
    const storiesDir = path.join(tmpRoot, 'stories')
    await writeStory(storiesDir, 'OQ-900-real.md', storySource({ id: 'OQ-900' }))
    await writeFile(path.join(storiesDir, 'README.md'), '# not a story, no frontmatter\n', 'utf8')
    await writeFile(path.join(storiesDir, '_TEMPLATE.md'), '# not a story either\n', 'utf8')

    const stories = await loadQueue(tmpRoot)

    expect(stories.map((s) => s.id)).toEqual(['OQ-900'])
  })
})

describe('OQ-49/AC-2: bad frontmatter fails loudly, naming the file', () => {
  it('throws naming the file when the frontmatter block is missing entirely', () => {
    const source = '## Intent\n\nNo frontmatter here.\n'
    expect(() => buildStory('/fake/OQ-1-x.md', source, false)).toThrow(/OQ-1-x\.md.*missing frontmatter/s)
  })

  it('throws naming the file when a frontmatter line is unparseable', () => {
    const source = ['---', 'id: OQ-1', 'this is not a key value line', 'tier: normal', '---', ''].join('\n')
    expect(() => buildStory('/fake/OQ-1-x.md', source, false)).toThrow(/OQ-1-x\.md.*unparseable frontmatter line/s)
  })

  it('throws naming the file and the field when a required field is missing', () => {
    const source = ['---', 'id: OQ-1', 'title: T', 'tier: normal', 'depends_on: []', '---', '## Open questions', '', '*(none)*', ''].join('\n')
    expect(() => buildStory('/fake/OQ-1-x.md', source, false)).toThrow(/OQ-1-x\.md.*required field 'blocked'/s)
  })

  it('does not choke on a field this module does not read, written as a block YAML list (e.g. stories/OQ-55-*.md)', () => {
    const source = [
      '---',
      'id: OQ-1',
      'title: T',
      'tier: normal',
      'kind: workflow',
      'depends_on: []',
      'model: sonnet',
      'blocked: null',
      'mechanisms:',
      "  - the lint's frontmatter validation",
      '  - the story schema of record',
      '---',
      '',
      '## Open questions',
      '',
      '*(none)*',
      '',
    ].join('\n')

    const story = buildStory('/fake/OQ-1-x.md', source, false)

    expect(story.id).toBe('OQ-1')
    expect(story.openQuestionsEmpty).toBe(true)
  })

  it('never skips or defaults a bad story -- loadQueue propagates the failure', async () => {
    const storiesDir = path.join(tmpRoot, 'stories')
    await writeStory(storiesDir, 'OQ-900-broken.md', '## Intent\n\nNo frontmatter.\n')

    await expect(loadQueue(tmpRoot)).rejects.toThrow(/OQ-900-broken\.md/)
  })
})

describe('OQ-49/AC-3: status derivation order', () => {
  const base = { id: 'OQ-900', numericId: 900, title: 'T', tier: 'normal', filePath: 'fake' }

  it('done wins even when blocked, draft and waiting would also apply', () => {
    const story = { ...base, isDone: true, blocked: 'reason', openQuestionsEmpty: false, dependsOn: ['OQ-1'] }
    expect(deriveStatus(story, new Set()).status).toBe('done')
  })

  it('blocked wins over draft and waiting when not done', () => {
    const story = { ...base, isDone: false, blocked: 'reason', openQuestionsEmpty: false, dependsOn: ['OQ-1'] }
    expect(deriveStatus(story, new Set()).status).toBe('blocked')
  })

  it('draft wins over waiting when not done or blocked', () => {
    const story = { ...base, isDone: false, blocked: null, openQuestionsEmpty: false, dependsOn: ['OQ-1'] }
    expect(deriveStatus(story, new Set()).status).toBe('draft')
  })

  it('waiting applies when a dependency is not in done/', () => {
    const story = { ...base, isDone: false, blocked: null, openQuestionsEmpty: true, dependsOn: ['OQ-1'] }
    const result = deriveStatus(story, new Set())
    expect(result.status).toBe('waiting')
    expect(result.waitingOn).toEqual(['OQ-1'])
  })

  it('ready applies when none of the above holds', () => {
    const story = { ...base, isDone: false, blocked: null, openQuestionsEmpty: true, dependsOn: [] }
    expect(deriveStatus(story, new Set()).status).toBe('ready')
  })

  it('waiting clears once the dependency is in done/', () => {
    const story = { ...base, isDone: false, blocked: null, openQuestionsEmpty: true, dependsOn: ['OQ-1'] }
    expect(deriveStatus(story, new Set(['OQ-1'])).status).toBe('ready')
  })
})

describe('OQ-49/AC-4: only ready stories are dispatchable', () => {
  it('filters out done, blocked, draft and waiting, keeping only ready', () => {
    const stories = [
      { id: 'OQ-1', status: 'done' },
      { id: 'OQ-2', status: 'blocked' },
      { id: 'OQ-3', status: 'draft' },
      { id: 'OQ-4', status: 'waiting', waitingOn: ['OQ-9'] },
      { id: 'OQ-5', status: 'ready' },
    ]
    expect(dispatchable(stories).map((s) => s.id)).toEqual(['OQ-5'])
  })

  it('a waiting story is still listed (by loadQueue), with what it is waiting on', async () => {
    const storiesDir = path.join(tmpRoot, 'stories')
    await writeStory(storiesDir, 'OQ-900-waiter.md', storySource({ id: 'OQ-900', dependsOn: ['OQ-800'] }))

    const stories = await loadQueue(tmpRoot)

    expect(stories).toHaveLength(1)
    expect(stories[0].status).toBe('waiting')
    expect(stories[0].waitingOn).toEqual(['OQ-800'])
    expect(dispatchable(stories)).toEqual([])
  })
})

describe('OQ-49/AC-5: ordering by tier then lowest id', () => {
  it('orders fix, next, normal, later, then ascending id within a tier', () => {
    const stories = [
      { id: 'OQ-30', numericId: 30, tier: 'later' },
      { id: 'OQ-10', numericId: 10, tier: 'fix' },
      { id: 'OQ-20', numericId: 20, tier: 'next' },
      { id: 'OQ-11', numericId: 11, tier: 'fix' },
      { id: 'OQ-40', numericId: 40, tier: 'normal' },
    ]
    expect(orderStories(stories).map((s) => s.id)).toEqual(['OQ-10', 'OQ-11', 'OQ-20', 'OQ-40', 'OQ-30'])
  })

  it('is identical regardless of input (filesystem enumeration) order', () => {
    const a = { id: 'OQ-1', numericId: 1, tier: 'normal' }
    const b = { id: 'OQ-2', numericId: 2, tier: 'fix' }
    const c = { id: 'OQ-3', numericId: 3, tier: 'later' }

    const orderedOne = orderStories([a, b, c]).map((s) => s.id)
    const orderedTwo = orderStories([c, a, b]).map((s) => s.id)
    const orderedThree = orderStories([b, c, a]).map((s) => s.id)

    expect(orderedOne).toEqual(['OQ-2', 'OQ-1', 'OQ-3'])
    expect(orderedTwo).toEqual(orderedOne)
    expect(orderedThree).toEqual(orderedOne)
  })

  it('an unrecognised tier fails loudly rather than sorting arbitrarily', () => {
    const source = storySource({ id: 'OQ-900', tier: 'urgent' })
    expect(() => buildStory('/fake/OQ-900-x.md', source, false)).toThrow(/OQ-900-x\.md.*unrecognised tier 'urgent'/s)
  })
})

describe('OQ-49/AC-6: running as a script', () => {
  it('prints every story in order with id, title and status, exiting 0', async () => {
    const storiesDir = path.join(tmpRoot, 'stories')
    await writeStory(storiesDir, 'OQ-902-second.md', storySource({ id: 'OQ-902', title: 'Second story', tier: 'normal' }))
    await writeStory(storiesDir, 'OQ-901-first.md', storySource({ id: 'OQ-901', title: 'First story', tier: 'fix' }))

    const stdout = execFileSync(process.execPath, [queueScript], { cwd: tmpRoot, encoding: 'utf8' })
    const lines = stdout.trim().split('\n')

    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^OQ-901\s+ready\s+First story$/)
    expect(lines[1]).toMatch(/^OQ-902\s+ready\s+Second story$/)
  })

  it('exits non-zero and names the file on the console when a story fails to parse', async () => {
    const storiesDir = path.join(tmpRoot, 'stories')
    await writeStory(storiesDir, 'OQ-903-broken.md', '## Intent\n\nNo frontmatter at all.\n')

    let error
    try {
      execFileSync(process.execPath, [queueScript], { cwd: tmpRoot, encoding: 'utf8' })
    } catch (err) {
      error = err
    }

    expect(error).toBeDefined()
    expect(error.status).not.toBe(0)
    expect(error.stderr).toMatch(/OQ-903-broken\.md/)
  })
})

describe('OQ-49/AC-7: what counts as an empty Open questions section', () => {
  it('is empty when content, ignoring whitespace, is exactly *(none)*', () => {
    expect(isOpenQuestionsEmpty('\n  *(none)*  \n')).toBe(true)
  })

  it('is empty when an HTML comment surrounds the marker', () => {
    expect(isOpenQuestionsEmpty('<!-- must be empty to dispatch -->\n\n*(none)*\n')).toBe(true)
  })

  it('is not empty when real content sits alongside the marker', () => {
    expect(isOpenQuestionsEmpty('- an actual open question\n\n*(none)*\n')).toBe(false)
  })

  it('is malformed -- throws -- when the section holds nothing at all', () => {
    expect(() => isOpenQuestionsEmpty('\n\n   \n')).toThrow(/empty/)
  })

  it('is malformed when only an HTML comment remains, with no marker', () => {
    expect(() => isOpenQuestionsEmpty('<!-- nobody filled this in -->\n')).toThrow(/empty/)
  })

  it("this story's own *(none)* marker derives ready, not draft (the failure AC-7 exists to prevent)", () => {
    // A literal copy of this story's own frontmatter and Open questions
    // section, so the test does not depend on where the file currently
    // lives (it moves to stories/done/ as part of this PR's own AC-19).
    const source = [
      '---',
      'id: OQ-49',
      'title: Read and rank the story queue',
      'tier: next',
      'kind: workflow',
      'depends_on: []',
      'model: sonnet',
      'blocked: null',
      '---',
      '',
      '## Open questions',
      '',
      '*(none)*',
      '',
    ].join('\n')

    const story = buildStory('/fake/OQ-49-read-story-queue.md', source, false)
    const status = deriveStatus(story, new Set())

    expect(story.openQuestionsEmpty).toBe(true)
    expect(status.status).toBe('ready')
  })
})

describe('OQ-49/AC-8: section boundaries ignore fenced code blocks', () => {
  it('reads the real Open questions section of stories/OQ-51-*.md, not the fake heading inside its fence', async () => {
    const fixturePath = path.join(repoRoot, 'stories', 'OQ-51-story-injection-boundary.md')
    const source = await readFile(fixturePath, 'utf8')
    const { body } = parseFrontmatter(source, fixturePath)
    const sections = parseSections(body)

    const openQuestions = sections.get('Open questions')

    expect(openQuestions).toBeDefined()
    expect(openQuestions).toContain('Where does assembly live')
    // The fence contains a fake "## Open questions" line followed by a fake
    // "## What review is" line -- a scanner that isn't fence-aware would
    // treat the first as the section start and bleed the second (and
    // everything between, including the real Out of scope/Constraints/
    // Context sections) into what it thinks is "Open questions".
    expect(openQuestions).not.toContain('## What review is')
    expect(openQuestions).not.toContain('<- story')
    expect(openQuestions).not.toContain('Out of scope')
  })

  it('derives draft for the real reason (genuine open question), not the fence artefact', async () => {
    const fixturePath = path.join(repoRoot, 'stories', 'OQ-51-story-injection-boundary.md')
    const source = await readFile(fixturePath, 'utf8')
    const story = buildStory(fixturePath, source, false)

    expect(story.openQuestionsEmpty).toBe(false)
    expect(deriveStatus(story, new Set()).status).toBe('draft')
  })

  it('a `## ` line inside a fence does not itself start or end a section', () => {
    const body = [
      '## Intent',
      '',
      'Real intent text.',
      '',
      '```',
      '## Fake heading inside a fence',
      'fenced content that must not become its own section',
      '```',
      '',
      '## Open questions',
      '',
      '*(none)*',
      '',
    ].join('\n')

    const sections = parseSections(body)

    expect(sections.has('Fake heading inside a fence')).toBe(false)
    expect(sections.get('Intent')).toContain('Fake heading inside a fence')
    expect(sections.get('Open questions').trim()).toBe('*(none)*')
  })
})
