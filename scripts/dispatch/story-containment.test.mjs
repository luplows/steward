// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fixtureSettings } from './settings-fixture.mjs'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { checkStoryContainment, resolveStory } from './story-containment.mjs'

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
  writeFileSync(path.join(repo, 'steward.config.json'), JSON.stringify(fixtureSettings({ repo: 'luplows/tower-workshop-paths' })))
  mkdirSync(path.join(repo, 'stories'))
  writeFileSync(path.join(repo, 'stories', 'stories.json'), JSON.stringify({ prefix: 'OQ' }))
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

})

describe("ST-67/AC-3: any story's pull request may add drafts", () => {
  it("ST-67/AC-3: passes when a kind: workflow story's pull request adds a draft", async () => {
    const args = spikeScenario('workflow-adds-draft', () => {
      write('stories/OQ-300-first.md', DRAFT('OQ-300'))
    }, 'workflow')
    await expect(checkStoryContainment(args)).resolves.toEqual({ ok: true })
  }, CONTAINMENT_TEST_TIMEOUT)

  it("ST-67/AC-3: a kind: workflow story's pull request still may not add a story that is not a draft", async () => {
    const args = spikeScenario('workflow-adds-non-draft', () => {
      write('stories/OQ-300-first.md', STORY('OQ-300'))
    }, 'workflow')
    const result = await checkStoryContainment(args)
    expect(result.ok).toBe(false)
    expect(result.violations).toContainEqual(
      expect.objectContaining({ file: 'stories/OQ-300-first.md', message: expect.stringContaining("not 'draft'") }),
    )
  }, CONTAINMENT_TEST_TIMEOUT)

  it('ST-67/AC-3: a pull request that does not move its story still may not add one', async () => {
    const args = scenario('no-move-adds-draft', MAIN(), () => {
      write('stories/OQ-300-first.md', DRAFT('OQ-300'))
    })
    const result = await checkStoryContainment(args)
    expect(result.ok).toBe(false)
    expect(result.violations).toContainEqual(expect.objectContaining({ file: 'stories/OQ-300-first.md' }))
  }, CONTAINMENT_TEST_TIMEOUT)
})

// ST-67: a story with an added line under `## Out of scope`, after the existing
// `*(none)*`. A story moved into stories/done/ also ticks an AC, so that path
// shows the two together; one not moved changes nothing else.
const NO_EXCLUSIONS = '## Out of scope\n\n*(none)*'
const WITH_OUT_OF_SCOPE = (...lines) => STORY('OQ-82').replace(NO_EXCLUSIONS, [NO_EXCLUSIONS, ...lines].join('\n'))
const AFTER_REVIEW = (followUp = 'none') => `- **After review:** A case it excludes (crew, 2026-11-03). Follow-up: ${followUp}.`

const LAYOUTS = [
  {
    name: 'moved into stories/done/',
    file: 'stories/done/OQ-82-foo.md',
    edit: (text) => {
      move('stories/OQ-82-foo.md', 'stories/done/OQ-82-foo.md')
      write('stories/done/OQ-82-foo.md', text.replace('- [ ] **AC-1**', '- [x] **AC-1**'))
    },
  },
  {
    name: 'not moved',
    file: 'stories/OQ-82-foo.md',
    edit: (text) => write('stories/OQ-82-foo.md', text),
  },
]

