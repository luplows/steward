#!/usr/bin/env node
/**
 * `steward handoff` (ST-89): a crew member's explicit approval of one unit for coding, kept on this
 * machine for the invoking OS user. Neither installing steward, nor activating a project, nor a
 * unit being ready authorizes coding; only an approval here does. The design is
 * `docs/agent-workflow-design.md`, "Approved coding handoffs and sequential execution".
 *
 *   steward handoff add --repo <owner/name> --file <relative-path>
 *   steward handoff add --repo <owner/name> --issue <number>
 *   steward handoff list
 *   steward handoff show <id>
 *   steward handoff reapprove <id>
 *   steward handoff withdraw <id>
 *
 * An approval pins the text it was given, exactly, with where it came from: for a file its path
 * and the full commit of `origin`'s `main` it was read at; for an Issue its number, title, body and
 * a fingerprint of the text. The approvals are kept in `~/.steward/state/handoffs.json`, in the
 * order they were approved, which `reapprove` keeps. None of these commands starts a model or a
 * coder, and none writes to GitHub: an Issue is only read.
 *
 * A handoff's status is one of `pending`, `held`, `admitted`, `completed` and `withdrawn`. This
 * module sets `pending` (by `add` and `reapprove`), `withdrawn`, and `held` (by `selectHandoff`,
 * ST-90, when a unit's content differs from what was approved), and refuses what it must for the
 * other two; the later stories that admit and complete a handoff set `admitted` and `completed`.
 *
 * `selectHandoff` is the operation the coordinator (ST-93) calls to choose the next unit to code:
 * the oldest pending handoff that is eligible now. It admits nothing, claims no branch and starts
 * no model, because selection alone is not a reservation; it reads, and writes only a hold. `list`
 * runs the same checks to report, and writes no record.
 *
 * The threat model is one member of the crew running one command at a time: no other process and
 * no other writer of the file.
 *
 * Exit code: 0 when the command did what it says; 1 when it did not (a refusal, a failed read or
 * write, a malformed records file, an unknown ID); 2 for a command line it does not take.
 */
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { git } from './init.mjs'
import { createContext, getIssue } from './github.mjs'
import { ownedCheckoutPath, readProjects, projectsPath, updateOwnedCheckout } from './project.mjs'
import { readSettings, REPO_RE } from './settings.mjs'
import { readStateFile, writeStateFile } from './state-file.mjs'
import { issueText, readUnit } from './unit.mjs'
import { stateDir } from './user-config.mjs'

export const STATUSES = ['pending', 'held', 'admitted', 'completed', 'withdrawn']
/** The statuses in which a handoff may still be selected: `add` and `reapprove` work on these. */
const OPEN_STATUSES = ['pending', 'held']
/** The statuses whose record may carry a `hold`: why selection held it. `withdraw` keeps it. */
const HOLD_STATUSES = ['held', 'withdrawn']
const HOLD_KEYS = ['reason', 'heldAt']
const RECORD_KEYS = ['id', 'order', 'repo', 'source', 'status', 'version', 'approvedAt', 'text', 'provenance', 'history']
const HISTORY_KEYS = ['version', 'approvedAt', 'text', 'provenance']
const COMMIT_RE = /^[0-9a-f]{40}$/
const ID_RE = /^H-([1-9][0-9]*)$/

const USAGE = [
  'usage: steward handoff add --repo <owner/name> --file <relative-path>',
  '       steward handoff add --repo <owner/name> --issue <number>',
  '       steward handoff list',
  '       steward handoff show <id>',
  '       steward handoff reapprove <id>',
  '       steward handoff withdraw <id>',
  '',
  'add         approves a file on the activated project\'s main, or one of its Issues, for coding',
  'list        the approvals, oldest first, and which are held or not eligible now (it writes no record)',
  'show        one approval: its complete approved text, version and source',
  'reapprove   reads the source again and approves its new text, keeping the ID and the place in order',
  'withdraw    stops a pending or held approval being selected; its history is kept',
].join('\n')

