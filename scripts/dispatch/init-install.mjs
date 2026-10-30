/**
 * The git side of `steward init`'s installation (ST-56): what it reads from the checkout and from
 * `origin` before it writes anything, the check that the caller's own changes do not touch what the
 * installation adds, and the steps that make the installation commit on a branch of its own.
 *
 * Every git command is an argument array run through an injectable runner (`defaultGit`), never a
 * shell string, so that a test can fail or interleave any one command; `init` hands every function
 * here that runner wrapped by `literalGit`, so that every command reads paths and objects
 * literally.
 * Nothing here stages, stashes, resets, cleans, checks out, commits or moves a branch in the
 * caller's checkout: the only writes to it are the ones `git fetch` and `git worktree add` make to
 * the repository's own bookkeeping. The installation itself is made in a worktree of its own, from
 * the commit `origin/main` had when `init` fetched it (`captureBase`).
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

/** Thrown for anything `init` refuses before it has written anything; `main` exits 2 with it. */
export class Refusal extends Error {}

/** A git command that failed; carries the command's `status` and `stderr`. */
export class GitError extends Error {
  constructor(args, result) {
    const said = String(result.stderr ?? '').trim()
    super(`git ${args.join(' ')} failed${said === '' ? '' : `: ${said}`}`)
    this.status = result.status
    this.stderr = result.stderr
  }
}

/**
 * The settings that decide what a read of the checkout sees, fixed for every git command so that
 * the caller's own configuration cannot hide a change from the check (a file system monitor or an
 * untracked cache lets `git status` trust earlier answers; `core.ignoreStat`, a
 * `status.showUntrackedFiles` or a `diff.ignoreSubmodules` of the caller's could change its
 * output). The status and diff commands also pass their own options. Passed as environment
 * configuration, after any the caller's environment holds.
 */
const FIXED_CONFIG = [
  ['core.ignoreStat', 'false'],
  ['core.fsmonitor', 'false'],
  ['core.untrackedCache', 'false'],
  ['status.showUntrackedFiles', 'normal'],
  ['diff.ignoreSubmodules', 'none'],
  ['push.followTags', 'false'],
]

/**
 * The environment variables that name a repository, its index, its objects or its configuration
 * (`git rev-parse --local-env-vars` lists them). One set in the caller's environment would point
 * git at the caller's repository or index from the installation's own worktree, so every git
 * command runs without them and finds its repository from the folder it runs in. The caller's
 * identity variables (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`) are not among them. `main` refuses all
 * inherited Git overrides before discovery; this sanitisation also protects injected runners.
 */
export const LOCAL_ENVIRONMENT = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
]

/** The environment git runs in: `env` without `LOCAL_ENVIRONMENT`, with `FIXED_CONFIG` added and optional locks off. */
export function gitEnvironment(env) {
  const kept = {}
  for (const [key, value] of Object.entries(env)) {
    if (LOCAL_ENVIRONMENT.includes(key) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) continue
    kept[key] = value
  }
  FIXED_CONFIG.forEach(([key, value], i) => {
    kept[`GIT_CONFIG_KEY_${i}`] = key
    kept[`GIT_CONFIG_VALUE_${i}`] = value
  })
  return { ...kept, GIT_CONFIG_COUNT: String(FIXED_CONFIG.length), GIT_OPTIONAL_LOCKS: '0' }
}

/**
 * The global options every installer Git command carries, put in front of it by `literalGit`:
 * `--literal-pathspecs`, so that a path read from the repository or the settings (a checklist named
 * `:(literal)REVIEW.md` or `docs/[r]eview.md`) names that one path and is never read as pathspec
 * magic or a wildcard; and `--no-replace-objects`, so that the objects compared and published are
 * the real ones GitHub sees, even if another process installs a local replacement after the
 * read-only preflight check. The caller's refs and configuration are never changed for either.
 */
export const LITERAL_GIT_OPTIONS = ['--literal-pathspecs', '--no-replace-objects']

/**
 * The one runner every installer Git command goes through: `run` (the injectable runner,
 * `defaultGit` unless a test passes another) with `LITERAL_GIT_OPTIONS` in front of every argument
 * array, so that no command can be written without them.
 */
export function literalGit(run) {
  return (cwd, args, options) => run(cwd, [...LITERAL_GIT_OPTIONS, ...args], options)
}

/**
 * Runs `git` with `args` in `cwd` without a shell and resolves nothing it did not throw: `{ status,
 * stdout, stderr }`, `status` being `-1` when git could not start. `GIT_OPTIONAL_LOCKS=0` keeps a
 * read from refreshing the caller's index behind its back. `init` runs it only through
 * `literalGit`.
 */
export function defaultGit(cwd, args, { input, env = process.env, hooksPath } = {}) {
  // This override belongs only to installer-owned operations, including worktree add. No caller
  // configuration is changed. Callers doing preflight reads never supply it.
  if (hooksPath !== undefined) args = ['-c', `core.hooksPath=${hooksPath}`, ...args]
  const result = spawnSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    windowsHide: true,
    env: gitEnvironment(env),
  })
  if (result.error) return { status: -1, stdout: '', stderr: String(result.error.message) }
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** The output of a git command that must succeed; throws `GitError` otherwise. */
export function gitOut(run, cwd, args, options) {
  const result = run(cwd, args, options)
  if (result.status !== 0) throw new GitError(args, result)
  return result.stdout
}

