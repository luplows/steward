#!/usr/bin/env node
/**
 * Reviews one open pull request end to end and records the verdict (OQ-69):
 * resolve the head, check out that exact commit somewhere that is not the
 * coder's tree, work out which story the PR implements, spawn the reviewer,
 * parse what it returns, and post the verdict as a marker comment.
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
 * A review that cannot be recorded is not an error: a `null` verdict, a
 * moved head, an unresolvable story all leave the PR pending, which
 * `REVIEW.md` ("When the reviewer returns no verdict") says is the right
 * outcome. Each is a distinct `status` on the result.
 *
 * Usage:
 *   node scripts/dispatch/review.mjs <pr-number> [--repo owner/name]
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { coderEnv } from './coder-env.mjs'
import {
  composeMarkerComment,
  createContext,
  getPullRequestState,
  listPullRequestComments,
  postComment,
  WRITABLE_VERDICTS,
} from './github.mjs'
import { ROLE_DEFAULTS } from './invocation.mjs'
import { parseFrontmatter, STORY_FILENAME_RE } from './queue.mjs'
import { spawnSession } from './spawn.mjs'

const execFileAsync = promisify(execFile)

const DISPATCH_DIR = path.dirname(fileURLToPath(import.meta.url))
const DISPATCHER_ROOT = path.resolve(DISPATCH_DIR, '..', '..')
const REVIEWER_PROMPT = path.join(DISPATCHER_ROOT, '.claude', 'prompts', 'reviewer.md')

const DEFAULT_REPO = 'luplows/tower-workshop-paths'
const REMOTE = 'origin'
const SHA_RE = /^[0-9a-f]{40}$/

// reviewer.md, "For a PR that implements no story".
const NO_STORY_TEXT = '*(none — this PR implements no story; items 16–19 do not apply.)*'

// ------------------------------------------------------------------- story

/**
 * Decides which story a pull request implements from the name-status lines of
 * its diff (`git diff --name-status --no-renames`) and its head branch name.
 *
 * The source is the story file the diff moves into `stories/done/` (`REVIEW.md`
 * item 19), which a conforming PR always has and which works for a PR this
 * dispatcher did not open. With `--no-renames` a move is a deletion under
 * `stories/` plus an addition under `stories/done/` of the same file name, so it
 * does not depend on git's similarity guess.
 *
 * The branch name is only a fallback for *diagnosis*: a branch that names a
 * story the diff does not move is a coder that forgot item 19, reported as
 * `branch-only` rather than reviewed against a story the diff never touched.
 *
 * Returns `{ kind: 'moved', file, id }`, `{ kind: 'ambiguous', files }`,
 * `{ kind: 'branch-only', id }` or `{ kind: 'none' }`.
 */
export function resolveStory({ nameStatus, branch }) {
  const deleted = new Set()
  const added = []
  for (const line of nameStatus.split(/\r?\n/)) {
    const [status, file] = line.split('\t')
    if (!file) continue
    const open = file.match(/^stories\/([^/]+)$/)
    const done = file.match(/^stories\/done\/([^/]+)$/)
    if (status === 'D' && open && STORY_FILENAME_RE.test(open[1])) deleted.add(open[1])
    if (status === 'A' && done && STORY_FILENAME_RE.test(done[1])) added.push(done[1])
  }
  const moved = added.filter((name) => deleted.has(name))
  if (moved.length === 1) return { kind: 'moved', file: moved[0], id: moved[0].match(/^(OQ-\d+)-/)[1] }
  if (moved.length > 1) return { kind: 'ambiguous', files: moved }
  const named = /^story\/(OQ-\d+)-/.exec(branch ?? '')
  return named ? { kind: 'branch-only', id: named[1] } : { kind: 'none' }
}

// ------------------------------------------------------------------- model

// A different family from the coder's is the point (reviewer.md: context
// isolation decorrelates knowledge, not reasoning style).
const REVIEWER_MODEL_FALLBACK = 'sonnet'

function sameModel(a, b) {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()]
  return x.includes(y) || y.includes(x)
}

/** The reviewer's model: the role default unless that is the story's own. */
export function chooseReviewerModel(storyModel) {
  const preferred = ROLE_DEFAULTS.reviewer.model
  if (typeof storyModel !== 'string' || storyModel === '') return preferred
  const chosen = sameModel(preferred, storyModel) ? REVIEWER_MODEL_FALLBACK : preferred
  if (sameModel(chosen, storyModel)) throw new Error(`no reviewer model differs from the story's ${storyModel}`)
  return chosen
}

