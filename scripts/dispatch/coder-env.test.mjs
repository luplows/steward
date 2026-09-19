import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { coderAllowedTools, CODER_DISALLOWED_TOOLS, coderEnv } from './coder-env.mjs'

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
