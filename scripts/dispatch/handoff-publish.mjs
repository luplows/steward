/**
 * Publishes the result of executing an approved handoff (`executeHandoff`, `handoff-coder.mjs`,
 * ST-91) as a pull request that `review.mjs` reads like any other (ST-92). The design is
 * `docs/agent-workflow-design.md`, "Approved coding handoffs and sequential execution".
 *
 * `publishHandoff` is called with the `pushed` result of `executeHandoff`. It runs no model, makes
 * no claim and pushes nothing, writes no handoff record and no admission (the coordinator does,
 * `handoff-coding.mjs`, ST-93), and opens at most one pull request. The coordinator calls it, once,
 * for each `pushed` result. Whatever `pushed` it is given, it resolves a result and never throws.
 *
 * It trusts one thing from the coding run: the branch and head SHA ST-91 pushed. In order, it
 *
 *   1. checks the result is a pushed one, that the handoff record exists for the project and
 *      version the result names, that the branch is the one `handoffBranch` gives it, that the
 *      model the session ran can be written as one `Coder:` token (`coderModelToken`, AC-6) and
 *      that the coder's proposed title, body and draft flag are well formed, and that its body
 *      has no `Unit:` line and no closing reference to an Issue (AC-3, below);
 *   2. checks that the remote branch's tip is still the head SHA (AC-1);
 *   3. reads the unit's source once more, with `assess` (`handoff.mjs`), to see whether it still
 *      has the approved text (AC-5). `assess` brings the owned checkout to `origin`'s `main`;
 *   4. reads the project's `unitLinks` from that refreshed checkout, and refuses when they no
 *      longer include the handoff's kind (AC-2). This one read decides, so a kind `assess` could
 *      not read for that reason is a refusal here, never a draft; and
 *   5. writes the body and opens the pull request against `main` (AC-1, AC-2, AC-3, AC-4, AC-6).
 *
 * The comparison in step 3 is made once, as late as the sequence allows. Nothing watches the source
 * while the coder works: a source that changed then and still differs is found by the comparison
 * and gives a draft, and one that changed after the comparison is not detected. When the source is
 * unchanged the pull request is opened as the coder asked, ready or draft. When it changed or could
 * not be read, it is opened as a draft, with a "Handoff discrepancy" section in its body, and the
 * result carries `discrepancy: { kind: 'changed' | 'unreadable', reason }` for the crew.
 *
 * The body is ATC's frame around the coder's text. In order: the one `Unit:` line, naming the
 * original file path on `main` or `#<number>`; for an Issue handoff, one `Closes #<number>`; the
 * coder's body, unchanged except for its outer blank space, its line endings (written as `\n`)
 * and that every `Coder:` line is removed (the coder's own is never trusted); the "Handoff
 * provenance" section; the "Handoff discrepancy" section when there is one; and a last
 * line `Coder: model=<id>`. A coder body that has a line starting `Unit:`, or any
 * closing keyword followed by an issue reference (GitHub's keywords, with `#n`, `owner/name#n`,
 * `GH-n` or an issue URL, anywhere in the text, a quoted command included), is refused as
 * `coder-link-conflict`, naming the lines found, and nothing of the coder's text is rewritten.
 * No attribution is added and none the coder wrote is removed (ST-99).
 * Before it is sent, the body is read with `findUnitLink` under the project's current
 * `unitLinks`, and sent only when that finds the one intended unit and the body has the closing
 * references intended, none for a file and one for an Issue.
 *
 * A result is `{ status, repo, handoffId, version, branch, headSha, ... }`. `status` is
 * `published` (with `pr` as `createPullRequest` returns it, `draft`, `discrepancy` or `null`,
 * `coder` as `{ tool, choice, model }` and `unit`, the `Unit:` text written), or one of
 * `PUBLISH_FAILURES`. A failure has `recoverable: true` and a `reason`: the branch is left on the
 * remote as it is, nothing is re-executed, and the coordinator records the handoff as stopped, for
 * the crew to decide what to do (`handoff-coding.mjs`, ST-93). A moved head also carries
 * `remoteHead` (the tip found, or `null` when the branch is gone).
 */
