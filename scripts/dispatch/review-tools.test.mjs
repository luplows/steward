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
    expect(resolveCommand(['git', 'diff', '--stat'])).toEqual({ file: 'git', args: ['diff', '--stat'] })
    expect(resolveCommand(['ls', '-la'])).toEqual({ file: 'ls', args: ['-la'] })
  })

  it('passes a `;` argument to the child as a literal argument', async () => {
    const out = await exit(['ls', ';', 'echo', '|', '&&', '>'], {
      start: async (file, args) => ({ code: 0, output: JSON.stringify([file, args]) }),
    })
    expect(out).toContain(JSON.stringify(['ls', [';', 'echo', '|', '&&', '>']]))
  })

  it('starts a real child without a shell: `;` reaches it as an argument', async () => {
    const { output } = await startProcess(process.execPath, ['-e', 'console.log(process.argv.slice(1).join("|"))', 'a;b', '&&', 'c'])
    expect(output.trim()).toBe('a;b|&&|c')
  })
})

describe('ST-33/AC-3: no npm or npx', () => {
  it.each([
    ['npm test', ['npm', 'test']],
    ['npx vitest run', ['npx', 'vitest', 'run']],
  ])('ST-33/AC-4: refuses %s, starting nothing', async (_name, argv) => {
    const start = neverStart()
    expect(() => resolveCommand(argv)).toThrow(/refused/)
    await expect(exit(argv, { start })).rejects.toThrow(/refused/)
    await expect(repeat(2, argv, { start })).rejects.toThrow(/refused/)
    await expect(sorted(argv, { start })).rejects.toThrow(/refused/)
    expect((await main(['exit', '--', ...argv], { start })).code).toBe(2)
    expect(start).not.toHaveBeenCalled()
  })
})

describe('OQ-92/AC-4: subcommand output', () => {
  const fake = (results) => {
    let i = 0
    return async () => results[i++]
  }

  it('repeat reports each exit code, the count, and the tail of failing runs', async () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    const out = await repeat(3, ['git', 'status'], {
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
    await expect(repeat(n, ['git', 'status'], { start })).rejects.toThrow(/1 to 10/)
    expect(start).not.toHaveBeenCalled()
    const result = await main(['repeat', String(n), '--', 'git', 'status'], { start })
    expect(result.code).toBe(2)
    expect(start).not.toHaveBeenCalled()
  })

  it('exit prints the output then a non-zero exit code, and the CLI itself exits 0', async () => {
    const start = async () => ({ code: 3, output: 'boom\n' })
    expect(await exit(['git', 'status'], { start })).toBe('boom\nexit code: 3\n')
    expect(await main(['exit', '--', 'git', 'status'], { start })).toEqual({
      code: 0,
      stdout: 'boom\nexit code: 3\n',
      stderr: '',
    })
  })

  it('sorted sorts lines, and deduplicates only with --unique', async () => {
    const start = async () => ({ code: 0, output: 'b\na\nb\nc\n' })
    expect(await sorted(['ls'], { start })).toBe('a\nb\nb\nc\nexit code: 0\n')
    expect(await sorted(['ls'], { start, unique: true })).toBe('a\nb\nc\nexit code: 0\n')
    expect((await main(['sorted', '--unique', '--', 'ls'], { start })).stdout).toBe('a\nb\nc\nexit code: 0\n')
  })
})
