import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyVerdict } from './apply-verdict.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO = 'owner/project'
const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)
const URL = 'https://github.com/owner/project/pull/7#issuecomment-1'

const marker = (verdict, sha = HEAD) => `<!-- agent-review head=${sha} verdict=${verdict} -->`

/** A fake `gh api`: serves the pull request's head and records the status posted. */
function fakeApi(head = HEAD) {
  const posted = []
  const api = (args) => {
    if (args.includes('--jq')) return `${head}\n`
    posted.push(args)
    return ''
  }
  return { api, posted }
}

const apply = (body, assoc = 'OWNER', head = HEAD) => {
  const fake = fakeApi(head)
  return { result: applyVerdict({ repo: REPO, pr: '7', body, assoc, commentUrl: URL }, fake.api), posted: fake.posted }
}

describe('ST-42/AC-1: apply-verdict sets review/agent from a marker', () => {
  it('ST-42/AC-1: pass and pass-with-observations set success on the head, with the comment as target', () => {
    for (const [verdict, description] of [
      ['pass', 'Agent review passed'],
      ['pass-with-observations', 'Agent review passed with observations'],
    ]) {
      const { result, posted } = apply(`findings\n\n${marker(verdict)}`)
      expect(result).toEqual({ outcome: 'posted', state: 'success', head: HEAD, messages: [`review/agent set success on ${HEAD}`] })
      expect(posted).toEqual([
        ['-X', 'POST', `repos/${REPO}/statuses/${HEAD}`, '-f', 'state=success', '-f', 'context=review/agent', '-f', `description=${description}`, '-f', `target_url=${URL}`],
      ])
    }
  })

  it('ST-42/AC-1: block and the deprecated fail set failure and report an error annotation', () => {
    for (const verdict of ['block', 'fail']) {
      const { result, posted } = apply(marker(verdict))
      expect(result.state).toBe('failure')
      expect(result.messages).toEqual([
        `review/agent set failure on ${HEAD}`,
        `::error title=Review blocked::Agent review found blocking items on ${HEAD}. See ${URL}`,
      ])
      expect(posted[0]).toContain('description=Agent review found blocking items')
    }
  })

  it('ST-42/AC-1: the last well-formed marker in a comment wins', () => {
    expect(apply(`${marker('block')}\n${marker('pass')}`).result.state).toBe('success')
    expect(apply(`${marker('pass')}\n${marker('block')}`).result.state).toBe('failure')
  })

  it('ST-42/AC-1: only OWNER, MEMBER and COLLABORATOR comments count; any other association leaves the status untouched', () => {
    for (const assoc of ['OWNER', 'MEMBER', 'COLLABORATOR']) expect(apply(marker('pass'), assoc).result.outcome).toBe('posted')
    for (const assoc of ['CONTRIBUTOR', 'NONE', 'FIRST_TIMER', '']) {
      const { result, posted } = apply(marker('pass'), assoc)
      expect(result.outcome).toBe('ignored-author')
      expect(result.messages).toEqual([`::notice title=Marker ignored::Author association '${assoc}' lacks write access; status untouched.`])
      expect(posted).toEqual([])
    }
  })

  it('ST-42/AC-1: a marker that is not well-formed on one line is ignored', () => {
    const bodies = [
      'no marker at all',
      `<!-- agent-review head=${HEAD.slice(1)} verdict=pass -->`,
      `<!-- agent-review head=${HEAD} verdict=maybe -->`,
      `<!-- agent-review head=${HEAD}\nverdict=pass -->`,
      `<!-- agent-review head=${HEAD.toUpperCase()} verdict=pass -->`,
    ]
    for (const body of bodies) {
      const { result, posted } = apply(body)
      expect(result.outcome).toBe('no-marker')
      expect(result.messages[0]).toMatch(/^::notice title=Marker ignored::No well-formed marker/)
      expect(posted).toEqual([])
    }
  })

  it('ST-42/AC-1: a marker about an older commit is stale and changes nothing', () => {
    const { result, posted } = apply(marker('pass', OLD))
    expect(result.outcome).toBe('stale')
    expect(result.messages).toEqual([`::notice title=Stale marker::Marker targets ${OLD} but head is ${HEAD}; status left as it is.`])
    expect(posted).toEqual([])
  })

  it('ST-42/AC-1: a gh failure is thrown, so the run fails', () => {
    const api = () => {
      throw new Error('HTTP 502')
    }
    expect(() => applyVerdict({ repo: REPO, pr: '7', body: marker('pass'), assoc: 'OWNER', commentUrl: URL }, api)).toThrow('HTTP 502')
  })

  it('ST-42/AC-1: the command prints the notice for an unprivileged marker and exits 0', () => {
    const output = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'land', 'apply-verdict.mjs')], {
      env: { ...process.env, REPO, PR: '7', BODY: marker('pass'), ASSOC: 'NONE', COMMENT_URL: URL },
      encoding: 'utf8',
    })
    expect(output).toContain("Author association 'NONE' lacks write access")
  })
})
