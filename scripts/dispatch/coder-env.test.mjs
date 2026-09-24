import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  coderAllowedTools,
  CODER_DISALLOWED_TOOLS,
  coderEnv,
  READ_ONLY_SHELL_UTILS,
} from './coder-env.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function hasGh() {
  try {
    execFileSync('gh', ['--version'])
    return true
  } catch {
    return false
  }
}

describe('coderEnv', () => {
  it('OQ-63/AC-1 - strips GH_TOKEN, so a status-setting call has no credential to use', () => {
    const env = coderEnv({ GH_TOKEN: 'a-real-looking-token', PATH: '/usr/bin' }, '/tmp/empty-gh-config')
    expect(env.GH_TOKEN).toBeUndefined()
  })

  it('OQ-63/AC-2 - strips GITHUB_TOKEN too, which gh and most GitHub clients also read', () => {
    const env = coderEnv({ GITHUB_TOKEN: 'a-real-looking-token' }, '/tmp/empty-gh-config')
    expect(env.GITHUB_TOKEN).toBeUndefined()
  })

  it('OQ-63/AC-3 - redirects GH_CONFIG_DIR away from any ambient gh login', () => {
    const env = coderEnv({ GH_CONFIG_DIR: '/home/owner/.config/gh' }, '/tmp/empty-gh-config')
    expect(env.GH_CONFIG_DIR).toBe('/tmp/empty-gh-config')
  })

  it('OQ-63/AC-4 - scrubs credentials regardless of what the ambient environment already carries', () => {
    // This is what node -e, npm run and npx inherit -- the *process*
    // environment, not the Bash tool's allowlist. If a credential survived
    // being copied from baseEnv here, it would survive being reached that
    // way too.
    const inheritedShell = { ...process.env, GH_TOKEN: 'inherited-from-a-logged-in-shell' }
    const env = coderEnv(inheritedShell, '/tmp/empty-gh-config')
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
  })

  it('requires an empty gh config directory, since gh would otherwise fall back to its default', () => {
    expect(() => coderEnv({}, undefined)).toThrow()
  })

  // Runs `gh` (or a child_process invocation of it) and asserts it failed
  // *for want of authorisation* rather than for some other reason -- a
  // 404/`Could not resolve` on a nonexistent PR number, for instance, would
  // mean the test isn't exercising what it claims to (see the AC-1 comment
  // below, which this generalises). `gh` reports an auth failure either
  // client-side, before any request goes out ("gh: To use GitHub CLI...",
  // "no authentication token"), or via the API's own 401/403, so the check
  // is a broad match against that vocabulary rather than one exact string.
  function expectDeniedForWantOfAuthorisation(runFn) {
    let threw = false
    let output = ''
    try {
      runFn()
    } catch (error) {
      threw = true
      output = `${error.stdout ?? ''}${error.stderr ?? ''}${error.message ?? ''}`
    }
    expect(threw).toBe(true)
    expect(output).toMatch(/auth|credential|401|403|token/i)
  }

  it.skipIf(!hasGh())(
    'OQ-63/AC-1, AC-2, AC-4 - gh fails for want of authorisation once scrubbed, including via child_process',
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'oq63-gh-config-'))
      try {
        const env = coderEnv(process.env, dir)

        // AC-1: setting a commit status. The SHA is invalid on purpose --
        // authorisation is checked before the payload is, so a 404/422 here
        // would mean this test is not exercising what it claims to.
        expectDeniedForWantOfAuthorisation(() =>
          execFileSync(
            'gh',
            [
              'api', '-X', 'POST',
              'repos/luplows/tower-workshop-paths/statuses/0000000000000000000000000000000000000000',
              '-f', 'state=success',
            ],
            { env, stdio: 'pipe' },
          ),
        )

        // AC-2: dispatching a workflow.
        expectDeniedForWantOfAuthorisation(() =>
          execFileSync(
            'gh',
            ['api', '-X', 'POST', 'repos/luplows/tower-workshop-paths/actions/workflows/land-approved.yml/dispatches', '-f', 'ref=main'],
            { env, stdio: 'pipe' },
          ),
        )

        // AC-4: the same call, made the way node -e would make it --
        // through child_process, never touching the Bash tool at all.
        expectDeniedForWantOfAuthorisation(() =>
          execFileSync(
            process.execPath,
            [
              '-e',
              "require('child_process').execFileSync('gh', ['api','-X','POST','repos/luplows/tower-workshop-paths/statuses/0000000000000000000000000000000000000000','-f','state=success'], {stdio:'pipe'})",
            ],
            { env, stdio: 'pipe' },
          ),
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(!hasGh())(
    'OQ-63/AC-3 - gh cannot merge, comment on, or review a pull request once scrubbed',
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'oq63-gh-config-pr-'))
      try {
        const env = coderEnv(process.env, dir)
        // The PR number doesn't need to exist -- as with the SHA above,
        // authorisation for a write is checked before the resource is
        // looked up, so failing here for authorisation rather than a
        // not-found is exactly what these assert.
        const fakePr = '999999999'

        // Merging a pull request.
        expectDeniedForWantOfAuthorisation(() =>
          execFileSync(
            'gh',
            ['api', '-X', 'PUT', `repos/luplows/tower-workshop-paths/pulls/${fakePr}/merge`],
            { env, stdio: 'pipe' },
          ),
        )

        // Commenting on a pull request (the issue-comments endpoint PRs share
        // with issues -- this is what a `<!-- agent-review -->` marker uses).
        expectDeniedForWantOfAuthorisation(() =>
          execFileSync(
            'gh',
            ['api', '-X', 'POST', `repos/luplows/tower-workshop-paths/issues/${fakePr}/comments`, '-f', 'body=test'],
            { env, stdio: 'pipe' },
          ),
        )

        // Reviewing a pull request.
        expectDeniedForWantOfAuthorisation(() =>
          execFileSync(
            'gh',
            ['api', '-X', 'POST', `repos/luplows/tower-workshop-paths/pulls/${fakePr}/reviews`, '-f', 'body=test', '-f', 'event=COMMENT'],
            { env, stdio: 'pipe' },
          ),
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})

describe('coderAllowedTools', () => {
  it('OQ-63/AC-5 - scopes push to the exact assigned branch, not a wildcard', () => {
    const tools = coderAllowedTools('story/OQ-63-coder-write-capability')
    expect(tools).toContain('Bash(git push origin HEAD:story/OQ-63-coder-write-capability)')
    expect(tools).toContain('Bash(git push origin story/OQ-63-coder-write-capability:story/OQ-63-coder-write-capability)')
    expect(tools).not.toContain('Bash(git push:*)')
  })

  it('OQ-63/AC-5 - a different branch gets a different scoped pattern, never a shared one', () => {
    const a = coderAllowedTools('story/OQ-63-a')
    const b = coderAllowedTools('story/OQ-63-b')
    expect(a).not.toContain('Bash(git push origin HEAD:story/OQ-63-b)')
    expect(b).not.toContain('Bash(git push origin HEAD:story/OQ-63-a)')
  })

  it('requires the branch, since an unscoped push pattern would defeat AC-5', () => {
    expect(() => coderAllowedTools()).toThrow()
  })

  it('OQ-63/AC-1, AC-2, AC-3 - gh is not on the allowlist at all, having no legitimate use left', () => {
    const tools = coderAllowedTools('story/OQ-63-coder-write-capability')
    expect(tools.some((tool) => tool.startsWith('Bash(gh'))).toBe(false)
  })

  it('still grants the toolchain the coder needs to do its job (AC-5 "can still do its job")', () => {
    const tools = coderAllowedTools('story/OQ-63-coder-write-capability')
    for (const needed of ['Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Read', 'Write', 'Edit']) {
      expect(tools).toContain(needed)
    }
  })
})

describe('CODER_DISALLOWED_TOOLS', () => {
  it('OQ-63/AC-1, AC-2, AC-3 - denies gh outright as defence in depth on top of coderEnv', () => {
    expect(CODER_DISALLOWED_TOOLS).toContain('Bash(gh:*)')
  })

  it('OQ-63/AC-5 - never denies git push outright, since that would shadow the allowlist\'s scoped push patterns and block the coder\'s own branch', () => {
    // Deny rules take precedence over allow rules. `Bash(git push:*)` is a
    // prefix match against `Bash(git push origin HEAD:<branch>)`, so if it
    // were in this list, coderAllowedTools's scoped grant would be
    // unreachable and AC-5 (the coder can push its own branch) would fail --
    // regardless of what coderAllowedTools itself contains.
    expect(CODER_DISALLOWED_TOOLS).not.toContain('Bash(git push:*)')
    for (const denied of CODER_DISALLOWED_TOOLS) {
      expect('Bash(git push origin HEAD:story/OQ-63-x)'.startsWith(denied.replace(/:\*$/, ':'))).toBe(false)
    }
  })
})

// A model of how Claude Code matches a Bash permission rule against a
// command: `Bash(prefix:*)` permits any command beginning with `prefix`, and
// `Bash(cmd)` permits exactly `cmd`. This is the loosest reading of the prefix
// form (no word boundary), so a "does not permit" assertion made with it
// holds under any stricter reading too.
function permits(tools, command) {
  return tools.some((tool) => {
    const match = tool.match(/^Bash\((.*)\)$/)
    if (!match) return false
    const rule = match[1]
    return rule.endsWith(':*') ? command.startsWith(rule.slice(0, -2)) : command === rule
  })
}

// The fenced allowlist block in coder.md, split into its entries with
// {{BRANCH}} substituted. `Bash(...)` entries can contain spaces, so they are
// matched whole before the plain tool names are split on whitespace.
function coderMdAllowlist(branch) {
  const text = readFileSync(path.join(REPO_ROOT, '.claude/prompts/coder.md'), 'utf8')
  const match = text.match(/The coder needs at least:\r?\n\r?\n```\r?\n([\s\S]*?)```/)
  if (!match) throw new Error("coder.md's allowlist block was not found where this test expects it")
  const block = match[1].replaceAll('{{BRANCH}}', branch)
  const bashEntries = [...block.matchAll(/Bash\([^)]*\)/g)].map((m) => m[0])
  const plainEntries = block.replace(/Bash\([^)]*\)/g, ' ').split(/\s+/).filter(Boolean)
  return [...plainEntries, ...bashEntries]
}

