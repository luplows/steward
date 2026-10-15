---
id: ST-27
title: Review and land an outside pull request once a member of the crew schedules it
tier: normal
kind: workflow
depends_on: [ST-25]
model: sonnet
blocked: null
---

## Intent

As a member of the crew, I want to schedule a pull request opened by someone
outside the crew, so that it is reviewed and can land through the same gate as
the crew's own work. Today the runway never lands it, whatever its verdict.

## Acceptance criteria

A first sketch, to be settled with the Open questions below.

- [ ] **AC-1** — The runway lands a pull request whose author the gate does not
      honour only when a member of the crew has scheduled it, as the answer to
      the first open question defines, and only at the head that was
      scheduled. Every other rule for landing still applies to it: a passing
      `review/agent` on the head, no `review-blocked`, and the circuit breaker.
- [ ] **AC-2** — A pull request from outside the crew that nobody in the crew
      has scheduled is still skipped, as today. `check-author.test.mjs`'s
      OQ-81 tests still pass unchanged.
- [ ] **AC-3** — A scheduling act counts only from an account the gate
      honours (`HONOURED_ASSOCIATIONS`, `scripts/land/check-author.mjs`). The
      same act by anyone else is ignored, and a test shows it.
- [ ] **AC-4** — ST-25's rotation command reviews a scheduled pull request
      from outside the crew. Its `outsider` skip (ST-25's AC-3 and AC-6)
      applies only to one that is not scheduled, and a test shows both.
- [ ] **AC-5** — `README.md`'s "From outside the crew" and
      `docs/agent-workflow-design.md` describe what is then built, and the
      `**Planned (ST-27)**` markers lose `ST-27`.

## Out of scope

- Who is honoured. `HONOURED_ASSOCIATIONS` is unchanged.
- Reviewing or landing an outside pull request without a crew member's act.
- Removing the reviewer's or the coder's access to the crew member's
  credentials: ST-6, a spike, and the stories it recommends.
- `scripts/dispatch/writer-prs.mjs` and the loop that runs it, which steward
  does not run.

## Constraints

*(none)*

## Context

- `.github/workflows/land-approved.yml`, the candidate loop: each pull request's
  `author_association` goes to `scripts/land/check-author.mjs`, and one not
  honoured is skipped before the breaker's exemptions (OQ-81).
- Who is reviewed: `scripts/dispatch/writer-prs.mjs` skips a pull request
  whose author is not honoured, with the outcome `outsider`, and `loop.mjs`
  runs it. ST-25's rotation command does the same (its AC-3 and AC-6), which is
  why this story depends on it, and until then the controller follows the same
  rule by hand (`docs/controller.md`, "A rotation"). `review.mjs` itself does
  not check the author, so a crew member can already have one reviewed by
  naming it, and the verdict counts, since ATC posts it under the crew member's
  credential.
- Reviewing a pull request runs its code: `review.mjs` installs its dependencies
  in the reviewer's checkout (`install.mjs`, `npm ci`, install scripts
  included), and the reviewer runs its tests. That checkout is on the crew
  member's machine, where an SSH key and a `gh` token are reachable
  (`docs/agent-workflow-design.md`, "Credential minimalism"; ST-6).
- Decided 2026-10-14 by the owner, while writing `README.md`'s contributing
  notes: outside work is scheduled by a member of the crew, and this story
  makes that possible, so that an outside contributor keeps the attribution
  for their work. Considered and not chosen: a crew member carrying the
  change in a pull request of their own, which lands as the crew member's,
  since the runway squash-merges (`gh pr merge … --squash`,
  `land-approved.yml`); and saying in `README.md` that only the crew's pull
  requests are reviewed and landed.

## Open questions

- **How does a member of the crew schedule one?** Options: a label, counted
  only when the account that applied it is honoured, read from the pull
  request's `labeled` events; an approving GitHub review from an honoured
  account, read from the reviews API, which reports each reviewer's
  `author_association`; or a marker comment from an honoured account, as the
  verdict is.
- **Is the schedule bound to a head?** A label or an approval survives a push,
  so a contributor could push a head no crew member looked at. Options: the
  schedule names the head SHA, as a verdict marker does; or a push clears it.
- **Does scheduling wait for ST-6 and the stories it recommends?** Reviewing
  an outside pull request runs its install scripts and tests with the crew
  member's credentials reachable (Context). Options: wait for them; or let the
  crew member's own look at the diff, before scheduling, be the guard.
- **Does the rotation review a scheduled outside pull request on its own**, or
  only when a crew member names it in a rotation request? AC-4 assumes on its
  own.
- **Does inspection (ST-29) watch a scheduled outside pull request** for a
  stall? ST-29 skips every pull request from outside the crew, since none is
  reviewed today.