/** Where the records are under `home`. */
export const handoffsPath = (homedir) => path.join(stateDir({ homedir }), 'handoffs.json')

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const sameKeys = (value, keys) => isObject(value) && Object.keys(value).sort().join() === [...keys].sort().join()
const fingerprint = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const isTimestamp = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value))

/**
 * Whether `target` is a repository-relative path in its one written form: not empty, no backslash
 * or control character and not starting with a drive letter, and no empty, `.` or `..` segment, so that two spellings of one file are
 * never two sources.
 */
export function isSafeRelativePath(target) {
  if (typeof target !== 'string' || target === '' || /[\\\p{Cc}]/u.test(target)) return false
  if (/^[A-Za-z]:/.test(target)) return false
  return target.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/** What `version`'s provenance holds for a source of `kind`, checked against `text`; else a reason. */
function provenanceProblem(kind, source, provenance, text) {
  if (kind === 'file') {
    if (!sameKeys(provenance, ['commit']) || typeof provenance.commit !== 'string' || !COMMIT_RE.test(provenance.commit)) {
      return 'its provenance must be {commit}, the full commit SHA'
    }
    return null
  }
  if (!sameKeys(provenance, ['number', 'title', 'body', 'fingerprint']) || provenance.number !== source.number) {
    return 'its provenance must be the Issue\'s number, title, body and fingerprint'
  }
  if (typeof provenance.title !== 'string' || typeof provenance.body !== 'string') return 'its title and body must be text'
  if (text !== issueText(provenance) || provenance.fingerprint !== fingerprint(text)) {
    return 'its text and fingerprint do not match its Issue title and body'
  }
  return null
}

/**
 * The records in `file`: `{ handoffs, nextOrder }`, an empty list and 1 when there is no file.
 * Throws, naming the file and what is wrong, on anything else, so that a file steward cannot
 * trust is never read as an approval. Validated: the exact keys; the ID, which is `H-` and the
 * approval order; that the orders rise strictly through the file and stay below `nextOrder`; the
 * status; the `hold`, which a record has only once selection has held it (ST-90) and only while it
 * is held or withdrawn; the source and each version's provenance; and that the versions run 1 to the current one.
 */
export function readHandoffs(file) {
  const bad = (what) => new Error(`${file} is malformed: ${what}. Fix or remove it; until then no handoff is approved, and no handoff command changes it.`)
  let data
  try {
    data = readStateFile(file)
  } catch (error) {
    throw error instanceof SyntaxError ? bad(`it is not valid JSON (${error.message})`) : error
  }
  if (data === undefined) return { handoffs: [], nextOrder: 1 }
  if (!sameKeys(data, ['handoffs', 'nextOrder']) || !Array.isArray(data.handoffs)) {
    throw bad('it must be an object whose only keys, "handoffs" and "nextOrder", are a list and a number')
  }
  if (!Number.isSafeInteger(data.nextOrder) || data.nextOrder < 1) throw bad('"nextOrder" must be a positive whole number')
  let previous = 0
  const open = new Set()
  data.handoffs.forEach((record, i) => {
    const at = `record ${i + 1}`
    const hasHold = isObject(record) && 'hold' in record
    if (!sameKeys(record, hasHold ? [...RECORD_KEYS, 'hold'] : RECORD_KEYS)) {
      throw bad(`${at} must have exactly ${RECORD_KEYS.join(', ')}, and \`hold\` only once selection has held it`)
    }
    const idMatch = typeof record.id === 'string' ? ID_RE.exec(record.id) : null
    if (!Number.isSafeInteger(record.order) || record.order < 1 || idMatch === null || Number(idMatch[1]) !== record.order) {
      throw bad(`${at}'s id must be H- and its approval order`)
    }
    if (record.order <= previous) throw bad(`${at}'s approval order does not follow the one before it`)
    if (record.order >= data.nextOrder) throw bad(`${at}'s approval order is not below "nextOrder"`)
    previous = record.order
    if (typeof record.repo !== 'string' || !REPO_RE.test(record.repo)) throw bad(`${at}'s repo is not owner/name`)
    if (!STATUSES.includes(record.status)) throw bad(`${at}'s status must be one of ${STATUSES.join(', ')}`)
    if (hasHold) {
      if (!HOLD_STATUSES.includes(record.status)) throw bad(`${at} is ${record.status} and cannot have a hold, which only a held or withdrawn handoff keeps`)
      if (!sameKeys(record.hold, HOLD_KEYS) || typeof record.hold.reason !== 'string' || record.hold.reason === '' || !isTimestamp(record.hold.heldAt)) {
        throw bad(`${at}'s hold must be ${HOLD_KEYS.join(' and ')}: a reason, and the time it was held`)
      }
    }
    const { source } = record
    if (sameKeys(source, ['kind', 'path']) && source.kind === 'file') {
      if (!isSafeRelativePath(source.path)) throw bad(`${at}'s file path is not a safe relative path`)
    } else if (sameKeys(source, ['kind', 'number']) && source.kind === 'issue') {
      if (!Number.isSafeInteger(source.number) || source.number < 1) throw bad(`${at}'s Issue number is not a positive whole number`)
    } else {
      throw bad(`${at}'s source must be {kind: "file", path} or {kind: "issue", number}`)
    }
    if (!Number.isSafeInteger(record.version) || record.version < 1) throw bad(`${at}'s version must be a positive whole number`)
    if (typeof record.text !== 'string' || !isTimestamp(record.approvedAt)) throw bad(`${at} must have its text and the time it was approved`)
    if (!Array.isArray(record.history) || record.history.length !== record.version - 1) {
      throw bad(`${at} has version ${record.version} and so needs ${record.version - 1} earlier versions in its history`)
    }
    const versions = [...record.history, { version: record.version, approvedAt: record.approvedAt, text: record.text, provenance: record.provenance }]
    versions.forEach((entry, j) => {
      const what = j + 1 === versions.length ? `${at}'s current version` : `${at}'s history entry ${j + 1}`
      if (j + 1 < versions.length && !sameKeys(entry, HISTORY_KEYS)) throw bad(`${what} must have exactly ${HISTORY_KEYS.join(', ')}`)
      if (entry.version !== j + 1) throw bad(`${what} must be version ${j + 1}`)
      if (typeof entry.text !== 'string' || !isTimestamp(entry.approvedAt)) throw bad(`${what} must have its text and the time it was approved`)
      const problem = provenanceProblem(source.kind, source, entry.provenance, entry.text)
      if (problem !== null) throw bad(`${what}: ${problem}`)
    })
    if (OPEN_STATUSES.includes(record.status)) {
      const key = sourceKey(record)
      if (open.has(key)) throw bad(`${at}: more than one pending or held approval of ${describeSource(record.source)} in ${record.repo}`)
      open.add(key)
    }
  })
  return { handoffs: data.handoffs, nextOrder: data.nextOrder }
}

const describeSource = (source) => (source.kind === 'file' ? `file ${source.path}` : `Issue #${source.number}`)
const sourceKey = (record) => `${record.repo}\n${record.source.kind}\n${record.source.kind === 'file' ? record.source.path : record.source.number}`

/** Whether `record` and the source `repo`/`source` are one unit. */
const isSource = (record, repo, source) => sourceKey(record) === sourceKey({ repo, source })

/**
 * Reads `source` of `repo` as it stands now, for an approval: the project must be activated, its
 * owned checkout is brought to `origin`'s `main`, and its `unitLinks` there must take the source's
 * kind. Resolves `{ ok: true, text, provenance }`, or `{ ok: false, reason }` with no handoff record written.
 */
async function readSource(repo, source, { homedir, createContext: makeContext }) {
  const projects = await readProjects(projectsPath(homedir))
  if (!projects.some((p) => p.repo === repo)) {
    return { ok: false, reason: `${repo} is not activated: run \`steward project activate <checkout-path>\` for it first.` }
  }
  const owned = ownedCheckoutPath(homedir, repo)
  try {
    await updateOwnedCheckout(owned)
  } catch (error) {
    return { ok: false, reason: `the owned checkout of ${repo} could not be brought to origin's main: ${error.message}` }
  }
  let settings
  try {
    settings = await readSettings(owned)
  } catch (error) {
    return { ok: false, reason: `steward.config.json on ${repo}'s main cannot be read: ${error.message}` }
  }
  if (!settings.unitLinks.includes(source.kind)) {
    return { ok: false, reason: `${repo}'s unitLinks, ${JSON.stringify(settings.unitLinks)}, does not include "${source.kind}", so a ${source.kind} is not a unit there` }
  }
  if (source.kind === 'file') {
    if (!isSafeRelativePath(source.path)) {
      return { ok: false, reason: `${source.path}: give a path relative to the repository, with / between folders and no ".", ".." or empty part` }
    }
    const read = await readUnit({ type: 'file', target: source.path }, { repoDir: owned, base: 'main', ctx: null })
    if (!read.read) return { ok: false, reason: read.reason }
    return { ok: true, text: read.text, provenance: { commit: git(owned, ['rev-parse', 'refs/remotes/origin/main']) } }
  }
  let issue
  try {
    issue = await getIssue(makeContext({ repo }), source.number)
  } catch (error) {
    return { ok: false, reason: `Issue #${source.number} cannot be read: ${error.message}` }
  }
  if (issue.isPullRequest) return { ok: false, reason: `#${source.number} is a pull request, not an Issue` }
  const text = issueText(issue)
  return { ok: true, text, provenance: { number: issue.number, title: issue.title, body: issue.body, fingerprint: fingerprint(text) } }
}

const unknown = (id, handoffs) => {
  const known = handoffs.map((h) => h.id)
  return `${id} is not a handoff. ${known.length === 0 ? 'None is approved yet.' : `The approved ones are ${known.join(', ')}.`} \`steward handoff list\` shows them.`
}

const line = (h) => `${h.id}  ${h.status}  v${h.version}  ${h.repo}  ${describeSource(h.source)}`

function parseAdd(args) {
  const values = {}
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]
    if (!['--repo', '--file', '--issue'].includes(flag) || i + 1 >= args.length || flag in values) return null
    values[flag] = args[i + 1]
  }
  if (!('--repo' in values) || ('--file' in values) === ('--issue' in values)) return null
  return values
}