describe('coderAllowedTools (OQ-67)', () => {
  const branch = 'story/OQ-67-coder-capability-gaps'

  it('OQ-67/AC-1 - permits git mv, which coder.md requires for the story-file move', () => {
    const tools = coderAllowedTools(branch)
    expect(permits(tools, `git mv stories/OQ-67-coder-capability-gaps.md stories/done/OQ-67-coder-capability-gaps.md`)).toBe(true)
  })

  it('OQ-67/AC-2 - permits pushing the assigned branch by its plain name, alongside both refspec forms', () => {
    const tools = coderAllowedTools(branch)
    expect(permits(tools, `git push origin ${branch}`)).toBe(true)
    expect(permits(tools, `git push origin HEAD:${branch}`)).toBe(true)
    expect(permits(tools, `git push origin ${branch}:${branch}`)).toBe(true)
  })

  it('OQ-67/AC-2 - no returned pattern permits a push to main, or to any other ref', () => {
    const tools = coderAllowedTools(branch)
    const forbidden = [
      'git push origin main',
      'git push origin main:main',
      'git push origin HEAD:main',
      'git push origin HEAD:refs/heads/main',
      `git push origin ${branch}:main`,
      'git push origin :main',
      'git push -f origin HEAD:main',
      'git push origin HEAD',
      'git push origin',
      'git push',
      'git push --all origin',
      'git push --mirror origin',
      `git push origin ${branch} main`,
      `git push origin ${branch}-other`,
      'git push origin HEAD:story/OQ-99-another-story',
    ]
    for (const command of forbidden) {
      expect(permits(tools, command), command).toBe(false)
    }
  })

  it('OQ-67/AC-2 - every push-granting pattern is exact, never a prefix wildcard', () => {
    // The structural reason the list above holds for commands nobody thought
    // to enumerate: an exact rule permits one command and nothing else.
    const pushRules = coderAllowedTools(branch).filter((tool) => tool.startsWith('Bash(git push'))
    expect(pushRules).toHaveLength(3)
    for (const rule of pushRules) expect(rule.endsWith(':*)'), rule).toBe(false)
  })

  it('OQ-67/AC-2 - refuses main as the assigned branch, since every push pattern would then name it', () => {
    expect(() => coderAllowedTools('main')).toThrow()
    expect(() => coderAllowedTools('refs/heads/main')).toThrow()
  })

  it("OQ-67/AC-3 - every git verb in coder.md's allowlist block is permitted by coderAllowedTools", () => {
    const tools = coderAllowedTools(branch)
    const gitEntries = coderMdAllowlist(branch).filter((entry) => entry.startsWith('Bash(git '))
    // A representative command per entry: the prefix itself for `:*` rules,
    // the exact command otherwise.
    const commands = gitEntries.map((entry) => entry.slice('Bash('.length, -1).replace(/:\*$/, ''))
    const verbs = new Set(commands.map((command) => command.split(' ')[1]))
    // Not vacuous: the block names the verbs whose absence caused OQ-67.
    for (const verb of ['mv', 'push', 'commit', 'add']) expect(verbs).toContain(verb)
    for (const command of commands) expect(permits(tools, command), command).toBe(true)
  })
})

