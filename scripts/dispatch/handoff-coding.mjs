/**
 * The coordinator's coding turn (ST-93): it admits the oldest eligible approved handoff, has it
 * coded to a pushed branch (`executeHandoff`, ST-91) and its pull request opened (`publishHandoff`,
 * ST-92), and records how that ended in the handoff's record, `~/.steward/state/handoffs.json`
 * (`handoff.mjs`, which validates what is written here). The design is
 * `docs/agent-workflow-design.md`, "Approved coding handoffs and sequential execution".
 * `coordinator-scheduler.mjs` decides when a turn runs, after the due reviews and landing attempts;
 * this module decides nothing about time, and one call is one bounded turn for one handoff.
 *
 * The admission is the handoff's own record. In one write, before any branch is claimed, setup run
 * or model started, a `pending` handoff becomes `admitted` and gains an `admission`, `{ id,
 * handoffId, version, repo, branch, admittedAt }`: a unique ID, the handoff and approved version,
 * and the branch it will be coded on. That `id` and the handoff and version are what
 * `executeHandoff` is given, and `admissionIsActive` reads the record again each time it is asked,
 * so what executes agrees with what was written. At most one handoff is `admitted` at a time, as
 * the coordinator runs one turn at a time, and an `admitted` handoff found when a turn starts, with
 * none of this process's turns running, is not coded: the turn is `blocked`.
 *
 * `codeNextHandoff` resolves `{ status, handoffId?, repo?, reason?, ... }`, `status` being
 *
 *   none             no handoff is eligible now (`skipped` lists those passed over). The turn
 *                    writes nothing, but the selection may have held a handoff on the way.
 *   select-failed    the records, the projects or a hold could not be read or written, so selection
 *                    chose nothing. A later turn selects again.
 *   not-admitted     a handoff was selected, but its record had changed by the time of admission
 *                    (reapproved, withdrawn, held), or the records could not be read then: nothing
 *                    was admitted or started.
 *   admission-closed `admit` refused the turn, a stop having been acknowledged: nothing was
 *                    written.
 *   blocked          an admission, or a record of how the coding ended, could not be written, or
 *                    the records show an admission nothing in this process is running. The
 *                    coordinator is to admit no more coding until it is restarted, and the
 *                    reason says what the crew checks. The file is as it was, or, when the
 *                    ending could not be written, shows the handoff `admitted`, which the next
 *                    `start` makes `interrupted` (`interruptAdmissions`); then the result's
 *                    `evidence` keeps the branch, head, pull request and kept work the file
 *                    lacks. Nothing is coded meanwhile.
 *   retry-later      a retryable refusal (`RETRYABLE_REFUSALS`, `handoff-coder.mjs`) before any
 *                    claim or model: the admission was cleared and the handoff is `pending` again.
 *   held             `executeHandoff` found the unit's text changed (`unit-changed`): the admission
 *                    was cleared and the handoff is `held`, with the reason, as selection holds it,
 *                    until `steward handoff reapprove`.
 *   completed        the pull request is open: the handoff is `completed`, with its pull request
 *                    and head.
 *   stopped          anything else: a refusal other than those two, or a failure after a claim, a
 *                    session or a push, or a publication that did not open a pull request. The
 *                    handoff is `stopped`, with what is known (the branch, the head, the pull
 *                    request, the work `executeHandoff` kept) and nothing is retried.
 *
 * A call runs `executeHandoff` and `publishHandoff` at most once each. Only `retry-later`, a
 * refusal before any claim or model, lets a later call execute the same handoff again; every other
 * ending is final for this module.
 *
 * The threat model is one member of the crew, one coordinator and one coding turn at a time on one
 * machine, as `coordinator.mjs` says, so nothing here guards against another writer of the file or
 * a process killed between its writes.
 */
import { randomUUID } from 'node:crypto'
import { withoutCredentials } from './coordinator-scheduler.mjs'
import { PUSHED, REFUSALS, executeHandoff, handoffBranch, isRetryableRefusal } from './handoff-coder.mjs'
import { publishHandoff } from './handoff-publish.mjs'
import { handoffsPath, keptWhere, readHandoffs, selectHandoff, updateHandoffs } from './handoff.mjs'

const SHA_RE = /^[0-9a-f]{40}$/
const text = (value) => (typeof value === 'string' && value !== '' ? value : null)
const sha = (value) => (typeof value === 'string' && SHA_RE.test(value) ? value : null)