describe.each(LAYOUTS)('ST-67/AC-1: an added exclusion, for a story $name', ({ name, file, edit }) => {
  const slug = name.replace(/\W+/g, '-')
  const violationsOf = async (scenarioName, text) => {
    const result = await checkStoryContainment(scenario(`${scenarioName}-${slug}`, MAIN(), () => edit(text)))
    expect(result.ok).toBe(false)
    return result.violations
  }

  it('ST-67/AC-1: accepts lines added to its Out of scope', async () => {
    const args = scenario(`added-lines-${slug}`, MAIN(), () => edit(WITH_OUT_OF_SCOPE(AFTER_REVIEW(), AFTER_REVIEW('OQ-90'))))
    await expect(checkStoryContainment(args)).resolves.toEqual({ ok: true })
  }, CONTAINMENT_TEST_TIMEOUT)

  it('ST-67/AC-1: fails a line in that form added in any other section', async () => {
    for (const heading of ['## Intent', '## Acceptance criteria', '## Constraints', '## Context', '## Open questions']) {
      const text = STORY('OQ-82').replace(`${heading}\n`, `${heading}\n\n${AFTER_REVIEW()}\n`)
      const violations = await violationsOf(`other-section-${heading.replace(/\W+/g, '-')}`, text)
      expect(violations).toContainEqual(expect.objectContaining({ file }))
    }
  }, CONTAINMENT_TEST_TIMEOUT)

  it('ST-67/AC-1: fails a line in that form above the first heading', async () => {
    const violations = await violationsOf('above-heading', STORY('OQ-82').replace('## Intent\n', `${AFTER_REVIEW()}\n\n## Intent\n`))
    expect(violations).toContainEqual(expect.objectContaining({ file }))
  }, CONTAINMENT_TEST_TIMEOUT)

  it('ST-67/AC-1: fails a change to a line already there', async () => {
    const text = STORY('OQ-82').replace(NO_EXCLUSIONS, '## Out of scope\n\n*(nothing)*')
    expect(await violationsOf('changed-existing', text)).toContainEqual(expect.objectContaining({ file }))
  }, CONTAINMENT_TEST_TIMEOUT)

  it('ST-67/AC-1: fails replacing a line already there with one in the form', async () => {
    const text = STORY('OQ-82').replace(NO_EXCLUSIONS, `## Out of scope\n\n${AFTER_REVIEW()}`)
    expect(await violationsOf('replaced-existing', text)).toContainEqual(expect.objectContaining({ file }))
  }, CONTAINMENT_TEST_TIMEOUT)

  it('ST-67/AC-1: fails removing a line already there', async () => {
    const text = STORY('OQ-82').replace(NO_EXCLUSIONS, '## Out of scope\n')
    expect(await violationsOf('removed-existing', text)).toContainEqual(expect.objectContaining({ file }))
  }, CONTAINMENT_TEST_TIMEOUT)

  it('ST-67/AC-2: fails an added line in any other form, naming the line', async () => {
    const forms = [
      '- A case it excludes.',
      '',
      '- **After review:** (crew, 2026-11-03). Follow-up: none.',
      '- **After review:** A case (coder, 2026-11-03). Follow-up: none.',
      '- **After review:** A case (crew, 3 November 2026). Follow-up: none.',
      '- **After review:** A case (crew, 2026-11-03).',
      '- **After review:** A case (crew, 2026-11-03). Follow-up: later.',
      '- **After review:** A case (crew, 2026-11-03). Follow-up: ST-90.',
      '- **After review:** A case (crew, 2026-11-03). Follow-up: none',
      '**After review:** A case (crew, 2026-11-03). Follow-up: none.',
    ]
    for (const [index, line] of forms.entries()) {
      const text = WITH_OUT_OF_SCOPE(line)
      const violations = await violationsOf(`other-form-${index}`, text)
      // An added blank line matches the blank line already there, so the second of the two is the addition.
      const added = text.split('\n').indexOf('*(none)*') + (line === '' ? 3 : 2)
      expect(violations, line).toEqual([expect.objectContaining({
        file,
        line: added,
        message: expect.stringContaining('not in the form'),
      })])
    }
  }, 2 * CONTAINMENT_TEST_TIMEOUT)

  it('ST-67/AC-2: fails a follow-up naming a story neither at the merge base nor added', async () => {
    const violations = await violationsOf('unknown-follow-up', WITH_OUT_OF_SCOPE(AFTER_REVIEW('OQ-999')))
    expect(violations).toEqual([expect.objectContaining({
      file,
      message: expect.stringContaining('OQ-999 is neither at the merge base nor added'),
    })])
  }, CONTAINMENT_TEST_TIMEOUT)
})

describe('ST-67/AC-2: what a follow-up may name', () => {
  // spikeScenario's base holds OQ-90 in stories/ and OQ-91 in stories/done/.
  const movedWithLine = (followUp, extra = () => {}) => spikeScenario(`follow-up-${followUp}`, () => {
    write('stories/done/OQ-82-foo.md', WITH_OUT_OF_SCOPE(AFTER_REVIEW(followUp)))
    extra()
  }, 'workflow')

  it('ST-67/AC-2: accepts none, and a story at the merge base in stories/ or stories/done/', async () => {
    for (const followUp of ['none', 'OQ-90', 'OQ-91']) {
      await expect(checkStoryContainment(movedWithLine(followUp))).resolves.toEqual({ ok: true })
    }
  }, CONTAINMENT_TEST_TIMEOUT)

  it('ST-67/AC-2: accepts a story the pull request adds as a draft', async () => {
    const args = movedWithLine('OQ-300', () => write('stories/OQ-300-later.md', DRAFT('OQ-300')))
    await expect(checkStoryContainment(args)).resolves.toEqual({ ok: true })
  }, CONTAINMENT_TEST_TIMEOUT)

  it('ST-67/AC-2: fails a story id no file carries', async () => {
    const result = await checkStoryContainment(movedWithLine('OQ-301', () => write('stories/OQ-300-later.md', DRAFT('OQ-300'))))
    expect(result.ok).toBe(false)
    expect(result.violations).toEqual([expect.objectContaining({
      file: 'stories/done/OQ-82-foo.md',
      message: expect.stringContaining('OQ-301'),
    })])
  }, CONTAINMENT_TEST_TIMEOUT)
})

