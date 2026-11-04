// @vitest-environment node

// The options automatic review's direct child processes are started with (ST-70). `execFile` is
// replaced, so these start no process and need no repository, GitHub or model session. They show
// the options passed, not what appears on a Windows desktop.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { ghAuthToken } from './github.mjs'
import { assertReviewableCheckout } from './review.mjs'
import { readRules } from './rules.mjs'
import { readUnit } from './unit.mjs'

const fake = vi.hoisted(() => ({ calls: [], stdout: () => '' }))

vi.mock('node:child_process', async (original) => ({
  ...await original(),
  // Takes the options as optional, as `execFile` does, so that a call without them reaches the
  // assertion instead of failing here.
  execFile: (file, args, ...rest) => {
    const callback = rest.at(-1)
    fake.calls.push({ file, args, options: rest.length > 1 ? rest[0] : undefined })
    callback(null, { stdout: fake.stdout(args), stderr: '' })
  },
}))

const MAX_BUFFER = 64 * 1024 * 1024
// Two different directories that exist: `assertReviewableCheckout` resolves both on disk.
const dir = path.dirname(fileURLToPath(import.meta.url))
const repoDir = path.dirname(dir)

beforeEach(() => {
  fake.calls.length = 0
  fake.stdout = () => ''
})

describe('ST-70: windowsHide at the direct child processes of automatic review', () => {
  it('ST-70/AC-2, AC-3: gh auth token is hidden, with the same command and the token trimmed', async () => {
    fake.stdout = () => 'the-token\n'

    expect(await ghAuthToken()).toBe('the-token')

    expect(fake.calls).toEqual([
      { file: 'gh', args: ['auth', 'token'], options: { windowsHide: true } },
    ])
  })

  it('ST-70/AC-2, AC-3: the Git helper in review.mjs is hidden, with the same arguments and directory', async () => {
    fake.stdout = (args) => (args.includes('rev-parse') ? 'abc123\n' : '')

    await assertReviewableCheckout(dir, 'abc123', repoDir)

    const options = { cwd: dir, maxBuffer: MAX_BUFFER, windowsHide: true }
    expect(fake.calls).toEqual([
      { file: 'git', args: ['-c', 'core.quotepath=off', 'rev-parse', 'HEAD'], options },
      { file: 'git', args: ['-c', 'core.quotepath=off', 'status', '--porcelain'], options },
    ])
  })

  it('ST-70/AC-2, AC-3: the git show in rules.mjs is hidden, with the same arguments and directory', async () => {
    await readRules({ repoDir, base: 'main', rulesFile: 'REVIEW.md' })

    expect(fake.calls).toEqual([
      {
        file: 'git',
        args: ['show', 'origin/main:REVIEW.md'],
        options: { cwd: repoDir, maxBuffer: MAX_BUFFER, windowsHide: true },
      },
    ])
  })

  it('ST-70/AC-2, AC-3: a file-unit read in unit.mjs is hidden, with the same arguments and directory', async () => {
    fake.stdout = (args) => (args.includes('cat-file') ? 'blob\n' : 'The unit.\n')

    const read = await readUnit({ type: 'file', target: 'stories/ST-1.md' }, { repoDir, base: 'main' })

    expect(read).toEqual({ read: true, text: 'The unit.\n' })
    const spec = 'origin/main:stories/ST-1.md'
    const options = { cwd: repoDir, maxBuffer: MAX_BUFFER, windowsHide: true }
    expect(fake.calls).toEqual([
      { file: 'git', args: ['-c', 'core.quotepath=off', 'cat-file', '-t', spec], options },
      { file: 'git', args: ['-c', 'core.quotepath=off', 'show', spec], options },
    ])
  })
})