// ----------------------------------------------------------------- verdict

/**
 * Reads the JSON object reviewer.md says is the last thing the reviewer prints,
 * tolerating a code fence around it. Returns `{ ok: true, verdict }` or
 * `{ ok: false, reason }`; never guesses a verdict from prose.
 */
export function parseReviewerVerdict(text) {
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

  const { head, verdict, findings, summary } = parsed
  if (typeof head !== 'string' || !SHA_RE.test(head)) return { ok: false, reason: '`head` is not a full 40-character SHA' }
  if (verdict !== null && !WRITABLE_VERDICTS.includes(verdict)) {
    return { ok: false, reason: `\`verdict\` is not one of ${WRITABLE_VERDICTS.join(', ')} or null` }
  }
  if (!Array.isArray(findings)) return { ok: false, reason: '`findings` is not an array' }
  for (const finding of findings) {
    const valid = finding !== null && typeof finding === 'object' &&
      Number.isInteger(finding.item) && ['block', 'observation'].includes(finding.severity) &&
      typeof finding.text === 'string'
    if (!valid) return { ok: false, reason: 'a finding lacks an integer `item`, a `severity` or `text`' }
  }
  if (typeof summary !== 'string') return { ok: false, reason: '`summary` is not a string' }
  if (verdict !== 'block' && findings.some((f) => f.severity === 'block')) {
    return { ok: false, reason: `a finding has severity block but the verdict is ${verdict}` }
  }
  return { ok: true, verdict: { head, verdict, findings, summary } }
}

