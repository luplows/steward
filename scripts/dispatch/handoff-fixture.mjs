/**
 * Handoff records for tests that need `handoffs.json` without reading a source (ST-93): a valid
 * record in each status the coordinator writes, in the form `readHandoffs` accepts. Test support
 * only; nothing in steward itself imports it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { handoffsPath } from './handoff.mjs'

export const COMMIT = 'c'.repeat(40)

/** A `pending` file handoff `H-<order>` of `repo`, approved at version 1, with `extra` over it. */
export function handoffRecord({ order = 1, repo = 'acme/widgets', file = `docs/unit-${order}.md`, ...extra } = {}) {
  return {
    id: `H-${order}`,
    order,
    repo,
    source: { kind: 'file', path: file },
    status: 'pending',
    version: 1,
    approvedAt: '2026-11-10T10:00:00.000Z',
    text: `Do unit ${order}.\n`,
    provenance: { commit: COMMIT },
    history: [],
    ...extra,
  }
}

/** Writes `handoffs` as the records of `homedir`, and returns the path. */
export function writeHandoffs(homedir, handoffs) {
  const file = handoffsPath(homedir)
  mkdirSync(path.dirname(file), { recursive: true })
  const nextOrder = Math.max(0, ...handoffs.map((h) => h.order)) + 1
  writeFileSync(file, `${JSON.stringify({ handoffs, nextOrder }, null, 2)}\n`)
  return file
}

/** The records of `homedir`, as the file has them. */
export const readRaw = (homedir) => JSON.parse(readFileSync(handoffsPath(homedir), 'utf8')).handoffs
