/**
 * What the coordinator does while it runs (ST-61): it discovers eligible pull-request heads of the
 * activated projects, and reviews them one at a time, in fair turns. The design is
 * `docs/agent-workflow-design.md`, Part 3, "Decided so far", "Automatic-review recovery, fair
 * scheduling and deferred shared E-stop".
 *
 * A scan reads the records and lists each project's candidates, queueing one entry for each pull
 * request and head, however many times discovery lists it. Turns then run through what the scan
 * found, with no added delay: each turn belongs to the next project, by `owner/name`, that has
 * a head left, brings that project's owned checkout to `origin`'s `main`, reads the records again
 * just before admitting, and awaits one review, unless `reviewEnding` now counts that head as a
 * model-consuming failure, which the scan checks too. When no head is left, the scheduler waits the
 * interval and scans again. The position in that order is kept in memory, so a restart begins a new
 * round.
 *
 * This only reviews. Landing, the runway, a rotation, inspection, the coder and the fixer are not
 * reached from here, whatever a project's `land` says. Verdicts go through the existing gate.
 *
 * The threat model is one member of the crew, one coordinator, one automatic review at a time, on
 * one machine. The bounds on usage are these turns and the reviewer's own checks. A person sees what
 * happened through `steward coordinator status`, which reads the fields `coordinator.report` writes
 * to the coordinator's record:
 *
 *   active           { repo, number, headSha } under review, or null
 *   nextScanAt       when the next scan is due, or null during a scan and its turns, and when that
 *                    time is past what a Date can hold, as the largest interval accepted is
 *   lastOutcome      { repo, number, headSha, status, counted?, reason?, at } of the latest review
 *   usage            { status, reason } of a usage refusal, until the next scan, or null
 *   recordsProblem   why the records could not be read, or null
 *   projectProblems  [{ repo, reason }]: discovery or checkout failures, until the next scan works
 */
import { createContext } from './github.mjs'
import { createInspectContext } from './inspect.mjs'
import { ownedCheckoutPath, projectsPath, readProjects, updateOwnedCheckout } from './project.mjs'
import { admitReview, classifyResult, reviewEnding } from './review-admission.mjs'
import { listReviewCandidates, reviewCandidate } from './review-work.mjs'

const USAGE_REFUSALS = ['over-usage', 'usage-unknown']
// The longest delay `setTimeout` takes; a longer one would fire at once.
const MAX_TIMER_MS = 2 ** 31 - 1

/** `text`, with any `user:password@` taken out of a URL in it, for the coordinator's record. */
export const withoutCredentials = (text) => String(text).replace(/\/\/[^/\s@]+@/g, '//')

/**
 * Resolves after `ms`, however long that is, as an interval has no upper bound. Its timers keep no
 * process alive, so a coordinator that has stopped exits without waiting for it.
 */
export async function waitMs(ms) {
  const end = Date.now() + ms
  for (let left = ms; left > 0; left = end - Date.now()) {
    await new Promise((resolve) => { setTimeout(resolve, Math.min(left, MAX_TIMER_MS)).unref() })
  }
}

/** Which of `repos` has the next turn after `position`, in order by `owner/name`, or undefined. */
function nextTurn(repos, position) {
  const ordered = [...repos].sort()
  return ordered.find((repo) => position === null || repo > position) ?? ordered[0]
}

/** What a usage refusal says, for `status`. `over-usage` carries its figures and no reason. */
function usageReason({ reason, window, percent, limit, resetsAt }) {
  if (reason) return withoutCredentials(reason)
  return `the ${window} window is at ${percent}%, at or over the limit of ${limit}%${resetsAt ? `; it resets at ${resetsAt}` : ''}`
}

const defaultContexts = (repo) => ({ ctx: createContext({ repo }), inspectCtx: createInspectContext({ repo }) })

/**
 * Runs scans and turns for `coordinator` (from `runCoordinator`) until its admission closes, and
 * resolves then. It does not reject: anything it cannot carry on from goes to `coordinator.fail`.
 * `contexts` (the GitHub contexts for a repository), `listCandidates`, `updateCheckout`, `admission`
 * (`admitReview`), `review`, `reviewOptions`, `now` and `wait` are injectable for tests.
 */