async function add(args, ctx) {
  const { homedir, out, err } = ctx
  const values = parseAdd(args)
  if (values === null) return null
  const repo = values['--repo']
  if (!REPO_RE.test(repo)) {
    err(`${repo}: give the repository as owner/name, as \`steward project list\` shows it. Nothing was recorded.`)
    return 1
  }
  let source
  if ('--file' in values) {
    source = { kind: 'file', path: values['--file'] }
  } else if (/^[1-9][0-9]*$/.test(values['--issue']) && Number.isSafeInteger(Number(values['--issue']))) {
    source = { kind: 'issue', number: Number(values['--issue']) }
  } else {
    err(`${values['--issue']}: give the Issue as its number. Nothing was recorded.`)
    return 1
  }

  const file = handoffsPath(homedir)
  const { handoffs, nextOrder } = readHandoffs(file)
  const existing = handoffs.find((h) => isSource(h, repo, source) && h.status !== 'withdrawn')
  if (existing !== undefined && !OPEN_STATUSES.includes(existing.status)) {
    err(`${describeSource(source)} of ${repo} is already ${existing.status} as ${existing.id}. A new request after a coder has taken it needs the crew's handling. Nothing was recorded.`)
    return 1
  }
  const read = await readSource(repo, source, ctx)
  if (!read.ok) {
    err(`Not approved: ${read.reason}. Nothing was recorded.`)
    return 1
  }
  if (existing !== undefined) {
    if (sameContent(existing, read)) {
      out(`${existing.id} already approves this ${describeSource(source)} of ${repo} at this text (${existing.status}, version ${existing.version}). Nothing was changed.`)
      return 0
    }
    err(`${describeSource(source)} of ${repo} is already approved as ${existing.id}, at different text. \`steward handoff reapprove ${existing.id}\` approves its new text. Nothing was recorded.`)
    return 1
  }
  const record = {
    id: `H-${nextOrder}`,
    order: nextOrder,
    repo,
    source,
    status: 'pending',
    version: 1,
    approvedAt: ctx.now().toISOString(),
    text: read.text,
    provenance: read.provenance,
    history: [],
  }
  writeStateFile(file, { handoffs: [...handoffs, record], nextOrder: nextOrder + 1 })
  out(`Approved ${record.id}: ${describeSource(source)} of ${repo}, pending (order ${record.order}, version 1).`)
  out(source.kind === 'file' ? `  read at main ${record.provenance.commit}` : `  Issue #${source.number}, fingerprint ${record.provenance.fingerprint}`)
  out(`  record: ${file}`)
  out('Nothing was started: this approval is all that was done.')
  return 0
}

