---
id: OQ-98
title: Pin that a GraphQL error fails a draft conversion even when the response says it is a draft
tier: normal
kind: workflow
depends_on: []
model: sonnet
blocked: null
---

## Intent

As the owner, I want a test to fail if `convertPullRequestToDraft` stops
checking a GraphQL `errors` array, so that a refactor cannot quietly turn a
failed conversion into a success. `story.mjs` commits `blocked:` on a stopped
story only after the conversion reports the pull request is a draft. If an
error response were taken as success, that commit would land on a pull request
that is still ready, which breaks the rule that a `blocked:` story is always a
draft.

## Acceptance criteria

- [ ] **AC-1** — `scripts/dispatch/github.test.mjs` has a new test, named for
      `OQ-98/AC-1`. Its GraphQL response carries a non-empty `errors` array
      **and** `data.convertPullRequestToDraft.pullRequest.isDraft: true`. The
      test asserts that `convertPullRequestToDraft` rejects, with a message
      that includes the error's `message`.
- [ ] **AC-2** — The test fails when the `json.errors` check in
      `convertPullRequestToDraft` is removed, and passes with it in place. The
      PR's **Verification** reports both runs: the command, and the result
      with the check removed and restored. The removal is not committed.

## Out of scope

- **Any change to `scripts/dispatch/github.mjs`.** The check exists and is
  correct; this story only pins it.
- **Changing the existing test** "OQ-87/AC-1: a GraphQL error response throws,
  and a missing draft state is not taken as success". It stays as it is. The
  new test sits beside it.
- **`story.mjs`'s handling of a failed conversion.** It is already tested in
  `story.test.mjs`, with a stubbed `convertPullRequestToDraft`.

## Constraints

*(none)*

## Context

- `scripts/dispatch/github.mjs`, `convertPullRequestToDraft` (OQ-87, #153):
  after the mutation, it throws if `json.errors` is a non-empty array, then
  reads `json.data?.convertPullRequestToDraft?.pullRequest?.isDraft` and
  throws if that is not a boolean.
- `scripts/dispatch/github.test.mjs`, `describe('OQ-87/AC-1: converting a pull
  request to a draft')`: the existing error test's fixture is
  `{ errors: [{ message: 'Resource not accessible' }] }` with no `data`. With
  the `errors` check removed, the missing `isDraft` still throws, so that test
  still passes. The fixtures there use `ctxWith` and `NODE_ID`.
- #153's "Notes from the runner": "One probe survives. With the `json.errors`
  check removed, the GraphQL-error test still passes. The fixture's `data` is
  null, so the missing `isDraft` throws anyway. A response carrying both
  `errors` and `isDraft: true` would be taken as success, and no test pins
  that case."
- `scripts/dispatch/story.mjs`, `stop()`: it records `blocked:` only when
  `convertPullRequestToDraft` returned `draft: true`, and says so in a comment,
  so that a `blocked:` story is never left ready.
- Raised by the dispatcher session on 2026-09-28; the owner chose a
  test-only story.

## Open questions

*(none)*