/**
 * The work a run kept, as the record holds it (`{ repoDir, branch?, worktree? }`), or null when
 * `retained` is not that. What is written to `handoffs.json` is checked on every read, so a result
 * that is not as `executeHandoff` says it is must not be written as it came.
 */
function keptWork(retained) {
  const repoDir = text(retained?.repoDir)
  if (repoDir === null) return null
  return { repoDir, ...(text(retained.branch) && { branch: retained.branch }), ...(text(retained.worktree) && { worktree: retained.worktree }) }
}

/**
 * Whether the admission `id` is the one the records show as active now: a handoff that is
 * `admitted` with that admission. Reads the file each call, and throws when it cannot, which
 * `executeHandoff` counts as not active.
 */
export function admissionIsActive(homedir, id) {
  const { handoffs } = readHandoffs(handoffsPath(homedir))
  return handoffs.some((h) => h.status === 'admitted' && h.admission?.id === id)
}

/**
 * For `start`, once it has found no coordinator running: moves every `admitted` handoff under
 * `homedir` to `interrupted`, in one write, and returns those handoffs as they were. With none,
 * writes nothing. It runs no model, claims and deletes no branch and looks for no worker or
 * worktree: it records what the file knows, the branch the admission named, and what the crew
 * inspects. Throws when the records cannot be read or written; a write that fails leaves the file
 * as it was.
 */
export function interruptAdmissions({ homedir, now = () => new Date() }) {
  const file = handoffsPath(homedir)
  const at = now().toISOString()
  const interrupted = ({ admission, ...kept }) => ({
    ...kept,
    status: 'interrupted',
    stop: {
      admissionId: admission?.id ?? null,
      at,
      outcome: 'interrupted',
      reason: 'the coordinator that was coding this handoff ended before it recorded how the coding ended, so whether a branch was claimed, a model ran or a pull request was opened is not known',
      branch: admission?.branch ?? null,
      headSha: null,
      pr: null,
      retained: null,
    },
  })
  const done = updateHandoffs(file, (handoffs) => {
    const admitted = handoffs.filter((h) => h.status === 'admitted')
    if (admitted.length === 0) return { result: [] }
    return { handoffs: handoffs.map((h) => (h.status === 'admitted' ? interrupted(h) : h)), result: admitted }
  })
  return done.result
}

/** What a result that is not a push says, in a line: its status, a session's outcome and reason. */
const failure = (result) => withoutCredentials(
  `${result.status}${result.outcome ? ` (the session ${result.outcome})` : ''}${result.reason ? `: ${result.reason}` : ''}`,
)

/**
 * Runs one coding turn for `homedir`, as the module's header says.
 *
 *   admit    `coordinator.admit` of `runCoordinator`: the turn's work, from the admission write to
 *            the record of how it ended, runs as admitted work, so that a stop waits for it
 *   report   `coordinator.report`; given `codingActive`, `{ repo, handoffId, branch, admissionId,
 *            admittedAt }` once the admission is written, and `null` once the turn has ended
 *   select, execute, publish   `selectHandoff`, `executeHandoff` and `publishHandoff`, for tests
 *   now, newId   the clock, and the source of unique admission IDs, for tests
 *   createContext   the GitHub context, for tests; given to all three
 *   executeOptions, publishOptions   more options for `executeHandoff` and `publishHandoff`
 */
