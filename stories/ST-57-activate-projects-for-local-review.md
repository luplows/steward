---
id: ST-57
title: Explicitly activate installed projects for local automatic review
tier: next
kind: product
depends_on: []
model: null
blocked: null
---

## Intent

As a developer, I want to explicitly register which installed projects Steward may review unattended, so that installing the gate or discovering a checkout never authorizes local execution.

## Acceptance criteria

- [ ] **AC-1** — `steward project activate <checkout-path>` resolves a Git checkout and matching GitHub `origin`, fetches `origin/main`, and validates the **installed revision on that fetched main**, not files on the caller's current branch: readable and valid `steward.config.json` with the matching `repo`, its configured checklist, and the installed `.github/workflows/review-gate.yml`. A valid local feature-branch configuration alone is insufficient. It prints the resolved repository and path on success; missing, unreadable, ambiguous, mismatched or not-yet-merged installation inputs refuse with a nonzero result and do not activate the project. Tests distinguish an installed `origin/main` from a feature branch that only proposes installation.
- [ ] **AC-2** — Activation provisions or validates a separate, coordinator-owned detached review checkout of the selected repository at `origin/main`. The coordinator never updates, stages, resets, or checks out the caller's worktree to operate. Failure to establish its isolated checkout refuses activation without touching the caller's tracked, staged, unstaged or untracked work. Tests exercise an active caller feature branch with local changes.
- [ ] **AC-3** — Activation state is stored atomically in the current OS user's Steward data directory, separate from the implemented strict `~/.steward/config.json` per-user model/usage configuration and from repository `steward.config.json`. It includes the canonical repository identity and a path for its owned checkout, but no credentials. Repeating activation for the same repository and same checkout is idempotent; a second ambiguous registration for that repository is refused rather than scheduled twice. Tests include aliases/symlinks to the same checkout.
- [ ] **AC-4** — `steward project list` reports all activated repositories, their source and owned checkout paths, and any invalid/missing checkout without starting a review. A malformed activation record fails visibly; it is never treated as permission to schedule unknown projects.
- [ ] **AC-5** — `steward project deactivate <owner/name>` atomically revokes the project's activation; once the command reports success, no subsequent **automatic admission** may begin for that project, including while the coordinator is running. An already admitted review may finish. Deactivation does not stop the coordinator, delete the coordinator-owned review checkout, or change the caller's files. A missing repository is reported as not activated without changing other registrations. Tests exercise deactivation concurrent with an admission attempt; ST-52/ST-61 consume the authoritative activation state at admission.
- [ ] **AC-6** — `steward init`, including its eventual ST-56 installation-PR path, never implicitly activates a project, starts the coordinator, or creates an activation record. Tests distinguish an installed but inactive project from an activated one.
- [ ] **AC-7** — `steward project list` and the documented interface use `steward project activate <checkout-path>` and `steward project deactivate <owner/name>`. The documentation states the per-user persistent-record location, the fetched-main installation requirement, the activation boundary, and that a deactivated project's managed checkout is **retained for reuse** and never automatically cleaned up. The planned design-of-record marker for this story is resolved by its implementing PR.

## Out of scope

- Starting, stopping or scheduling the coordinator; those belong to ST-58 and ST-61.
- Migrating existing per-user/project configuration schemas or implicitly activating existing installations.
- Deleting unrecognized worktrees, manipulating the caller's current branch, or opening installation PRs (ST-56).
- Cross-account project activation, shared credentials, and emergency stop.

## Constraints

- Scope and ownership are per OS user on one machine. No new runtime service or OS administrator privilege is required for activation.
- A repository's `steward.config.json` remains the authority for project review settings; activation grants local execution permission but does not alter GitHub authorization.

## Context

- `scripts/dispatch/settings.mjs` validates project settings, and `scripts/dispatch/user-config.mjs` strictly validates current per-user model/usage configuration (ST-63).
- `scripts/dispatch/rotation.mjs` currently insists on a dedicated detached controller worktree; `scripts/dispatch/review.mjs` prepares a separate temporary reviewer checkout. The new activation checkout must not be the developer's working checkout.
- ST-56 (in draft PR #90 when drafted) defines reviewable installation PRs, separately from local activation; it is not an implementation dependency for this local state mechanism.
- Crew decision, 2026-10-27: coordinator scope is per OS user; manual commands are independent of automatic scheduling.
- Suggested size: medium; no scheduling or process owner implementation in this story.

## Open questions

*(none)*
