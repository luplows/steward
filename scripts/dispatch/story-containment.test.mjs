// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fixtureSettings } from './settings-fixture.mjs'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { checkStoryContainment } from './story-containment.mjs'

const git = (cwd, ...args) => execFileSync(
  'git',
  ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8' },
).trim()

// OQ-113: every test in this file runs git, through scenario, MAIN or git
// directly, which a machine running anything else has pushed past the 5 s
// default.
const CONTAINMENT_TEST_TIMEOUT = 30_000

const STORY = (id) => `---
id: ${id}
title: A story
tier: next
kind: workflow
depends_on: []
model: sonnet
blocked: null
---

## Intent

Do the thing.

## Acceptance criteria

- [ ] **AC-1** — First thing.
- [ ] **AC-2** — Second thing.

## Out of scope

*(none)*

## Constraints

*(none)*

## Context

*(none)*

## Open questions

*(none)*
`

let repo

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'tw-containment-test-'))
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(path.join(repo, 'steward.config.json'), JSON.stringify(fixtureSettings({ repo: 'luplows/tower-workshop-paths', storyPrefix: 'OQ' })))
  mkdirSync(path.join(repo, 'stories'))
  writeFileSync(path.join(repo, 'stories', 'OQ-82-foo.md'), STORY('OQ-82'))
  writeFileSync(path.join(repo, 'stories', 'OQ-90-other.md'), STORY('OQ-90'))
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'base')
})

afterAll(() => rmSync(repo, { recursive: true, force: true }))

// Starts a branch from `base`, applies `edit` to the working tree, commits,
// and returns { base, head, branch } ready to pass to checkStoryContainment.
function scenario(name, base, edit) {
  const branch = `story/OQ-82-${name}`
  git(repo, 'checkout', '-q', '-B', branch, base)
  edit()
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', name, '--allow-empty')
  const head = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'checkout', '-q', 'main')
  return { cwd: repo, base, head, branch }
}

function write(file, content) {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
  writeFileSync(path.join(repo, file), content)
}

function move(from, to) {
  mkdirSync(path.dirname(path.join(repo, to)), { recursive: true })
  git(repo, 'mv', from, to)
}

const MAIN = () => git(repo, 'rev-parse', 'main')

describe('OQ-82/AC-2: a conforming move with ticks', () => {
  it('is not a violation', async () => {
    const args = scenario('conforming-move', MAIN(), () => {
      move('stories/OQ-82-foo.md', 'stories/done/OQ-82-foo.md')
      write('stories/done/OQ-82-foo.md', STORY('OQ-82').replace('- [ ] **AC-1**', '- [x] **AC-1**'))
    })
    await expect(checkStoryContainment(args)).resolves.toEqual({ ok: true })
  }, CONTAINMENT_TEST_TIMEOUT)
})

describe('OQ-82/AC-2: a conforming blocked: edit', () => {
  it('is not a violation', async () => {
    const args = scenario('conforming-blocked', MAIN(), () => {
      write('stories/OQ-82-foo.md', STORY('OQ-82').replace('blocked: null', 'blocked: "waiting on the owner"'))
    })
    await expect(checkStoryContainment(args)).resolves.toEqual({ ok: true })
  }, CONTAINMENT_TEST_TIMEOUT)
})

describe('OQ-82/AC-2: a second story added', () => {
  it('is a violation naming the added file', async () => {
    const args = scenario('second-story-added', MAIN(), () => {
      move('stories/OQ-82-foo.md', 'stories/done/OQ-82-foo.md')
      write('stories/done/OQ-82-foo.md', STORY('OQ-82').replace('- [ ] **AC-1**', '- [x] **AC-1**'))
      write('stories/OQ-200-new.md', STORY('OQ-200'))
    })
    const result = await checkStoryContainment(args)
    expect(result.ok).toBe(false)
    expect(result.violations).toContainEqual(expect.objectContaining({ file: 'stories/OQ-200-new.md' }))
  }, CONTAINMENT_TEST_TIMEOUT)
})

describe('OQ-82/AC-2: another story\'s ACs edited', () => {
  it('is a violation naming that file and line', async () => {
    const args = scenario('other-story-edited', MAIN(), () => {
      move('stories/OQ-82-foo.md', 'stories/done/OQ-82-foo.md')
      write('stories/done/OQ-82-foo.md', STORY('OQ-82').replace('- [ ] **AC-1**', '- [x] **AC-1**'))
      write('stories/OQ-90-other.md', STORY('OQ-90').replace('- [ ] **AC-1**', '- [x] **AC-1**'))
    })
    const result = await checkStoryContainment(args)
    expect(result.ok).toBe(false)
    const found = result.violations.find((v) => v.file === 'stories/OQ-90-other.md')
    expect(found).toBeDefined()
    expect(found.line).toBeGreaterThan(0)
  }, CONTAINMENT_TEST_TIMEOUT)
})