export async function codeNextHandoff({
  homedir, admit, report = () => {}, select = selectHandoff, execute = executeHandoff, publish = publishHandoff,
  now = () => new Date(), newId = () => `adm-${randomUUID()}`, createContext, executeOptions = {}, publishOptions = {},
}) {
  const file = handoffsPath(homedir)
  const gh = createContext === undefined ? {} : { createContext }

  let selection
  try {
    const { handoffs } = readHandoffs(file)
    const stale = handoffs.find((h) => h.status === 'admitted')
    if (stale !== undefined) {
      return {
        status: 'blocked', handoffId: stale.id, repo: stale.repo,
        reason: `${stale.id} is admitted for coding, and nothing in this coordinator is coding it. Nothing is coded until the coordinator is restarted, which marks it interrupted; inspect ${stale.admission?.branch ?? 'its branch'} on ${stale.repo} first`,
      }
    }
    selection = await select({ homedir, now, ...gh })
  } catch (error) {
    return { status: 'select-failed', reason: withoutCredentials(error.message) }
  }
  if (selection.result !== 'selected') return { status: 'none', skipped: selection.skipped }

  return new Promise((resolve) => {
    const job = async () => {
      try {
        resolve(await admitAndCode(selection))
      } catch (error) {
        resolve({ status: 'blocked', handoffId: selection.handoff.id, repo: selection.handoff.repo, reason: `an unexpected failure ended the coding turn: ${withoutCredentials(error.message)}. Nothing is coded until the coordinator is restarted; check ${file}` })
      } finally {
        report({ codingActive: null })
      }
    }
    if (!admit(job)) resolve({ status: 'admission-closed' })
  })

  /** The turn's work for the handoff `selected` chose, from the admission to the record of its end. */
  async function admitAndCode({ handoff: selectedHandoff, version }) {
    const named = { handoffId: selectedHandoff.id, repo: selectedHandoff.repo }
    // AC-2: the admission is durable before any claim, setup or model. The records are read afresh
    // in the same step as the write, and the handoff is admitted only if it is still the pending
    // version that was selected and nothing else is admitted. A write that fails starts nothing,
    // and no more coding is admitted.
    let admission
    let h
    try {
      const admitted = updateHandoffs(file, (handoffs) => {
        const now0 = handoffs.find((x) => x.id === selectedHandoff.id)
        if (now0 === undefined || now0.status !== 'pending' || now0.version !== version.version) {
          return {
            status: 'not-admitted',
            refuse: `${selectedHandoff.id} was selected at version ${version.version} and is now ${now0 === undefined ? 'gone' : `${now0.status} at version ${now0.version}`}, so nothing was admitted`,
          }
        }
        if (handoffs.some((x) => x.status === 'admitted')) {
          return { status: 'blocked', refuse: `another handoff is admitted for coding, so ${now0.id} was not admitted. Nothing is coded until the coordinator is restarted` }
        }
        h = now0
        admission = { id: newId(), handoffId: h.id, version: h.version, repo: h.repo, branch: handoffBranch(h), admittedAt: now().toISOString() }
        return { handoffs: handoffs.map((x) => (x === now0 ? { ...now0, status: 'admitted', admission } : x)) }
      })
      if (!admitted.ok) return { status: admitted.status, ...named, reason: admitted.reason }
    } catch (error) {
      if (error.phase === 'read') {
        return { status: 'not-admitted', ...named, reason: `the records cannot be read, so nothing was admitted: ${withoutCredentials(error.message)}` }
      }
      return {
        status: 'blocked', ...named,
        reason: `the admission of ${selectedHandoff.id} could not be written to ${file}, so no branch was claimed and no model was started: ${withoutCredentials(error.message)}. Nothing is coded until the cause is fixed and the coordinator is restarted`,
      }
    }
    report({ codingActive: { repo: h.repo, handoffId: h.id, branch: admission.branch, admissionId: admission.id, admittedAt: admission.admittedAt } })

    // From here the handoff is `admitted`: whatever happens, only the record of its ending below
    // moves it, and `executeHandoff` and `publishHandoff` are each called at most once.
    let result
    let thrown = null
    try {
      result = await execute({
        ...executeOptions, ...gh, homedir, now, handoffId: h.id, version: h.version,
        admission: { id: admission.id, handoffId: h.id, version: h.version },
        admissionIsActive: async (id) => admissionIsActive(homedir, id),
      })
    } catch (error) {
      thrown = error
    }

    // What is known when the run stopped: the branch the admission named, unless the result knows
    // better, and nothing else unless `stop` says.
    const stopped = (stop) => {
      const full = {
        admissionId: admission.id, at: stop.at, outcome: text(stop.outcome) ?? 'unknown', reason: text(stop.reason) ?? 'no reason was given',
        branch: text(stop.branch) ?? admission.branch, headSha: sha(stop.headSha), pr: null, retained: keptWork(stop.retained),
      }
      return finish(admission, { status: 'stopped', stop: full }, { status: 'stopped', reason: full.reason, outcome: full.outcome, branch: full.branch, headSha: full.headSha, pr: full.pr, retained: full.retained })
    }
    const doneAt = now().toISOString()

    if (thrown !== null) {
      return stopped({
        at: doneAt, outcome: 'threw', reason: withoutCredentials(`the coding run ended with an error: ${thrown.message}`), retained: thrown.retained,
      })
    }
    if (REFUSALS.includes(result.status)) {
      // A refusal came before any claim and any model: the admission is cleared, and the handoff
      // goes back to pending, is held, or, for any other refusal, is stopped for the crew.
      if (result.status === 'unit-changed') {
        const held = withoutCredentials(text(result.reason) ?? 'its unit changed after it was approved')
        return finish(admission, { status: 'held', hold: { reason: held, heldAt: doneAt } }, { status: 'held', reason: held })
      }
      if (isRetryableRefusal(result)) {
        return finish(admission, { status: 'pending' }, { status: 'retry-later', reason: failure(result) })
      }
      return stopped({ at: doneAt, outcome: result.status, reason: failure(result) })
    }
    if (result.status !== PUSHED) {
      return stopped({
        at: doneAt, outcome: result.status, reason: failure(result),
        branch: result.branch, headSha: result.headSha, retained: result.retained,
      })
    }

    // AC-3: the branch is pushed, so the pull request is published once.
    const pushed = { branch: result.branch, headSha: result.headSha, retained: result.retained }
    let published
    try {
      published = await publish({ ...publishOptions, ...gh, homedir, now, pushed: result })
    } catch (error) {
      published = { status: 'publish-failed', reason: error.message }
    }
    const pr = published?.pr
    const prOpen = published?.status === 'published' && Number.isSafeInteger(pr?.number) && pr.number > 0 && typeof pr.url === 'string' && pr.url !== ''
    if (!prOpen) {
      return stopped({
        at: now().toISOString(), outcome: published?.status === 'published' ? 'no-pull-request' : text(published?.status) ?? 'publish-failed',
        reason: withoutCredentials(published?.status === 'published' ? 'publication reported success with no pull request' : `the branch was pushed, but its pull request was not opened (${published?.status}): ${published?.reason ?? 'no reason given'}`),
        ...pushed,
      })
    }
    return finish(admission, {
      status: 'completed',
      completion: { admissionId: admission.id, at: now().toISOString(), branch: pushed.branch, headSha: pushed.headSha, pr: { number: pr.number, url: pr.url }, draft: published.draft === true },
    }, { status: 'completed', branch: pushed.branch, headSha: pushed.headSha, pr: { number: pr.number, url: pr.url }, draft: published.draft === true })
  }

  /**
   * Records how the admitted run ended: `next` replaces the handoff's status, and the admission
   * is cleared, in one write. Resolves `outcome`, plus the handoff, or `blocked` when the write
   * cannot be made, in which case the handoff stays `admitted` in the file and the result's
   * `evidence` keeps what the run is known to have left (`{ outcome, branch, headSha, pr, retained }`),
   * since the file will not have it.
   */
  function finish(admission, next, outcome) {
    const named = { handoffId: admission.handoffId, repo: admission.repo }
    try {
      // The run took time: the records are read afresh in the same step as the write, and only the
      // record that still holds this admission is changed.
      const done = updateHandoffs(file, (handoffs) => {
        const h = handoffs.find((x) => x.status === 'admitted' && x.admission?.id === admission.id)
        if (h === undefined) return { refuse: `${file} no longer shows ${admission.handoffId} as admitted under ${admission.id}` }
        const { admission: _cleared, ...kept } = h
        return { handoffs: handoffs.map((x) => (x === h ? { ...kept, ...next } : x)) }
      })
      if (!done.ok) throw new Error(done.reason)
    } catch (error) {
      const kept = keptWhere(outcome.retained ?? null)
      return {
        status: 'blocked', ...named,
        evidence: {
          outcome: outcome.outcome ?? outcome.status, branch: outcome.branch ?? admission.branch, headSha: outcome.headSha ?? null,
          pr: outcome.pr ?? null, retained: outcome.retained ?? null,
        },
        reason: `${admission.handoffId} ended as ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''}${outcome.branch ? `, on branch ${outcome.branch}` : ''}${outcome.pr ? `, pull request #${outcome.pr.number}` : ''}${kept === null ? '' : `, with work kept at ${kept}`}, but the record of it could not be written to ${file}: ${withoutCredentials(error.message)}. It stays admitted, and is marked interrupted when the coordinator is restarted. Nothing is coded until then`,
      }
    }
    return { ...named, ...outcome }
  }
}
