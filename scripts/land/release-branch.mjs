// The one definition of a release branch's name (ST-45): `release/v<major>.<minor>.<patch>`,
// each part a non-negative integer written without leading zeros, as a semantic version is.
// The release review cuts one for each release (docs/release-review.md), and steward reviews,
// checks and lands a pull request into one as it does one into `main`.

export const RELEASE_BRANCH_RE = /^release\/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/

/** Whether `name` is a release branch's name. */
export function isReleaseBranch(name) {
  return typeof name === 'string' && RELEASE_BRANCH_RE.test(name)
}

/** Whether steward reviews and lands a pull request into `base`: `main` or a release branch. */
export function isLandingBase(base) {
  return base === 'main' || isReleaseBranch(base)
}
