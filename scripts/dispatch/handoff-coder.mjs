/**
 * Executes one approved coding handoff (ST-91) with steward's bounded coder, to a branch pushed to
 * the project's remote. The design is `docs/agent-workflow-design.md`, "Approved coding handoffs
 * and sequential execution". It is the coder's counterpart to `dispatchCoder` in `coder.mjs`, for a
 * unit approved with `steward handoff` (`handoff.mjs`, ST-89) rather than a story in `stories/`: it
 * needs no `stories/` folder, story frontmatter, `blocked:` field or instruction file in the
 * project. It reuses the story coder's claim, usage checks, choice of tool, session, Codex commit
 * path and push (`coder.mjs`) and the project's `setup` (`install.mjs`, ST-7).
 *
 * `executeHandoff` is called with a handoff's ID and the version approved. It opens no pull request
 * and updates none (ST-92), writes no handoff record and no admission (ST-93), and never pushes to
 * `main`. A call starts at most one session, and no failed result starts another.
 *
 * It checks the handoff at the start, and again immediately before the branch is claimed, because
 * the usage check between them takes time; a refusal at the start returns without the second. Each
 * check reads the source and then, once it is read, awaits the admission's activity and, with
 * nothing awaited after that, reads the projects and the records again and decides the project's
 * activation, the version, the status and the admission match from those reads, so a change made
 * while the source or the admission was being read is seen. The unit's text is the one thing that
 * cannot be read again without another await: it is compared when the source read returns, and a
 * change to the source after that is not seen before the claim. A check passes only when
 *
 *   - the handoff exists and its current version is the one asked for;
 *   - without an `admission`, its status is `pending`; with one, its status is `admitted` and the
 *     admission's ID is the one `admissionIsActive` says is active, and its handoff ID and version
 *     are this handoff's and this version (a matching active admission is not a duplicate); and
 *   - its project is activated, its source is readable, and the source's text is exactly the text
 *     approved (`assess` in `handoff.mjs`, the check selection makes).
 *
 * `admission` is ST-93's to supply: `{ id, handoffId, version }` of the coordinator's admission
 * record, which this module neither stores nor creates. `admissionIsActive(id)` resolves whether
 * that admission is the active one now; it is required with an `admission` and read at each check.
 *
 * Resolves `{ status, repo, handoffId, version, ... }`. `status` is one of
 *
 *   refused before anything is claimed or started, so no model session ran (`REFUSALS`):
 *     handoff-unknown, version-not-current, not-executable, admission-mismatch, admission-inactive,
 *     records-unreadable, unit-changed, source-unavailable, over-usage, usage-unknown,
 *     no-git-identity (`user.name` or `user.email` unset or empty in the project's owned checkout,
 *     with `missing` naming them), choice-unavailable (including a user config that cannot be
 *     read), bad-machine-label, branch-exists
 *       `unit-changed` is the refusal because the source was read and its text differs from the
 *       approved version: the one ST-93 answers with ST-90 AC-3's hold. `source-unavailable` (the
 *       source could not be read now, or `main` could not be fetched), `over-usage` and
 *       `usage-unknown` carry `retryable: true` (`RETRYABLE_REFUSALS`): the same handoff may be
 *       executed again later. No other refusal does.
 *   failed while claiming or setting up, before any model ran: claim-failed (including a throw
 *       while making the worktree or the claim commit), install-failed (the setting or the setup)
 *       (a `branch-exists` found only when the claim is pushed is a refusal too)
 *   failed in the model: session-failed (with `outcome`; `not-started` when the session could not be
 *       started, for example its executable could not be run)
 *   failed after a completed session, with the branch not pushed: nothing-committed,
 *       uncommitted-changes, prompt-change-refused, push-failed, commit-failed (ATC's commit of a
 *       Codex session's work threw)
 *   failed after the push: pr-block-invalid (the branch is pushed, with no description)
 *   pushed: the branch is on the remote at `headSha`, with `proposedPr`, the coder's parsed
 *       `{ title, body, draft }`, and `choice`, the choice that actually ran
 *
 * A result after a session that ran to its end carries `session`; one for a step that threw (the
 * session could not be started, or ATC's commit or push threw) carries the error as `reason`
 * instead. A failed result after the claim is pushed leaves that claim on the remote. A failed
 * result after the session started also carries `retained` -- `{ repoDir, branch, worktree? }` --
 * when removing what the run made would have destroyed the only copy of the coder's work, whatever
 * the failure, `pr-block-invalid` included: `worktree` (with its `branch`) when the worktree holds
 * uncommitted changes or untracked files, `branch` alone when it holds commits not on the remote.
 * What is named is left where it is.
 *
 * What still throws, and only that: a caller error (an `admission` without `admissionIsActive`), the
 * engine's own prompt file being unreadable, and a failure of the clean-up after the run. A read of
 * the records, the projects, the source, the user config, the usage, `main` or the remote's
 * branches that fails is a refusal; each step from the claim on that fails is a result.
 */
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir as osHomedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BASE, REMOTE, badMachineLabelReason, claimBranch, cleanUp, commitMessageOf, commitSessionWork, git, gitOrNull,
  machineLabel, pickCoderChoice, pushBranch, readGitIdentity, remoteTip, sessionSummary, startCoderSession, titleOf,
} from './coder.mjs'
import { coderEnv } from './coder-env.mjs'
import { readCodexUsage, spawnCodexCoder } from './codex.mjs'
import { createContext } from './github.mjs'
import { assess, describeSource, handoffsPath, readHandoffs } from './handoff.mjs'
import { installDependencies } from './install.mjs'
import { ownedCheckoutPath, projectsPath, readProjectsSync } from './project.mjs'
import { readSettings } from './settings.mjs'
import { coderChoice, readUserConfig } from './user-config.mjs'
import { readUsage } from './usage.mjs'

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const HANDOFF_PROMPT = path.join(ENGINE_ROOT, '.claude', 'prompts', 'coder-handoff.md')