const FULL_SHA = /^[0-9a-f]{40}$/

/**
 * A path as git spells it: without `.` segments (`isRulesFilePath` allows `a/./b.md` and
 * `./REVIEW.md`, which git reports as `a/b.md` and `REVIEW.md`). Every path the installer compares
 * with git's output, uses as a key of a tree or stages is put in this form once, where it is read.
 */
export function canonicalPath(rel) {
  return rel.split('/').filter((s) => s !== '' && s !== '.').join('/')
}

// -------- preflight: the checkout and origin

/**
 * The checkout's root, or `null` when `cwd` is not in a git repository with a working tree. Refuses
 * a checkout whose `HEAD` is not a readable commit (a repository with no commit yet, or a damaged
 * one).
 */
export function openCheckout(run, cwd) {
  // Check before trusting --show-toplevel: core.worktree can make that name another checkout.
  const redirected = run(cwd, ['config', '--show-origin', '--get-all', 'core.worktree'])
  if (redirected.status === 0) throw new Refusal(`core.worktree is set (${redirected.stdout.trim()}): run init from an ordinary checkout without this setting; no fetch was attempted`)
  if (redirected.status !== 1) throw new Refusal(`cannot inspect effective Git configuration (${redirected.stderr.trim()}): fix the named configuration source, or run init from another checkout`)
  const both = run(cwd, ['rev-parse', '--show-toplevel', 'HEAD^{commit}'])
  if (both.status === 0) {
    const [top, head] = both.stdout.trim().split('\n')
    if (top && FULL_SHA.test(head ?? '')) return path.resolve(top)
  }
  const top = run(cwd, ['rev-parse', '--show-toplevel'])
  if (top.status !== 0 || top.stdout.trim() === '') return null
  throw new Refusal(
    'this checkout has no readable HEAD commit (a repository with no commit yet, or a damaged one): ' +
      'make its first commit, or repair it, and run init again',
  )
}

/**
 * The URLs `origin` has: `effective`, what `git remote get-url --all origin` gives (after any
 * `url.<base>.insteadOf` rewriting, so where a fetch goes) as a list, or `null` when there is no
 * `origin`; and `configured`, the first `remote.origin.url` as written, or `null`.
 */
export function originUrls(run, root) {
  const effective = run(root, ['remote', 'get-url', '--all', 'origin'])
  const configured = run(root, ['config', '--get-all', 'remote.origin.url'])
  const lines = (r) => (r.status === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '') : [])
  return { effective: effective.status === 0 ? lines(effective) : null, configured: lines(configured)[0] ?? null }
}

/**
 * Fetches `main` from `url` (the URL of `origin`, as the caller's transport reaches it) and returns
 * the full SHA of the commit it points at: the installation's base. A remote with no `main` is a
 * refusal; a remote that cannot be reached is an ordinary failure.
 */
