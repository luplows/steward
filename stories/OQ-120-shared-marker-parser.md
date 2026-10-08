---
id: OQ-120
title: Count review-blocked's blocks with github.mjs's marker parser, not a copy of it
tier: normal
kind: workflow
depends_on: []
model: sonnet
blocked: "Held for the move to steward, decided 2026-10-08 by the owner (docs/agent-workflow-design.md, Portability, R4)"
---

## Intent

As the owner, I want one piece of code to decide what verdict a marker
comment carries, so that the label the circuit breaker counts and the round
bound `story.mjs` enforces cannot disagree about which comments are blocks.
`scripts/land/apply-review-blocked.mjs` (OQ-80) reads markers with its own
`MARKER_RE` and `lastVerdict`, and treats `fail` as `block` itself, while
`story.mjs` reads them through `github.mjs`'s `parseMarkerComment`. They agree
today, but nothing would fail if one changed and the other did not.

## Acceptance criteria

- [ ] **AC-1** — `countBlockingVerdicts` in
      `scripts/land/apply-review-blocked.mjs` decides each comment's verdict
      with `parseMarkerComment` from `scripts/dispatch/github.mjs`. A comment
      counts when it parses as `kind: 'marker'` with `verdict: 'block'` and
      its author is honoured (`isHonouredAuthor`, as now). The deprecated
      `fail` spelling counts because `parseMarkerComment` maps it to `block`,
      not because this module does.
- [ ] **AC-2** — `apply-review-blocked.mjs` no longer defines a marker
      pattern or a verdict mapping of its own: `MARKER_RE` and `lastVerdict`
      are gone. A test asserts that the module imports `parseMarkerComment`
      from `../dispatch/github.mjs` and defines no regular expression that
      matches `agent-review`, as `scripts/dispatch/review.test.mjs`'s
      "OQ-83/AC-5" test checks `writer-prs.mjs` for its own copy.
- [ ] **AC-3** — Every test in `scripts/land/apply-review-blocked.test.mjs`
      under "OQ-80/AC-3: only markers the gate itself honours are counted"
      passes with its expectations unchanged: malformed markers, authors
      without write access, `fail` counting as `block`, and the last
      well-formed marker in a comment winning.
- [ ] **AC-4** — The header comment of `apply-review-blocked.mjs` (lines
      13–16) says that markers are read with `github.mjs`'s
      `parseMarkerComment`, and no longer says the module keeps a
      transcription of the gate's pattern.

## Out of scope

- **When the label is applied after a removal by hand.** That is OQ-119.
  Both stories change `countBlockingVerdicts`; whichever lands second builds
  on the first.
- **`github.mjs`'s `WELL_FORMED_RE`**, and how it is checked against
  `review-gate.yml`.
- **The honoured-author sets.** `check-author.test.mjs` already ties
  `check-author.mjs`'s set to `review.mjs`'s and to `review-gate.yml`'s.
- **`ROUND_BOUND`**, already tied to `story.mjs`'s `MAX_ROUNDS` by a test.

## Constraints

*(none)*

## Context

- `scripts/land/apply-review-blocked.mjs`: `MARKER_RE` (lines 34–35),
  `lastVerdict` (lines 37–40), `countBlockingVerdicts` (lines 43–49).
- `scripts/dispatch/github.mjs`: `parseMarkerComment` returns
  `{ kind: 'marker', headSha, verdict, deprecatedSpelling, malformed }` for
  a comment with a well-formed marker, taking the last one, and maps `fail`
  to `block` (`DEPRECATED_VERDICTS`). It imports only `node:child_process`
  and `node:util`, and does nothing when imported, so the `verdict` job in
  `review-gate.yml` can load it.
- `scripts/dispatch/story.mjs`: its own `countBlockingVerdicts` counts
  comments whose parsed marker is a `block` from an honoured author.
- `scripts/land/apply-review-blocked.test.mjs`, "the marker pattern is the
  one review-gate.yml greps with, transcribed": it checks that
  `review-gate.yml` contains the pattern, not that `MARKER_RE` matches it.
- No non-test module under `scripts/land/` imports from
  `scripts/dispatch/` yet; `check-author.test.mjs` does. With the workflow
  moving to its own repository (OQ-115), both directories move together.
- Raised by the dispatcher in the review of #203 (OQ-80). The owner decided
  on 2026-10-08: one shared copy, not a test tying two copies together.

## Open questions

*(none)*
