#!/usr/bin/env node
/**
 * Reviews one open pull request end to end and records the verdict (OQ-69):
 * resolve the head, read the project's checklist from `main` (ST-21), find and
 * read from `main` the unit the PR's body links (ST-22, `unit.mjs`), check out
 * that exact commit somewhere that is not the coder's tree, spawn the
 * reviewer, parse what it returns against the checklist, and post the verdict
 * as a marker comment.
 *
 * It joins existing modules and reimplements none of them: `github.mjs` reads
 * the pull request, lists its comments, composes and posts the marker;
 * `spawn.mjs` runs the session, building the prompt through `invocation.mjs`.
 * It posts no commit status -- `review-gate.yml` derives `review/agent` from
 * the marker -- and it never triggers a workflow.
 *
 * Both the prompt template and `render.mjs` come from the checkout this file
 * lives in, never from the pull request's branch. When the diff under review is
 * the renderer, using the PR's copy to build the review prompt would be
 * circular.
 *
 * It installs nothing in the checkout: the reviewer runs no checks (ST-33).
 * Before it starts a session it reads the usage of the tool the reviewer's
 * choice runs on (`usage.mjs`, ST-31; `codex.mjs` for Codex, ST-32), and
 * starts none when either window is at or over the reviewer's limit in the
 * settings (`over-usage`), or when the usage cannot be read (`usage-unknown`).
 * A second session for a malformed verdict is not checked again.
 *
 * A unit that is missing, unreadable, `Unit: none` or one of several links
 * does not stop the review: the reviewer is told which, and the rules judge it.
 *
 * A review that cannot be recorded is not an error: a `null` verdict or a
 * moved head leaves the PR pending, which
 * `docs/agent-workflow-design.md` ("What the gate enforces") says is the
 * right outcome. Each is a distinct `status` on the result. A `null` verdict
 * is `no-verdict` only when the pull request's head has moved since the
 * reviewer was handed it; on an unchanged head it is `cannot-review` (ST-37),
 * a failure that stops the rotation (`docs/controller.md`).
 *
 * Usage:
 *   node scripts/dispatch/review.mjs <pr-number> [--repo owner/name] [--rereview]
 *
 * `--rereview` permits reviewing a head whose governing verdict is a `block`
 * (`docs/agent-workflow-design.md`, "What the gate enforces", item 3). Over any
 * other verdict, or none, it stops.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { readCodexUsage, spawnCodexReviewer } from './codex.mjs'
import { coderEnv } from './coder-env.mjs'
import {
  composeMarkerComment,
  createContext,
  getPullRequestState,
  listPullRequestComments,
  postComment,
  WRITABLE_VERDICTS,
} from './github.mjs'
import { renderReviewerPrompt } from './invocation.mjs'
import { readMachineSettings } from './machine-settings.mjs'
import { parseFrontmatter } from './queue.mjs'
import { readRules } from './rules.mjs'
import { readSettings } from './settings.mjs'
import { spawnSession } from './spawn.mjs'
import { describeUnit, findUnitLink, readUnit } from './unit.mjs'
import { checkUsage, readUsage } from './usage.mjs'

const execFileAsync = promisify(execFile)

const DISPATCH_DIR = path.dirname(fileURLToPath(import.meta.url))
// The engine root: where this module and its prompt live, found from its own
// location (OQ-123). Not the project -- see `repoDir` below.
const ENGINE_ROOT = path.resolve(DISPATCH_DIR, '..', '..')
const REVIEWER_PROMPT = path.join(ENGINE_ROOT, '.claude', 'prompts', 'reviewer.md')

const REMOTE = 'origin'

// The author associations review-gate.yml's "Apply verdict from marker" step
// honours. A restatement so the two read the same; a test compares it to the
// workflow's `case` and fails on drift.
export const HONOURED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR']
const SHA_RE = /^[0-9a-f]{40}$/

// What {{UNIT}} renders as when no unit was read (reviewer.md, the
// placeholders). {{UNIT_NOTE}} says why.
const NO_UNIT_TEXT = '*(none — no unit was read; the note above says why.)*'

// -------------------------------------------------------------------- unit

/**
 * The `model:` of the unit's story (ST-22/AC-4, ST-34/AC-5): only a file unit that was read and
 * parses as one of this repository's stories has one, since only a story gives the coder its model.
 * `undefined` for any other unit or a file that does not parse; `null` for a story whose `model:`
 * is `null`, the coder's default; otherwise the string.
 */
