/**
 * What a checkout of a GitHub repository needs to say which repository it is and to be brought to
 * `origin`'s `main`, kept apart from `init.mjs` and `project.mjs` so that `inspect.mjs`'s command
 * line can reach `manual-checkout.mjs` without a cycle (`init.mjs` imports `inspect.mjs`).
 */

const ORIGIN_RE = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git@)github\.com(?::\d+(?=\/))?[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i

/**
 * `owner/name` (as written) from the URL of a GitHub repository, or `null` for anything else. The
 * scheme, the host and the `.git` suffix are read without regard to case. The forms are `https` or
 * `http` (with or without user info and a port), `ssh://` (with or without user info and a port),
 * and the scp-like `git@github.com:owner/name`, each with or without `.git` and a trailing slash.
 */
export function repoFromRemoteUrl(url) {
  const match = ORIGIN_RE.exec(String(url).trim())
  return match ? `${match[1]}/${match[2]}` : null
}

// What brings a checkout that has been cloned to origin's main, detached.
export const FETCH_MAIN = ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main']
export const CHECKOUT_MAIN = ['checkout', '--quiet', '--detach', 'refs/remotes/origin/main']