export function captureBase(run, root, url) {
  const fetched = run(root, ['fetch', '--no-tags', '--quiet', url, '+refs/heads/main:refs/remotes/origin/main'])
  if (fetched.status !== 0) {
    // Which of the two it is: ask `origin` for its heads (exit 2 is "no such branch", anything else
    // a failure).
    const listed = run(root, ['ls-remote', '--exit-code', '--heads', url, 'refs/heads/main'])
    if (listed.status === 2) {
      throw new Refusal('origin has no `main` branch: steward installs through a pull request against `main`, so push `main` first')
    }
    throw new GitError(['fetch', 'origin', 'main'], fetched)
  }
  const sha = gitOut(run, root, ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']).trim()
  if (!FULL_SHA.test(sha)) throw new Error(`origin/main resolved to ${JSON.stringify(sha)}, which is not a commit's full SHA`)
  return sha
}

/** The entries of the output of `git ls-tree -z`, as `{ path, mode, type, sha }`. */
function parseTree(text) {
  const entries = []
  for (const record of text.split('\0')) {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(record)
    if (match) entries.push({ mode: match[1], type: match[2], sha: match[3], path: match[4] })
  }
  return entries
}

/**
 * Reads the tree of commit `base`, with as few git commands as it can: `entries(paths)` gives the
 * entry of each of the paths that is there, `list(dir)` the entries directly inside a directory,
 * and `text(rel)` the content of a file.
 */
export function createBaseReader(run, root, base) {
  const lists = new Map()
  const direct = (dir, entries) =>
    entries
      .filter((e) => path.posix.dirname(e.path) === (dir === '' ? '.' : dir))
      .map((e) => ({ name: path.posix.basename(e.path), isDirectory: e.type === 'tree', isFile: e.type === 'blob' && e.mode !== '120000' }))
  return {
    entries(paths) {
      const found = new Map()
      if (paths.length === 0) return found
      for (const e of parseTree(gitOut(run, root, ['ls-tree', '-z', base, '--', ...paths]))) found.set(e.path, e)
      return found
    },
    list(dir) {
      if (!lists.has(dir)) {
        // `docs/` and `.github/` are listed together: they are the two directories a template is
        // looked for in.
        const dirs = dir === 'docs' || dir === '.github' ? ['docs', '.github'] : dir === '' ? [''] : [dir]
        const text = gitOut(run, root, ['ls-tree', '-z', base, ...(dirs[0] === '' ? [] : ['--', ...dirs.map((d) => `${d}/`)])])
        const all = parseTree(text)
        for (const d of dirs) {
          const inside = direct(d, all)
          lists.set(d, inside.length === 0 ? null : inside)
        }
      }
      return lists.get(dir)
    },
    text(rel) {
      const entry = this.entries([rel]).get(rel)
      if (!entry || entry.type !== 'blob') throw new Error(`${rel} is not a file on origin/main`)
      return gitOut(run, root, ['cat-file', 'blob', entry.sha])
    },
    /**
     * The content of each of the files `rels`, as a map; `null` for a symbolic link, whose content
     * is its target.
     */
    texts(rels) {
      const found = this.entries(rels)
      const texts = new Map()
      for (const rel of rels) {
        const entry = found.get(rel)
        if (!entry || entry.type !== 'blob') throw new Error(`${rel} is not a file on origin/main`)
        texts.set(rel, entry.mode === '120000' ? null : gitOut(run, root, ['cat-file', 'blob', entry.sha]))
      }
      return texts
    },
  }
}

/**
 * What `origin/main` says about the project's settings: `{ present: false }`, or `{ present: true,
 * rulesFile }`, read from the one key `rulesFile` and nothing else. A file that is not JSON, or
 * whose `rulesFile` `isValid` refuses, is a refusal: the checklist's path could not be chosen.
 */
export function readBaseSettings(reader, isValid) {
  const entry = reader.entries(['steward.config.json']).get('steward.config.json')
  if (!entry) return { present: false }
  if (entry.type !== 'blob') {
    throw new Refusal('steward.config.json on origin/main is not a file, so the checklist it names cannot be read: fix it through a pull request of the project, then run init again')
  }
  let data
  try {
    data = JSON.parse(reader.text('steward.config.json'))
  } catch (error) {
    throw new Refusal(`steward.config.json on origin/main is not valid JSON (${error.message}): fix it through a pull request of the project, then run init again`)
  }
  const rulesFile = data !== null && typeof data === 'object' && !Array.isArray(data) ? data.rulesFile : undefined
  if (!isValid(rulesFile)) {
    throw new Refusal(
      `steward.config.json on origin/main has no usable rulesFile (${JSON.stringify(rulesFile)}): ` +
        'it must be a relative path with forward slashes; fix it through a pull request of the project, then run init again',
    )
  }
  const canonical = canonicalPath(rulesFile)
  if (canonical === '') {
    throw new Refusal('steward.config.json on origin/main has a rulesFile that names no file; fix it through a pull request of the project, then run init again')
  }
  return { present: true, rulesFile: canonical }
}

/** Every parent directory of the paths `rels`, shortest first, each once. */
export function parentDirectories(rels) {
  const dirs = new Set()
  for (const rel of rels) {
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  return [...dirs].sort((a, b) => a.length - b.length)
}

/**
 * Refuses a target (of those in `rels`) whose parent directories, in `entries` (a map from path to
 * its entry on `origin/main`, for the parents), include one that is a file or a link: the
 * installation could not create the target there.
 */
export function assertParentsAreDirectories(entries, rels) {
  for (const rel of rels) {
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      const entry = entries.get(dir)
      if (entry && entry.type !== 'tree') {
        throw new Refusal(`${dir} on origin/main is not a directory, so ${rel} cannot be added under it: move ${dir} aside through a pull request of the project, then run init again`)
      }
    }
  }
}

// ------------------------------------------------------------------ pull request templates

/** Where a project's pull request template may be, as GitHub reads it. */
export const TEMPLATE_DIRS = ['', 'docs', '.github']

/**
 * The project's pull request templates as paths relative to the root, from `list(dir)`, which gives
 * the entries `{ name, isDirectory, isFile }` directly inside `dir` ('' for the root), or `null`
 * when the directory is not there: `pull_request_template.md` in the root, `docs/` or `.github/`,
 * and each file of a `PULL_REQUEST_TEMPLATE/` directory in any of them. An empty such directory is
 * `<dir>/`.
 */
export function discoverTemplates(list) {
  const found = []
  for (const dir of TEMPLATE_DIRS) {
    const entries = list(dir)
    if (entries === null) continue
    for (const entry of entries) {
      const lower = entry.name.toLowerCase()
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (lower === 'pull_request_template.md' && !entry.isDirectory) found.push(rel)
      if (lower === 'pull_request_template' && entry.isDirectory) {
        const inside = (list(rel) ?? []).filter((e) => e.isFile)
        if (inside.length === 0) found.push(`${rel}/`)
        for (const file of inside) found.push(`${rel}/${file.name}`)
      }
    }
  }
  return found
}

// -------- the caller's changes (what the installation must not touch)

const TEMPLATE_PATH = /^(?:(?:docs|\.github)\/)?pull_request_template(?:\.md|\/[^/]+)?$/

/**
 * What the installation can touch, for a settings file, a checklist at `rulesFile` and the workflow
 * files `workflows`: `affects(path)` says whether a change at `path` is one that matters. A path
 * matters when it is one of those files, a path under one (the file became a directory), an
 * ancestor of one (a directory became a file or a link), or a place a pull request template is
 * found (`discoverTemplates`) in any case. Compared without regard to case, as some file systems
 * are.
 */
export function relevance({ rulesFile, workflows }) {
  const files = ['steward.config.json', rulesFile, ...workflows.map((w) => `.github/workflows/${w}`), '.github/pull_request_template.md'].map((f) => f.toLowerCase())
  const ancestors = new Set(['docs', '.github', '.github/workflows', ...parentDirectories(files)])
  const fileSet = new Set(files)
  const normal = (p) => p.replace(/\/+$/, '').toLowerCase()
  return {
    files,
    affects(p) {
      const l = normal(p)
      return TEMPLATE_PATH.test(l) || fileSet.has(l) || ancestors.has(l) || files.some((f) => l.startsWith(`${f}/`))
    },
    /**
     * Whether a wholly untracked or ignored directory `d` is, or leads to, something that matters.
     */
    touches(d) {
      const l = normal(d)
      return TEMPLATE_PATH.test(l) || fileSet.has(l) || ancestors.has(l)
    },
  }
}

const STATUS_WORDS = { A: 'added', D: 'deleted', M: 'modified', T: 'changed from one kind of entry to another (file, link or directory)', U: 'unmerged' }
const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/** The entries of the output of `git diff --raw -z --no-renames --no-abbrev`. */
function parseRaw(text) {
  const tokens = text.split('\0')
  const entries = []
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const [oldMode, newMode, , newSha, status] = tokens[i].replace(/^:/, '').trim().split(/\s+/)
    entries.push({ oldMode, newMode, newSha, status, path: tokens[i + 1] })
  }
  return entries
}

