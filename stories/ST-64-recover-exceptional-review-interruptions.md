---
id: ST-64
title: Recover exceptional coordinator and review interruptions
tier: later
kind: workflow
depends_on: [ST-60]
model: null
blocked: null
---

## Intent

As a developer, I want a future Steward release to help resolve automatic review work left uncertain by an unexpected coordinator or supervisor failure, so that recovery can become practical without silently duplicating live work.

## Acceptance criteria

Provisional only. This story is a holding draft, not implementation-ready.

- [ ] **AC-1** — Recover or explicitly refuse unfinished automatic work after an exceptional interruption, using evidence sufficient for the chosen safety boundary. The success/refusal cases and operator procedure must be refined from the Open questions before implementation.
- [ ] **AC-2** — The implementing PR documents the chosen recovery boundary and resolves this story's planned design marker.

## Out of scope

- Routine failures under a living coordinator, clean stop/start and carrying on after an interruption, with an interrupted review counted as failed (ST-60).
- Shared E-stop and universal manual-process registration (ST-62).
- Cross-user or distributed ownership unless separately authorized.

## Constraints

*(none)*

## Context

- Crew decision, 2026-10-27: keep 0.1 focused on expected failures; retain these questions as a draft for a future release, without choosing its release number or mechanism.
- Crew decision, 2026-11-02: ST-60 no longer refuses on uncertain work. Its `start` counts an interrupted review as failed and carries on, accepting that a reviewer which outlived its coordinator may still post a verdict. This story's questions are what a future release would add to that.
- The read-only architecture investigation found that current timeout and tree-kill handling depends on a living supervisor; a missing root PID or a posted verdict does not establish descendant termination.

## Open questions

- Which exceptional failures should be supported first: coordinator death with a surviving worker, worker death with surviving descendants, machine restart, or interrupted persistence?
- What is the required termination boundary, and what positive evidence can establish it on Windows and other supported platforms? How should PID reuse, lost ancestry and permission failures be reported?
- Is a dedicated worker or OS containment worthwhile? If needed, how are child creation/identity-recording races closed without building a universal process registry?
- How should a verdict POST accepted by GitHub but not durably acknowledged locally be reconciled without duplicate posting or another paid review? Is attempt metadata needed?
- Should the crew be able to have an interrupted head reviewed again automatically, and what evidence would that require?
- When may safely interrupted work be retried, and how does that interact with ST-61's unchanged-head suppression after a model-consuming failure?
- Which future release needs this capability, and should the eventual work be split by failure case or platform?