/**
 * Whether what `read` found (from `readSource`) is exactly what `h` approved, with nothing trimmed
 * or normalised on either side: a file's text as Git gives it, and an Issue's title and body as
 * GitHub gives them (its `text` trims trailing whitespace, so a change there alone is not seen in it).
 */
const sameContent = (h, read) => read.text === h.text
  && (h.source.kind === 'file' || (read.provenance.title === h.provenance.title && read.provenance.body === h.provenance.body))

/**
 * Whether the pending handoff `h` could be selected now, by reading its source as it stands:
 * `{ eligible: true }`; `{ eligible: false, changed: true, reason }` when the source was read and
 * its text is not the approved text (selection holds it); or `{ eligible: false, changed: false,
 * reason }` when the source could not be read (the project is not activated, the owned checkout or
 * the source cannot be read, GitHub failed), which changes no handoff record; a later selection that reaches it reads it again.
 * Rejects when the projects file is malformed or cannot be read, so that nothing is selected.
 */
async function assess(h, ctx) {
  const read = await readSource(h.repo, h.source, ctx)
  if (!read.ok) return { eligible: false, changed: false, reason: read.reason }
  if (sameContent(h, read)) return { eligible: true }
  const now = h.source.kind === 'file' ? `read at main ${read.provenance.commit.slice(0, 12)}` : 'its title or body now differs'
  return {
    eligible: false,
    changed: true,
    reason: `${describeSource(h.source)} of ${h.repo} no longer has the text approved as version ${h.version} (${now})`,
  }
}

