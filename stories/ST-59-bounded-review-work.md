---
id: ST-59
title: Expose a bounded review-only operation for the coordinator
tier: next
kind: workflow
depends_on: []
model: null
blocked: null
---

## Intent

As the automatic coordinator, I want to identify and review one eligible pull-request head at a time using Steward's existing reviewer, so that an automated review turn does not execute an entire rotation or accidentally request landing.

## Acceptance criteria

- [ ] **AC-1** — A reusable review-side operation identifies eligible PR/head candidates for one repository using the same supported bases (`main` and release branches), trust, draft, `review-blocked`, and existing-head-verdict rules as `runRotation`. Candidates are deterministically ordered by PR number; a rejected candidate is reported with its skip reason and starts no model session.
- [ ] **AC-2** — Given a candidate `(repository, PR number, expected full head SHA)`, the operation passes `expectedHeadSha` into the **actual `reviewPullRequest` execution boundary**, not only an earlier scheduler-side lookup. `reviewPullRequest` refuses with `head-moved` and starts **no model session** if the PR head it reads differs from that explicit expectation, or if eligibility has changed; a malformed SHA is refused before any model session. Its existing rechecks before posting still apply, and the caller receives the actual result and head. Tests move the PR head **between candidate selection and reviewer invocation**, proving that the newer head is not silently reviewed.
- [ ] **AC-3** — One invocation attempts no more than one PR/head review. It uses `reviewPullRequest`'s current tool selection, budget, timeout, allowed malformed-result retry, checkout safety, verdict marker, and GitHub gate path. It does not promise that an invocation runs only one model session if the existing reviewer legitimately retries.
- [ ] **AC-4** — The operation never calls `landPullRequest`, a GitHub landing workflow, `dispatchCoder`, `runRotation`, or inspection, regardless of the project's `land: true` or `false`. Tests fail if any of those effects occurs. Existing manual `rotation` and `land` behavior is unchanged.
- [ ] **AC-5** — It works against a project configured with issue-based or file-based unit links without reading Steward's own story queue as a prerequisite. Test fixtures exercise both settings forms and confirm the project's configured checklist remains authoritative.
- [ ] **AC-6** — Tests cover a moved head at the `reviewPullRequest` boundary, an invalid expected SHA, an already-reviewed head, a draft, an outsider, a `review-blocked` PR, a valid head, a supported release-branch PR and refusal before any model session starts. The implementing PR resolves the corresponding planned design marker.

## Out of scope

- Selecting which activated project receives the next turn (ST-61).
- Global reviewer-slot ownership or automatic duplicate reservations (ST-52).
- Modifying manual CLI concurrency, introducing a second reviewer implementation, or changing the gate or runway.
- Automatic landing, auto-inspection, coding, fixing, E-stop or background process lifecycle.

## Constraints

- Keep the existing reviewer and gate as the implementation of review correctness. Do not copy `rotation.mjs` eligibility logic into a second independently drifting definition.

## Context

- `scripts/dispatch/rotation.mjs` currently performs several sequential reviews, may request landing when `land` is true, then inspects; its full rotation is not an atomic fair scheduling turn.
- `scripts/dispatch/review.mjs` already rechecks the PR head and governing verdict before posting; automatic work must additionally bind the selected candidate to the intended SHA before starting.
- The crew chose 0.1 unattended review without required unattended landing; 0.1.5 is the optional landing milestone.
- Suggested size: medium, independently implementable before the coordinator.

## Open questions

*(none)*
