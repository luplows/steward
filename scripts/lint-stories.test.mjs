// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { isSectionEmpty, lintAll, lintDocs, lintStory, parseFrontmatter, parseSections } from './lint-stories.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

function frontmatter({
  id = 'OQ-9001',
  title = 'A test story',
  tier = 'normal',
  kind = 'workflow',
  dependsOn = [],
  model = 'sonnet',
  blocked = null,
  extraLines = [],
} = {}) {
  const blockedLine = blocked === null ? 'null' : `"${blocked}"`
  return [
    '---',
    `id: ${id}`,
    `title: ${title}`,
    `tier: ${tier}`,
    `kind: ${kind}`,
    `depends_on: [${dependsOn.join(', ')}]`,
    `model: ${model}`,
    `blocked: ${blockedLine}`,
    ...extraLines,
    '---',
    '',
  ].join('\n')
}

function sections({
  intent = 'As a tester, I want a fixture, so that the lint can be checked.',
  acceptanceCriteria = '- [ ] **AC-1** — Something observable.',
  outOfScope = '- Nothing in particular.',
  constraints = '*(none)*',
  context = '- nowhere in particular',
  openQuestions = '*(none)*',
} = {}) {
  return [
    '## Intent',
    '',
    intent,
    '',
    '## Acceptance criteria',
    '',
    acceptanceCriteria,
    '',
    '## Out of scope',
    '',
    outOfScope,
    '',
    '## Constraints',
    '',
    constraints,
    '',
    '## Context',
    '',
    context,
    '',
    '## Open questions',
    '',
    openQuestions,
    '',
  ].join('\n')
}

function storySource(frontmatterOpts, sectionOpts) {
  return frontmatter(frontmatterOpts) + '\n' + sections(sectionOpts)
}

let tmpRoot

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'lint-stories-test-'))
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

async function writeStory(dir, filename, source) {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, filename), source, 'utf8')
}

describe('OQ-61/AC-1: single-run reporting', () => {
  it('a conforming story produces no violations', () => {
    const violations = lintStory('OQ-9001-fixture.md', storySource())
    expect(violations).toEqual([])
  })

  it('reports every violation in one run, not just the first', () => {
    const source = storySource({ tier: 'bogus', kind: 'bogus' })
    const violations = lintStory('OQ-9001-fixture.md', source)
    const rules = violations.map((v) => v.rule)
    expect(rules).toContain('AC-2')
    expect(violations.filter((v) => v.rule === 'AC-2').length).toBeGreaterThanOrEqual(2)
  })

  it('lintAll exits non-blocking (0) for a fully conforming set and blocking (non-zero-worthy) for a broken one', async () => {
    await writeStory(path.join(tmpRoot, 'stories'), 'OQ-9001-ok.md', storySource())
    const clean = await lintAll(tmpRoot)
    expect(clean.some((v) => v.blocking !== false)).toBe(false)

    await writeStory(path.join(tmpRoot, 'stories'), 'OQ-9002-broken.md', storySource({ id: 'OQ-9002', tier: 'nope' }))
    const withBroken = await lintAll(tmpRoot)
    expect(withBroken.some((v) => v.blocking !== false && v.file.endsWith('OQ-9002-broken.md'))).toBe(true)
  })
})

