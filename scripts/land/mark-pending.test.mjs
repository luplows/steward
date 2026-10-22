import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { markPending } from './mark-pending.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SHA = 'd'.repeat(40)

describe('ST-42/AC-1: mark-pending sets review/agent pending on the head commit', () => {
  it('ST-42/AC-1: posts a pending status with the gate\'s context and description', () => {
    const calls = []
    const message = markPending('owner/project', SHA, (args) => calls.push(args))
    expect(calls).toEqual([
      ['-X', 'POST', `repos/owner/project/statuses/${SHA}`, '-f', 'state=pending', '-f', 'context=review/agent', '-f', 'description=Awaiting agent review'],
    ])
    expect(message).toBe(`review/agent set pending on ${SHA}`)
  })

  it('ST-42/AC-1: a gh failure is thrown, so the run fails', () => {
    expect(() =>
      markPending('owner/project', SHA, () => {
        throw new Error('HTTP 502')
      }),
    ).toThrow('HTTP 502')
  })

  it('ST-42/AC-1: the command without REPO and SHA exits non-zero and says so', () => {
    const env = { ...process.env }
    delete env.REPO
    delete env.SHA
    let failure
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'land', 'mark-pending.mjs')], { env, encoding: 'utf8', stdio: 'pipe' })
    } catch (error) {
      failure = error
    }
    expect(failure.status).toBe(1)
    expect(failure.stderr).toContain('mark-pending needs REPO and SHA')
  })
})