const reapproveHint = (h) => `Run \`steward handoff reapprove ${h.id}\` to approve its present text, or \`steward handoff withdraw ${h.id}\`.`
const retryHint = 'It stays approved; a later selection that reaches it reads it again.'
const heldReason = (h) => `${h.hold?.reason ?? 'its unit changed after it was approved'}. ${reapproveHint(h)}`

/** A handoff passed over, as `selectHandoff` and `list` report it. */
const passedOver = (h, state, reason) => ({ id: h.id, repo: h.repo, source: h.source, order: h.order, state, reason })

/**
 * Selects the next handoff to code (ST-90): the oldest `pending` one, in the order approved across
 * every project, whose activation, source and exact approved text all hold now. `homedir`, `now`
 * and `createContext` are as for `main`. Resolves
 *
 *   { result: 'selected', handoff, version, skipped }   the first eligible record, and its approved
 *       version `{ version, approvedAt, text, provenance }`
 *   { result: 'no-eligible-handoffs', skipped }         when none qualifies. Each pending handoff
 *       is read at most once and the call returns, so a caller decides when to ask again.
 *
 * `skipped` lists, in order, each handoff passed over before the one selected (all of them when none
 * was): `{ id, repo, source, order, state: 'held' | 'unavailable', reason }`. A withdrawn, admitted
 * or completed handoff is not eligible and not listed. Handoffs after the one selected are not read.
 *
 * A source that was read and differs from the approved text makes its handoff `held`, with the
 * reason, written before the next is considered. A held handoff is skipped without reading its
 * source and stays held, whatever the source says later, until `reapprove`. A source that could not
 * be read leaves its handoff pending and writes no record. Selection reserves nothing: the execution
 * boundary (ST-91) rechecks before its first side effect.
 *
 * Rejects, selecting nothing, when the handoffs file is malformed or cannot be read. The projects
 * file is read when the first pending handoff's source is: if it is malformed or cannot be read
 * then, selection rejects before any hold is written, and with no pending handoff it is not read.
 * It also rejects when a hold cannot be written.
 */