function storyModel(found, read) {
  if (found?.kind !== 'link' || found.type !== 'file' || read?.read !== true) return undefined
  try {
    const { model } = parseFrontmatter(read.text, String(found.target)).data
    if (model === null) return null
    return typeof model === 'string' && model !== '' ? model : undefined
  } catch {
    return undefined
  }
}

/** The `model:` a unit names, or `null` when it names none (a `null` `model:` names none). */
export function unitModel(found, read) {
  return storyModel(found, read) ?? null
}

/**
 * The model the coder ran for the unit, for `chooseReviewer` (ST-34/AC-5): the model of the choice
 * the story's `model:` names in `roles.coder.available`, else that string as written; the model of
 * `roles.coder.default` when the story's `model:` is `null`; `null` when the unit is no story, so
 * no coder is known.
 */
export function unitCoderModel(machine, found, read) {
  const named = storyModel(found, read)
  if (named === undefined) return null
  const { available, default: fallback } = machine.roles.coder
  if (named === null) return available[fallback].model
  return Object.hasOwn(available, named) ? available[named].model : named
}

// ------------------------------------------------------------------- model

function sameModel(a, b) {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()]
  return x.includes(y) || y.includes(x)
}

/**
 * The reviewer's choice (ST-34/AC-5; docs/agent-workflow-design.md, "Reviewer": context isolation
 * decorrelates knowledge, not reasoning style, so a different model from the coder's): the
 * `default` of `roles.reviewer` unless its model is the coder's (`unitCoderModel`), else the first
 * other choice in `available`, in the file's order, whose model differs. `null` when none does.
 * With no coder model (`null`) it is the default.
 */
export function chooseReviewer(machine, coderModel) {
  const { available, default: preferred } = machine.roles.reviewer
  const differs = (choice) => typeof coderModel !== 'string' || !sameModel(choice.model, coderModel)
  const name = [preferred, ...Object.keys(available).filter((key) => key !== preferred)]
    .find((key) => differs(available[key]))
  return name === undefined ? null : { name, ...available[name] }
}

// ----------------------------------------------------------------- verdict

/**
 * Why `sections`, the reviewer's list of the checklist's sections, is not what
 * the checklist has (ST-21/AC-3), or `null` when it names each once, with a
 * reason for each not applied. `items` maps each section name to its numbers.
 */
function sectionsProblem(sections, items) {
  if (!Array.isArray(sections)) return '`sections` is not an array'
  const seen = new Set()
  for (const entry of sections) {
    if (entry === null || typeof entry !== 'object' || typeof entry.name !== 'string' ||
      typeof entry.applied !== 'boolean') {
      return 'a `sections` entry lacks a `name` or a boolean `applied`'
    }
    if (!items.has(entry.name)) return `\`sections\` names "${entry.name}", which the checklist does not have`
    if (seen.has(entry.name)) return `\`sections\` names "${entry.name}" twice`
    seen.add(entry.name)
    if (!entry.applied && (typeof entry.reason !== 'string' || entry.reason.trim() === '')) {
      return `\`sections\` gives no reason for not applying "${entry.name}"`
    }
  }
  const missing = [...items.keys()].filter((name) => !seen.has(name))
  if (missing.length > 0) return `\`sections\` leaves out ${missing.map((name) => `"${name}"`).join(', ')}`
  return null
}

/**
 * Reads the JSON object reviewer.md says is the last thing the reviewer prints,
 * tolerating a code fence around it, and checks it against `rules`, the
 * checklist as `parseRules` read it (ST-21/AC-3): each finding names a section
 * and an item the checklist has, and `sections` names every section once,
 * with a reason for each not applied. A `null` verdict, which records nothing,
 * need not list the sections. Returns `{ ok: true, verdict }` or
 * `{ ok: false, reason }`; never guesses a verdict from prose.
 */
