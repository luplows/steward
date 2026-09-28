// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { exit, main, repeat, resolveCommand, sorted, startProcess } from './review-tools.mjs'

const neverStart = () => vi.fn(async () => { throw new Error('a process was started') })

describe('OQ-92/AC-2: only what the reviewer allowlist admits, and no shell', () => {
  it.each([
    ['git push', ['git', 'push', 'origin', 'main']],
    ['gh', ['gh', 'pr', 'list']],
    ['sed -i', ['sed', '-i', 's/a/b/', 'f']],
    ['sort -o', ['sort', '-o', 'out', 'in']],
    ['node -e', ['node', '-e', '1']],
    ['a first word not on the allowlist', ['curl', 'https://example.com']],
  ])('refuses %s without starting a process', async (_name, argv) => {
    const start = neverStart()
    await expect(exit(argv, { start })).rejects.toThrow(/refused/)
    await expect(repeat(2, argv, { start })).rejects.toThrow(/refused/)
    await expect(sorted(argv, { start })).rejects.toThrow(/refused/)
    expect(start).not.toHaveBeenCalled()
    const result = await main(['exit', '--', ...argv], { start })
    expect(result.code).toBe(2)
    expect(start).not.toHaveBeenCalled()
  })

  it('admits allowed commands by name, as git and ls', () => {
    expect(resolveCommand(['git', 'diff', '--stat'], { platform: 'linux' })).toEqual({ file: 'git', args: ['diff', '--stat'] })
    expect(resolveCommand(['ls', '-la'], { platform: 'linux' })).toEqual({ file: 'ls', args: ['-la'] })
  })

  it('passes a `;` argument to the child as a literal argument', async () => {
    const out = await exit(['npm', ';', 'echo', '|', '&&', '>'], {
      platform: 'linux',
      start: async (file, args) => ({ code: 0, output: JSON.stringify([file, args]) }),
    })
    expect(out).toContain(JSON.stringify(['npm', [';', 'echo', '|', '&&', '>']]))
  })

  it('starts a real child without a shell: `;` reaches it as an argument', async () => {
    const { output } = await startProcess(process.execPath, ['-e', 'console.log(process.argv.slice(1).join("|"))', 'a;b', '&&', 'c'])
    expect(output.trim()).toBe('a;b|&&|c')
  })
})

describe('OQ-92/AC-3: npm and npx start on Windows too', () => {
  const win = { platform: 'win32', execPath: 'C:\\node\\node.exe' }

  it('starts npx on win32 as node running npx-cli.js', () => {
    const script = 'C:\\node\\node_modules\\npm\\bin\\npx-cli.js'
    expect(resolveCommand(['npx', 'vitest', 'run', 'x'], { ...win, exists: (p) => p === script })).toEqual({
      file: 'C:\\node\\node.exe',
      args: [script, 'vitest', 'run', 'x'],
    })
  })

  it('starts npm on win32 as node running npm-cli.js', () => {
    const script = 'C:\\node\\node_modules\\npm\\bin\\npm-cli.js'
    expect(resolveCommand(['npm', 'test'], { ...win, exists: () => true })).toEqual({
      file: 'C:\\node\\node.exe',
      args: [script, 'test'],
    })
  })

  it('starts npx on linux by name', () => {
    expect(resolveCommand(['npx', 'vitest', 'run', 'x'], { platform: 'linux', execPath: '/usr/bin/node' })).toEqual({
      file: 'npx',
      args: ['vitest', 'run', 'x'],
    })
  })

  it('refuses on win32, naming the path, when the script is missing', () => {
    expect(() => resolveCommand(['npx', 'vitest'], { ...win, exists: () => false }))
      .toThrow('C:\\node\\node_modules\\npm\\bin\\npx-cli.js')
  })

  it('still refuses node on win32', () => {
    expect(() => resolveCommand(['node', '-v'], { ...win, exists: () => true })).toThrow(/refused/)
  })
})

describe('OQ-92/AC-4: subcommand output', () => {
  const env = { platform: 'linux' }
  const fake = (results) => {
    let i = 0
    return async () => results[i++]
  }

  it('repeat reports each exit code, the count, and the tail of failing runs', async () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    const out = await repeat(3, ['npm', 'test'], {
      ...env,
      start: fake([{ code: 0, output: 'fine\n' }, { code: 1, output: long }, { code: 0, output: '' }]),
    })
    expect(out).toContain('run 1: exit 0')
    expect(out).toContain('run 2: exit 1')
    expect(out).toContain('run 3: exit 0')
    expect(out).toContain('2/3 exited 0')
    expect(out).toContain('line 30')
    expect(out).toContain('line 11')
    expect(out).not.toContain('line 10\n')
    expect(out).not.toContain('fine')
  })

  it.each([0, 11])('repeat refuses %i without starting a process', async (n) => {
    const start = neverStart()
    await expect(repeat(n, ['npm', 'test'], { ...env, start })).rejects.toThrow(/1 to 10/)
    expect(start).not.toHaveBeenCalled()
    const result = await main(['repeat', String(n), '--', 'npm', 'test'], { ...env, start })
    expect(result.code).toBe(2)
    expect(start).not.toHaveBeenCalled()
  })

  it('exit prints the output then a non-zero exit code, and the CLI itself exits 0', async () => {
    const start = async () => ({ code: 3, output: 'boom\n' })
    expect(await exit(['npm', 'test'], { ...env, start })).toBe('boom\nexit code: 3\n')
    expect(await main(['exit', '--', 'npm', 'test'], { ...env, start })).toEqual({
      code: 0,
      stdout: 'boom\nexit code: 3\n',
      stderr: '',
    })
  })

  it('sorted sorts lines, and deduplicates only with --unique', async () => {
    const start = async () => ({ code: 0, output: 'b\na\nb\nc\n' })
    expect(await sorted(['ls'], { ...env, start })).toBe('a\nb\nb\nc\nexit code: 0\n')
    expect(await sorted(['ls'], { ...env, start, unique: true })).toBe('a\nb\nc\nexit code: 0\n')
    expect((await main(['sorted', '--unique', '--', 'ls'], { ...env, start })).stdout).toBe('a\nb\nc\nexit code: 0\n')
  })
})