export async function selectHandoff({ homedir = osHomedir(), now = () => new Date(), createContext: makeContext = createContext } = {}) {
  const ctx = { homedir, now, createContext: makeContext }
  const file = handoffsPath(homedir)
  let { handoffs, nextOrder } = readHandoffs(file)
  const skipped = []
  for (const h of [...handoffs]) {
    if (h.status === 'held') {
      skipped.push(passedOver(h, 'held', heldReason(h)))
      continue
    }
    if (h.status !== 'pending') continue
    const verdict = await assess(h, ctx)
    if (verdict.eligible) {
      const { version, approvedAt, text, provenance } = h
      return { result: 'selected', handoff: h, version: { version, approvedAt, text, provenance }, skipped }
    }
    if (!verdict.changed) {
      skipped.push(passedOver(h, 'unavailable', `${verdict.reason}. ${retryHint}`))
      continue
    }
    const held = { ...h, status: 'held', hold: { reason: verdict.reason, heldAt: now().toISOString() } }
    handoffs = handoffs.map((x) => (x === h ? held : x))
    writeStateFile(file, { handoffs, nextOrder })
    skipped.push(passedOver(held, 'held', heldReason(held)))
  }
  return { result: 'no-eligible-handoffs', skipped }
}

async function list(ctx) {
  const { homedir, out } = ctx
  const file = handoffsPath(homedir)
  const { handoffs } = readHandoffs(file)
  if (handoffs.length === 0) {
    out(`No handoff is approved (${file} lists none).`)
    return 0
  }
  out(`Approved handoffs, oldest first (${file}):`)
  for (const h of handoffs) out(line(h))
  // Report only. A pending handoff is read as selection reads it, but no handoff record is written: a changed
  // unit is held by a selection that reaches it, not here, and an unreadable source is never held.
  const attention = []
  for (const h of handoffs) {
    if (h.status === 'held') {
      attention.push(passedOver(h, 'held', heldReason(h)))
    } else if (h.status === 'pending') {
      const verdict = await assess(h, ctx)
      if (verdict.eligible) continue
      attention.push(verdict.changed
        ? passedOver(h, 'changed', `${verdict.reason}; a selection that reaches it holds it if its content still differs. ${reapproveHint(h)}`)
        : passedOver(h, 'unavailable', `${verdict.reason}. ${retryHint}`))
    }
  }
  if (attention.length > 0) {
    out('Not eligible now:')
    const labels = { held: 'held', changed: 'changed', unavailable: 'temporarily ineligible' }
    for (const e of attention) out(`  ${e.id}  ${e.repo}  ${describeSource(e.source)}  position ${e.order}  ${labels[e.state]}: ${e.reason}`)
  }
  return 0
}