describe('READ_ONLY_SHELL_UTILS (OQ-67)', () => {
  const utilityOf = (entry) => entry.match(/^Bash\(([a-z]+):\*\)$/)?.[1]

  it('OQ-67/AC-4 - is an exported value that coderAllowedTools includes, so no caller supplies its own', () => {
    expect(READ_ONLY_SHELL_UTILS.length).toBeGreaterThan(0)
    const tools = coderAllowedTools('story/OQ-67-x')
    for (const entry of READ_ONLY_SHELL_UTILS) expect(tools).toContain(entry)
  })

  it('OQ-67/AC-4 - every entry names one utility, with no arguments baked in', () => {
    for (const entry of READ_ONLY_SHELL_UTILS) expect(utilityOf(entry), entry).toBeTruthy()
  })

  // Arguments that make some common utility write, each tried in a scratch
  // directory holding one file. A utility that can write in any mode is
  // expected to trip at least one of these; the control test below shows
  // that the ones this list must exclude do. The probes are a fixed set, so
  // the property is only as strong as they are: a writer added to the list
  // needs a probe here before its absence proves anything. #122's review
  // found xargs, dd and perl passing clean before their probes were added.
  const WRITE_PROBES = [
    ['-i', 's/a/b/', 'f'], // sed -i
    ['--in-place', 's/a/b/', 'f'],
    ['-n', 'w out', 'f'], // sed's w command writes without -i
    ['-o', 'out', 'f'], // sort -o
    ['--output=out', 'f'],
    ['f', 'out'], // uniq: a second operand is an output file
    ['out'], // tee
    ['.', '-delete'], // find
    ['.', '-exec', 'touch', 'made', ';'],
    ['.', '-fprint', 'out'],
    ['BEGIN { print 1 > "out" }'], // awk
    ['touch', 'made'], // xargs: its operands are a command to run
    ['of=out'], // dd
    ['-i', '-pe', 's/a/b/', 'f'], // perl -i
    ['-e', 'open(F, ">out")'], // perl -e, and any other interpreter
  ]

  function snapshot(dir) {
    return JSON.stringify(
      readdirSync(dir, { withFileTypes: true })
        .map((e) => [e.name, e.isFile() ? readFileSync(path.join(dir, e.name), 'utf8') : '<dir>'])
        .sort(),
    )
  }

  // The probe arguments that made `utility` change its directory, or [].
  function writingProbes(utility) {
    const tripped = []
    for (const args of WRITE_PROBES) {
      const dir = mkdtempSync(path.join(tmpdir(), 'oq67-probe-'))
      try {
        writeFileSync(path.join(dir, 'f'), 'a\nb\n')
        const before = snapshot(dir)
        spawnSync(utility, args, { cwd: dir, input: 'a\n', timeout: 5000, stdio: 'pipe' })
        if (snapshot(dir) !== before) tripped.push(args.join(' '))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
    return tripped
  }

  // GNU-style `--version` distinguishes the POSIX utilities these probes are
  // written for from same-named Windows ones (`sort.exe`, `find.exe`), which
  // take different arguments and would make the probes meaningless.
  const hasGnuUtility = (utility) => spawnSync(utility, ['--version'], { stdio: 'pipe' }).status === 0
  const listed = READ_ONLY_SHELL_UTILS.map(utilityOf)

  const KNOWN_WRITERS = ['sed', 'sort', 'tee', 'find', 'xargs', 'dd', 'perl']

  it.skipIf(!KNOWN_WRITERS.every(hasGnuUtility))(
    'OQ-67/AC-5 - control: the probes do catch sed, sort, tee, find, xargs, dd and perl, so a clean result below is not vacuous',
    () => {
      for (const utility of KNOWN_WRITERS) {
        expect(writingProbes(utility), utility).not.toEqual([])
      }
    },
  )

  it.skipIf(!listed.every(hasGnuUtility))(
    'OQ-67/AC-5 - no entry can write: each is probed with write-shaped arguments and changes nothing',
    () => {
      for (const utility of listed) {
        expect(writingProbes(utility), utility).toEqual([])
      }
    },
  )
})

describe("coder.md's allowlist block (OQ-67)", () => {
  it('OQ-67/AC-6 - lists exactly what coderAllowedTools returns, no more and no fewer', () => {
    const branch = 'story/OQ-67-coder-capability-gaps'
    const documented = coderMdAllowlist(branch)
    const returned = coderAllowedTools(branch)
    expect([...documented].sort()).toEqual([...returned].sort())
  })

  it("OQ-67/AC-6 - the design doc's invocation sketch no longer references an undefined $READ_ONLY_SHELL_UTILS", () => {
    const design = readFileSync(path.join(REPO_ROOT, 'docs/agent-workflow-design.md'), 'utf8')
    expect(design).not.toContain('$READ_ONLY_SHELL_UTILS')
  })
})
