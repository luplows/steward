// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { COMMANDS } from './cli.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const cliScript = path.join(here, 'cli.mjs')

function run(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [cliScript, ...args], { cwd, encoding: 'utf8' })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

describe('OQ-131/AC-1: cli.mjs dispatches to the module each command names', () => {
  it('lists loop, story, coder, review, land, queue, lint and verdicts', () => {
    expect(Object.keys(COMMANDS)).toEqual(['loop', 'story', 'coder', 'review', 'land', 'queue', 'lint', 'verdicts'])
  })

  it('runs lint-stories.mjs for `lint` and review-verdicts.mjs for `verdicts`, the other six by their own module name', () => {
    expect(COMMANDS.lint.endsWith(path.join('scripts', 'lint-stories.mjs'))).toBe(true)
    expect(COMMANDS.verdicts.endsWith(path.join('scripts', 'report', 'review-verdicts.mjs'))).toBe(true)
    for (const name of ['loop', 'story', 'coder', 'review', 'land', 'queue']) {
      expect(COMMANDS[name].endsWith(path.join('scripts', 'dispatch', `${name}.mjs`))).toBe(true)
    }
  })

  it('an unknown command prints the list of commands and exits non-zero', () => {
    const result = run(['bogus'], here)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/usage: node scripts\/dispatch\/cli\.mjs/)
    for (const name of Object.keys(COMMANDS)) {
      expect(result.stderr).toContain(name)
    }
  })

  it('a missing command prints the same list and exits non-zero', () => {
    const result = run([], here)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/usage: node scripts\/dispatch\/cli\.mjs/)
    for (const name of Object.keys(COMMANDS)) {
      expect(result.stderr).toContain(name)
    }
  })
})

describe('OQ-131/AC-2: cli.mjs runs the project in the working directory, not this repository', () => {
  let tmpRoot

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'cli-test-'))
    execFileSync('git', ['init', '--quiet'], { cwd: tmpRoot })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpRoot })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpRoot })
    await writeFile(
      path.join(tmpRoot, 'steward.config.json'),
      JSON.stringify({ repo: 'owner/repo', storyPrefix: 'ST' }),
      'utf8',
    )
    const storiesDir = path.join(tmpRoot, 'stories')
    await mkdir(storiesDir, { recursive: true })
    const story = [
      '---',
      'id: ST-1',
      'title: A thing',
      'tier: normal',
      'kind: workflow',
      'depends_on: []',
      'model: sonnet',
      'blocked: null',
      '---',
      '',
      '## Intent',
      '',
      'As a tester, I want a fixture, so that the CLI can be exercised against another project.',
      '',
      '## Acceptance criteria',
      '',
      '- [ ] **AC-1** — Something observable.',
      '',
      '## Out of scope',
      '',
      '- Nothing in particular.',
      '',
      '## Constraints',
      '',
      '*(none)*',
      '',
      '## Context',
      '',
      '- nowhere in particular',
      '',
      '## Open questions',
      '',
      '*(none)*',
      '',
    ].join('\n')
    await writeFile(path.join(storiesDir, 'ST-1-thing.md'), story, 'utf8')
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('`queue` lists ST-1 from the temporary project and nothing from this repository', () => {
    const result = run(['queue'], tmpRoot)
    expect(result.status).toBe(0)
    const lines = result.stdout.trim().split('\n')
    expect(lines).toEqual(['ST-1  ready     A thing'])
  })

  it('`lint` checks the temporary project\'s stories, not this repository\'s', () => {
    const result = run(['lint'], tmpRoot)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  it('`lint` reports a violation from the temporary project\'s own story, naming its file', () => {
    const storiesDir = path.join(tmpRoot, 'stories')
    const broken = '## Intent\n\nNo frontmatter at all.\n'
    return writeFile(path.join(storiesDir, 'ST-2-broken.md'), broken, 'utf8').then(() => {
      const result = run(['lint'], tmpRoot)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/ST-2-broken\.md/)
    })
  })
})
