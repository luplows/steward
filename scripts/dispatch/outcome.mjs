/**
 * Turns the raw record of a finished coder or reviewer session into one
 * classification. Pure: it starts no process, builds no invocation and
 * performs no GitHub operation. See stories/done/OQ-75-*.md for the
 * acceptance criteria this implements.
 *
 * The raw record is produced by the code that runs the session (OQ-65); its
 * shape is defined here, by RAW_RECORD_FIELDS and validateRawRecord.
 *
 * A non-`completed` outcome says only that the session did not report
 * completion. It says nothing about whether the branch was pushed or a pull
 * request opened: a session that hit its limit after opening its PR is
 * `died`, and the caller has to look at the repository to know the rest.
 * Nothing is `completed` by default -- only a session that positively
 * reports success is.
 */

export const OUTCOMES = [
  'completed',
  'budget-exhausted',
  'timed-out',
  'stalled',
  'died',
  'malformed-output',
]

export const ROLES = ['coder', 'reviewer']

export const STOPPED_FOR = [null, 'timeout', 'stall']

/**
 * The raw record of a finished session:
 *   role       'coder' | 'reviewer'
 *   exitCode   integer | null   (null when the process was killed by a signal)
 *   signal     string | null
 *   stdout     string           (captured `--output-format json` output)
 *   stoppedFor null | 'timeout' | 'stall'
 *              set by the runner when it stopped the session for exceeding
 *              its time limit, or for producing no output for the configured
 *              interval
 */
export const RAW_RECORD_FIELDS = ['role', 'exitCode', 'signal', 'stdout', 'stoppedFor']

// The `subtype` the claude CLI's JSON result carries when --max-budget-usd
// stopped the session.
const BUDGET_SUBTYPE = 'error_max_budget_usd'
const SUCCESS_SUBTYPE = 'success'
// The only stop_reason that means the model finished of its own accord.
const NORMAL_STOP_REASON = 'end_turn'

/** Throws, naming the problem, when `record` is not a well-formed raw record. */
export function validateRawRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('raw session record must be an object')
  }
  if (!ROLES.includes(record.role)) {
    throw new Error(`raw session record: role must be one of ${ROLES.join(', ')}`)
  }
  if (record.exitCode !== null && !Number.isInteger(record.exitCode)) {
    throw new Error('raw session record: exitCode must be an integer or null')
  }
  if (record.signal !== null && typeof record.signal !== 'string') {
    throw new Error('raw session record: signal must be a string or null')
  }
  if (typeof record.stdout !== 'string') {
    throw new Error('raw session record: stdout must be a string')
  }
  if (!STOPPED_FOR.includes(record.stoppedFor)) {
    throw new Error("raw session record: stoppedFor must be null, 'timeout' or 'stall'")
  }
}

function parseEnvelope(stdout) {
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
}

/**
 * Parses the closing block that coder.md pins as the last thing in a coder's
 * report:
 *
 *   ## PR title
 *   <one line>
 *   ## PR body
 *   <the filled template>
 *   ## Open as
 *   draft            (or ready; nothing may follow)
 *
 * Returns `{ status: 'parsed', title, body, draft }` or
 * `{ status: 'absent' | 'malformed', reason }`. Never invents a body.
 *
 * The last `## PR title` opens the block, so a report that quotes the
 * headings earlier still parses. After `## Open as` there must be exactly
 * one non-empty line, `draft` or `ready` (backticks, asterisks or
 * underscores around it are tolerated, nothing else is). Anything after it,
 * such as a head-SHA line, makes the block malformed: coder.md puts that
 * above the block, and guessing which trailing prose is harmless is exactly
 * what this module must not do.
 */
