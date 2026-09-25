// Deletes the head branch of every merged PR whose branch is still on origin.
//
// `land-approved.yml` used to rely on the repository's `delete_branch_on_merge`
// setting, which is enabled and observably does not fire (OQ-52). This makes the
// deletion an explicit act of the sweep. It is cleanup, not a gate: nothing here
// throws, so a branch that is already gone or cannot be deleted never fails the
// landing run (AC-2).
//
// A branch is deleted only if it is a same-repository head, is not the base
// branch, and still points at the exact commit the merged PR had as its head.
// A branch that has moved since -- for instance a spawn reusing the name of a
// merged story branch -- is someone's live work and is left alone.

import { execFileSync } from 'node:child_process'

// Node's default maxBuffer is 1 MiB; an unprojected listing of 100 PRs is about 2 MB and
// made every call fail with ENOBUFS. The listing is projected (see LIST_PROJECTION) and the
// buffer is also raised, so neither alone is relied on. `run` is injectable for tests.
export const MAX_BUFFER = 64 * 1024 * 1024

export function ghApi(args, run = execFileSync) {
  return run('gh', ['api', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_BUFFER,
  })
}

// Only the fields deleteMergedHeads reads.
export const LIST_PROJECTION =
  '[.[] | {number, merged_at, base: {ref: .base.ref}, head: {ref: .head.ref, sha: .head.sha, repo: (if .head.repo then {full_name: .head.repo.full_name} else null end)}}]'

// `api` takes the argument list after `gh api` and returns stdout, or throws.
// Returns one { pr, ref, outcome } per merged PR considered.
export function deleteMergedHeads(repo, api = ghApi) {
  const results = []
  let closed
  try {
    closed = JSON.parse(
      api([`repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`, '--jq', LIST_PROJECTION]),
    )
  } catch (error) {
    return [{ pr: null, ref: null, outcome: `could not list closed PRs: ${error.message}` }]
  }

  const seen = new Set()
  for (const pr of closed) {
    if (!pr.merged_at) continue
    if (!pr.head?.repo || pr.head.repo.full_name !== repo) continue
    const ref = pr.head.ref
    if (ref === pr.base.ref || seen.has(ref)) continue

    let tip
    try {
      tip = api([`repos/${repo}/git/ref/heads/${ref}`, '--jq', '.object.sha']).trim()
    } catch {
      continue // already gone
    }
    // Only a PR whose head matched the tip claims the ref: another merged PR with the
    // same ref name (a reused branch) must still be considered if this one did not.
    if (tip !== pr.head.sha) {
      results.push({ pr: pr.number, ref, outcome: 'kept: branch has moved since the merge' })
      continue
    }
    seen.add(ref)
    try {
      api(['-X', 'DELETE', `repos/${repo}/git/refs/heads/${ref}`])
      results.push({ pr: pr.number, ref, outcome: 'deleted' })
    } catch (error) {
      results.push({ pr: pr.number, ref, outcome: `not deleted: ${error.message}` })
    }
  }
  return results
}

if (process.argv[1]?.endsWith('delete-merged-heads.mjs')) {
  const repo = process.env.REPO
  if (!repo) {
    console.log('::warning title=Branch cleanup skipped::REPO is not set')
  } else {
    for (const { pr, ref, outcome } of deleteMergedHeads(repo)) {
      const line = `PR #${pr ?? '?'} ${ref ?? ''}: ${outcome}`
      console.log(outcome === 'deleted' ? line : `::warning title=Branch cleanup::${line}`)
    }
  }
}