/**
 * The refusals after which the same handoff may be executed again: nothing about the handoff was
 * wrong.
 */
export const RETRYABLE_REFUSALS = ['source-unavailable', 'over-usage', 'usage-unknown']

/** Every `status` meaning this run claimed no branch and no model ran. */
export const REFUSALS = [
  'handoff-unknown', 'version-not-current', 'not-executable', 'admission-mismatch', 'admission-inactive',
  'records-unreadable', 'unit-changed', ...RETRYABLE_REFUSALS, 'no-git-identity', 'choice-unavailable',
  'bad-machine-label', 'branch-exists',
]

/** The `status` of a result whose branch was pushed with a description. */
export const PUSHED = 'pushed'

/** Whether `result` is a refusal after which executing the same handoff again may succeed. */
export const isRetryableRefusal = (result) => RETRYABLE_REFUSALS.includes(result?.status)

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '')

/**
 * The branch a handoff is worked on (AC-3): `handoff/` and its ID, and a word for its source, the
 * path of a file in lower-case letters and digits, or `issue-<number>`. It depends on the record's
 * ID and source only, so it is the same for every execution of one handoff, and it is always a
 * plain name `claimPushArgs` takes.
 */
export function handoffBranch(handoff) {
  const word = handoff.source.kind === 'issue' ? `issue-${handoff.source.number}` : slug(handoff.source.path) || 'file'
  return `handoff/${handoff.id}-${word}`
}

/** `{ status, repo, handoffId, version, ...}`: what every result starts with. */
const result = (base, status, rest = {}) => ({ status, repo: base.repo, handoffId: base.handoffId, version: base.version, ...rest })

/**
 * The part of a check that reads the records and decides from them, with no await: the handoff exists,
 * its version is the one asked for, its status fits (`pending`; or `admitted` with an admission),
 * and the admission names this handoff and version. Resolves `{ handoff }` or `{ refusal }`.
 */