describe('OQ-82/AC-2: its own AC reworded', () => {
  it('is a violation, not satisfied by a tick alone', async () => {
    const args = scenario('own-ac-reworded', MAIN(), () => {
      move('stories/OQ-82-foo.md', 'stories/done/OQ-82-foo.md')
      write(
        'stories/done/OQ-82-foo.md',
        STORY('OQ-82').replace('- [ ] **AC-1** — First thing.', '- [x] **AC-1** — First thing, reworded.'),
      )
    })
    const result = await checkStoryContainment(args)
    expect(result.ok).toBe(false)
    expect(result.violations).toContainEqual(expect.objectContaining({ file: 'stories/done/OQ-82-foo.md' }))
  }, CONTAINMENT_TEST_TIMEOUT)
})

describe('OQ-82/AC-2: a tick removed', () => {
  it('is a violation -- direction matters, not just that the text matches', async () => {
    // A dedicated base where AC-1 already reads [x] (a state no live dispatch
    // reaches, but it isolates the direction check: [x] regressing to [ ] must
    // fail exactly as any other disallowed edit would, not pass as a no-op).
    git(repo, 'checkout', '-q', '-B', 'preticked-base', 'main')
    write('stories/OQ-83-preticked.md', STORY('OQ-83').replace('- [ ] **AC-1**', '- [x] **AC-1**'))
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'preticked base')
    const preticked = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '-q', 'main')

    const args = scenario('tick-removed', preticked, () => {
      write('stories/OQ-83-preticked.md', STORY('OQ-83'))
    })
    const result = await checkStoryContainment({ ...args, branch: 'story/OQ-83-tick-removed' })
    expect(result.ok).toBe(false)
    expect(result.violations).toContainEqual(expect.objectContaining({ file: 'stories/OQ-83-preticked.md' }))
  }, CONTAINMENT_TEST_TIMEOUT)
})

describe('OQ-82/AC-1 and AC-2: a story branch with no move that adds a story', () => {
  it('is caught by the branch-name fallback and flagged', async () => {
    const args = scenario('no-move-adds-story', MAIN(), () => {
      write('stories/OQ-201-added.md', STORY('OQ-201'))
    })
    const result = await checkStoryContainment(args)
    expect(result.ok).toBe(false)
    expect(result.violations).toContainEqual(expect.objectContaining({ file: 'stories/OQ-201-added.md' }))
  }, CONTAINMENT_TEST_TIMEOUT)
})

describe('OQ-82/AC-3: a story-writing PR is not restricted', () => {
  it('passes regardless of what it changes under stories/', async () => {
    git(repo, 'checkout', '-q', '-B', 'chore/add-stories', 'main')
    write('stories/OQ-202-added.md', STORY('OQ-202'))
    write('stories/OQ-90-other.md', STORY('OQ-90').replace('- [ ] **AC-1**', '- [x] **AC-1**'))
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'the planning session writes stories')
    const head = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '-q', 'main')

    const result = await checkStoryContainment({ cwd: repo, base: MAIN(), head, branch: 'chore/add-stories' })
    expect(result).toEqual({ ok: true })
  }, CONTAINMENT_TEST_TIMEOUT)
})

// ST-30: a base where OQ-82 is a `kind: spike` story and OQ-91 is already done.
const DRAFT = (id) => STORY(id).replace('## Open questions\n\n*(none)*', '## Open questions\n\n- Which way should it go?')

function spikeBase(kind) {
  git(repo, 'checkout', '-q', '-B', `${kind}-base`, 'main')
  write('stories/OQ-82-foo.md', STORY('OQ-82').replace('kind: workflow', `kind: ${kind}`))
  write('stories/done/OQ-91-finished.md', STORY('OQ-91'))
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', `${kind} base`)
  const sha = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'checkout', '-q', 'main')
  return sha
}

function spikeScenario(name, edit, kind = 'spike') {
  return scenario(name, spikeBase(kind), () => {
    move('stories/OQ-82-foo.md', 'stories/done/OQ-82-foo.md')
    write(
      'stories/done/OQ-82-foo.md',
      STORY('OQ-82').replace('kind: workflow', `kind: ${kind}`).replace('- [ ] **AC-1**', '- [x] **AC-1**'),
    )
    edit()
  })
}

