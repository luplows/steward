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
 * This reviews, discovers (ST-83) and, when `landing.attempt` is given, requests landing (ST-84).
 * The runway, a rotation, inspection, the coder and the fixer are not reached from here. Verdicts
 * go through the existing gate. When `landing` is given, discovery of landing candidates runs on
 * the review scan, or on a due time of its own when `landing.intervalMinutes` is given. Each time
 * it hands `landing.onCandidates` the open, non-draft pull requests, on supported bases, of the
 * projects whose current `main` settings have `land` exactly `true`, as `landingCandidates` shapes
 * them. With `landing.attempt`, the scan's candidates are then taken one at a time, after the
 * review turns, and each is rechecked just before its attempt: the project is still activated, its
 * current `main` still has `land` exactly `true`, and the pull request is open at the head the scan
 * found. Only then is `landPullRequest` called, as admitted work, with `mode: unattended` and
 * `once: true`, on a context made with `createLandContext` from that `main`'s `landWhen`. The pilot
 * and the runway decide; nothing is merged or dispatched from here. Scans and attempts run one
 * after another, never beside a review or each other: work that runs past a due time delays that
 * scan, which is also why no pull request and head has two attempts at once. Nothing is recorded
 * of an attempt beyond the fields below, so a later scan, or a restarted coordinator, may try the
 * same head again.
 *
 * The threat model is one member of the crew, one coordinator, one automatic review or landing
 * attempt at a time, on one machine. The bounds on usage are these turns, the reviewer's own checks
 * and the pilot's bounded waits. A person sees what
 * happened through `steward coordinator status`, which reads the fields `coordinator.report` writes
 * to the coordinator's record:
 *
 *   active           { repo, number, headSha } under review, or null
 *   nextScanAt       when the next scan, of either kind, is due, or null during a scan and its
 *                    turns, and when that time is past what a Date can hold, as the largest
 *                    interval accepted is
 *   nextLandingScanAt  when the landing scan is next due; only with a cadence of its own
 *   landingCandidates  [{ repo, number, headSha }] the latest landing scan found; only with
 *                    discovery
 *   lastOutcome      { repo, number, headSha, status, counted?, reason?, at } of the latest review
 *   landingActive    { repo, number, headSha } of the landing attempt under way, or null; only
 *                    with `landing.attempt`
 *   lastLanding      { repo, number, headSha, discoveredHeadSha?, status, triggers?, reason?, at } of
 *                    the latest landing attempt. `headSha` is the head the pilot reports when it
 *                    gives one, and `discoveredHeadSha` the scan's, only when they differ. It has
 *                    the pilot's `status` and the `triggers` it sent, or `threw`, or
 *                    `not-attempted` when a recheck refused the candidate, and nothing was sent.
 *                    Only with `landing.attempt`
 *   usage            { status, reason } of a usage refusal, until the next scan, or null
 *   recordsProblem   why the records could not be read, or null
 *   projectProblems  [{ repo, reason }]: discovery or checkout failures that stop the project's
 *                    reviews, until the next scan works
 *   landingProblems  [{ repo, reason }]: why a landing scan gave no candidates for the project
 *                    (settings unreadable or invalid, checkout not updated, discovery failed).
 *                    These stop no review. Only with discovery. A project with `land` false is
 *                    no problem and is not listed
 */
import { createContext, getPullRequestState } from './github.mjs'
import { createInspectContext } from './inspect.mjs'
import { createLandContext, landPullRequest, UNATTENDED } from './land.mjs'
import { ownedCheckoutPath, projectsPath, readProjects, updateOwnedCheckout } from './project.mjs'
import { admitReview, classifyResult, reviewEnding } from './review-admission.mjs'
import { listReviewCandidates, reviewCandidate } from './review-work.mjs'
import { readSettings as readProjectSettings } from './settings.mjs'

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

// What discovery says of a pull request that unattended landing may consider (ST-83/AC-3): open
// and not a draft, on a supported base, as `listReviewCandidates` already tells. A head with a
// verdict is one, as landing follows review. A refusal that the pilot and the runway would repeat
// is left out to save their calls; they keep the final say.
const LANDING_STATUSES = ['eligible', 'already-reviewed']

/**
 * The landing candidates in `listed` (what `listReviewCandidates` returned): `[{ repo, number,
 * headSha }]`, one for each repository, pull request number and head SHA, in number order. This is
 * what ST-84 takes to consider for landing.
 */