/**
 * The caller's changes that touch what the installation adds, as `{ path, what }`, found in each
 * layer on its own: the commits made since `HEAD` left `base` (every commit, compared with `base`
 * itself, when they share no history), then, from one `git status`, the index against `HEAD`, the
 * files against the index, the entries the index leaves unmerged, and the untracked and ignored
 * files. A change that one layer undoes for another still counts in its own. Throws `Refusal` when
 * a comparison cannot be made.
 */
export function findLocalConflicts(run, root, base, relevant) {
  const conflicts = []
  const note = (path_, what) => {
    if (!conflicts.some((c) => c.path === path_ && c.what === what)) conflicts.push({ path: path_, what })
  }
  const cannot = (what, error) =>
    new Refusal(`init could not compare ${what} reliably (${error.message}): resolve that, or run init from another checkout of the project`)
  const diff = (label, args) => {
    let text
    try {
      text = gitOut(run, root, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--ignore-submodules=none', ...args])
    } catch (error) {
      throw cannot(label, error)
    }
    for (const entry of parseRaw(text)) {
      if (relevant.affects(entry.path)) note(entry.path, `${STATUS_WORDS[entry.status] ?? 'changed'} ${label}`)
    }
  }

  const bases = run(root, ['merge-base', '--all', 'HEAD', base])
  if (bases.status === 0 && bases.stdout.trim() !== '') {
    for (const mergeBase of bases.stdout.trim().split('\n')) {
      diff('in a commit of this checkout since it left origin/main', [mergeBase.trim(), 'HEAD'])
    }
  } else if (bases.status === 1) {
    diff("in this checkout's commits, which share no history with origin/main (compared with origin/main itself)", [base, 'HEAD'])
  } else {
    throw cannot("this checkout's commits with origin/main", new GitError(['merge-base'], bases))
  }

  let status
  try {
    status = gitOut(run, root, ['status', '--porcelain=v1', '-z', '--no-renames', '--ignore-submodules=none', '--untracked-files=normal', '--ignored'])
  } catch (error) {
    throw cannot('the index and the working files', error)
  }
  const listInside = (dir, ignored) => {
    try {
      return gitOut(run, root, ['ls-files', '--others', ...(ignored ? ['--ignored'] : []), '--exclude-standard', '-z', '--', dir])
        .split('\0')
        .filter((p) => p !== '')
    } catch (error) {
      throw cannot(`the files under ${dir}`, error)
    }
  }
  // A tracked file marked assume-unchanged or skip-worktree (a sparse checkout sets the second) is
  // one whose edits `git status` does not show, and nothing else compares its bytes with the index
  // here, so a relevant one is refused rather than trusted: the flags are what `git ls-files -v`
  // shows.
  let tagged
  try {
    tagged = gitOut(run, root, ['ls-files', '-v', '-z'])
  } catch (error) {
    throw cannot('the index flags of tracked files', error)
  }
  for (const record of tagged.split('\0')) {
    if (record.length < 3) continue
    const tag = record[0]
    const file = record.slice(2)
    if (!relevant.affects(file)) continue
    if (tag === 'S' || tag === 's') {
      note(file, `marked skip-worktree, so git does not show edits to it (a sparse checkout does this); clear it with: git update-index --no-skip-worktree ${file}`)
    } else if (/[a-z]/.test(tag)) {
      note(file, `marked assume-unchanged, so git does not show edits to it; clear it with: git update-index --no-assume-unchanged ${file}`)
    }
  }
  for (const record of status.split('\0')) {
    if (record.length < 4) continue
    const xy = record.slice(0, 2)
    const entry = record.slice(3)
    if (xy === '??' || xy === '!!') {
      const ignored = xy === '!!'
      const kind = ignored ? 'an ignored file that exists only in this checkout' : 'an untracked file that exists only in this checkout'
      if (!entry.endsWith('/')) {
        if (relevant.affects(entry)) note(entry, kind)
      } else if (relevant.touches(entry)) {
        for (const file of listInside(entry.slice(0, -1), ignored)) if (relevant.affects(file)) note(file, kind)
      }
      continue
    }
    if (!relevant.affects(entry)) continue
    if (UNMERGED.has(xy)) {
      note(entry, 'unmerged in the index')
      continue
    }
    if (xy[0] !== ' ') note(entry, `${STATUS_WORDS[xy[0]] ?? 'changed'} in the index (staged)`)
    if (xy[1] !== ' ') note(entry, `${STATUS_WORDS[xy[1]] ?? 'changed'} in the working files (not staged)`)
  }
  return conflicts
}

// ------------------------------------------------------------------ the branch

/** Refuses a branch name that is not a valid git branch name, is `main`, or is under `release/`. */
export function assertBranchName(run, root, name) {
  if (name === 'main' || name.startsWith('release/')) {
    throw new Refusal(`--branch ${name}: the installation never goes on main or on a release branch`)
  }
  const valid = !name.startsWith('-') && name !== 'HEAD' && run(root, ['check-ref-format', `refs/heads/${name}`]).status === 0
  if (!valid) throw new Refusal(`--branch ${name}: not a valid git branch name`)
}

/**
 * What already stands where the installation would go: a local branch of that name (and the
 * worktree it is checked out in, if any), a branch of that name on `origin` (asked of `origin`
 * itself, not of what was fetched), and a worktree at the path. Resolves a list of sentences, empty
 * when all is free; throws when `origin` cannot be asked.
 */
export function branchCollisions(run, root, branch, worktree, destination) {
  const found = []
  const listed = run(root, ['worktree', 'list', '--porcelain'])
  if (listed.status !== 0) throw new GitError(['worktree', 'list'], listed)
  const trees = []
  if (listed.status === 0) {
    for (const block of listed.stdout.split(/\r?\n\r?\n/)) {
      const where = /^worktree (.+)$/m.exec(block)?.[1]
      if (where) trees.push({ where, branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null })
    }
  }
  const local = run(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
  if (![0, 1].includes(local.status)) throw new GitError(['show-ref', '--verify', `refs/heads/${branch}`], local)
  if (local.status === 0) {
    const checkedOut = trees.find((t) => t.branch === branch)
    found.push(`the local branch ${branch} already exists${checkedOut ? `, checked out in ${checkedOut.where}` : ''}`)
  }
  // Asked of the destination the push will write to (`pushDestination`), not of `origin` by name.
  const remote = run(root, ['ls-remote', '--exit-code', '--heads', destination, `refs/heads/${branch}`])
  if (remote.status === 0) found.push(`origin already has a branch ${branch}`)
  else if (remote.status !== 2) throw new GitError(['ls-remote', 'origin'], remote)
  if (trees.some((t) => path.resolve(t.where) === path.resolve(worktree))) found.push(`${worktree} is already a worktree of this repository`)
  return found
}

/** The folder of the installation's worktree: beside the checkout, in `<checkout>.worktrees/`. */
export function worktreePath(root, branch) {
  return path.join(`${root}.worktrees`, branch.replace(/[^A-Za-z0-9._-]/g, '-'))
}

// ------------------------------------------------------------------ making the commit

/**
 * What of the installation exists now, found by asking git rather than by assuming from where a
 * step failed (a hook can fail after git has made the worktree and the branch, and a push can fail
 * after origin has the branch): `{ worktree, local, remote }`. `worktree` is whether the repository
 * lists a worktree at `dir`; `local` the full SHA of the local branch or `null`; `remote` the SHA
 * `origin` has for the branch or `null`. Each is `undefined` when git could not say.
 */
export function inspectInstallation(run, root, { dir, branch, destination }) {
  const found = { worktree: undefined, local: undefined, remote: undefined }
  const listed = run(root, ['worktree', 'list', '--porcelain'])
  if (listed.status === 0) {
    found.worktree = listed.stdout.split('\n').some((l) => l.startsWith('worktree ') && path.resolve(l.slice('worktree '.length).trim()) === path.resolve(dir))
  }
  const local = run(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  if (local.status === 0) found.local = local.stdout.trim()
  else if (local.status === 1) found.local = null
  const remote = run(root, ['ls-remote', '--heads', destination, `refs/heads/${branch}`])
  if (remote.status === 0) found.remote = remote.stdout.trim() === '' ? null : remote.stdout.trim().split(/\s+/)[0]
  return found
}

/** Adds the worktree `dir` on a new branch at `base`. */
export function addWorktree(run, root, branch, dir, base) {
  gitOut(run, root, ['worktree', 'add', '--quiet', '-b', branch, dir, base])
}

/** Stages exactly the files `rels`, each by its own path. */
export function stageFiles(run, dir, rels) {
  gitOut(run, dir, ['add', '--', ...rels])
}

/** The blob id git gives `content`, as a SHA-1 repository does. */
function blobId(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

/**
 * Checks that what changed against the base is exactly the addition of `expected` (a map from path
 * to the bytes it was generated with): each an added regular file, with the blob git stores for
 * those bytes. `against` ends the `git diff` command: `['--cached', base]` for the index against
 * the base, `[base, commit]` for a commit against it. Resolves a list of problems, empty when the
 * diff is the installation and nothing else.
 */
export function checkAdditions(run, dir, against, expected) {
  const text = gitOut(run, dir, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--ignore-submodules=none', ...against])
  const problems = []
  const seen = new Set()
  for (const entry of parseRaw(text)) {
    const rel = entry.path
    seen.add(rel)
    if (!expected.has(rel)) {
      problems.push(`${rel}: a change that is not one of the files the installation adds`)
    } else if (entry.status !== 'A' || !/^0+$/.test(entry.oldMode)) {
      problems.push(`${rel}: expected an added file, git reports ${STATUS_WORDS[entry.status] ?? entry.status}`)
    } else if (entry.newMode !== '100644') {
      problems.push(`${rel}: expected a regular file, git reports mode ${entry.newMode}`)
    } else if (entry.newSha !== blobId(expected.get(rel))) {
      problems.push(`${rel}: its content is not what was generated`)
    }
  }
  for (const rel of expected.keys()) if (!seen.has(rel)) problems.push(`${rel}: missing from the diff`)
  return problems
}

/** Compare actual files as well as the entire staged diff, without trusting stat caches or filters. */
export function checkInventory(run, dir, base, expected) {
  const problems = checkAdditions(run, dir, ['--cached', base], expected)
  for (const [rel, content] of expected) {
    const file = path.join(dir, ...rel.split('/'))
    try {
      const info = lstatSync(file)
      if (!info.isFile() || info.isSymbolicLink() || !readFileSync(file).equals(Buffer.from(content))) {
        problems.push(`${rel}: its working-file bytes or type are not what was generated`)
      }
    } catch (error) {
      problems.push(`${rel}: cannot verify its working-file bytes (${error.code ?? error.message})`)
    }
  }
  // Detect edits to preserved files and unexpected untracked/ignored entries as well.
  const status = gitOut(run, dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored'])
  for (const record of status.split('\0').filter(Boolean)) {
    if (record.slice(0, 3) !== 'A  ' || !expected.has(record.slice(3))) {
      problems.push(`${record.slice(3)}: unexpected worktree or index change (${record.slice(0, 2)})`)
    }
  }
  return problems
}

/**
 * Commits what is staged, with the checkout's configured identity; the caller disables hooks. Resolves the
 * commit's full SHA and every parent, so verification cannot miss imported merge history.
 */
export function commitStaged(run, dir, message) {
  gitOut(run, dir, ['commit', '--quiet', '-m', message])
  const [commit, ...parents] = gitOut(run, dir, ['rev-list', '--parents', '--max-count=1', 'HEAD']).trim().split(' ')
  return { commit, parents }
}

/**
 * Pushes the verified `commit` to `branch` at `destination` (the URL `pushDestination` found, so that
 * no `remote.origin.*` push setting applies) as a new branch only: the lease expects the branch not
 * to exist there, so a branch another run created in the meantime makes the push fail instead of
 * being updated. The explicit refspec is the only ref sent: tags are not followed, the push is not
 * signed and submodules are not pushed, whatever the caller's `push.*` settings say.
 * The mutable local branch is never the source: it may advance after commit verification.
 */
export function pushNewBranch(run, dir, branch, destination, commit) {
  if (!FULL_SHA.test(commit ?? '')) throw new Error('publication requires the verified commit\'s full SHA')
  gitOut(run, dir, [
    'push',
    '--no-follow-tags',
    '--no-signed',
    '--no-push-option',
    '--recurse-submodules=no',
    destination,
    `${commit}:refs/heads/${branch}`,
    `--force-with-lease=refs/heads/${branch}:`,
  ])
}

/**
 * Where a push of the installation would write, read before anything is made: every URL
 * `git remote get-url --push --all origin` gives (so after `remote.origin.pushurl` and
 * `url.*.pushInsteadOf`). There must be exactly one, and `accepts(url)` must say it is a GitHub URL
 * naming the repository init installs into. Resolves that URL. Throws `Refusal` naming the URL and
 * what to clear.
 */
export function pushDestination(run, root, accepts) {
  const pushes = run(root, ['remote', 'get-url', '--push', '--all', 'origin'])
  if (pushes.status !== 0) {
    throw new Refusal('init could not read where a push to origin would go (git remote get-url --push --all origin failed): fix the remote, or run init from another checkout')
  }
  const urls = pushes.stdout.split('\n').map((u) => u.trim()).filter((u) => u !== '')
  const elsewhere = urls.filter((u) => !accepts(u))
  const how = 'clear remote.origin.pushurl and any url.<base>.insteadOf or pushInsteadOf that rewrites it, or run init from another checkout'
  if (urls.length === 0 || elsewhere.length > 0) {
    throw new Refusal(`a push to origin would go to ${elsewhere.length > 0 ? elsewhere.join(', ') : 'nowhere'}, which is not a GitHub URL naming the repository init installs into: ${how}`)
  }
  if (new Set(urls).size > 1) {
    throw new Refusal(`a push to origin would go to more than one place (${urls.join(', ')}); init pushes to one: ${how}`)
  }
  return urls[0]
}

/**
 * Checks that `main` on the push `destination` is the commit fetched from `origin` as the base, so
 * that the place the base was read from and the place the branch will be written to are one
 * repository. Throws `Refusal` when they differ (or `main` moved in between: run init again), and
 * an ordinary error when the destination cannot be read.
 */
export function assertSameMain(run, root, destination, base) {
  const listed = run(root, ['ls-remote', '--heads', destination, 'refs/heads/main'])
  if (listed.status !== 0) throw new GitError(['ls-remote', destination], listed)
  const sha = listed.stdout.trim().split(/\s+/)[0] || null
  if (sha !== base) {
    throw new Refusal(
      `main at ${destination}, where the branch would be pushed, is ${sha ?? 'missing'}, not ${base}, the commit fetched from origin: the fetch and the push go to different places, or main moved just now; run init again`,
    )
  }
}

/** Refuse inherited Git overrides before even discovering the repository; never print their values. */
export function assertGitEnvironment(env) {
  const keys = Object.keys(env).filter((key) => /^GIT_/i.test(key) && env[key] !== undefined)
  if (keys.length > 0) {
    throw new Refusal(`unsupported inherited Git environment: ${keys.join(', ')}. Run init from a fresh terminal with these variables unset, outside a Git hook; no fetch or worktree was attempted`)
  }
}

const simpler = 'run init from an ordinary checkout without this setting, or remove it from the named configuration source'

/** Resolve symlinks in an existing path or its nearest existing ancestor. Errors refuse preflight. */
function physicalPath(file) {
  try {
    return realpathSync(file)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = path.dirname(file)
    if (parent === file) throw error
    return path.join(physicalPath(parent), path.basename(file))
  }
}

function inside(file, dir) {
  const relative = path.relative(dir, file)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/**
 * The 0.1 supported-environment boundary: inspect included configuration with sources and refuse
 * rewrites, pushurl, worktree configuration, unsafe hooks paths, absent identity or signing.
 * No configuration is repaired. Called before fetch and rechecked in the installation worktree.
 */
export function assertConfigApplies(run, root) {
  const listed = run(root, ['config', '--null', '--show-origin', '--includes', '--list'])
  const unknown = (why) => new Refusal(`cannot inspect effective Git configuration: ${why}; ${simpler}`)
  if (listed.status !== 0) throw unknown(listed.stderr || 'git config --list failed')
  const fields = listed.stdout.split('\0')
  if (fields.pop() !== '' || fields.length % 2 !== 0) throw unknown('unrecognised git config output')
  const settings = []
  for (let i = 0; i < fields.length; i += 2) {
    const source = fields[i]
    const [key, ...value] = fields[i + 1].split('\n')
    if (!source || !key) throw unknown('a key or source is missing')
    settings.push({ key: key.toLowerCase(), source, value: value.join('\n') })
  }
  const refuse = (entry, why = 'unsupported for init 0.1') => {
    throw new Refusal(`${entry.key} from ${entry.source}: ${why}; ${simpler}`)
  }
  for (const entry of settings) {
    if (/^url\..*\.(insteadof|pushinsteadof)$/.test(entry.key) || entry.key === 'remote.origin.pushurl' || entry.key === 'core.worktree') refuse(entry)
    // Git resolves a remote operand as a configured name before treating it as a literal URL.
    // A URL-shaped name could therefore redirect even an origin URL with no rewrite rules.
    if (/^remote\.(?:[a-z][a-z0-9+.-]*:\/\/|git@[^/]+[:/])/.test(entry.key)) {
      refuse(entry, 'a URL-shaped remote name can override the validated origin destination')
    }
    if (entry.key.startsWith('includeif.')) refuse(entry, 'conditional configuration cannot be established for the new branch and worktree during read-only preflight')
  }
  const replacements = run(root, ['for-each-ref', '--format=%(refname)', 'refs/replace/'])
  const replacementRemedy = 'run init from an ordinary checkout without local replacement refs; inspect them with git replace --list'
  if (replacements.status !== 0) {
    throw new Refusal(`cannot inspect local Git replacement refs (${replacements.stderr.trim()}); ${replacementRemedy}`)
  }
  if (replacements.stdout.trim() !== '') {
    throw new Refusal(`local Git replacement refs are unsupported (${replacements.stdout.trim().split('\n').join(', ')}); ${replacementRemedy}`)
  }
  const bool = (key) => {
    const result = run(root, ['config', '--bool', '--get', key])
    if (result.status === 1) return false
    if (result.status !== 0 || !['true', 'false'].includes(result.stdout.trim())) throw unknown(`unreadable ${key} from ${settings.findLast((s) => s.key === key.toLowerCase())?.source ?? 'an unknown source'}`)
    return result.stdout.trim() === 'true'
  }
  if (bool('extensions.worktreeConfig')) {
    refuse(settings.findLast((s) => s.key === 'extensions.worktreeconfig'), 'enabled per-worktree config (config.worktree) is unsupported')
  }
  let metadata
  try {
    metadata = ['--absolute-git-dir', '--git-common-dir'].map((flag) => {
      const result = run(root, ['rev-parse', flag])
      if (result.status !== 0 || !result.stdout.trim()) throw unknown(`git rev-parse ${flag} failed`)
      return physicalPath(path.resolve(root, result.stdout.trim()))
    })
    for (const dir of new Set(metadata)) {
      const file = path.join(dir, 'config.worktree')
      try {
        lstatSync(file)
        throw new Refusal(`repository config.worktree at ${file} is unsupported even with extensions.worktreeConfig off; ${simpler}`)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    const entry = settings.findLast((s) => s.key === 'core.hookspath')
    if (entry) {
      const result = run(root, ['config', '--path', '--get', 'core.hooksPath'])
      if (result.status !== 0) throw unknown('core.hooksPath cannot be read')
      const hooks = result.stdout.trim()
      if (!path.isAbsolute(hooks)) refuse(entry, 'relative core.hooksPath is unsupported')
      const resolved = physicalPath(hooks)
      if (metadata.some((dir) => inside(resolved, dir)) || resolved.split(path.sep).some((part) => part.toLowerCase() === '.git')) {
        refuse(entry, 'core.hooksPath resolves inside Git metadata')
      }
    }
  } catch (error) {
    if (error instanceof Refusal) throw error
    throw unknown(error.message)
  }
  for (const key of ['user.name', 'user.email']) {
    const value = run(root, ['config', '--get', key])
    if (value.status !== 0 || value.stdout.trim() === '') {
      throw new Refusal(`${key} is missing, blank or unreadable in effective Git configuration; configure it with git config ${key} <your-value> in an ordinary checkout before running init`)
    }
  }
  if (bool('commit.gpgSign')) {
    refuse(settings.findLast((s) => s.key === 'commit.gpgsign'), 'enabled commit.gpgSign is unsupported; use a checkout with commit.gpgSign false')
  }
}

/** The settings, and identities Git derives from them, that decide who commits and whether it signs. */
const COMMIT_SETTINGS = ['user.name', 'user.email', 'user.signingkey', 'commit.gpgsign', 'tag.gpgsign', 'gpg.format', 'gpg.program']

/**
 * Checks that a commit made in the new worktree `dir` would be made as the checkout at `root` would
 * make it: the same effective value of each of `COMMIT_SETTINGS` and the same author and committer
 * identities (an `includeIf` on the branch or the git folder can differ between the two). Throws
 * naming the first difference.
 */
export function assertSameCommitter(run, root, dir) {
  const same = (args, label) => {
    const here = run(root, args)
    const there = run(dir, args)
    const strip = (r) => (r.status === 0 ? r.stdout.trim().replace(/ \d+ [+-]\d{4}$/, '') : `(unset, status ${r.status})`)
    if (strip(here) !== strip(there)) {
      throw new Error(`a commit in the new worktree would not be made as this checkout makes it: ${label} is ${strip(there)} there and ${strip(here)} here`)
    }
  }
  for (const key of COMMIT_SETTINGS) same(['config', '--get', key], key)
  same(['var', 'GIT_AUTHOR_IDENT'], 'the author')
  same(['var', 'GIT_COMMITTER_IDENT'], 'the committer')
}

/** Remove only a worktree verified clean, including files Git's own removal would ignore. */
export function removeWorktree(run, root, dir, commit) {
  if (!FULL_SHA.test(commit ?? '')) throw new Error('cleanup requires the verified commit\'s full SHA')
  const head = gitOut(run, dir, ['rev-parse', '--verify', 'HEAD^{commit}']).trim()
  if (head !== commit) throw new Error(`the installation worktree HEAD is now ${head}, not the verified commit ${commit}; nothing was removed`)
  const status = gitOut(run, dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored', '--ignore-submodules=none'])
  if (status !== '') throw new Error('the installation worktree is not clean, including untracked or ignored files; nothing was removed')
  // These flags can hide changed tracked files from both status and worktree remove. A foreign
  // process may set them while the PR request is pending; do not infer ownership of that work.
  const marked = gitOut(run, dir, ['ls-files', '-v', '-z']).split('\0').filter((entry) => /^[a-zS] /.test(entry))
  if (marked.length > 0) throw new Error('the installation worktree has assume-unchanged or skip-worktree entries; nothing was removed')
  gitOut(run, root, ['worktree', 'remove', dir])
}