describe('OQ-61/AC-2: frontmatter schema', () => {
  it('rejects a story missing a required field', () => {
    const source = storySource().replace('model: sonnet\n', '')
    const violations = lintStory('OQ-9001-fixture.md', source)
    expect(violations.some((v) => v.rule === 'AC-2' && /model/.test(v.message))).toBe(true)
  })

  it("rejects an id that doesn't match ^OQ-\\d+$", () => {
    const violations = lintStory('OQ-9001-fixture.md', storySource({ id: 'weird-id' }))
    expect(violations.some((v) => v.rule === 'AC-2' && /'id'/.test(v.message))).toBe(true)
  })

  it('rejects a tier outside fix|next|normal|later', () => {
    const violations = lintStory('OQ-9001-fixture.md', storySource({ tier: 'someday' }))
    expect(violations.some((v) => v.rule === 'AC-2' && /'tier'/.test(v.message))).toBe(true)
  })

  it('rejects a kind outside product|workflow', () => {
    const violations = lintStory('OQ-9001-fixture.md', storySource({ kind: 'business' }))
    expect(violations.some((v) => v.rule === 'AC-2' && /'kind'/.test(v.message))).toBe(true)
  })

  it('rejects depends_on when it is not a list', () => {
    const source = storySource().replace('depends_on: []', 'depends_on: OQ-45')
    const violations = lintStory('OQ-9001-fixture.md', source)
    expect(violations.some((v) => v.rule === 'AC-2' && /depends_on' is not a list/.test(v.message))).toBe(true)
  })

  it('rejects a depends_on entry that does not match ^OQ-\\d+$', () => {
    const violations = lintStory('OQ-9001-fixture.md', storySource({ dependsOn: ['OQ-45', 'not-a-story'] }))
    expect(violations.some((v) => v.rule === 'AC-2' && /entry does not match/.test(v.message))).toBe(true)
  })

  it('accepts a populated depends_on list of valid ids', () => {
    const violations = lintStory('OQ-9001-fixture.md', storySource({ dependsOn: ['OQ-45', 'OQ-46'] }))
    expect(violations).toEqual([])
  })

  it('rejects blocked that is neither null nor a non-empty string', () => {
    const source = storySource().replace('blocked: null', 'blocked: ""')
    const violations = lintStory('OQ-9001-fixture.md', source)
    expect(violations.some((v) => v.rule === 'AC-2' && /'blocked'/.test(v.message))).toBe(true)
  })

  it('accepts a non-null blocked reason string', () => {
    const violations = lintStory('OQ-9001-fixture.md', storySource({ blocked: 'waiting on the owner' }))
    expect(violations).toEqual([])
  })

  it('reports an unknown extra frontmatter field but does not block the run', () => {
    const source = storySource({ extraLines: ['mechanisms: [thing]'] })
    const violations = lintStory('OQ-9001-fixture.md', source)
    const unknown = violations.find((v) => v.rule === 'AC-2' && /unknown frontmatter field/.test(v.message))
    expect(unknown).toBeDefined()
    expect(unknown.blocking).toBe(false)
  })
})

describe('OQ-61/AC-3: id must match its own filename', () => {
  it('rejects an id that does not match the OQ-<n> prefix of its filename', () => {
    const violations = lintStory('OQ-9001-anything.md', storySource({ id: 'OQ-9002' }))
    expect(violations.some((v) => v.rule === 'AC-3')).toBe(true)
  })

  it('does not constrain the slug after the prefix', () => {
    const violations = lintStory('OQ-9001-any-slug-at-all.md', storySource({ id: 'OQ-9001' }))
    expect(violations.some((v) => v.rule === 'AC-3')).toBe(false)
  })
})

describe('OQ-61/AC-4: all six sections must be present', () => {
  it('names every missing heading, not just the first', () => {
    const source = frontmatter() + '\n## Intent\n\nSomething.\n'
    const violations = lintStory('OQ-9001-fixture.md', source)
    const missing = violations.filter((v) => v.rule === 'AC-4').map((v) => v.message)
    expect(missing.some((m) => m.includes('Acceptance criteria'))).toBe(true)
    expect(missing.some((m) => m.includes('Out of scope'))).toBe(true)
    expect(missing.some((m) => m.includes('Constraints'))).toBe(true)
    expect(missing.some((m) => m.includes('Context'))).toBe(true)
    expect(missing.some((m) => m.includes('Open questions'))).toBe(true)
  })

  it('a fully headed story reports no AC-4 violations', () => {
    const violations = lintStory('OQ-9001-fixture.md', storySource())
    expect(violations.some((v) => v.rule === 'AC-4')).toBe(false)
  })
})

describe('OQ-61/AC-5: acceptance-criterion numbering', () => {
  it('rejects an empty Acceptance criteria section', () => {
    const violations = lintStory('OQ-9001-fixture.md', storySource(undefined, { acceptanceCriteria: '*(none)*' }))
    expect(violations.some((v) => v.rule === 'AC-5' && /no AC items/.test(v.message))).toBe(true)
  })

  it('rejects an AC-3 with no AC-2 (a gap)', () => {
    const ac = ['- [ ] **AC-1** — first.', '- [ ] **AC-3** — third, skipping second.'].join('\n')
    const violations = lintStory('OQ-9001-fixture.md', storySource(undefined, { acceptanceCriteria: ac }))
    expect(violations.some((v) => v.rule === 'AC-5' && /missing 'AC-2'/.test(v.message))).toBe(true)
  })

  it('rejects two AC-1 items (a duplicate)', () => {
    const ac = ['- [ ] **AC-1** — first.', '- [ ] **AC-1** — first again.'].join('\n')
    const violations = lintStory('OQ-9001-fixture.md', storySource(undefined, { acceptanceCriteria: ac }))
    expect(violations.some((v) => v.rule === 'AC-5' && /duplicate 'AC-1'/.test(v.message))).toBe(true)
  })

  it('rejects an AC-4b with no AC-4', () => {
    const ac = ['- [ ] **AC-1** — first.', '- [ ] **AC-4b** — an orphaned suffix.'].join('\n')
    const violations = lintStory('OQ-9001-fixture.md', storySource(undefined, { acceptanceCriteria: ac }))
    expect(violations.some((v) => v.rule === 'AC-5' && /'AC-4b' has no base 'AC-4'/.test(v.message))).toBe(true)
  })

  it('accepts a suffixed id whose base is present, alongside a clean 1..n run', () => {
    const ac = ['- [ ] **AC-1** — first.', '- [ ] **AC-1b** — inserted after dispatch.', '- [ ] **AC-2** — second.'].join('\n')
    const violations = lintStory('OQ-9001-fixture.md', storySource(undefined, { acceptanceCriteria: ac }))
    expect(violations.some((v) => v.rule === 'AC-5')).toBe(false)
  })

  it('rejects an AC item that is not a task-list checkbox at all', () => {
    const ac = ['- [ ] **AC-1** — first.', '- **AC-2** — not a checkbox.'].join('\n')
    const violations = lintStory('OQ-9001-fixture.md', storySource(undefined, { acceptanceCriteria: ac }))
    expect(violations.some((v) => v.rule === 'AC-5' && /not a well-formed/.test(v.message))).toBe(true)
  })

  it('rejects an AC item whose id is not bolded', () => {
    const ac = ['- [ ] **AC-1** — first.', '- [ ] AC-2 — id not bolded.'].join('\n')
    const violations = lintStory('OQ-9001-fixture.md', storySource(undefined, { acceptanceCriteria: ac }))
    expect(violations.some((v) => v.rule === 'AC-5' && /not a well-formed/.test(v.message))).toBe(true)
  })

  it("stories/done/OQ-68, OQ-69 and OQ-70's real suffixed ids (AC-3b, AC-6b, AC-7b) pass", async () => {
    for (const filename of ['OQ-68-github-operations.md', 'OQ-69-reviewer-dispatch.md', 'OQ-70-coder-dispatch.md']) {
      const filePath = path.join(repoRoot, 'stories', 'done', filename)
      const source = await readFile(filePath, 'utf8')
      const violations = lintStory(filePath, source).filter((v) => v.rule === 'AC-5')
      expect(violations, `${filename}: ${JSON.stringify(violations)}`).toEqual([])
    }
  })
})

describe('OQ-61/AC-6: a placeholder-only section is empty, like no content at all', () => {
  it('*(none)*, from docs/migration-plan.md\'s worked example, is empty', async () => {
    const text = await readFile(path.join(repoRoot, 'test', 'fixtures', 'placeholder-none.md'), 'utf8')
    expect(isSectionEmpty(text)).toBe(true)
  })

  it("*(must be empty to dispatch)*, from docs/agent-workflow-design.md's story artifact, is empty too", async () => {
    const text = await readFile(path.join(repoRoot, 'test', 'fixtures', 'placeholder-must-be-empty.md'), 'utf8')
    expect(isSectionEmpty(text)).toBe(true)
  })

  it('is identical to a section with no content at all', () => {
    expect(isSectionEmpty('')).toBe(true)
    expect(isSectionEmpty('\n  \n')).toBe(true)
  })

  it('the equivalence holds for Constraints as well as Open questions', async () => {
    const none = await readFile(path.join(repoRoot, 'test', 'fixtures', 'placeholder-none.md'), 'utf8')
    const mustBeEmpty = await readFile(path.join(repoRoot, 'test', 'fixtures', 'placeholder-must-be-empty.md'), 'utf8')

    const source = storySource(undefined, { constraints: none.trim(), openQuestions: mustBeEmpty.trim() })
    const bodyLines = source.split('\n')
    const bodyStartLine = bodyLines.findIndex((line) => line === '## Intent') + 1
    const parsed = parseSections(bodyLines.slice(bodyStartLine - 1), bodyStartLine)

    const constraintsText = parsed.get('Constraints').lines.map((l) => l.text).join('\n')
    const openQuestionsText = parsed.get('Open questions').lines.map((l) => l.text).join('\n')

    expect(isSectionEmpty(constraintsText)).toBe(true)
    expect(isSectionEmpty(openQuestionsText)).toBe(true)
  })

  it('anything beyond the marker is not empty', () => {
    expect(isSectionEmpty('*(none)*\n\nOne more thing to resolve.')).toBe(false)
  })
})

describe('OQ-61/AC-7: **Planned (OQ-n, ...)** markers in docs/*.md', () => {
  async function setupStories(dirRoot) {
    await writeStory(path.join(dirRoot, 'stories'), 'OQ-9001-open.md', storySource({ id: 'OQ-9001' }))
    await writeStory(path.join(dirRoot, 'stories', 'done'), 'OQ-9002-done.md', storySource({ id: 'OQ-9002' }))
  }

  it('a marker naming an open story passes', async () => {
    await setupStories(tmpRoot)
    await mkdir(path.join(tmpRoot, 'docs'), { recursive: true })
    await writeFile(path.join(tmpRoot, 'docs', 'design.md'), '**Planned (OQ-9001):** not built yet.\n', 'utf8')
    const violations = await lintDocs(tmpRoot)
    expect(violations).toEqual([])
  })

  it('a marker naming a story already in stories/done/ fails', async () => {
    await setupStories(tmpRoot)
    await mkdir(path.join(tmpRoot, 'docs'), { recursive: true })
    await writeFile(path.join(tmpRoot, 'docs', 'design.md'), '**Planned (OQ-9002):** already built.\n', 'utf8')
    const violations = await lintDocs(tmpRoot)
    expect(violations.some((v) => v.rule === 'AC-7' && /already in stories\/done/.test(v.message))).toBe(true)
  })

  it('a marker naming a numeric id with no story file at all fails', async () => {
    await setupStories(tmpRoot)
    await mkdir(path.join(tmpRoot, 'docs'), { recursive: true })
    await writeFile(path.join(tmpRoot, 'docs', 'design.md'), '**Planned (OQ-9999):** never written.\n', 'utf8')
    const violations = await lintDocs(tmpRoot)
    expect(violations.some((v) => v.rule === 'AC-7' && /has no story file/.test(v.message))).toBe(true)
  })

  it('the illustrative **Planned (OQ-n)** marker, with no numeric id, passes untouched', async () => {
    await setupStories(tmpRoot)
    await mkdir(path.join(tmpRoot, 'docs'), { recursive: true })
    await writeFile(path.join(tmpRoot, 'docs', 'design.md'), 'A passage that is decided but not built starts **Planned (OQ-n)**.\n', 'utf8')
    const violations = await lintDocs(tmpRoot)
    expect(violations).toEqual([])
  })
})

describe('OQ-61/AC-8: docs/agent-workflow-design.md resolves its own OQ-61 markers', () => {
  it('no **Planned (...)** marker in the real repo still names OQ-61', async () => {
    const source = await readFile(path.join(repoRoot, 'docs', 'agent-workflow-design.md'), 'utf8')
    const markers = [...source.matchAll(/\*\*Planned \(([^)]*)\)(?::\*\*|\*\*)/g)]
    const namesOQ61 = markers.some((m) =>
      m[1]
        .split(',')
        .map((s) => s.trim())
        .includes('OQ-61'),
    )
    expect(namesOQ61).toBe(false)
  })
})

describe('OQ-61: frontmatter and section parsing helpers', () => {
  it('parseFrontmatter tracks the 1-based line each field was declared on', () => {
    const { entries, bodyStartLine } = parseFrontmatter(storySource())
    expect(entries.get('id').line).toBe(2)
    expect(entries.get('tier').line).toBe(4)
    expect(bodyStartLine).toBe(10)
  })

  it('parseFrontmatter reports malformed when no --- block is found', () => {
    const { malformed } = parseFrontmatter('## Intent\n\nNo frontmatter here.\n')
    expect(malformed).toBe(true)
  })
})

describe('OQ-61: the real repository lints clean', () => {
  it('every story in stories/ and stories/done/, and every docs/*.md marker, is currently conforming', async () => {
    const violations = await lintAll(repoRoot)
    const blocking = violations.filter((v) => v.blocking !== false)
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([])
  })
})