describe("ST-30/AC-2 and AC-4: a spike's pull request adding drafts", () => {
  it('passes when it adds two drafts', async () => {
    const args = spikeScenario('two-drafts', () => {
      write('stories/OQ-300-first.md', DRAFT('OQ-300'))
      write('stories/OQ-301-second.md', DRAFT('OQ-301'))
    })
    await expect(checkStoryContainment(args)).resolves.toEqual({ ok: true })
  }, CONTAINMENT_TEST_TIMEOUT)

  it("fails when an added story's Open questions holds only a placeholder", async () => {
    const args = spikeScenario('placeholder', () => {
      write('stories/OQ-300-first.md', STORY('OQ-300'))
    })
    const result = await checkStoryContainment(args)
    expect(result.ok).toBe(false)
    expect(result.violations).toContainEqual(
      expect.objectContaining({ file: 'stories/OQ-300-first.md', message: expect.stringContaining("not 'draft'") }),
    )
  }, CONTAINMENT_TEST_TIMEOUT)

  it('fails when an added story has blocked: set', async () => {
    const args = spikeScenario('blocked', () => {
      write('stories/OQ-300-first.md', DRAFT('OQ-300').replace('blocked: null', 'blocked: "waiting"'))
    })
    const result = await checkStoryContainment(args)
    expect(result.ok).toBe(false)
    expect(result.violations).toContainEqual(
      expect.objectContaining({ file: 'stories/OQ-300-first.md', message: expect.stringContaining("'blocked'") }),
    )
  }, CONTAINMENT_TEST_TIMEOUT)

  it("fails when an added story's id is in stories/done/ at the merge base", async () => {
    const args = spikeScenario('id-in-done', () => {
      write('stories/OQ-91-again.md', DRAFT('OQ-91'))
    })
    const result = await checkStoryContainment(args)
    expect(result.ok).toBe(false)
    expect(result.violations).toContainEqual(
      expect.objectContaining({ file: 'stories/OQ-91-again.md', message: expect.stringContaining('merge base') }),
    )
  }, CONTAINMENT_TEST_TIMEOUT)

  it('fails when two added files share one id', async () => {
    const args = spikeScenario('one-id-twice', () => {
      write('stories/OQ-300-first.md', DRAFT('OQ-300'))
      write('stories/OQ-300-second.md', DRAFT('OQ-300'))
    })
    const result = await checkStoryContainment(args)
    expect(result.ok).toBe(false)
    expect(result.violations.filter((v) => v.message.includes('another file the pull request adds'))).toHaveLength(2)
  }, CONTAINMENT_TEST_TIMEOUT)

  it("fails when an added file's name does not match the story filename pattern", async () => {
    const args = spikeScenario('bad-name', () => {
      write('stories/notes.md', DRAFT('OQ-300'))
    })
    const result = await checkStoryContainment(args)
    expect(result.ok).toBe(false)
    expect(result.violations).toContainEqual(
      expect.objectContaining({ file: 'stories/notes.md', message: expect.stringContaining('filename pattern') }),
    )
  }, CONTAINMENT_TEST_TIMEOUT)
})

describe("ST-30/AC-3 and AC-4: nothing else a spike's pull request does changes", () => {
  it('fails when it changes a story that exists at the merge base', async () => {
    const args = spikeScenario('changes-existing', () => {
      write('stories/OQ-300-first.md', DRAFT('OQ-300'))
      write('stories/OQ-90-other.md', STORY('OQ-90').replace('- [ ] **AC-1**', '- [x] **AC-1**'))
    })
    const result = await checkStoryContainment(args)
    expect(result.ok).toBe(false)
    expect(result.violations).toContainEqual(expect.objectContaining({ file: 'stories/OQ-90-other.md' }))
  }, CONTAINMENT_TEST_TIMEOUT)

  it('fails when it deletes a story', async () => {
    const args = spikeScenario('deletes-existing', () => {
      git(repo, 'rm', '-q', 'stories/OQ-90-other.md')
    })
    const result = await checkStoryContainment(args)
    expect(result.ok).toBe(false)
    expect(result.violations).toContainEqual(expect.objectContaining({ file: 'stories/OQ-90-other.md' }))
  }, CONTAINMENT_TEST_TIMEOUT)

  it('fails when it adds a file in stories/done/ or stories/retired/', async () => {
    const args = spikeScenario('adds-done-retired', () => {
      write('stories/done/OQ-300-first.md', DRAFT('OQ-300'))
      write('stories/retired/OQ-301-second.md', DRAFT('OQ-301'))
    })
    const result = await checkStoryContainment(args)
    expect(result.ok).toBe(false)
    expect(result.violations.map((v) => v.file)).toEqual(
      expect.arrayContaining(['stories/done/OQ-300-first.md', 'stories/retired/OQ-301-second.md']),
    )
  }, CONTAINMENT_TEST_TIMEOUT)

  it("fails when a kind: workflow story's pull request adds a draft", async () => {
    const args = spikeScenario('workflow-adds-draft', () => {
      write('stories/OQ-300-first.md', DRAFT('OQ-300'))
    }, 'workflow')
    const result = await checkStoryContainment(args)
    expect(result.ok).toBe(false)
    expect(result.violations).toContainEqual(expect.objectContaining({ file: 'stories/OQ-300-first.md' }))
  }, CONTAINMENT_TEST_TIMEOUT)
})