export async function scheduleReviews({
  homedir, coordinator, intervalMinutes,
  contexts = defaultContexts, listCandidates = listReviewCandidates, updateCheckout = updateOwnedCheckout,
  admission = admitReview, review = reviewCandidate, reviewOptions,
  now = () => new Date(), wait = waitMs,
}) {
  const { report, admitting } = coordinator
  const queues = new Map()
  const problems = new Map()
  let position = null

  const reportProblems = () => report({ projectProblems: [...problems].map(([repo, reason]) => ({ repo, reason })) })

  /** The activated repositories, or null when the records cannot be read, which `status` gives. */
  const activated = async () => {
    try {
      const repos = (await readProjects(projectsPath(homedir))).map(({ repo }) => repo)
      report({ recordsProblem: null })
      return repos
    } catch (error) {
      report({ recordsProblem: withoutCredentials(error.message) })
      return null
    }
  }

  const scan = async () => {
    report({ nextScanAt: null, usage: null })
    queues.clear()
    const repos = await activated()
    if (repos === null) return
    for (const repo of [...repos].sort()) {
      if (!admitting()) return
      let listed
      try {
        listed = await listCandidates(contexts(repo))
        problems.delete(repo)
      } catch (error) {
        problems.set(repo, withoutCredentials(`discovery failed: ${error.message}`))
        continue
      }
      // Discovery can list a head twice, and a second entry would be an immediate retry. A throw
      // here, from a record of reviews that cannot be read, ends the coordinator.
      const seen = new Set()
      const eligible = listed.filter(({ status, repo: from, number, expectedHeadSha: headSha }) => {
        const identity = JSON.stringify([from, number, headSha])
        if (status !== 'eligible' || seen.has(identity)) return false
        seen.add(identity)
        return reviewEnding({ homedir, repo: from, number, headSha }) !== 'model-consuming-failure'
      })
      if (eligible.length > 0) queues.set(repo, eligible)
    }
    for (const repo of problems.keys()) {
      if (!repos.includes(repo)) problems.delete(repo)
    }
    reportProblems()
  }

  /** Reports how the review of `candidate` ended, and whether turns may carry on after it. */
  const ended = (candidate, { entry, reviewed }) => {
    const { result } = entry
    const reason = reviewed?.reason ?? result.message
    report({
      lastOutcome: {
        repo: candidate.repo, number: candidate.number, headSha: candidate.expectedHeadSha,
        status: result.status, counted: classifyResult(result),
        ...(reason && { reason: withoutCredentials(reason) }), at: entry.endedAt,
      },
    })
    if (!USAGE_REFUSALS.includes(result.status)) return true
    report({ usage: { status: result.status, reason: usageReason(reviewed) } })
    return false
  }

  const turns = async () => {
    while (admitting()) {
      const repos = await activated()
      if (repos === null) return
      for (const repo of queues.keys()) {
        if (!repos.includes(repo)) queues.delete(repo)
      }
      const repo = nextTurn(queues.keys(), position)
      if (repo === undefined) return
      position = repo

      const repoDir = ownedCheckoutPath(homedir, repo)
      try {
        await updateCheckout(repoDir)
      } catch (error) {
        queues.delete(repo)
        problems.set(repo, withoutCredentials(`could not bring the owned checkout to origin's main: ${error.message}`))
        reportProblems()
        continue
      }

      // Git may have taken a while, and the project may have been deactivated meanwhile.
      const current = await activated()
      if (current === null) return
      if (!current.includes(repo)) {
        queues.delete(repo)
        continue
      }

      const queue = queues.get(repo)
      const candidate = queue.shift()
      if (queue.length === 0) queues.delete(repo)
      // What the scan read of this head's ending may be out of date by now. A throw here, as in the
      // scan, ends the coordinator.
      const { number, expectedHeadSha: headSha } = candidate
      if (reviewEnding({ homedir, repo, number, headSha }) === 'model-consuming-failure') continue
      report({ active: { repo, number: candidate.number, headSha: candidate.expectedHeadSha } })
      const outcome = await admission({
        homedir, admit: coordinator.admit, candidate, repoDir, ctx: contexts(repo).ctx, reviewOptions, review, now,
      })
      report({ active: null })

      if (outcome.status === 'record-failed') return coordinator.fail(new Error(outcome.reason))
      if (outcome.status === 'admission-closed') return
      if (outcome.status === 'already-admitted') {
        report({
          lastOutcome: {
            repo, number: candidate.number, headSha: candidate.expectedHeadSha,
            status: outcome.status, at: now().toISOString(),
          },
        })
      } else if (!ended(candidate, outcome)) {
        return
      }
    }
  }

  try {
    while (admitting()) {
      await scan()
      await turns()
      if (!admitting()) return
      const ms = intervalMinutes * 60_000
      const due = new Date(now().getTime() + ms)
      report({ nextScanAt: Number.isNaN(due.getTime()) ? null : due.toISOString() })
      await Promise.race([wait(ms), coordinator.done])
    }
  } catch (error) {
    coordinator.fail(error)
  }
}
