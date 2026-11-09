---
id: ST-76
title: Close explicitly linked GitHub Issues after runway landing
tier: normal
kind: product
depends_on: [ST-54]
model: null
blocked: null
---

## Intent

As a crew member using GitHub Issues as units, I want the runway to close the explicitly linked
issue when its complete implementation lands, so that unattended landing does not leave routine
issue cleanup to the crew.

## Acceptance criteria

- [ ] **AC-1** — After the runway successfully merges a PR into `main`, it examines that PR's
      body for one authoritative `Unit: #<n>` in the same repository and an explicit
      `Closes #<n>` referring to that same Issue. With `issue` enabled in the project's
      `unitLinks`, it explicitly closes that Issue through the GitHub API. The same behavior
      applies to manual and unattended runway landings. An already-closed Issue is a successful
      no-op, not an error.
- [ ] **AC-2** — A PR with no matching explicit `Closes #<n>` leaves the Issue open. A missing,
      file-based, unreadable or ambiguous unit reference, additional conflicting closing
      references, or a closing reference to another Issue results in no automatic Issue closure
      and an actionable explanation. A bare `Unit: #<n>` never suffices to close an Issue.
- [ ] **AC-3** — Refused, skipped and failed merges close no Issue. A runway merge into a release
      branch closes no Issue. Issue closure happens only after the merge has succeeded, and is
      not an additional gate on which PRs may merge.
- [ ] **AC-4** — Both Steward's own `.github/workflows/land-approved.yml` and the installed
      `templates/workflows/land-approved.yml` grant `issues: write` to the existing
      GitHub Actions `github.token` for the bounded post-merge Issue update. No new token,
      GitHub App, secret or merge identity is introduced.
- [ ] **AC-5** — When the post-merge Issue read or update fails, the landing is still reported
      as merged. The workflow emits a visible warning identifying the PR and Issue and explaining
      that the crew must close it manually; a closure failure does not retry or undo the merge.
      Repeated cleanup of an Issue already closed is harmless.
- [ ] **AC-6** — Tests using injected GitHub and merge stand-ins cover a successful default-branch
      landing (manual and unattended), already-closed Issue, missing or mismatched closing
      reference, extra conflicting reference, file or missing unit, disabled Issue links,
      release-branch landing, failed or refused merge, and failed Issue API read/update. Tests
      verify that only the matching same-repository Issue can be updated and that both workflow
      variants grant the required permission, without making real GitHub mutations.
- [ ] **AC-7** — Validate explicit post-merge closure on an authorized public scratch repository,
      recording the PR, Issue, workflow run and observed final Issue state. Also record the result
      of a landing with no `Closes #<n>`; do not claim the API remedy works solely from the
      existing controlled merge-token comparison.
- [ ] **AC-8** — Explain the `Unit: #<n>` plus `Closes #<n>` requirement, main-only behavior
      and manual recovery from API failure in project-facing guidance. Remove the
      `**Planned (ST-76)**` marker from `docs/agent-workflow-design.md` when implemented.

## Out of scope

- Closing an Issue from `Unit:` alone, from arbitrary Issue mentions, or from multiple units.
- Closing Issues in other repositories, auto-closing parent features, or supporting partial
  completion of a unit. A unit must be independently complete; split larger work before handoff.
- Changing GitHub's native behavior for manually merged PRs, or replacing the runway's merge token.
- Automatic post-crash reconciliation or retries of a merge that already succeeded.
- Adversarial edits of PR descriptions between review and merge; this covers normal crew-authored,
  review-gated PRs.
- Reinvestigating whether a squash message or `issues: write` alone triggers GitHub's native
  automatic closure; the public controlled comparison already distinguishes those behaviors.

## Constraints

The bounded case is one crew-reviewed PR implementing one Issue in the same repository, landed
by Steward's existing runway. The reviewed unit stays the source of truth; issue-closing
references express completion, not additional work authorization. Post-merge Issue updates use
only the workflow's `github.token`.

## Context

- Public controlled experiment on 2026-11-04 with Steward `935fb5b`: playground PR
  [#20](https://github.com/luplows/playground/pull/20) merged through the runway without
  `issues: write` and left issue [#3](https://github.com/luplows/playground/issues/3)
  open. PR [#21](https://github.com/luplows/playground/pull/21) merged with that permission
  and still left issue [#5](https://github.com/luplows/playground/issues/5) open.
  PR [#22](https://github.com/luplows/playground/pull/22) merged by the crew and closed
  issue [#7](https://github.com/luplows/playground/issues/7). All PR bodies used
  `Closes #n`; GitHub identified the closing references. Direct API closure remains untested.
- The v0.2.0 walkthrough at Steward `8d06431` observed playground issue #32 still open
  after unattended landing of PR #33 (reported 2026-11-09).
- `scripts/land/runway.mjs` merges with `gh pr merge --squash --match-head-commit` and
  currently performs no Issue update. `scripts/dispatch/unit.mjs` identifies the unit in
  a PR body; `templates/workflows/land-approved.yml` supplies `github.token`.
- ST-92 owns generation of `Unit: #n` and `Closes #n` for approved Issue handoffs.
  ST-75 separately explains why `push` workflows do not run after a runway landing.
- Crew decisions, 2026-11-09: use explicit Issue closure after a successful merge; close only
  the linked Issue when a matching `Closes #n` is present; favor ordinary expected conditions
  over a new authorization system. Target v0.3.0 without making this a dependency of coding
  and PR publication.

## Open questions

*(none)*
