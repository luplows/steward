// @vitest-environment node

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { manualCheckoutPath, resolveCheckout } from './manual-checkout.mjs'
import { CHECKOUT_MAIN, FETCH_MAIN } from './checkout-main.mjs'
import { ownedCheckoutPath } from './project.mjs'

const HOME = path.resolve('/home/crew')
const CWD = path.resolve('/work/invoking')
const REPO = 'luplows/playground'
const MANUAL = path.join(HOME, '.steward', 'state', 'manual-checkouts', 'luplows', 'playground')
const url = (repo) => `https://github.com/${repo}.git`

/**
 * Git, `gh repo clone` and the file system injected: nothing here runs a command or touches a
 * disk. `origins` maps a directory to its `origin` URL; `present` is the directories that are
 * checkouts. `calls` lists, in order, every directory a command was given and what it was.
 */
function world({ origins = {}, present = [], cloneFails, gitFails } = {}) {
  const calls = []
  const have = new Set(present)
  const deps = {
    git: async (cwd, args) => {
      calls.push({ kind: 'git', dir: cwd, args })
      if (args[0] === 'remote') {
        if (origins[cwd] === undefined) throw new Error('error: No such remote \'origin\'')
        return `${origins[cwd]}\n`
      }
      if (gitFails?.(args)) throw new Error('fatal: could not read from remote repository')
      return ''
    },
    cloneRepo: async (repo, dir) => {
      calls.push({ kind: 'clone', dir, repo })
      if (cloneFails) throw new Error(cloneFails)
      have.add(dir)
      origins[dir] ??= url(repo)
    },
    isCheckout: (dir) => have.has(dir),
    makeDirectory: async (dir) => {
      calls.push({ kind: 'mkdir', dir })
    },
  }
  return { deps, calls }
}

const resolve = (w, repo) => resolveCheckout({ repo, cwd: CWD, homedir: HOME, deps: w.deps })

describe('ST-86/AC-1: the invoking checkout is used when --repo is its own repository or absent', () => {
  it('ST-86/AC-1: no --repo resolves the invoking checkout and runs nothing', async () => {
    const w = world()
    expect(await resolve(w, undefined)).toBe(CWD)
    expect(w.calls).toEqual([])
  })

  it("ST-86/AC-1: --repo naming the invoking checkout's origin (in any case) resolves it, and only reads origin", async () => {
    const w = world({ origins: { [CWD]: 'git@github.com:LUPLOWS/Playground.git' } })
    expect(await resolve(w, REPO)).toBe(CWD)
    expect(w.calls).toEqual([{ kind: 'git', dir: CWD, args: ['remote', 'get-url', 'origin'] }])
  })
})

describe('ST-86/AC-2: another repository is worked on in its manual checkout', () => {
  it('ST-86/AC-2: the manual checkout is at ~/.steward/state/manual-checkouts/<owner>/<name>, not the owned checkout', () => {
    expect(manualCheckoutPath(HOME, REPO)).toBe(MANUAL)
    expect(manualCheckoutPath(HOME, REPO)).not.toBe(ownedCheckoutPath(HOME, REPO))
    const stateRoot = path.join(HOME, '.steward', 'state')
    expect(path.relative(stateRoot, MANUAL).split(path.sep)[0]).toBe('manual-checkouts')
    expect(path.relative(stateRoot, ownedCheckoutPath(HOME, REPO)).split(path.sep)[0]).toBe('checkouts')
  })

  it('ST-86/AC-2: when absent it is cloned with gh repo clone, then brought to origin main, detached', async () => {
    const w = world({ origins: { [CWD]: url('luplows/steward') } })
    expect(await resolve(w, REPO)).toBe(MANUAL)
    expect(w.calls).toEqual([
      { kind: 'git', dir: CWD, args: ['remote', 'get-url', 'origin'] },
      { kind: 'mkdir', dir: path.dirname(MANUAL) },
      { kind: 'clone', dir: MANUAL, repo: REPO },
      { kind: 'git', dir: MANUAL, args: ['remote', 'get-url', 'origin'] },
      { kind: 'git', dir: MANUAL, args: FETCH_MAIN },
      { kind: 'git', dir: MANUAL, args: CHECKOUT_MAIN },
    ])
  })

  it('ST-86/AC-2: when present it is reused, not cloned, and brought to origin main again', async () => {
    const w = world({ origins: { [CWD]: url('luplows/steward'), [MANUAL]: url(REPO) }, present: [MANUAL] })
    expect(await resolve(w, REPO)).toBe(MANUAL)
    expect(w.calls.some((c) => c.kind === 'clone' || c.kind === 'mkdir')).toBe(false)
    expect(w.calls.filter((c) => c.dir === MANUAL).map((c) => c.args)).toEqual([['remote', 'get-url', 'origin'], FETCH_MAIN, CHECKOUT_MAIN])
  })

  it('ST-86/AC-2: an invoking checkout with no origin does not stand in for the repository', async () => {
    const w = world()
    expect(await resolve(w, REPO)).toBe(MANUAL)
  })

  it('ST-86/AC-2, AC-5: a manual checkout whose origin is another repository is refused, naming its path, before any fetch', async () => {
    const w = world({ origins: { [MANUAL]: url('someone/else') }, present: [MANUAL] })
    const error = await resolve(w, REPO).catch((e) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain(MANUAL)
    expect(error.message).toContain('someone/else')
    expect(w.calls.filter((c) => c.dir === MANUAL).map((c) => c.args)).toEqual([['remote', 'get-url', 'origin']])
  })

  it('ST-86/AC-2: a manual checkout with no origin is refused, naming its path', async () => {
    const w = world({ present: [MANUAL] })
    const error = await resolve(w, REPO).catch((e) => e)
    expect(error.message).toContain(MANUAL)
    expect(error.message).toMatch(/not a GitHub repository/)
  })

  it('ST-86/AC-2: a manual checkout that cannot be brought to main is refused, naming its path and what Git said', async () => {
    const w = world({ origins: { [MANUAL]: url(REPO) }, present: [MANUAL], gitFails: (args) => args[0] === 'fetch' })
    const error = await resolve(w, REPO).catch((e) => e)
    expect(error.message).toContain(MANUAL)
    expect(error.message).toContain('could not read from remote repository')
    expect(w.calls.some((c) => c.args?.[0] === 'checkout')).toBe(false)
  })

  it('ST-86/AC-2: a clone that fails is refused, naming the path and what gh said', async () => {
    const w = world({ cloneFails: 'GraphQL: Could not resolve to a Repository' })
    const error = await resolve(w, REPO).catch((e) => e)
    expect(error.message).toContain(MANUAL)
    expect(error.message).toContain('Could not resolve to a Repository')
  })

  it("ST-86/AC-5: the coordinator's owned checkout is never touched", async () => {
    const owned = ownedCheckoutPath(HOME, REPO)
    const w = world({ origins: { [CWD]: url('luplows/steward'), [owned]: url(REPO) }, present: [owned] })
    expect(await resolve(w, REPO)).toBe(MANUAL)
    const ownedRoot = path.dirname(path.dirname(owned))
    expect(w.calls.filter((c) => c.dir === ownedRoot || c.dir.startsWith(ownedRoot + path.sep))).toEqual([])
    // The owned checkout being present does not stand in for the manual one: it is cloned.
    expect(w.calls.some((c) => c.kind === 'clone' && c.dir === MANUAL)).toBe(true)
  })
})
