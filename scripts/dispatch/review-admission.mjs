/**
 * The coordinator's note of each automatic review (ST-52), so that a later scan does not start, and
 * pay for, a review already started. The design is `docs/agent-workflow-design.md`, Part 3,
 * "Decided so far", "Per-user coordinator foundations and manual independence".
 *
 * The threat model is one member of the crew, one coordinator, one automatic review at a time, on
 * one machine: this is a small record the coordinator keeps for itself, not a lock. Manual commands
 * neither read nor write it. Scheduling (who calls `admitReview`, and when) and what a `running`
 * entry found at `start` means are not here.
 *
 * The file, `~/.steward/state/reviews.json`, is `{ "reviews": [entry, ...] }`, with one entry for
 * each identity, `repo` (owner/name), `number` and `headSha` (full). An entry is
 *
 *   { repo, number, headSha, state: 'running', startedAt }
 *   { repo, number, headSha, state: 'ended', startedAt, endedAt, result }
 *
 * where `result` is `{ status, sessions? }`, the reviewer's own as it returned them, or
 * `{ status: 'threw', message }` when the review threw.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { FULL_HEAD_SHA } from './review-eligibility.mjs'
import { reviewCandidate } from './review-work.mjs'
import { REPO_RE } from './settings.mjs'
import { stateDir } from './user-config.mjs'

/** Where the record is under `homedir`. */
export const reviewsPath = (homedir) => path.join(stateDir({ homedir }), 'reviews.json')

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isIdentity = ({ repo, number, headSha }) => typeof repo === 'string' && REPO_RE.test(repo) &&
  Number.isSafeInteger(number) && number > 0 && typeof headSha === 'string' && FULL_HEAD_SHA.test(headSha)
const isEntry = (entry) => isObject(entry) && isIdentity(entry) && typeof entry.startedAt === 'string' && (
  entry.state === 'running' ||
  (entry.state === 'ended' && typeof entry.endedAt === 'string' && isObject(entry.result) && typeof entry.result.status === 'string')
)
const sameIdentity = (a, b) => a.repo === b.repo && a.number === b.number && a.headSha === b.headSha

/**
 * The entries in `file`: `[]` when there is no file. Throws, naming the file and what is wrong, on
 * anything else: a malformed file never reads as an empty one.
 */
export function readReviews(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const bad = (what) => new Error(`${file} is malformed: ${what}. Fix or remove it; until then no automatic review starts.`)
  let data
  try {
    data = JSON.parse(raw)
  } catch (error) {
    throw bad(`it is not valid JSON (${error.message})`)
  }
  if (!isObject(data) || Object.keys(data).join() !== 'reviews' || !Array.isArray(data.reviews)) {
    throw bad('it must be an object whose only key, "reviews", is a list')
  }
  data.reviews.forEach((entry, i) => {
    if (!isEntry(entry)) throw bad(`entry ${i + 1} is not a review entry steward wrote`)
  })
  return data.reviews
}

function writeEntry(file, entry) {
  const others = readReviews(file).filter((other) => !sameIdentity(other, entry))
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ reviews: [...others, entry] }, null, 2)}\n`, 'utf8')
}

/**
 * Runs one automatic review of `candidate` (`{ repo, number, expectedHeadSha }`) as admitted work,
 * through `admit` from `runCoordinator`, noting it in the record before it starts and how it ended
 * after. `review` is `reviewCandidate`, given `candidate`, `repoDir`, `ctx` and `reviewOptions`. A
 * candidate that is no identity is refused with a throw, writing nothing. Otherwise resolves, once
 * there is nothing left to wait for, with one of:
 *
 * - `{ status: 'ended', entry, reviewed }`: the review returned or threw, and `entry` says so.
 *   `reviewed` is all the reviewer returned, and absent when it threw.
 * - `{ status: 'already-admitted', entry }`: a `running` entry holds this identity. Nothing
 *   started, and the entry is as it was. Not a failure, and not a review's result.
 * - `{ status: 'admission-closed' }`: `admit` refused it, a stop having been acknowledged. Nothing
 *   was written or started.
 * - `{ status: 'record-failed', file, reason, entry?, reviewed? }`: the record could not be read or
 *   written. Without `entry`, no review started. With it, the review has ended, and the returned
 *   `entry` is what says how. What the file then holds is uncertain: it may still have the entry
 *   `running`, or it may be malformed.
 */
export async function admitReview({ homedir, admit, candidate, repoDir, ctx, reviewOptions, review = reviewCandidate, now = () => new Date() }) {
  const identity = { repo: candidate.repo, number: candidate.number, headSha: candidate.expectedHeadSha }
  if (!isIdentity(identity)) throw new Error(`not a review identity: ${JSON.stringify(identity)}`)
  const file = reviewsPath(homedir)
  const failed = (error, more) => ({ status: 'record-failed', file, reason: error.message, ...more })

  return new Promise((resolve) => {
    const job = async () => {
      let running
      try {
        const found = readReviews(file).find((entry) => sameIdentity(entry, identity))
        if (found?.state === 'running') return resolve({ status: 'already-admitted', entry: found })
        running = { ...identity, state: 'running', startedAt: now().toISOString() }
        writeEntry(file, running)
      } catch (error) {
        return resolve(failed(error))
      }

      let reviewed, result
      try {
        reviewed = await review({ candidate, repoDir, ctx, reviewOptions })
        const { status, sessions } = reviewed
        result = sessions === undefined ? { status } : { status, sessions }
      } catch (error) {
        result = { status: 'threw', message: error.message }
      }
      const entry = { ...running, state: 'ended', endedAt: now().toISOString(), result }
      const ending = reviewed === undefined ? { entry } : { entry, reviewed }
      try {
        writeEntry(file, entry)
      } catch (error) {
        return resolve(failed(error, ending))
      }
      return resolve({ status: 'ended', ...ending })
    }
    if (!admit(job)) resolve({ status: 'admission-closed' })
  })
}
