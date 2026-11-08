/**
 * The checkout a manual command works against (ST-86). `rotation`, `review` and `inspect` take
 * `--repo owner/name`. When it names the repository of the invoking checkout's `origin`, or is not
 * given, the command works in the invoking checkout, as it always has. When it names another
 * repository, the command works in a checkout of that repository kept for manual commands, at
 * `~/.steward/state/manual-checkouts/<owner>/<name>`:
 *
 *   - cloned with `gh repo clone owner/name` when it is absent, so that `gh`'s sign-in and protocol
 *     apply;
 *   - brought to `origin`'s `main`, detached, every time, before anything else.
 *
 * It is never the coordinator's owned checkout, `~/.steward/state/checkouts/<owner>/<name>`
 * (`project.mjs`): nothing here reads, fetches or changes that path. A manual checkout whose
 * `origin` is not the repository, or that cannot be brought to `main`, is refused with an error
 * naming its path and the reason. Nothing here removes or cleans up a manual checkout, and two
 * manual commands for the same repository at the same time are not coordinated.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir as osHomedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { CHECKOUT_MAIN, FETCH_MAIN, repoFromRemoteUrl } from './checkout-main.mjs'
import { stateDir } from './user-config.mjs'

const execFileAsync = promisify(execFile)

const manualCheckoutsRoot = (homedir) => path.join(stateDir({ homedir }), 'manual-checkouts')

/** Where the manual checkout of `repo` (`owner/name`) is, under `homedir`. */
export const manualCheckoutPath = (homedir, repo) => path.join(manualCheckoutsRoot(homedir), ...repo.split('/'))

// `owner/name`: exactly two segments of the characters GitHub allows, neither `.` nor `..`.
const SEGMENT = /^[A-Za-z0-9_.-]+$/
const isOwnerName = (repo) => {
  const parts = typeof repo === 'string' ? repo.split('/') : []
  return parts.length === 2 && parts.every((part) => SEGMENT.test(part) && part !== '.' && part !== '..')
}

async function run(file, args, cwd) {
  try {
    const { stdout } = await execFileAsync(file, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    return stdout
  } catch (error) {
    throw new Error(String(error.stderr ?? '').trim() || String(error.stdout ?? '').trim() || error.message)
  }
}

const defaultDeps = {
  git: (cwd, args) => run('git', args, cwd),
  cloneRepo: (repo, dir) => run('gh', ['repo', 'clone', repo, dir], path.dirname(dir)),
  isCheckout: (dir) => existsSync(path.join(dir, '.git')),
  makeDirectory: (dir) => mkdir(dir, { recursive: true }),
}

/** The repository `dir`'s `origin` names, lower-cased, or `null` when it has none on GitHub. */
async function originRepo(git, dir) {
  try {
    return repoFromRemoteUrl(await git(dir, ['remote', 'get-url', 'origin']))?.toLowerCase() ?? null
  } catch {
    return null
  }
}

/**
 * Resolves the checkout a command given `repo` works in. `cwd` is the invoking checkout; `repo` is
 * the `--repo` value, or `undefined`. Resolves `cwd` when `repo` is not given or is the repository
 * of `cwd`'s `origin` (compared without regard to case, as GitHub does); otherwise resolves the
 * manual checkout of `repo`, cloned and brought to `origin`'s `main` as the header says. Throws,
 * before anything is read, when `repo` is not `owner/name` (two plain segments, neither `.` nor
 * `..`), and throws an error naming the path and the reason when that checkout is refused. `deps`
 * is replaceable by a
 * test: `git(cwd, args)` (resolving stdout), `cloneRepo(repo, dir)`, `isCheckout(dir)` and
 * `makeDirectory(dir)`.
 */
export async function resolveCheckout({ repo, cwd, homedir = osHomedir(), deps = {} }) {
  if (repo === undefined) return cwd
  const d = { ...defaultDeps, ...deps }
  if (!isOwnerName(repo)) throw new Error(`--repo must be owner/name, got: ${repo}`)
  if ((await originRepo(d.git, cwd)) === repo.toLowerCase()) return cwd

  const dir = manualCheckoutPath(homedir, repo)
  const inside = path.relative(manualCheckoutsRoot(homedir), dir)
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error(`--repo ${repo} would put the manual checkout at ${dir}, outside ${manualCheckoutsRoot(homedir)}`)
  }
  if (!d.isCheckout(dir)) {
    try {
      await d.makeDirectory(path.dirname(dir))
      await d.cloneRepo(repo, dir)
    } catch (error) {
      throw new Error(`${dir} could not be cloned from ${repo}: ${error.message}`)
    }
  }
  const origin = await originRepo(d.git, dir)
  if (origin !== repo.toLowerCase()) {
    throw new Error(`${dir} is refused: its origin is ${origin === null ? 'not a GitHub repository' : origin}, not ${repo}`)
  }
  for (const args of [FETCH_MAIN, CHECKOUT_MAIN]) {
    try {
      await d.git(dir, args)
    } catch (error) {
      throw new Error(`${dir} could not be brought to origin's main: ${error.message}`)
    }
  }
  return dir
}