function fromRecords(base, { admission, ctx }) {
  const refuse = (status, reason, extra = {}) => ({ refusal: result(base, status, { reason, ...extra }) })
  let handoffs
  try {
    ;({ handoffs } = readHandoffs(handoffsPath(ctx.homedir)))
  } catch (error) {
    return refuse('records-unreadable', error.message)
  }
  const h = handoffs.find((x) => x.id === base.handoffId)
  if (h === undefined) return refuse('handoff-unknown', `${base.handoffId} is not an approved handoff`)
  base.repo = h.repo
  if (h.version !== base.version) {
    return refuse('version-not-current', `${h.id} is at version ${h.version}, not the version ${base.version} that was asked for`)
  }
  if (admission === undefined) {
    if (h.status !== 'pending') {
      return refuse('not-executable', `${h.id} is ${h.status}, and only a pending handoff is executed without an admission`, { handoffStatus: h.status })
    }
  } else {
    if (admission.handoffId !== h.id || admission.version !== base.version || typeof admission.id !== 'string' || admission.id === '') {
      return refuse('admission-mismatch', `the admission ${JSON.stringify(admission.id)} is for ${admission.handoffId} version ${admission.version}, not ${h.id} version ${base.version}`)
    }
    if (h.status !== 'admitted') {
      return refuse('not-executable', `${h.id} is ${h.status}, and an admission applies only to an admitted handoff`, { handoffStatus: h.status })
    }
  }
  return { handoff: h }
}

/**
 * Whether the handoff is authorized now (AC-1). Everything asynchronous is awaited first (the
 * admission's activity); then, with no await after that, `projects.json` and `handoffs.json` are
 * read and the project's activation, the version, the status and the admission match are decided
 * from those fresh reads. So no condition read from a file is older than the last await.
 */
async function authorize(base, args) {
  const { admission, admissionIsActive, ctx } = args
  const refuse = (status, reason, extra = {}) => ({ refusal: result(base, status, { reason, ...extra }) })
  const early = fromRecords(base, args)
  if (early.refusal) return early
  let active = true
  if (admission !== undefined) {
    try {
      active = (await admissionIsActive(admission.id)) === true
    } catch {
      active = false
    }
  }
  // No await from here to the return.
  let projects
  try {
    projects = readProjectsSync(projectsPath(ctx.homedir))
  } catch (error) {
    return refuse('records-unreadable', error.message)
  }
  const last = fromRecords(base, args)
  if (last.refusal) return last
  if (!projects.some((p) => p.repo === last.handoff.repo)) {
    return refuse('source-unavailable', `${last.handoff.repo} is not activated`, { retryable: true })
  }
  if (!active) return refuse('admission-inactive', `the admission ${admission.id} is not the active admission of ${last.handoff.id}`)
  return last
}

/**
 * Whether the handoff `base.handoffId` can be executed now, per the module's header. Resolves
 * `{ handoff }`, or `{ refusal }` (a result). Reads the records file and the unit's source afresh
 * each time it is called, and decides authorization again after the source is read, since that
 * read can take a while.
 */
async function check(base, args) {
  const refuse = (status, reason, extra = {}) => ({ refusal: result(base, status, { reason, ...extra }) })
  const before = await authorize(base, args)
  if (before.refusal) return before
  const h = before.handoff
  let verdict
  try {
    verdict = await assess(h, args.ctx)
  } catch (error) {
    return refuse('records-unreadable', error.message)
  }
  if (verdict.eligible) {
    // The source read may have taken a while: authorization is decided again after it, so a
    // handoff withdrawn, a project deactivated or an admission stopped meanwhile is refused.
    return authorize(base, args)
  }
  if (verdict.changed) return refuse('unit-changed', verdict.reason, { retryable: false })
  return refuse('source-unavailable', verdict.reason, { retryable: true })
}

/**
 * After the run: removes the worktree and the local branch unless doing so would lose the only
 * copy of the coder's work (AC-6). Resolves what was kept, `{ repoDir, branch?, worktree? }`, or
 * `null` when nothing was. Never throws for a git failure: a worktree whose state cannot be read is
 * kept.
 */
