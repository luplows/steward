// The protected paths (ST-106): the files that define how a project is reviewed and landed. A pull
// request that changes one is reviewed as any other, and lands only when a person asks
// (`steward land <pr-number>`). The runway (`runway.mjs`) enforces it, taking this list from the
// steward release it runs; the pilot (`scripts/dispatch/land.mjs`) uses it only to save a dispatch
// and say why. The list is fixed here, in one place. Pure: it imports nothing and reads nothing.

/** A path starting with one of these is protected. */
export const PROTECTED_PREFIXES = ['.github/workflows/', '.claude/']

/** Exactly this path is protected, as is the project's `rulesFile`. */
export const PROTECTED_SETTINGS_PATH = 'steward.config.json'

/** Whether `path` is protected, given the project's `rulesFile`. Compared case-sensitively. */
export function isProtectedPath(path, rulesFile) {
  if (typeof path !== 'string') return false
  return PROTECTED_PREFIXES.some((prefix) => path.startsWith(prefix)) || path === PROTECTED_SETTINGS_PATH || path === rulesFile
}

/**
 * The protected paths a pull request changes, each once, in the order found. `files` is the pull
 * request's files as GitHub lists them: `{ filename, previous_filename? }`. A moved file counts by
 * its old path as well as its new one.
 */
export function protectedPathsChanged(files, rulesFile) {
  const found = new Set()
  for (const { filename, previous_filename: previous } of files) {
    for (const path of [filename, previous]) if (isProtectedPath(path, rulesFile)) found.add(path)
  }
  return [...found]
}
