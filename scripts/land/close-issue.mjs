// Closing the Issue a landed pull request completes (ST-76). The runway calls `closeLinkedIssue`
// after a merge into `main` has succeeded; it is cleanup, never a gate on which pull requests may
// merge, and it never throws. `docs/agent-workflow-design.md`, "GitHub mechanics", says why the
// runway closes the Issue itself: GitHub's own closing does not follow a merge made by the
// workflow's token.
//
// An Issue is closed only when the body has exactly one `Unit: #<n>` and exactly one closing
// reference, `Closes #<n>` or another of GitHub's keywords, naming that same Issue, and the
// project's `unitLinks` includes `issue`. A body with no closing reference closes nothing and says
// nothing: a bare `Unit: #<n>` is not a request to close. A closing reference that does not
// qualify closes nothing and says why in a `::warning::` line.

import { closingIssueNumbers, unitLineTexts } from '../dispatch/unit.mjs'

const ISSUE_UNIT_RE = /^#([1-9][0-9]*)$/

/** One line of text from an error or a value, so it cannot add a line or a workflow command to the log. */
const oneLine = (value) => JSON.stringify(String(value))

/**
 * What to do for a merged pull request's body. Returns `{ action: 'none' }` when the body has no
 * closing reference, `{ action: 'close', issue }` when it qualifies, and `{ action: 'warn', reason }`
 * when a closing reference is present and does not qualify. `unitLinks` is the project's setting as
 * read, which may be anything. Pure.
 */
export function planIssueClosure(body, unitLinks) {
  const closing = closingIssueNumbers(body)
  if (closing.length === 0) return { action: 'none' }
  const refs = closing.map((n) => `#${n}`).join(', ')
  const warn = (reason) => ({ action: 'warn', reason })

  if (!Array.isArray(unitLinks) || !unitLinks.includes('issue')) {
    return warn(`the project's unitLinks does not include "issue", so the closing reference ${refs} is not acted on`)
  }
  const units = unitLineTexts(body)
  if (units.length === 0) return warn(`the body has the closing reference ${refs} and no "Unit: #<n>" line`)
  if (units.length > 1) return warn(`the body has ${units.length} Unit: lines (${units.join('; ')}), so its unit is ambiguous`)
  const unit = ISSUE_UNIT_RE.exec(units[0])
  if (!unit) return warn(`its Unit: is "${units[0]}", not an Issue of this repository ("Unit: #<n>")`)
  const issue = Number(unit[1])
  if (closing.length > 1) return warn(`the body has conflicting closing references ${refs}; it needs one, #${issue}`)
  if (closing[0] !== issue) return warn(`the closing reference ${refs} is not its unit, Issue #${issue}`)
  return { action: 'close', issue }
}

/**
 * After a merge of pull request `pr` into `base`: closes the Issue `planIssueClosure` finds, through
 * `api` (the argument list after `gh api`, stdout out), and logs. Only a merge into `main` is
 * considered. Returns the number of the Issue closed or found already closed, or null. Never throws:
 * a failed read or update is logged as a warning that the crew must close the Issue by hand.
 */
export function closeLinkedIssue({ repo, pr, base, body, unitLinks }, { api, log }) {
  try {
    const plan = planIssueClosure(body, unitLinks)
    if (plan.action === 'none') return null
    if (base !== 'main') {
      log(`::notice title=No Issue closed::PR #${pr} merged into ${oneLine(base)}, not main; the runway closes an Issue only for a merge into main.`)
      return null
    }
    if (plan.action === 'warn') {
      log(`::warning title=No Issue closed::PR #${pr} merged, and no Issue was closed: ${plan.reason}. Close the Issue by hand if it is complete.`)
      return null
    }
    const path = `repos/${repo}/issues/${plan.issue}`
    try {
      const issue = JSON.parse(api([path]))
      if (issue.pull_request) {
        log(`::warning title=No Issue closed::PR #${pr} merged, but #${plan.issue} is a pull request, not an Issue. Nothing was closed.`)
        return null
      }
      if (issue.state === 'closed') {
        log(`::notice title=Issue already closed::Issue #${plan.issue} was already closed when PR #${pr} merged.`)
        return plan.issue
      }
      api(['-X', 'PATCH', path, '-f', 'state=closed', '-f', 'state_reason=completed'])
      log(`::notice title=Issue closed::Issue #${plan.issue} closed after PR #${pr} merged.`)
      return plan.issue
    } catch (error) {
      log(
        `::warning title=Issue not closed::PR #${pr} merged, but Issue #${plan.issue} could not be closed: ${oneLine(error.message)}. The merge stands; close Issue #${plan.issue} by hand.`,
      )
      return null
    }
  } catch (error) {
    log(`::warning title=Issue not closed::PR #${pr} merged, but closing its Issue failed: ${oneLine(error.message)}. The merge stands; close the Issue by hand.`)
    return null
  }
}
