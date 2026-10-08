---
id: OQ-119
title: After review-blocked is removed by hand, count only the blocks recorded since
tier: normal
kind: workflow
depends_on: []
model: sonnet
blocked: "Held for the move to steward, decided 2026-10-08 by the owner (docs/agent-workflow-design.md, Portability, R4)"
---

## Intent

As the owner, I want removing `review-blocked` from a pull request to mean
"I've seen it, carry on", so that the next block does not put the label straight
back. Today `decideReviewBlocked` (`scripts/land/apply-review-blocked.mjs`)
applies the label whenever it is absent and the pull request has three or more
blocking verdicts. After a removal by hand, the count is still three or more, so
the next marker comment re-applies it. Only blocks recorded after the removal
should count towards applying it again.

## Acceptance criteria

- [ ] **AC-1** — `applyReviewBlocked` reads the pull request's issue events
      (`GET repos/<repo>/issues/<pr>/events`, all pages) and finds the latest
      `unlabeled` event whose `label.name` is `review-blocked`. When there is
      one, only comments whose `created_at` is later than that event's
      `created_at` count towards the bound. When there is none, every comment
      counts, as today.
- [ ] **AC-2** — Tests of the decision, with comments and events as data:
      - no removal and three honoured blocks: applied (unchanged);
      - removed after three blocks, then two more: not applied;
      - removed after three blocks, then three more: applied;
      - removed twice: only blocks after the second removal count;
      - a block whose `created_at` equals the removal's does not count;
      - a label already present is left as it is (unchanged).
- [ ] **AC-3** — A test of `applyReviewBlocked` with an injected `api` shows
      the events request it makes, and that it still never calls the
      labels-removal endpoint.
- [ ] **AC-4** — `review-gate.yml`'s `permissions:` add `issues: read`, with
      a comment saying it is for AC-1's events request. The comment above
      `pull-requests: write` (`review-gate.yml` lines 57–59, "Nothing here
      removes a label or reads anything the `read` scope did not already
      cover") is corrected to match.
- [ ] **AC-5** — The three places that say the label is never reapplied are
      corrected to say what AC-1 does: the header of
      `scripts/land/apply-review-blocked.mjs` (lines 18–20), the comment in
      `review-gate.yml` (lines 38–39), and the title of the
      `describe` block in `scripts/land/apply-review-blocked.test.mjs`
      (line 65, "OQ-80/AC-2: applied once, never removed or reapplied"), whose
      `OQ-80/AC-2` id stays.
- [ ] **AC-6** — The **Planned (OQ-119)** sentence in
      `docs/agent-workflow-design.md`, "Merging", is resolved as that
      document's "Reading this document" note says.

## Out of scope

- **What `story.mjs` does at the bound.** It counts every honoured block on
  the pull request (`countBlockingVerdicts`, `MAX_ROUNDS`) and stops the
  story; a label removal does not change that. Carrying on a stopped story is
  still Session A's, by clearing `blocked:`.
- **Who removed the label.** Any `unlabeled` event counts.
- **Comments edited after the removal.** A comment counts by its
  `created_at`, not by when it was last edited.
- **The breaker's threshold and exemptions** in `land-approved.yml`.
- **Sharing the marker parser with `github.mjs`.** That is OQ-120.

## Constraints

*(none)*

## Context

- `scripts/land/apply-review-blocked.mjs` (OQ-80): `decideReviewBlocked`,
  `countBlockingVerdicts`, `applyReviewBlocked`, which reads comments with
  `.[] | {body: .body, authorAssociation: .author_association}` and so does
  not read `created_at` today.
- `.github/workflows/review-gate.yml`: the `verdict` job runs
  `node scripts/land/apply-review-blocked.mjs` with `GH_TOKEN` set to
  `github.token`. Its `permissions:` are `contents: read`,
  `statuses: write` and `pull-requests: write`.
- Why AC-4 adds `issues: read` rather than leaving it to be found out:
  GitHub's "Permissions required for GitHub Apps" (read 2026-10-08) lists
  `GET /repos/{owner}/{repo}/issues/{issue_number}/events` under both
  "Issues" (read) and "Pull requests" (read), each with the "Additional
  permissions" mark. That page says the mark means either that more than one
  permission is needed or that any one of a set will do, without saying
  which applies here. So `pull-requests: write` alone may or may not be
  enough, and the gate's workflow cannot be tried on the pull request that
  changes it for an `issue_comment` run, which runs from the default branch.
  Adding the `read` settles it either way.
- GitHub's "Issue event types" reference (read 2026-10-08): an `unlabeled`
  event carries `created_at` and `label.name`, and applies to pull requests as
  well as issues.
- OQ-80's AC-2 (`stories/done/OQ-80-review-blocked-label.md`): "Removing it
  is a deliberate human act meaning 'I have seen the cost, proceed'". Its
  test covers a pull request that still carries the label, not one it was
  removed from. The dispatcher raised the gap after #203 landed; the owner
  decided on 2026-10-08 to count only blocks recorded after the removal.

## Open questions

*(none)*
