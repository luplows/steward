---
id: OQ-99
title: Have the verdict report cover every pull request by default, and say when a limit cut it short
tier: later
kind: workflow
depends_on: []
model: sonnet
blocked: null
---

## Intent

As the owner, I want `scripts/report/review-verdicts.mjs` run with no flags
to report on every pull request, and a run capped by `--limit` to say that it
is partial. OQ-47's AC-1 asks for a tally "across all gated pull requests".
Today the default covers only the 60 most recent (`DEFAULT_LIMIT`), and the
output does not say so, so whoever runs it next gets a partial count that
looks complete.

## Acceptance criteria

- [ ] **AC-1** — Run with no `--limit`, the report scans every pull request in
      the repository. It pages through the listing until a page holds fewer
      than 100, and no cap is applied. A test with an injected `fetch`
      serving 250 pull requests over three pages asserts that all 250 are
      scanned.
- [ ] **AC-2** — `--limit N` still caps the scan at the N most recent pull
      requests. The tally gains a boolean field, `limited`, that is `true`
      exactly when the repository has more pull requests than were scanned,
      and `false` otherwise, including every run with no `--limit`. When
      `limited` is `true`, the text report's line for pull requests scanned
      also says the scan was capped by `--limit`, so older pull requests are
      not counted. When it is `false`, the text says nothing about a limit.
      Tests cover:
      - `--limit 3` over 5 pull requests: `limited` is `true`, and the text
        says the scan was capped;
      - `--limit 5` over 5 pull requests: `limited` is `false`;
      - `--limit 100` over exactly 100 pull requests, the second page empty:
        `limited` is `false`;
      - `--limit 100` over 101 pull requests: `limited` is `true`.
- [ ] **AC-3** — The module header's **Usage** and its paragraph about
      `--limit` say that the default is every pull request and that
      `--limit` caps the scan. Nothing in the module or its tests still
      describes 60 as the default. The existing test "DEFAULT_LIMIT is a
      positive integer the CLI falls back to" pins the default this story
      removes. It is replaced by AC-1's test, or rewritten to assert that the
      default applies no cap. This criterion authorises that change and no
      other to what OQ-47's tests assert. An existing test's call may change
      to a new signature or return shape, as long as it still asserts what it
      asserted before.

## Out of scope

- **The over-count of stale markers.** `actedOnVerdicts` applies no head
  check, so it also counts a marker the gate ignored as stale when it was
  posted (#169's round-4 review). On 2026-09-28 the owner chose to follow
  up only the default limit.
- **Rate limits, tokens and caching.** A full run needs a token in practice.
  How the script reads `GITHUB_TOKEN` or `GH_TOKEN` does not change.
- **Changing the tally's other fields**, or the order and wording of the
  report's other lines.

## Constraints

*(none)*

## Context

- `scripts/report/review-verdicts.mjs` (OQ-47, #169):
  - `DEFAULT_LIMIT` is 60.
  - `listRecentPullRequests(ctx, limit)` pages 100 at a time, newest first,
    stops when `all.length >= limit` or a page holds fewer than 100, and
    returns `all.slice(0, limit)`.
  - `gatherVerdicts(ctx, { limit = DEFAULT_LIMIT })` calls it, and `main`
    passes `--limit` or `DEFAULT_LIMIT`.
  - `tallyVerdicts` sets `pullRequestsScanned`, and `formatReport` prints it
    as `Pull requests scanned: <n>`.
  - The module's allowlist admits the pull-request listing only as
    `?state=all&sort=created&direction=desc&per_page=100&page=<n>`.
- `scripts/report/review-verdicts.test.mjs`: the existing tests call
  `gatherVerdicts` with `limit: 1` and `limit: 3` through an injected `fetch`.
  The test "DEFAULT_LIMIT is a positive integer the CLI falls back to" asserts
  only that `DEFAULT_LIMIT` is a positive integer (AC-3).
- #169's round-4 review, observation 2: "DEFAULT_LIMIT is 60 … so a run
  without --limit reports only the 60 most recent. Full coverage needs
  --limit of at least the PR count." The run recorded in #169 used
  `--limit 500` and scanned all 169.
- Raised by the dispatcher session on 2026-09-28. The owner asked for a small
  story at low priority, so it is `later`.

## Open questions

*(none)*