export function parseReviewerVerdict(text, rules) {
  if (typeof text !== 'string') return { ok: false, reason: 'the session returned no text' }
  const candidates = [text.trim()]
  for (const fenced of text.matchAll(/```(?:json)?[^\S\n]*\n([\s\S]*?)\n```/g)) candidates.unshift(fenced[1])
  for (const start of [...text.matchAll(/^\{/gm)].map((m) => m.index).reverse()) {
    candidates.push(text.slice(start).trim())
  }
  let parsed = null
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate)
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'verdict' in value) {
        parsed = value
        break
      }
    } catch {
      // Not this candidate.
    }
  }
  if (parsed === null) return { ok: false, reason: 'no JSON verdict object found in the reviewer output' }

  const { head, verdict, findings, summary, sections } = parsed
  if (typeof head !== 'string' || !SHA_RE.test(head)) return { ok: false, reason: '`head` is not a full 40-character SHA' }
  if (verdict !== null && !WRITABLE_VERDICTS.includes(verdict)) {
    return { ok: false, reason: `\`verdict\` is not one of ${WRITABLE_VERDICTS.join(', ')} or null` }
  }
  const items = new Map(rules.sections.map((s) => [s.name, new Set(s.items.map((i) => i.number))]))
  if (!Array.isArray(findings)) return { ok: false, reason: '`findings` is not an array' }
  for (const finding of findings) {
    const valid = finding !== null && typeof finding === 'object' &&
      typeof finding.section === 'string' && Number.isInteger(finding.item) &&
      ['block', 'observation'].includes(finding.severity) && typeof finding.text === 'string'
    if (!valid) return { ok: false, reason: 'a finding lacks a `section`, an integer `item`, a `severity` or `text`' }
    if (!items.has(finding.section)) {
      return { ok: false, reason: `a finding names section "${finding.section}", which the checklist does not have` }
    }
    if (!items.get(finding.section).has(finding.item)) {
      return { ok: false, reason: `a finding names item ${finding.item} of "${finding.section}", which that section does not have` }
    }
  }
  if (typeof summary !== 'string') return { ok: false, reason: '`summary` is not a string' }
  if (verdict !== 'block' && findings.some((f) => f.severity === 'block')) {
    return { ok: false, reason: `a finding has severity block but the verdict is ${verdict}` }
  }
  if (verdict !== null || sections !== undefined) {
    const problem = sectionsProblem(sections, items)
    if (problem) return { ok: false, reason: problem }
  }
  return { ok: true, verdict: { head, verdict, findings, summary, sections: sections ?? [] } }
}

/**
 * The comment text that precedes the marker (ST-21/AC-4): what the reviewer
 * found, each finding by section and item, then every section of the
 * checklist, applied or not, with the reason for each not applied.
 */
export function formatFindings({ verdict, findings, summary, sections }) {
  const lines = [`**Review verdict: ${verdict}**`, '', summary.trim()]
  if (findings.length > 0) {
    lines.push('')
    for (const { section, item, severity, text } of findings) {
      lines.push(`- **${section}, item ${item}** (${severity}): ${text.trim()}`)
    }
  }
  lines.push('', '**Sections**', '')
  for (const { name, applied, reason } of sections) {
    lines.push(applied ? `- ${name}: applied` : `- ${name}: not applied. ${reason.trim()}`)
  }
  return lines.join('\n')
}

// --------------------------------------------------------------------- git

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout
}

/**
 * Throws unless `dir` is a checkout of exactly `sha`, with nothing uncommitted,
 * that is not `repoDir` (AC-5). A reviewer reading a dirty tree reviews
 * something that is not what the PR contains.
 */
async function assertReviewableCheckout(dir, sha, repoDir) {
  if (realpathSync(dir) === realpathSync(repoDir)) throw new Error('the review checkout is the dispatcher\'s own tree')
  const head = (await git(dir, ['rev-parse', 'HEAD'])).trim()
  if (head !== sha) throw new Error(`the review checkout is at ${head}, not ${sha}`)
  if ((await git(dir, ['status', '--porcelain'])).trim() !== '') {
    throw new Error('the review checkout has uncommitted changes')
  }
}

// ------------------------------------------------------------------- entry