export function parsePrBlock(text) {
  if (typeof text !== 'string') return { status: 'absent', reason: 'no report text' }

  const lines = text.split(/\r?\n/)
  const titleAt = lines.findLastIndex((line) => /^##\s+PR title\s*$/i.test(line))
  if (titleAt === -1) return { status: 'absent', reason: 'no "## PR title" heading' }

  const bodyAt = lines.findIndex((line, i) => i > titleAt && /^##\s+PR body\s*$/i.test(line))
  if (bodyAt === -1) {
    return { status: 'malformed', reason: '"## PR title" without a following "## PR body"' }
  }

  const openAt = lines.findLastIndex((line, i) => i > bodyAt && /^##\s+Open as\s*$/i.test(line))
  if (openAt === -1) {
    return { status: 'malformed', reason: '"## PR body" without a following "## Open as"' }
  }

  const after = lines.slice(openAt + 1).map((line) => line.trim()).filter((line) => line !== '')
  if (after.length !== 1) {
    return {
      status: 'malformed',
      reason: after.length === 0
        ? '"## Open as" is empty'
        : '"## Open as" must be followed by one line, "draft" or "ready", and nothing else',
    }
  }
  const marker = after[0].match(/^[`*_]*(draft|ready)[`*_]*$/i)
  if (!marker) return { status: 'malformed', reason: '"## Open as" is not "draft" or "ready"' }

  const title = lines.slice(titleAt + 1, bodyAt).join('\n').trim()
  const body = lines.slice(bodyAt + 1, openAt).join('\n').trim()
  if (title === '') return { status: 'malformed', reason: '"## PR title" is empty' }
  if (body === '') return { status: 'malformed', reason: '"## PR body" is empty' }

  return { status: 'parsed', title, body, draft: marker[1].toLowerCase() === 'draft' }
}

/**
 * Classifies a finished session from its raw record.
 *
 * Returns `{ outcome, reason, envelope, prText? }`:
 *   outcome   one of OUTCOMES
 *   reason    a short human-readable account of why
 *   envelope  the parsed JSON the session emitted, unaltered; null when stdout
 *             did not parse to a JSON object. What a reviewer's verdict inside
 *             it means is not decided here.
 *   prText    coder records only: parsePrBlock of the envelope's `result`.
 *             Present whatever the outcome, since it is only text the coder
 *             wrote; it is not evidence that anything was pushed or opened.
 *
 * Throws on a record that is not a well-formed raw record.
 */
export function classifySession(record) {
  validateRawRecord(record)

  const envelope = parseEnvelope(record.stdout)
  const classified = (outcome, reason) => {
    const result = { outcome, reason, envelope }
    if (record.role === 'coder') {
      result.prText = parsePrBlock(typeof envelope?.result === 'string' ? envelope.result : null)
    }
    return result
  }

  if (record.stoppedFor === 'timeout') {
    return classified('timed-out', 'stopped for exceeding its time limit')
  }
  if (record.stoppedFor === 'stall') {
    return classified('stalled', 'stopped for producing no output within the interval')
  }

  if (envelope?.subtype === BUDGET_SUBTYPE) {
    return classified('budget-exhausted', `session reported subtype ${BUDGET_SUBTYPE}`)
  }

  if (record.signal !== null) return classified('died', `terminated by signal ${record.signal}`)
  if (record.exitCode !== 0) return classified('died', `exit code ${record.exitCode}`)

  if (envelope === null) return classified('malformed-output', 'stdout is absent or not a JSON object')

  if (envelope.is_error === true) return classified('died', 'session reported is_error: true')
  if (typeof envelope.stop_reason === 'string' && envelope.stop_reason !== NORMAL_STOP_REASON) {
    return classified('died', `abnormal stop_reason ${JSON.stringify(envelope.stop_reason)}`)
  }
  if (typeof envelope.subtype === 'string' && envelope.subtype !== SUCCESS_SUBTYPE) {
    return classified('died', `session reported subtype ${JSON.stringify(envelope.subtype)}`)
  }

  // Completion needs positive evidence; anything short of it is not completed.
  const reportsSuccess =
    envelope.type === 'result' &&
    envelope.subtype === SUCCESS_SUBTYPE &&
    envelope.is_error === false &&
    envelope.stop_reason === NORMAL_STOP_REASON &&
    typeof envelope.result === 'string'
  if (!reportsSuccess) {
    return classified('malformed-output', 'JSON parsed but does not positively report a successful result')
  }

  return classified('completed', 'session reported a successful result')
}