async function show(id, { homedir, out, err }) {
  const { handoffs } = readHandoffs(handoffsPath(homedir))
  const h = handoffs.find((x) => x.id === id)
  if (h === undefined) {
    err(unknown(id, handoffs))
    return 1
  }
  out(line(h))
  out(`  order:     ${h.order}`)
  out(`  source:    ${describeSource(h.source)} of ${h.repo}`)
  out(`  version:   ${h.version} (approved ${h.approvedAt})`)
  out(`  read at:   ${h.source.kind === 'file' ? `main ${h.provenance.commit}` : `Issue #${h.provenance.number}, title ${JSON.stringify(h.provenance.title)}, fingerprint ${h.provenance.fingerprint}`}`)
  out(`  earlier versions: ${h.history.length === 0 ? 'none' : h.history.map((e) => `v${e.version} (${e.approvedAt})`).join(', ')}`)
  out('  approved text:')
  out('--- begin approved text ---')
  out(h.text)
  out('--- end approved text ---')
  return 0
}

async function reapprove(id, ctx) {
  const { homedir, out, err } = ctx
  const file = handoffsPath(homedir)
  const { handoffs, nextOrder } = readHandoffs(file)
  const h = handoffs.find((x) => x.id === id)
  if (h === undefined) {
    err(unknown(id, handoffs))
    return 1
  }
  if (!OPEN_STATUSES.includes(h.status)) {
    err(`${id} is ${h.status} and is not reapproved: reapproval changes only a pending or held approval, never what a coder was given. Nothing was changed.`)
    return 1
  }
  const read = await readSource(h.repo, h.source, ctx)
  if (!read.ok) {
    err(`Not reapproved: ${read.reason}. Nothing was changed.`)
    return 1
  }
  if (h.status === 'pending' && sameContent(h, read)) {
    out(`${id}: ${describeSource(h.source)} of ${h.repo} still has the approved text (version ${h.version}). Nothing was changed.`)
    return 0
  }
  const { hold: _released, ...kept } = h
  const next = {
    ...kept,
    status: 'pending',
    version: h.version + 1,
    approvedAt: ctx.now().toISOString(),
    text: read.text,
    provenance: read.provenance,
    history: [...h.history, { version: h.version, approvedAt: h.approvedAt, text: h.text, provenance: h.provenance }],
  }
  writeStateFile(file, { handoffs: handoffs.map((x) => (x === h ? next : x)), nextOrder })
  out(`Reapproved ${id}: ${describeSource(h.source)} of ${h.repo}, pending at version ${next.version}, in its place (order ${h.order}). Version ${h.version} is kept in its history.`)
  return 0
}

async function withdraw(id, { homedir, out, err }) {
  const file = handoffsPath(homedir)
  const { handoffs, nextOrder } = readHandoffs(file)
  const h = handoffs.find((x) => x.id === id)
  if (h === undefined) {
    err(unknown(id, handoffs))
    return 1
  }
  if (h.status === 'withdrawn') {
    out(`${id} is already withdrawn. Nothing was changed.`)
    return 0
  }
  if (!OPEN_STATUSES.includes(h.status)) {
    err(`${id} is ${h.status}: a coder has taken it, and this command cannot cancel or withdraw it. Nothing was changed.`)
    return 1
  }
  writeStateFile(file, { handoffs: handoffs.map((x) => (x === h ? { ...h, status: 'withdrawn' } : x)), nextOrder })
  out(`Withdrew ${id}: it will not be selected for coding, and its text and history are kept in ${file}.`)
  return 0
}

/**
 * Runs `steward handoff <argv>` and returns its exit code. `homedir`, the output, the clock (`now`)
 * and `createContext` (the GitHub context an Issue is read through; only tests pass one, to stand
 * in for GitHub) are injectable.
 */
export async function main(argv, { homedir = osHomedir(), out = console.log, err = console.error, now = () => new Date(), createContext: makeContext = createContext } = {}) {
  const [command, ...rest] = argv
  const ctx = { homedir, out, err, now, createContext: makeContext }
  try {
    let code = null
    if (command === 'add') code = await add(rest, ctx)
    else if (command === 'list' && rest.length === 0) code = await list(ctx)
    else if (command === 'show' && rest.length === 1) code = await show(rest[0], ctx)
    else if (command === 'reapprove' && rest.length === 1) code = await reapprove(rest[0], ctx)
    else if (command === 'withdraw' && rest.length === 1) code = await withdraw(rest[0], ctx)
    if (code !== null) return code
  } catch (error) {
    err(error.message)
    return 1
  }
  err(USAGE)
  return 2
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
