---
id: ST-54
title: Allow an explicit manual landing when unattended landing is disabled
tier: next
kind: product
depends_on: []
model: null
blocked: null
---

## Intent

As a member of the crew, I want `steward land <pr-number>` to request one gated landing even
when my project has `land: false`, so that choosing independent review without unattended
landing does not force me to merge outside steward's review gate.

## Acceptance criteria

- [ ] **AC-1** — **Two authorizations.** The required boolean `land` setting means standing
      permission for unattended landing. `steward land <pr-number>` is an explicit manual
      request, valid with either value of `land`. The command reports its manual mode, project,
      PR number and full head SHA. It changes no project setting, label or standing permission.
      Tests invoke the CLI entry point with `land: false` and `land: true` and show the same
      eligible PR dispatched through the pilot in manual mode.
- [ ] **AC-2** — **Automatic callers stay automatic.** `landPullRequest`'s programmatic mode
      defaults to unattended; only the standalone `land` command selects manual mode. A rotation,
      and the existing frozen-loop callers, do not request manual mode. With `land: false` a
      rotation still reviews and inspects but sends no landing dispatch; a programmatic pilot
      call returns `landing-off`. Tests cover both, and show unattended landing with `land: true`
      still working. A true local setting cannot override a false setting read by the runway
      from the project's `main`.
- [ ] **AC-3** — **Explicit workflow scope.** Both `land-approved.yml` files, steward's and the
      thin template's, take `mode` (`unattended` by default), `pr`, and `head` inputs. A manual
      dispatch requires `mode: manual`, one positive PR number and a full 40-character head SHA;
      it authorizes only that PR at that head. The pilot binds the manual request to the first
      head it reads and includes that SHA in the dispatch. A later head change ends the request
      with `head-changed`, sends no further dispatch, and requires a new crew invocation.
      This applies while waiting for checks and after dispatch. Manual mode never falls back
      to the oldest candidate. Tests cover the dispatch body, strict allowlist validation, a
      head change before dispatch, and a head change after dispatch.
- [ ] **AC-4** — **The runway enforces authorization.** Before merging, the runway reads and
      validates `land` and `landWhen` from the project's settings on `main`. An unattended
      dispatch, including a direct workflow trigger with no mode or only a PR number, merges
      nothing when `land` is false. Missing, malformed or unreadable authorization settings
      fail closed, with a reason. Manual mode requires a `workflow_dispatch` event whose actor
      has write, maintain or admin permission on this repository, checked against GitHub; the
      actor comes from the workflow event context, never an input claiming an actor. A direct
      workflow trigger is a manual authorization only when it explicitly supplies manual mode,
      the PR and matching head. Unknown modes, missing scope, a head mismatch, an unqualified
      actor or an unreadable permission refuse the merge. Tests demonstrate each refusal and
      an authorized scoped manual dispatch with `land: false` succeeding.
- [ ] **AC-5** — **The same gate.** Manual authorization changes only the `land` restriction.
      It bypasses none of: an open non-draft PR against a supported landing base; honoured PR
      author; `review-blocked`; the circuit breaker and its existing exemptions; passing
      `review/agent` on the current head; the checks `landWhen` requires; GitHub mergeability;
      and the runway's final status re-check and `--match-head-commit` merge. The manual head
      must equal the current head at the runway as well as at the pilot. Tests with `land: false`
      show each failed prerequisite preventing merge, and a head change at the merge boundary
      refused. No call merges through the pilot or through a new merge path.
- [ ] **AC-6** — **Workflow parity and traceability.** The workflows pass mode, PR, head and
      trusted event context through environment values, never interpolated shell text. Update
      the existing thin-workflow parity tests to cover the new inputs and environment. The
      workflow log identifies the mode, actor, PR, authorized head and landing or refusal; an
      unattended dispatch logs its standing-authorization decision. No manual request changes
      subsequent rotations' permission to land, even after a failed request or process restart.
      Tests show manual success and refusal followed by an unattended refusal with `land: false`.
- [ ] **AC-7** — **Documentation and decisions.** `README.md`, `docs/settings.md` and the
      controller instructions describe manual landing with `land: false`, unattended opt-in,
      and the scoped direct-dispatch contract. They state that tools using the crew's write
      credential can deliberately issue a manual request too: mode is explicit authorization,
      not proof of a human at a terminal or credential isolation. Resolve every **Planned**
      marker naming ST-54 in `docs/`, correcting the passages to the delivered behaviour.

## Out of scope

- Changing the installation default: ST-55 depends on this story to make that default usable.
- Scheduler or coordinator implementation, unattended-landing rollout, new landing rules,
  outside-author scheduling (ST-27), or client installation and validation (ST-48).
- Removing `once` or changing the pilot's wait bounds: ST-53 owns that separate decision.
- New credential isolation, secrets, a durable permission service or per-handoff cancellation.
  GitHub write access remains trusted; neither a CLI mode nor a workflow input proves intent
  against a credential holder deliberately choosing manual mode.

## Constraints

- Node 24, ESM, no new runtime dependencies. Keep the existing pilot/runway division and
  workflow names, concurrency and merge safeguards. Keep `land` a required boolean.
- A manual invocation does not silently follow a new head or grant permission to other PRs.

## Context

- Crew decision, 2026-10-26: distinguish standing unattended authorization from one manual
  landing. Design doc, "Manual landing and review-only installation defaults".
- `scripts/dispatch/land.mjs`: `createLandContext`, `landPullRequest`, `buildDispatchSweep`,
  `assertAllowedRequest` and `main`. Today `ctx.landing === false` prevents even manual landing.
- `scripts/dispatch/rotation.mjs`: the rotation uses `settings.land` for its landing step.
- `scripts/land/runway.mjs`: reads `landWhen` from `main` but does not enforce `land` today;
  `check-author.mjs` and `checks-green.mjs` hold existing eligibility rules.
- `.github/workflows/land-approved.yml` and `templates/workflows/land-approved.yml`: the
  current workflow has only the optional `pr` input. `thin-workflows.test.mjs` under
  `scripts/land/` checks parity; keep these callers thin.
- ST-53 is a draft about wait behaviour, not this story's authorization distinction.

## Open questions

*(none)*
