---
id: ST-94
title: Explain cleanup of manually merged installation and upgrade branches
tier: later
kind: product
depends_on: []
model: null
blocked: null
---

## Intent

As a crew member installing or upgrading Steward, I want the generated pull request and final
command message to explain how to clean up a head branch left by a manual merge, so that
leftover branches do not surprise me or prevent later installations and upgrades.

## Acceptance criteria

- [ ] **AC-1** — When `init` opens an installation PR, the PR body and successful command output
      say that its head branch may remain after a manual merge, name the actual branch and explain
      how the crew can delete it after confirming the PR merged. They do not claim that every
      manually merged branch necessarily remains.
- [ ] **AC-2** — When `upgrade` opens an upgrade PR, its body and successful output give the same
      instructions, using the actual head branch even when the crew chose a custom branch name.
- [ ] **AC-3** — Tests check both PR bodies and command outputs for default and custom branch
      names. Refused and no-op runs never report that a new PR was opened or its head cleaned up.
- [ ] **AC-4** — Guidance notes that a later runway run may also clean up previously merged
      heads, and never instructs the crew to delete a branch belonging to an open PR or one
      that has moved to other work.

## Out of scope

- Deleting head branches automatically, immediately or otherwise.
- Changing the runway's merged-head cleanup or GitHub repository settings.
- Resuming partial installation/upgrade runs or implementing ST-65's other candidates.
- Changing the gate or approval requirements for the installation and upgrade PRs.

## Constraints

Only user-facing guidance and tests change. The crew remains responsible for approving and
merging an installation or upgrade PR; a later runway cleanup is not guaranteed.

## Context

- `scripts/dispatch/init.mjs` and `scripts/dispatch/upgrade.mjs` open draft PRs and print
  closing instructions. The first installation cannot review itself through its own gate.
- `scripts/land/delete-merged-heads.mjs` already sweeps previously merged same-repository heads
  on subsequent runway runs, with guards against moved branch tips.
- ST-65 collects unrelated installer follow-ups; ST-69 delivered versioned upgrades.
- Crew decision, 2026-11-09, after the v0.2.0 release review: guidance only, not a new deletion
  mechanism. This story is `later`, with no committed release target.

## Open questions

*(none)*
