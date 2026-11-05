---
id: ST-78
title: Validate existing review rules before relying on the gate
tier: fix
kind: product
depends_on: []
model: null
blocked: null
---

## Intent

As a member of the crew installing or activating steward, I want an existing checklist parsed before steward relies on it, so that malformed review rules cannot silently establish a gate that refuses even its own repair pull request.

## Acceptance criteria

- [ ] **AC-1** — Expose shared validation using the reviewer's actual rules parser (`parseRules` in `scripts/dispatch/rules.mjs`), returning a diagnostic naming the configured file and invalid section/reason. Do not maintain a separate checklist grammar.
- [ ] **AC-2** — When `steward init` finds an existing checklist on project `main` that fails validation, leave it untouched and report the exact problem in CLI output and prominently in the **draft installation PR**, instructing the crew to repair it before merging. An otherwise eligible installation still creates that PR. Valid existing rules do not cause a warning.
- [ ] **AC-3** — `steward protect` validates configured rules from `main` before setting protection. Invalid rules cause a refusal naming the file and reason, and no protection-setting request. Valid rules preserve existing behavior.
- [ ] **AC-4** — `steward project activate` validates configured rules from `main` before making a project active. Invalid rules refuse without changing activation state. Valid rules preserve existing behavior.
- [ ] **AC-5** — Tests reproduce D5: a `## ` section containing prose but no numbered item is rejected by the reviewer parser, warned on by `init` in output and PR body, and refused by `protect` and `activate` without their state-changing actions. Tests use the shared parser, not a simulated alternate validator.
- [ ] **AC-6** — Document recovery when a checklist becomes invalid after protection, including crew-authorized changes to required checks if needed. Do not recommend fabricated verdict markers or an automatic bypass.
- [ ] **AC-7** — Link ST-48/AC-7's D5 finding to this story. The ST-48 completion diff does not include defect implementation work.
- [ ] **AC-8** — Resolve the `**Planned (ST-78)**` marker in `docs/agent-workflow-design.md` when implementing this story.

## Out of scope

- Allowing checklist sections without numbered rules or otherwise changing accepted checklist grammar.
- Inventing or automatically rewriting project review policy.
- A privileged bypass, automatic repair, or automatic relaxation of branch protection.
- Upgrade orchestration and repinning (ST-69).
- Protecting against concurrent checklist changes or future edits made after validation.
- Repeating ST-48 validation.

## Constraints

- Read the configured rules file from project `main`, not merely the caller's checkout.
- Preserve the separation of installation, protection and activation, and the existing project's review policy.
- Bound guarantees to the state observed in each command, without promising protection against concurrent modifications.

## Context

- D5 was found during ST-48 validation in tower-workshop-paths: its existing `REVIEW.md` held a section without numbered rules, leading to `rules-unreadable` and `no-model-refusal`. The required gate could not review the fixing PR.
- TWP PR #283 repaired the checklist under crew control and genuine review and landing resumed. Follow-up work is separate from ST-48's completion.
- `scripts/dispatch/rules.mjs`, `init.mjs`, `protect.mjs` and `project.mjs` are the relevant current paths.
- Crew decision, 2026-11-04: `init` warns and leaves a draft PR; `protect` and `activate` refuse. Preserve parser semantics and document recovery.

## Open questions

*(none)*