/** The comment text that precedes the marker: what the reviewer found, by item. */
export function formatFindings({ verdict, findings, summary }) {
  const lines = [`**Review verdict: ${verdict}**`, '', summary.trim()]
  if (findings.length > 0) {
    lines.push('')
    for (const { item, severity, text } of findings) lines.push(`- **Item ${item}** (${severity}): ${text.trim()}`)
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
 *   repoDir        the dispatcher's own checkout, whose object store the
 *                  review checkout is made from; defaults to this file's repo
 *   promptTemplate reviewer.md's text; defaults to the copy beside this file
 *   baseEnv        the environment to derive the session's from; defaults to
 *                  `process.env`, with every GitHub credential removed
 *   sessionOptions extra `spawnSession` options (executable, run, timeouts,
 *                  budget)
 *
 * Resolves `{ status, ... }`. `recorded` carries the comment id; every other
 * status means nothing was posted, and `reason` says why. `no-verdict` and
 * `already-reviewed` are not failures.
 */
export async function reviewPullRequest({
  number, ctx, repoDir = DISPATCHER_ROOT, promptTemplate, baseEnv = process.env, sessionOptions = {},
}) {
  const template = promptTemplate ?? readFileSync(REVIEWER_PROMPT, 'utf8')
  const pr = await getPullRequestState(ctx, number)
  if (!SHA_RE.test(pr.headSha) || !pr.headRef || !pr.baseRef) {
    throw new Error(`pull request #${number} did not resolve a head SHA, head branch and base branch`)
  }

  const existing = await verdictAt(ctx, number, pr.headSha)
  if (existing) return { status: 'already-reviewed', headSha: pr.headSha, existing }

  const scratch = await mkdtemp(path.join(tmpdir(), 'tw-review-'))
  const tree = path.join(scratch, 'tree')
  let worktreeAdded = false
  try {
    await git(repoDir, ['fetch', REMOTE, pr.headRef, pr.baseRef])
    const fetchedTip = (await git(repoDir, ['rev-parse', `${REMOTE}/${pr.headRef}`])).trim()
    if (fetchedTip !== pr.headSha) {
      return { status: 'head-moved', reason: `${pr.headRef} is at ${fetchedTip}, not the ${pr.headSha} the API reported` }
    }
    await git(repoDir, ['worktree', 'add', '--detach', tree, pr.headSha])
    worktreeAdded = true
    await assertReviewableCheckout(tree, pr.headSha, repoDir)

    const nameStatus = await git(repoDir, [
      'diff', '--name-status', '--no-renames', `${REMOTE}/${pr.baseRef}...${pr.headSha}`,
    ])
    const resolved = resolveStory({ nameStatus, branch: pr.headRef })
    if (resolved.kind === 'branch-only') {
      return {
        status: 'story-not-moved',
        reason: `branch ${pr.headRef} names ${resolved.id}, but the diff moves no story file into stories/done/ ` +
          '(REVIEW.md item 19); not reviewing against a story the diff never touched',
      }
    }
    if (resolved.kind === 'ambiguous') {
      return { status: 'story-ambiguous', reason: `the diff moves more than one story: ${resolved.files.join(', ')}` }
    }

    let story
    if (resolved.kind === 'moved') {
      const storyPath = `stories/done/${resolved.file}`
      const text = readFileSync(path.join(tree, storyPath), 'utf8')
      try {
        const { data } = parseFrontmatter(text, storyPath)
        story = { id: resolved.id, path: storyPath, text, model: data.model ?? null }
      } catch (error) {
        return { status: 'story-unreadable', reason: error.message }
      }
    } else {
      story = { id: 'n/a', path: 'n/a', text: NO_STORY_TEXT, model: null }
    }

    // The session's environment carries no GitHub credential: the reviewer
    // posts nothing (reviewer.md). `coderEnv` is what strips them.
    const ghConfigDir = path.join(scratch, 'gh-config')
    await mkdir(ghConfigDir)
    const { classification, output } = await spawnSession({
      ...sessionOptions,
      role: 'reviewer',
      promptTemplate: template,
      story,
      branch: pr.headRef,
      pr: { number, headSha: pr.headSha, body: pr.body },
      baseEnv: coderEnv(baseEnv, ghConfigDir),
      model: chooseReviewerModel(story.model),
      cwd: tree,
    })
    if (classification.outcome !== 'completed') {
      return { status: 'session-failed', outcome: classification.outcome, reason: classification.reason }
    }

    const parsed = parseReviewerVerdict(output.result)
    if (!parsed.ok) return { status: 'malformed-verdict', reason: parsed.reason }
    const { verdict } = parsed

    // A `null` verdict is the reviewer declining to review; the PR stays pending.
    if (verdict.verdict === null) return { status: 'no-verdict', headSha: verdict.head, summary: verdict.summary }

    // The checkout it was handed was at `pr.headSha`; a verdict about another
    // commit was not made from what it read.
    if (verdict.head !== pr.headSha) {
      return { status: 'head-moved', reason: `the reviewer reported ${verdict.head}, having been handed ${pr.headSha}` }
    }
    const current = await getPullRequestState(ctx, number)
    if (verdict.head !== current.headSha) {
      return { status: 'head-moved', reason: `the pull request moved to ${current.headSha} during the review of ${verdict.head}` }
    }
    const raced = await verdictAt(ctx, number, verdict.head)
    if (raced) return { status: 'already-reviewed', headSha: verdict.head, existing: raced }

    let body
    try {
      body = composeMarkerComment({ headSha: verdict.head, verdict: verdict.verdict, findings: formatFindings(verdict) })
    } catch (error) {
      return { status: 'unrecordable', reason: error.message }
    }
    const { id } = await postComment(ctx, number, body)
    return { status: 'recorded', headSha: verdict.head, verdict: verdict.verdict, commentId: id }
  } finally {
    if (worktreeAdded) await git(repoDir, ['worktree', 'remove', '--force', tree]).catch(() => {})
    await rm(scratch, { recursive: true, force: true })
  }
}

// The gate reads the marker, so an existing verdict is a well-formed marker at
// this head in any comment. Malformed marker-like text is not a verdict.
async function verdictAt(ctx, number, headSha) {
  const comments = await listPullRequestComments(ctx, number)
  const found = comments.find((c) => c.marker.kind === 'marker' && c.marker.headSha === headSha)
  return found ? { commentId: found.id, author: found.author, verdict: found.marker.verdict } : null
}

// --------------------------------------------------------------------- CLI

const NON_FAILURES = ['recorded', 'no-verdict', 'already-reviewed']

async function main(argv) {
  const args = [...argv]
  const repoAt = args.indexOf('--repo')
  const repo = repoAt === -1 ? DEFAULT_REPO : args.splice(repoAt, 2)[1]
  const number = Number(args[0])
  if (args.length !== 1 || !Number.isInteger(number) || number <= 0) {
    throw new Error('usage: node scripts/dispatch/review.mjs <pr-number> [--repo owner/name]')
  }
  const result = await reviewPullRequest({ number, ctx: createContext({ repo }) })
  console.log(JSON.stringify(result, null, 2))
  if (!NON_FAILURES.includes(result.status)) process.exitCode = 1
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
