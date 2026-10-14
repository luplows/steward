---
id: ST-23
title: Land in one look, without waiting, and not at all when the project turns landing off
tier: next
kind: workflow
depends_on: [ST-18]
model: sonnet
blocked: null
---

## Intent

As a member of the crew, I want a review-and-land pass to look once at whether a passed pull request
is safe to merge, land it if so, and otherwise leave it for a later pass, so that one pull request's
slow checks hold up nothing and a landing that did not happen is simply tried again. I want a
project that has turned steward's landing off never to have the sweep triggered by steward.

## Acceptance criteria

- [ ] **AC-1** — `landPullRequest` in `scripts/dispatch/land.mjs` takes an option `once`. With
      `once: true` it reads the pull request and its `review/agent` status once:
      - a terminal state (`draft`, `review-blocked`, `review-failed`, `conflict`, `closed`,
        `merged`) is returned as today;
      - a state that is not landable yet (today's waits: `review-pending`, `gate-lag`, `blocked`,
        `unknown`) is returned at once as `not-landable`, with the reason, and nothing is
        triggered;
      - a landable pull request has the sweep triggered once, and is then polled for its merge
        for at most `SWEEP_RUN_BOUND_MS`, returning `merged`, or `sweep-pending` if it has not
        merged by then. It is never triggered a second time in the same call.
- [ ] **AC-2** — Without `once`, and with `landing: true`, `landPullRequest` behaves exactly as
      today. Its existing tests pass, changed only to pass `landing`.
- [ ] **AC-3** — `createLandContext` takes `landing`, the settings' `land` value. With `landing:
      false`, `landPullRequest`, in either mode, returns `landing-off` without sending any request.
      Every place that creates a land context (`land.mjs`'s command line, `loop.mjs` and
      `story.mjs`) passes the settings' value.
- [ ] **AC-4** — Each `once` call appends its line to the latency log as other calls do.
- [ ] **AC-5** — Tests in `land.test.mjs`, named `ST-23/AC-<n>`, with the requests, `sleep` and
      `now` injected: each not-landable state returns at once with no trigger; a landable pull
      request is triggered once and returns `merged` when it merges within the bound and
      `sweep-pending` when it does not; `landing: false` sends nothing.
- [ ] **AC-6** — The `**Planned (ST-23)**` marker in `docs/agent-workflow-design.md` loses
      `ST-23`, and the passage is corrected wherever what was built differs.

## Out of scope

- Which checks must be green (`landWhen`): ST-24. Landability here is today's.
- The pass that calls `once`: ST-25.
- Changing the sweep, `land-approved.yml`.

## Constraints

- Node, ESM, no new runtime dependencies.
- `land.mjs` stays the only module that triggers the sweep, and its request allowlist gains
  nothing.

## Context

- `docs/outline.md`, "Defining steward", "The two sides": "Landing never waits", and a
  rotation's step 4; "Settings": a project can turn steward's landing off.
- `scripts/dispatch/land.mjs`: `assess` (the waits and terminal states), `landPullRequest`'s
  loop, and the bounds `SWEEP_RUN_BOUND_MS`, `BLOCKED_BOUND_MS` and `MAX_TOTAL_WAIT_MS`.
- `scripts/dispatch/writer-prs.mjs`: skips a pull request that already has a verdict at its head,
  so a landing that gave up there is never tried again (`docs/agent-workflow-design.md`, "The
  outline's reasoning", "The two sides").

## Open questions

*(none)*