describe('ST-67/AC-1: edits beside an added exclusion', () => {
  const expectDisallowedAt = async (name, text, changed) => {
    const result = await checkStoryContainment(scenario(name, MAIN(), () => write('stories/OQ-82-foo.md', text)))
    expect(result.ok).toBe(false)
    expect(result.violations).toEqual([expect.objectContaining({
      file: 'stories/OQ-82-foo.md',
      line: text.split('\n').indexOf(changed) + 1,
      message: expect.stringContaining('disallowed change'),
    })])
  }

  it('ST-67/AC-1: a tick and a blocked: edit still pass', async () => {
    const ticked = WITH_OUT_OF_SCOPE(AFTER_REVIEW()).replace('- [ ] **AC-2**', '- [x] **AC-2**').replace('blocked: null', 'blocked: "waiting"')
    const passing = scenario('beside-pass', MAIN(), () => write('stories/OQ-82-foo.md', ticked))
    await expect(checkStoryContainment(passing)).resolves.toEqual({ ok: true })
  }, CONTAINMENT_TEST_TIMEOUT)

  it('ST-67/AC-1: a reworded acceptance criterion still fails, naming its line', async () => {
    const changed = '- [ ] **AC-2** — Second thing, reworded.'
    const text = WITH_OUT_OF_SCOPE(AFTER_REVIEW()).replace('- [ ] **AC-2** — Second thing.', changed)
    await expectDisallowedAt('beside-reworded-ac', text, changed)
  }, CONTAINMENT_TEST_TIMEOUT)

  it('ST-67/AC-1: a changed line in a section after the added line still fails, naming its line in the new file', async () => {
    const changed = '*(changed)*'
    const text = WITH_OUT_OF_SCOPE(AFTER_REVIEW()).replace('## Constraints\n\n*(none)*', `## Constraints\n\n${changed}`)
    await expectDisallowedAt('beside-changed-constraints', text, changed)
  }, CONTAINMENT_TEST_TIMEOUT)
})

// Moved from review.test.mjs with resolveStory (ST-22/AC-1), unchanged.
describe('OQ-69/AC-6: the story comes from the file the diff moves into stories/done/', () => {
  it('OQ-69/AC-6: the move is the source even when the branch name names another story', () => {
    const nameStatus = 'D\tstories/OQ-99-thing.md\nA\tstories/done/OQ-99-thing.md\nA\tsrc/x.mjs\n'
    expect(resolveStory({ nameStatus, branch: 'story/OQ-12-unrelated', prefix: 'OQ' })).toEqual({
      kind: 'moved', file: 'OQ-99-thing.md', id: 'OQ-99',
    })
    expect(resolveStory({ nameStatus, branch: 'whatever/a-pr-someone-else-opened', prefix: 'OQ' }).kind).toBe('moved')
  })

  it('OQ-69/AC-6: an added file under done/ that was never in stories/ is not a move', () => {
    const nameStatus = 'A\tstories/done/OQ-99-thing.md\nM\tstories/OQ-98-other.md\n'
    expect(resolveStory({ nameStatus, branch: 'chore/x', prefix: 'OQ' })).toEqual({ kind: 'none' })
  })

  it('OQ-69/AC-6: two moved stories are reported as ambiguous rather than picked between', async () => {
    const nameStatus = 'D\tstories/OQ-1-a.md\nA\tstories/done/OQ-1-a.md\nD\tstories/OQ-2-b.md\nA\tstories/done/OQ-2-b.md\n'
    expect(resolveStory({ nameStatus, branch: 'story/OQ-1-a', prefix: 'OQ' })).toEqual({ kind: 'ambiguous', files: ['OQ-1-a.md', 'OQ-2-b.md'] })
  })
})

describe('OQ-126/AC-3: resolveStory takes the story-id prefix it is given, not a hardcoded OQ-', () => {
  it('reads ST-3 from a moved stories/done/ST-3-thing.md, and finds no story when the moved file is OQ-3', () => {
    const stNameStatus = 'D\tstories/ST-3-thing.md\nA\tstories/done/ST-3-thing.md\n'
    expect(resolveStory({ nameStatus: stNameStatus, branch: 'chore/x', prefix: 'ST' })).toEqual({
      kind: 'moved', file: 'ST-3-thing.md', id: 'ST-3',
    })

    const oqNameStatus = 'D\tstories/OQ-3-thing.md\nA\tstories/done/OQ-3-thing.md\n'
    expect(resolveStory({ nameStatus: oqNameStatus, branch: 'chore/x', prefix: 'ST' })).toEqual({ kind: 'none' })
  })

  it('reads ST-3 from a branch story/ST-3-thing, and finds no story from a branch story/OQ-3-thing', () => {
    expect(resolveStory({ nameStatus: '', branch: 'story/ST-3-thing', prefix: 'ST' })).toEqual({
      kind: 'branch-only', id: 'ST-3',
    })
    expect(resolveStory({ nameStatus: '', branch: 'story/OQ-3-thing', prefix: 'ST' })).toEqual({ kind: 'none' })
  })
})