async function cleanUpKeeping({ repoDir, tree, branch, state, succeeded }) {
  if (!state.worktreeAdded) return null
  if (!succeeded && state.sessionStarted) {
    const status = await gitOrNull(tree, ['status', '--porcelain', '-z', '--untracked-files=all'])
    if (status === null || status !== '') return { repoDir, worktree: tree, branch }
  }
  await cleanUp({ repoDir, tree, branch, baseSha: state.baseSha, worktreeAdded: true })
  const left = await gitOrNull(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  return left ? { repoDir, branch } : null
}

/**
 *   handoffId, version  the handoff to execute and the version approved (`readHandoffs`)
 *   admission, admissionIsActive   see the header; both from ST-93's coordinator
 *   homedir            where `~/.steward/` is; defaults to the OS user's home. The handoff records,
 *                      the project's owned checkout and (by default) the user config are under it
 *   remoteTip          `(repoDir, branch)`, resolving the branch's tip on the remote or `null`; defaults
 *                      to `remoteTip` of `coder.mjs`; for tests
 *   now                the clock, passed to the source read
 *   createContext      the GitHub context an Issue is read through (a stand-in in tests)
 *   promptTemplate     coder-handoff.md's text; defaults to the copy beside the engine
 *   baseEnv, sessionOptions, install, usage, codexUsage, codexSession, userConfig
 *                      as for `dispatchCoder` (`coder.mjs`). `choice` names a key of
 *                      `roles.coder.available` to run instead of the user config's default
 *
 * The tool is the user config's default coder choice (or `choice`), never a unit's own: a unit
 * names none. As for the story coder, when that choice's tool is over its usage limit, the other
 * choices at least as strong are tried, and the choice that ran is in the result.
 */
export async function executeHandoff({
  handoffId, version, admission, admissionIsActive,
  homedir = osHomedir(), now = () => new Date(), createContext: makeContext = createContext,
  promptTemplate, baseEnv = process.env, sessionOptions = {}, install = installDependencies,
  usage = readUsage, remoteTip: readRemoteTip = remoteTip, choice: named, codexUsage = readCodexUsage, codexSession = spawnCodexCoder,
  userConfig = () => readUserConfig({ env: process.env, homedir }),
}) {
  if (admission !== undefined && typeof admissionIsActive !== 'function') {
    throw new TypeError('executeHandoff needs admissionIsActive when it is given an admission')
  }
  const ctx = { homedir, now, createContext: makeContext }
  const base = { repo: null, handoffId, version }
  const checkArgs = { admission, admissionIsActive, ctx }

  // AC-1: the first check, before the user config, the usage or the branches are looked at.
  const first = await check(base, checkArgs)
  if (first.refusal) return first.refusal
  const { handoff } = first
  const repoDir = ownedCheckoutPath(homedir, handoff.repo)
  const branch = handoffBranch(handoff)

  // ST-99/AC-1: the identity ATC commits as in this run, read once from the owned checkout, before
  // the user config or the usage is read and before anything is claimed.
  const who = await readGitIdentity(repoDir)
  if (who.refusal) return result(base, who.refusal.status, { branch, missing: who.refusal.missing, reason: who.refusal.reason })
  const { identity } = who

  let machine
  try {
    machine = await userConfig()
  } catch (error) {
    return result(base, 'choice-unavailable', { choice: named ?? null, reason: `the user config cannot be read: ${error.message}` })
  }
  const picked0 = named !== undefined
    ? { choice: typeof named === 'string' ? coderChoice(machine, named) : null, why: 'crew' }
    : { choice: coderChoice(machine, null), why: 'default' }
  if (picked0.choice === null) return result(base, 'choice-unavailable', { choice: named ?? null, reason: 'the user config names no such coder choice' })
  let picked
  try {
    picked = await pickCoderChoice({
      machine, first: picked0, named, usage, codexUsage, cwd: repoDir, extra: { handoffId },
    })
  } catch (error) {
    return result(base, 'usage-unknown', { retryable: true, reason: `the usage cannot be read: ${error.message}` })
  }
  if (picked.refusal) return result(base, picked.refusal.status, { ...picked.refusal, retryable: isRetryableRefusal(picked.refusal) })
  const { choice, ran } = picked

  const label = machineLabel(baseEnv)
  if (label === null) {
    return result(base, 'bad-machine-label', { branch, reason: badMachineLabelReason(baseEnv) })
  }
  const template = promptTemplate ?? readFileSync(HANDOFF_PROMPT, 'utf8')

  let mainSha
  try {
    await git(repoDir, ['fetch', REMOTE, BASE])
    mainSha = (await git(repoDir, ['rev-parse', `${REMOTE}/${BASE}`])).trim()
  } catch (error) {
    return result(base, 'source-unavailable', { retryable: true, reason: `${REMOTE}'s ${BASE} cannot be fetched: ${String(error.stderr ?? '').trim() || error.message}` })
  }
  // AC-3: an existing branch, local or remote, is refused.
  if (await gitOrNull(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) {
    return result(base, 'branch-exists', { branch, reason: `${branch} already exists locally` })
  }
  let remote
  try {
    remote = await readRemoteTip(repoDir, branch)
  } catch (error) {
    return result(base, 'source-unavailable', { retryable: true, reason: `${REMOTE}'s branches cannot be listed: ${String(error.stderr ?? '').trim() || error.message}` })
  }
  if (remote) return result(base, 'branch-exists', { branch, reason: `${branch} already exists on ${REMOTE}` })

  let scratch
  try {
    scratch = await mkdtemp(path.join(tmpdir(), 'steward-handoff-'))
  } catch (error) {
    return result(base, 'claim-failed', { branch, reason: `a scratch folder cannot be made: ${error.message}` })
  }
  // AC-1: the second check. Nothing is awaited between its last read and the claim.
  const again = await check(base, checkArgs)
  if (again.refusal) {
    await rm(scratch, { recursive: true, force: true })
    return again.refusal
  }
  const tree = path.join(scratch, 'tree')
  const state = { worktreeAdded: false, baseSha: mainSha, sessionStarted: false }
  let outcome
  let failure = null
  try {
    outcome = await attempt()
  } catch (error) {
    failure = error
  }
  const retained = await cleanUpKeeping({ repoDir, tree, branch, state, succeeded: outcome?.status === PUSHED })
  if (retained === null || retained.worktree === undefined) await rm(scratch, { recursive: true, force: true })
  if (failure !== null) {
    if (retained !== null) failure.retained = retained
    throw failure
  }
  return retained === null ? outcome : { ...outcome, retained }

  async function attempt() {
    // Each step that can throw is named, so a throw is a result of that step's kind (AC-6). What
    // is left to throw out of `executeHandoff` is described in its header.
    let step = 'claim'
    try {
      // AC-3: the claim, the existing non-forced claim push, before the setup or the model.
      const refused = await claimBranch(state, { repoDir, tree, branch, mainSha, unitId: handoff.id, label, identity })
      if (refused) return result(base, refused.status, { branch, reason: refused.reason })

      // The project's setup, read from the revision the worktree was made from (ST-7).
      step = 'setup'
      const { setup, rulesFile } = await readSettings(tree)
      const ghConfigDir = path.join(scratch, 'gh-config')
      await mkdir(ghConfigDir)
      await install({ cwd: tree, env: coderEnv(baseEnv, ghConfigDir), setup })

      step = 'session'
      state.sessionStarted = true
      const { classification, output } = await startCoderSession({
        choice, machine, sessionOptions, codexSession, scratch,
        promptTemplate: template,
        repo: handoff.repo,
        handoff: { id: handoff.id, version: handoff.version, source: describeSource(handoff.source), text: handoff.text, rulesFile },
        branch,
        baseEnv,
        emptyGhConfigDir: ghConfigDir,
        cwd: tree,
      })
      const context = { branch, headSha: null, pushed: false, session: sessionSummary(classification, output), ...ran }
      if (classification.outcome !== 'completed') {
        return result(base, 'session-failed', { ...context, outcome: classification.outcome, reason: classification.reason })
      }
      // ST-15/AC-5: a Codex session cannot commit, so the dispatcher commits what it left.
      const viaCodex = choice.tool === 'codex'
      if (viaCodex) {
        step = 'commit'
        await commitSessionWork({
          cwd: tree, storyId: handoff.id, title: titleOf(classification.prText), message: commitMessageOf(classification.prText), identity,
        })
      }
      step = 'push'
      const push = await pushBranch({ cwd: tree, branch, baseSha: state.baseSha, hooksOff: viaCodex })
      if (push.status !== PUSHED) {
        const { status, ...rest } = push
        return result(base, status, { ...context, ...rest })
      }
      context.headSha = push.headSha
      context.pushed = true
      const block = classification.prText
      if (block.status !== 'parsed') return result(base, 'pr-block-invalid', { ...context, reason: block.reason })
      return result(base, PUSHED, { ...context, proposedPr: { title: block.title, body: block.body, draft: block.draft } })
    } catch (error) {
      const failed = { claim: 'claim-failed', setup: 'install-failed', session: 'session-failed', commit: 'commit-failed', push: 'push-failed' }[step]
      return result(base, failed, { branch, reason: error.message, ...(step === 'session' && { outcome: 'not-started', pushed: false }) })
    }
  }
}