/**
 * Runs the reviewer half for pull request `number`.
 *
 *   number         the pull request
 *   ctx            a `github.mjs` context (`createContext`)
 *   repoDir        the project root, whose object store the review checkout is
 *                  made from, and where `steward.config.json` is read from;
 *                  defaults to the current working directory
 *   promptTemplate reviewer.md's text; defaults to the copy beside this file
 *   baseEnv        the environment to derive the session's from; defaults to
 *                  `process.env`, with every GitHub credential removed
 *   rereview       review a head that already has a verdict, only when the
 *                  governing verdict there is `block`
 *   scratchRoot    the directory the `tw-review-*` scratch directory is made in;
 *                  defaults to `os.tmpdir()`. Not exposed by the CLI
 *   sessionOptions extra `spawnSession` options (executable, run, timeouts,
 *                  budget)
 *   usage          `({ cwd })`, resolving `readUsage`'s result; defaults to
 *                  `readUsage`. Called once, in `repoDir`, when the reviewer's
 *                  choice runs on Claude Code
 *   codexUsage     `({ executable, cwd })`, resolving `readCodexUsage`'s result,
 *                  in its place when the choice runs on Codex (ST-32/AC-3)
 *   codexSession   `spawnCodexReviewer`'s shape of call, for a Codex choice
 *                  (ST-32/AC-2); defaults to `spawnCodexReviewer`
 *   machineSettings  `()`, resolving the machine's settings; defaults to `readMachineSettings`
 *                  on the real environment and home directory. Called once (ST-34)
 *
 * Resolves `{ status, ... }`. `recorded` carries the comment id; every other
 * status means nothing was posted, and `reason` says why. `no-verdict` (a
 * `null` verdict on a head that has moved) and `already-reviewed` are not
 * failures. `cannot-review` (ST-37) is a `null` verdict on a head that has not
 * moved: the reviewer could not review, a fault in the machine or the prompt
 * that someone has to fix. It carries `headSha`, the reviewer's `summary` and
 * `sessions`, and is a failure for the CLI. `rereview-refused`,
 * `rules-unreadable`, `over-usage` (with `window`, `percent`, `limit` and
 * `resetsAt`) and `usage-unknown` (ST-31) are, and the CLI exits 1 for them: a
 * review that was asked for did not happen. The last two start no session.
 * `rules-unreadable` (ST-21/AC-1) is a checklist (the settings' `rulesFile`)
 * that is missing from the base branch or does not parse: it carries
 * `problems`, and comes before any session. `reviewer-unavailable`
 * (ST-34/AC-5) is a machine whose reviewer choices all have the coder's model:
 * no session is started, and it is a failure like the others.
 * Every result returned after a session started carries `sessions`, the
 * number of reviewer sessions run (1 or 2, OQ-121). A verdict that does not
 * parse (`parseReviewerVerdict` rejects it) gets one re-run, in the same
 * worktree with the same prompt, unit, pull request, environment and model;
 * a second malformed reply is `malformed-verdict` with both sessions' reasons.
 * The checkout is checked again before the re-run, and if the first session
 * left it changed, there is no second session and nothing is reset.
 */