export function landingCandidates(listed) {
  const seen = new Set()
  const found = []
  for (const { status, repo, number, expectedHeadSha: headSha } of listed) {
    const identity = JSON.stringify([repo, number, headSha])
    if (!LANDING_STATUSES.includes(status) || seen.has(identity)) continue
    seen.add(identity)
    found.push({ repo, number, headSha })
  }
  return found.sort((a, b) => a.number - b.number)
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
 * `landing` is absent to discover no landing candidates, or `{ intervalMinutes, onCandidates,
 * attempt }`: the optional landing scan interval, the function given each scan's candidates, which
 * does nothing by default, and `attempt`, absent to request no landing, or `{ land, createLand,
 * readPull }` (all optional, `landPullRequest`, `createLandContext` and a read of the pull request
 * with `getPullRequestState`), which requests it. `contexts` (the GitHub contexts for a
 * repository), `listCandidates`, `updateCheckout`, `readSettings` (of a project's owned checkout),
 * `admission` (`admitReview`), `review`, `reviewOptions`, `now` and `wait` are injectable for tests.
 */
export async function scheduleReviews({
  homedir, coordinator, intervalMinutes, landing,
  contexts = defaultContexts, listCandidates = listReviewCandidates, updateCheckout = updateOwnedCheckout,
  readSettings = readProjectSettings, admission = admitReview, review = reviewCandidate, reviewOptions,
  now = () => new Date(), wait = waitMs,
}) {
  const { report, admitting } = coordinator
  const queues = new Map()
  const problems = new Map()
  const landingProblems = new Map()
  let position = null
  const separateLanding = landing?.intervalMinutes !== undefined

  const entries = (map) => [...map].map(([repo, reason]) => ({ repo, reason }))
  const reportProblems = () => report({
    projectProblems: entries(problems), ...(landing !== undefined && { landingProblems: entries(landingProblems) }),
  })

  /**
   * Whether the current `main` of `repo` authorizes landing candidates (ST-83/AC-4): only `land`
   * exactly `true` does. A checkout that cannot be brought to `main`, or settings that cannot be
   * read or are not valid, authorize nothing, and are reported as landing problems, which stop no
   * review. Gives those settings when it does, and null when it does not.
   */
  const landSettings = async (repo) => {
    const repoDir = ownedCheckoutPath(homedir, repo)
    try {
      await updateCheckout(repoDir)
      const settings = await readSettings(repoDir)
      landingProblems.delete(repo)
      return settings.land === true ? settings : null
    } catch (error) {
      landingProblems.set(repo, withoutCredentials(`settings or checkout: ${error.message}`))
      return null
    }
  }
  const landAllowed = async (repo) => (await landSettings(repo)) !== null

  // The candidates of the latest landing scan that no attempt has taken yet (ST-84).
  let landQueue = []

  /** Records `found` as the latest landing scan's candidates and hands them on. */
  const deliver = async (found) => {
    if (!admitting()) return
    const candidates = [...found].sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : a.number - b.number))
    report({ landingCandidates: candidates })
    landQueue = [...candidates]
    await (landing.onCandidates ?? (() => {}))(candidates)
  }

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

  /**
   * One scan of the activated projects. A `review` scan rebuilds the queues of heads to review. A
   * `landing` scan (ST-83) lists the pull requests that unattended landing may consider, for the
   * projects whose current `main` settings have `land` exactly `true`, and delivers them. A scan
   * can be both, and then lists each project once.
   */
  const scan = async ({ review, landing: landingScan }) => {
    report({ nextScanAt: null, ...(separateLanding && { nextLandingScanAt: null }), ...(review && { usage: null }) })
    if (review) queues.clear()
    const found = []
    try {
      const repos = await activated()
      if (repos === null) return
      for (const repo of [...repos].sort()) {
        if (!admitting()) return
        const landable = landingScan && await landAllowed(repo)
        let listed
        try {
          listed = review || landable ? await listCandidates(contexts(repo)) : []
          if (review) problems.delete(repo)
          if (landable) landingProblems.delete(repo)
        } catch (error) {
          const reason = withoutCredentials(`discovery failed: ${error.message}`)
          if (review) problems.set(repo, reason)
          if (landable) landingProblems.set(repo, reason)
          continue
        }
        if (landable) found.push(...landingCandidates(listed))
        if (!review) continue
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
      for (const map of [problems, landingProblems]) {
        for (const repo of map.keys()) {
          if (!repos.includes(repo)) map.delete(repo)
        }
      }
      reportProblems()
    } finally {
      if (landingScan) await deliver(found)
    }
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

  /** Why the pilot could not land, or has not yet, beyond its `status`; for `status` to show. */
  const landingReason = ({ reason, failing, waiting, newHeadSha }) => [
    reason,
    failing?.length > 0 && `failing: ${failing.join(', ')}`,
    waiting?.length > 0 && `waiting for: ${waiting.join(', ')}`,
    newHeadSha && `the head is now ${newHeadSha}`,
  ].filter(Boolean).join('; ')

  /**
   * The landing attempts for the candidates the latest landing scan left (ST-84), one at a time.
   * Each is rechecked just before it is admitted, and refused, with nothing sent, when the project
   * is no longer activated, its `main` no longer has `land` exactly `true`, or the pull request is
   * not open at the head the scan found. `attempt.land` is then given the pull request and a
   * context for it, with `mode: unattended` and `once: true`; whatever it returns, or throws, is the
   * attempt's outcome. A stop admits no more.
   */
  const landTurns = async () => {
    const { land = landPullRequest, createLand = createLandContext, readPull = (repo, number) => getPullRequestState(createContext({ repo }), number) } = landing.attempt
    while (admitting() && landQueue.length > 0) {
      const { repo, number, headSha } = landQueue.shift()
      const lastLanding = (fields) => report({ lastLanding: { repo, number, headSha, ...fields, at: now().toISOString() } })
      const refuse = (reason) => lastLanding({ status: 'not-attempted', reason: withoutCredentials(reason) })

      const repos = await activated()
      if (repos === null) {
        landQueue = []
        return
      }
      if (!repos.includes(repo)) {
        refuse('the project is no longer activated')
        continue
      }
      const settings = await landSettings(repo)
      reportProblems()
      if (settings === null) {
        refuse(landingProblems.get(repo) ?? "land is not true in the project's current main settings")
        continue
      }
      let ctx
      try {
        const pull = await readPull(repo, number)
        if (pull.state !== 'open') {
          refuse(`the pull request is ${pull.state}`)
          continue
        }
        if (pull.headSha !== headSha) {
          refuse(`the head is now ${pull.headSha}`)
          continue
        }
        ctx = createLand({ repo, landing: true, landWhen: settings.landWhen })
      } catch (error) {
        refuse(`could not recheck the pull request: ${error.message}`)
        continue
      }

      // The settings and the pull request took time to read, as did the checkout: the project may
      // have been deactivated meanwhile, and a deactivated one is sent nothing.
      const admittable = await activated()
      if (admittable === null) {
        landQueue = []
        return
      }
      if (!admittable.includes(repo)) {
        refuse('the project is no longer activated')
        continue
      }

      report({ landingActive: { repo, number, headSha } })
      const outcome = await new Promise((resolve) => {
        const job = async () => {
          try {
            resolve({ result: await land({ number, ctx, mode: UNATTENDED, once: true }) })
          } catch (error) {
            resolve({ error })
          }
        }
        if (!coordinator.admit(job)) resolve(null)
      })
      report({ landingActive: null })
      if (outcome === null) return
      if (outcome.error) {
        lastLanding({ status: 'threw', reason: withoutCredentials(outcome.error.message) })
        continue
      }
      const { result } = outcome
      const reason = landingReason(result)
      // The pilot reads the head itself, so the head it reports is the one its outcome belongs to.
      const pilotHead = typeof result.headSha === 'string' && result.headSha !== '' ? result.headSha : headSha
      lastLanding({
        ...(pilotHead !== headSha && { headSha: pilotHead, discoveredHeadSha: headSha }),
        status: result.status, triggers: result.triggers, ...(reason && { reason: withoutCredentials(reason) }),
      })
    }
  }

  // When each kind of scan is next due, in milliseconds since the epoch. Landing shares the review
  // scan unless it has an interval of its own.
  let reviewDue = -Infinity
  let landingDue = -Infinity
  const asDate = (ms) => {
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }

  try {
    while (admitting()) {
      const at = now().getTime()
      // A time the clock cannot give counts as past every due time, as the largest interval's does.
      const review = !(at < reviewDue)
      const landingScan = landing !== undefined && (separateLanding ? !(at < landingDue) : review)
      if (review || landingScan) {
        await scan({ review, landing: landingScan })
        if (landingScan && separateLanding) landingDue = now().getTime() + landing.intervalMinutes * 60_000
        if (review) await turns()
        if (landing?.attempt !== undefined) await landTurns()
        if (!admitting()) return
        if (review) reviewDue = now().getTime() + intervalMinutes * 60_000
      }
      const next = separateLanding ? Math.min(reviewDue, landingDue) : reviewDue
      // A scan that came due while the turns ran is run now, after them, never beside them.
      if (next <= now().getTime()) continue
      report({ nextScanAt: asDate(next), ...(separateLanding && { nextLandingScanAt: asDate(landingDue) }) })
      await Promise.race([wait(next - now().getTime()), coordinator.done])
    }
  } catch (error) {
    coordinator.fail(error)
  }
}