import { homedir as osHomedir } from 'node:os'
import { coderModelToken, withCoderLine } from './choices.mjs'
import { remoteTip } from './coder.mjs'
import { createContext, createPullRequest } from './github.mjs'
import { PUSHED, handoffBranch } from './handoff-coder.mjs'
import { assess, describeSource, handoffsPath, readHandoffs } from './handoff.mjs'
import { ownedCheckoutPath } from './project.mjs'
import { readSettings } from './settings.mjs'
import { findUnitLink } from './unit.mjs'

/** Every failing `status` of `publishHandoff`. */
export const PUBLISH_FAILURES = [
  'not-a-pushed-result', 'handoff-mismatch', 'records-unreadable', 'bad-model-id', 'pr-invalid', 'coder-link-conflict',
  'head-moved', 'head-unverified', 'unit-link-refused', 'unit-link-ambiguous', 'publish-failed',
]

const SHA_RE = /^[0-9a-f]{40}$/
const BASE = 'main'

const UNIT_LINE_RE = /^ *Unit:/
// GitHub's closing keywords followed, with an optional colon, by an issue reference. A superset of
// `findUnitLink`'s own pattern (`unit.mjs`), so that a reference it would not see is found too,
// one after a hyphen or a slash included.
const CLOSING_REFERENCE_RE =
  /(?<!\w)(close[sd]?|fix(?:es|ed)?|resolve[sd]?)(?=[ \t]*:?[ \t]+(?:(?:[\w.-]+\/[\w.-]+)?#[0-9]+|GH-[0-9]+|https?:\/\/\S*\/issues\/[0-9]+))/gi

const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim()

/**
 * `text` with each closing keyword that precedes an issue reference changed to `Refs`. Used on
 * ATC's own discrepancy reason, which may carry text from GitHub or git, never on the coder's.
 * Pure.
 */
export function neutralizeClosing(text) {
  return text.replace(CLOSING_REFERENCE_RE, 'Refs')
}

/** How many closing references `text` has, as `neutralizeClosing` would find them. Pure. */
const closingCount = (body) => [...body.matchAll(CLOSING_REFERENCE_RE)].length

/**
 * The lines of the coder's `body` that would give the pull request a unit or a closing reference
 * of the coder's choosing (AC-3): each line starting `Unit:` and each line with a closing keyword
 * before an issue reference, trimmed and cut at 100 characters. Empty when there are none. Pure.
 */
export function coderLinkLines(body) {
  return body.split(/\r?\n/)
    .filter((line) => UNIT_LINE_RE.test(line) || closingCount(line) > 0)
    .map((line) => (line.trim().length > 100 ? `${line.trim().slice(0, 100)}...` : line.trim()))
}

/** The `Unit:` text of `handoff`: the original path on `main`, or `#<number>`. */
const unitText = (handoff) => (handoff.source.kind === 'file' ? handoff.source.path : `#${handoff.source.number}`)

/** The "Handoff provenance" section: what a reader needs to find the approval, in plain words. */
function provenanceSection(handoff, coder) {
  const approved = handoff.source.kind === 'file'
    ? `${describeSource(handoff.source)}, approved as it stood at \`main\` ${handoff.provenance.commit}`
    : `${describeSource(handoff.source)}, approved with the title and body fingerprint (sha256) ${handoff.provenance.fingerprint}`
  return [
    '## Handoff provenance',
    '',
    `- Handoff: ${handoff.id}, approved revision ${handoff.version}.`,
    `- Source: ${approved}.`,
    `- Ran as: tool ${coder.tool}, choice ${JSON.stringify(coder.choice)}, model ${coder.model}.`,
    '',
    `The approved revision is provenance, not the reviewer's source of truth: the reviewer reads the`,
    `unit as it stands now on \`main\`. The approved text and the handoff's version history are in`,
    `\`steward handoff show ${handoff.id}\` on the machine that approved it.`,
  ].join('\n')
}

/** The "Handoff discrepancy" section of a draft opened because the source changed or was unreadable. */
function discrepancySection(handoff, discrepancy) {
  return [
    '## Handoff discrepancy',
    '',
    discrepancy.kind === 'changed'
      ? `The source of ${handoff.id} no longer has the text approved as version ${handoff.version}, so this pull request is a draft.`
      : `The source of ${handoff.id} could not be compared with the text approved as version ${handoff.version}, so this pull request is a draft.`,
    '',
    `Reason: ${neutralizeClosing(oneLine(discrepancy.reason))}`,
    '',
    'The crew decides what to do: the work is the approved revision, and the reviewer verifies it against the unit as it stands now.',
  ].join('\n')
}

/**
 * The pull request body, in the order the module's header gives. `discrepancy` is `null` or the
 * comparison's. Pure.
 */
export function composeHandoffBody({ handoff, proposedPr, coder, discrepancy, token }) {
  const head = [`Unit: ${unitText(handoff)}`, ...(handoff.source.kind === 'issue' ? [`Closes #${handoff.source.number}`] : [])].join('\n')
  const parts = [head, proposedPr.body.trim(), provenanceSection(handoff, coder)]
  if (discrepancy !== null) parts.push(discrepancySection(handoff, discrepancy))
  return withCoderLine(parts.filter((part) => part !== '').join('\n\n'), [token])
}

/**
 * Publishes the coding result `pushed`, per the module's header.
 *
 *   pushed       the `pushed` result of `executeHandoff`
 *   homedir      where `~/.steward/` is; the records and the owned checkout are under it
 *   now, createContext   as for `executeHandoff`: the clock, and the GitHub context an Issue is read
 *                and the pull request opened through (a stand-in in tests)
 *   remoteTip    `(repoDir, branch)`, the branch's tip on the remote or `null`; for tests
 *   assess       `(handoff, ctx)`, as `assess` of `handoff.mjs`, the comparison of step 3; for tests
 */
export async function publishHandoff({
  pushed, homedir = osHomedir(), now = () => new Date(), createContext: makeContext = createContext,
  remoteTip: readRemoteTip = remoteTip, assess: assessSource = assess,
}) {
  const base = {
    repo: pushed?.repo ?? null, handoffId: pushed?.handoffId ?? null, version: pushed?.version ?? null,
    branch: pushed?.branch ?? null, headSha: pushed?.headSha ?? null,
  }
  const fail = (status, reason, extra = {}) => ({ status, ...base, recoverable: true, reason, ...extra })

  try {
    // 1. The result, the record, the model and the coder's text.
    const { choice, proposedPr } = pushed ?? {}
    if (pushed?.status !== PUSHED || typeof pushed.branch !== 'string' || !SHA_RE.test(pushed.headSha ?? '')) {
      return fail('not-a-pushed-result', 'publication takes the pushed result of executeHandoff, with its branch and full head SHA')
    }
    let handoffs
    try {
      ;({ handoffs } = readHandoffs(handoffsPath(homedir)))
    } catch (error) {
      return fail('records-unreadable', error.message)
    }
    const handoff = handoffs.find((h) => h.id === pushed.handoffId)
    if (handoff === undefined || handoff.repo !== pushed.repo || handoff.version !== pushed.version || handoffBranch(handoff) !== pushed.branch) {
      return fail('handoff-mismatch', `${pushed.handoffId} is not an approved handoff of ${pushed.repo} at version ${pushed.version} worked on ${pushed.branch}`)
    }
    const token = coderModelToken(choice?.model)
    if (token === null || typeof choice.tool !== 'string' || typeof choice.name !== 'string') {
      return fail('bad-model-id', `the model ${JSON.stringify(choice?.model)} cannot be written as one unambiguous \`Coder:\` token, so the pull request is not opened`)
    }
    if (typeof proposedPr?.title !== 'string' || oneLine(proposedPr.title) === '' || typeof proposedPr.body !== 'string'
      || proposedPr.body.trim() === '' || typeof proposedPr.draft !== 'boolean') {
      return fail('pr-invalid', 'the coder\'s proposed pull request has no title or no body, or its draft flag is not true or false')
    }
    const conflicts = coderLinkLines(proposedPr.body)
    if (conflicts.length > 0) {
      return fail('coder-link-conflict', `the coder's body has ${conflicts.length} line(s) that name a unit or close an Issue, which only ATC writes: ${conflicts.map((l) => JSON.stringify(l)).join('; ')}`, { conflicts })
    }

    // 2. AC-1: the remote branch is the one ST-91 pushed.
    const repoDir = ownedCheckoutPath(homedir, handoff.repo)
    let remote
    try {
      remote = await readRemoteTip(repoDir, pushed.branch)
    } catch (error) {
      return fail('head-unverified', `the remote's branches cannot be listed: ${String(error.stderr ?? '').trim() || error.message}`)
    }
    if (remote !== pushed.headSha) {
      return fail('head-moved', `${pushed.branch} on the remote is ${remote ?? 'gone'}, not the ${pushed.headSha} that was pushed; the existing branch is left as it is`, { remoteHead: remote ?? null })
    }

    // 3. AC-5: one comparison, immediately before the pull request is made. It brings the owned
    // checkout to `origin`'s `main`.
    let discrepancy = null
    try {
      const verdict = await assessSource(handoff, { homedir, now, createContext: makeContext })
      if (!verdict.eligible) discrepancy = { kind: verdict.changed ? 'changed' : 'unreadable', reason: verdict.reason }
    } catch (error) {
      discrepancy = { kind: 'unreadable', reason: error.message }
    }

    // 4. AC-2: the one read of the settings, from the checkout step 3 refreshed, decides whether
    // the project still takes this kind of unit.
    let unitLinks
    try {
      ;({ unitLinks } = await readSettings(repoDir))
    } catch (error) {
      return fail('unit-link-refused', `the project's current settings cannot be read: ${error.message}`)
    }
    if (!unitLinks.includes(handoff.source.kind)) {
      return fail('unit-link-refused', `${handoff.repo}'s unitLinks, ${JSON.stringify(unitLinks)}, no longer include "${handoff.source.kind}"`)
    }

    // 5. AC-2, AC-3, AC-4, AC-6: the body, checked as the reviewer will read it.
    const coder = { tool: choice.tool, choice: choice.name, model: choice.model }
    const body = composeHandoffBody({ handoff, proposedPr, coder, discrepancy, token })
    const found = findUnitLink(body, unitLinks)
    const wanted = handoff.source.kind === 'file' ? { type: 'file', target: handoff.source.path } : { type: 'issue', target: handoff.source.number }
    const closing = handoff.source.kind === 'issue' ? 1 : 0
    if (found.kind !== 'link' || found.unread === true || found.type !== wanted.type || found.target !== wanted.target || closingCount(body) !== closing) {
      return fail('unit-link-ambiguous', `the body would not name exactly ${unitText(handoff)} as its unit under unitLinks ${JSON.stringify(unitLinks)}: ${JSON.stringify(found)}`)
    }
    const draft = proposedPr.draft || discrepancy !== null
    let pr
    try {
      pr = await createPullRequest(makeContext({ repo: handoff.repo }), { title: oneLine(proposedPr.title), body, head: pushed.branch, base: BASE, draft })
    } catch (error) {
      return fail('publish-failed', `GitHub did not open the pull request: ${error.message}`)
    }
    return { status: 'published', ...base, pr, draft, discrepancy, coder, unit: unitText(handoff) }
  } catch (error) {
    return fail('publish-failed', error.message)
  }
}