export async function reviewPullRequest({
  number, ctx, repoDir = process.cwd(), promptTemplate, baseEnv = process.env, sessionOptions = {},
  rereview = false, scratchRoot = tmpdir(), usage = readUsage,
  machineSettings = () => readMachineSettings({ env: process.env, homedir: homedir() }),
  codexUsage = readCodexUsage, codexSession = spawnCodexReviewer,
}) {
  const template = promptTemplate ?? readFileSync(REVIEWER_PROMPT, 'utf8')
  const { unitLinks, rulesFile } = await readSettings(repoDir)
  const machine = await machineSettings()
  const pr = await getPullRequestState(ctx, number)
  if (!SHA_RE.test(pr.headSha) || !pr.headRef || !pr.baseRef) {
    throw new Error(`pull request #${number} did not resolve a head SHA, head branch and base branch`)
  }

  const existing = await verdictAt(ctx, number, pr.headSha)
  if (rereview) {
    if (existing?.verdict !== 'block') {
      return {
        status: 'rereview-refused',
        headSha: pr.headSha,
        reason: existing
          ? `the governing verdict at ${pr.headSha} is ${existing.verdict}; only a block can be re-reviewed at the same head`
          : `there is no verdict at ${pr.headSha} to re-review`,
      }
    }
  } else if (existing) {
    return { status: 'already-reviewed', headSha: pr.headSha, existing }
  }

  const scratch = await mkdtemp(path.join(scratchRoot, 'tw-review-'))
  const tree = path.join(scratch, 'tree')
  let worktreeAdded = false
  // AC-1b: set when a first session leaves the checkout changed, so the
  // `finally` below leaves the worktree and scratch directory in place
  // instead of cleaning them away -- a reviewer that wrote to its checkout is
  // itself worth seeing.
  let keepCheckout = false
  try {
    await git(repoDir, ['fetch', REMOTE, pr.headRef, pr.baseRef])
    const fetchedTip = (await git(repoDir, ['rev-parse', `${REMOTE}/${pr.headRef}`])).trim()
    if (fetchedTip !== pr.headSha) {
      return { status: 'head-moved', reason: `${pr.headRef} is at ${fetchedTip}, not the ${pr.headSha} the API reported` }
    }

    // ST-21/AC-1: the checklist as it stands on the base branch, never the
    // pull request's own copy, read before a session is started,
    // so a missing or broken file costs no review.
    const rules = await readRules({ repoDir, base: pr.baseRef, rulesFile })
    if (!rules.ok) {
      return { status: 'rules-unreadable', problems: rules.problems, reason: rules.problems.join('; ') }
    }

    // ST-22/AC-1: the unit the body links, read as it stands on the base
    // branch, never the head. A missing, unreadable, `Unit: none` or
    // several-link case is reviewed, with the note saying which.
    const found = findUnitLink(pr.body, unitLinks)
    const read = found.kind === 'link' ? await readUnit(found, { repoDir, base: pr.baseRef, ctx }) : null
    const unit = { note: describeUnit(found, read), text: read?.read === true ? read.text : NO_UNIT_TEXT }
    // ST-34/AC-5: a choice whose model is not the coder's, or no session at all.
    const choice = chooseReviewer(machine, unitCoderModel(machine, found, read))
    if (choice === null) {
      return {
        status: 'reviewer-unavailable',
        reason: `no choice in roles.reviewer.available has a model that differs from the coder's, ${unitCoderModel(machine, found, read)}`,
      }
    }

    // ST-31/AC-3, ST-32/AC-3: once per call, after the decision to review and
    // the reviewer's choice, and before any checkout or session, reading the
    // usage of the tool the choice runs on. The malformed-verdict re-run below
    // is not checked again.
    const codex = choice.tool === 'codex'
    const readChosen = codex
      ? ({ cwd }) => codexUsage({ executable: machine.tools.codex.executable, cwd })
      : usage
    const refused = await checkUsage({ read: readChosen, cwd: repoDir, limits: machine.usageLimits.reviewer })
    if (refused) return refused

    await git(repoDir, ['worktree', 'add', '--detach', tree, pr.headSha])
    worktreeAdded = true
    await assertReviewableCheckout(tree, pr.headSha, repoDir)

    // The session's environment carries no GitHub credential: the reviewer
    // posts nothing (reviewer.md). `coderEnv` is what strips them.
    const ghConfigDir = path.join(scratch, 'gh-config')
    await mkdir(ghConfigDir)
    const sessionEnv = coderEnv(baseEnv, ghConfigDir)

    const reviewerInputs = {
      promptTemplate: template,
      unit,
      branch: pr.headRef,
      pr: { number, headSha: pr.headSha, body: pr.body },
      rules: rules.text,
    }
    let attempt = 0
    const runSession = () => {
      attempt += 1
      if (!codex) {
        return spawnSession({
          ...sessionOptions, ...reviewerInputs, role: 'reviewer', baseEnv: sessionEnv,
          model: choice.model, effort: choice.effort, cwd: tree,
        })
      }
      // ST-32/AC-2: the same prompt, through `codex exec -s read-only`, its last
      // message written in the scratch directory, outside the checkout.
      const { timeoutMs, stallMs } = sessionOptions
      return codexSession({
        executable: machine.tools.codex.executable, cwd: tree, model: choice.model, effort: choice.effort,
        prompt: renderReviewerPrompt(reviewerInputs), env: sessionEnv,
        outputFile: path.join(scratch, `codex-last-message-${attempt}.txt`),
        ...(timeoutMs !== undefined && { timeoutMs }), ...(stallMs !== undefined && { stallMs }),
      })
    }

    let sessions = 1
    let { classification, output } = await runSession()
    if (classification.outcome !== 'completed') {
      return { status: 'session-failed', outcome: classification.outcome, reason: classification.reason, sessions }
    }

    let parsed = parseReviewerVerdict(output.result, rules)
    if (!parsed.ok) {
      // OQ-121: one malformed verdict does not stop the story; try once more,
      // in the same checkout, unless the first session left it changed.
      const firstReason = parsed.reason
      try {
        await assertReviewableCheckout(tree, pr.headSha, repoDir)
      } catch (error) {
        keepCheckout = true
        return {
          status: 'malformed-verdict',
          reason: `first session: ${firstReason}; no second session: the checkout was changed (${error.message})`,
          sessions,
        }
      }
      sessions = 2
      ;({ classification, output } = await runSession())
      if (classification.outcome !== 'completed') {
        return { status: 'session-failed', outcome: classification.outcome, reason: classification.reason, sessions }
      }
      parsed = parseReviewerVerdict(output.result, rules)
      if (!parsed.ok) {
        return { status: 'malformed-verdict', reason: `first session: ${firstReason}; second session: ${parsed.reason}`, sessions }
      }
    }
    const { verdict } = parsed

    // A `null` verdict is the reviewer declining to review; nothing is posted and the PR stays
    // pending. Only a head that moved is an ordinary reason (`reviewer.md`), so the head is read
    // again: moved is `no-verdict`; unchanged is something about the machine or the prompt, and
    // is `cannot-review`, a failure (ST-37/AC-1).
    if (verdict.verdict === null) {
      const now = await getPullRequestState(ctx, number)
      const status = now.headSha === pr.headSha ? 'cannot-review' : 'no-verdict'
      return { status, headSha: verdict.head, summary: verdict.summary, sessions }
    }

    // The checkout it was handed was at `pr.headSha`; a verdict about another
    // commit was not made from what it read.
    if (verdict.head !== pr.headSha) {
      return { status: 'head-moved', reason: `the reviewer reported ${verdict.head}, having been handed ${pr.headSha}`, sessions }
    }
    const current = await getPullRequestState(ctx, number)
    if (verdict.head !== current.headSha) {
      return {
        status: 'head-moved',
        reason: `the pull request moved to ${current.headSha} during the review of ${verdict.head}`,
        sessions,
      }
    }
    const raced = await verdictAt(ctx, number, verdict.head)
    // Under a re-review the block being overridden is expected to be there; a
    // different governing marker is one that arrived during the review.
    if (raced && !(rereview && raced.commentId === existing.commentId)) {
      return { status: 'already-reviewed', headSha: verdict.head, existing: raced, sessions }
    }

    let body
    try {
      body = composeMarkerComment({ headSha: verdict.head, verdict: verdict.verdict, findings: formatFindings(verdict) })
    } catch (error) {
      return { status: 'unrecordable', reason: error.message, sessions }
    }
    const { id } = await postComment(ctx, number, body)
    return { status: 'recorded', headSha: verdict.head, verdict: verdict.verdict, commentId: id, sessions }
  } finally {
    if (!keepCheckout) {
      if (worktreeAdded) await git(repoDir, ['worktree', 'remove', '--force', tree]).catch(() => {})
      await rm(scratch, { recursive: true, force: true })
    }
  }
}

// The gate reads the marker, so an existing verdict is a well-formed marker at
// this head in a comment whose author the gate honours. Malformed marker-like
// text is not a verdict. The latest such comment governs, as the gate applies
// each in turn.
async function verdictAt(ctx, number, headSha) {
  const comments = await listPullRequestComments(ctx, number)
  const found = comments.findLast((c) =>
    c.marker.kind === 'marker' && c.marker.headSha === headSha && HONOURED_ASSOCIATIONS.includes(c.authorAssociation))
  return found ? { commentId: found.id, author: found.author, verdict: found.marker.verdict } : null
}

// --------------------------------------------------------------------- CLI

export const NON_FAILURES = ['recorded', 'no-verdict', 'already-reviewed']

async function main(argv) {
  const args = [...argv]
  const repoAt = args.indexOf('--repo')
  const repo = repoAt === -1 ? (await readSettings(process.cwd())).repo : args.splice(repoAt, 2)[1]
  const rereviewAt = args.indexOf('--rereview')
  const rereview = rereviewAt !== -1
  if (rereview) args.splice(rereviewAt, 1)
  const number = Number(args[0])
  if (args.length !== 1 || !Number.isInteger(number) || number <= 0) {
    throw new Error('usage: node scripts/dispatch/review.mjs <pr-number> [--repo owner/name] [--rereview]')
  }
  const result = await reviewPullRequest({ number, ctx: createContext({ repo }), rereview })
  console.log(JSON.stringify(result, null, 2))
  if (!NON_FAILURES.includes(result.status)) process.exitCode = 1
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
