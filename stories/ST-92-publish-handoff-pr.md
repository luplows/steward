---
id: ST-92
title: Publish a handoff's coding result as a linked pull request
tier: normal
kind: product
depends_on: [ST-89, ST-91]
model: null
blocked: null
---

## Intent

As a crew member, I want Steward to publish a completed coder branch as a correctly linked PR, showing the original approval without replacing the reviewer's current source of truth.

## Acceptance criteria

- [ ] **AC-1** — Given ST-91's successful result, the matching approved handoff and the expected branch/head SHA, ATC verifies the remote branch still identifies that head and creates a PR targeting `main`. It does not run a model, make another claim, or accept a different branch. A mismatch refuses publication and reports the existing branch.

- [ ] **AC-2** — ATC, not the coder, writes exactly one authoritative `Unit:` reference to the original file path on `main`, or `#<issue number>`. The destination of a file moved within the coder branch cannot replace that path. Reject publication if current project settings no longer permit the unit-link kind.

- [ ] **AC-3** — Sanitize or reject coder-supplied conflicting `Unit:` lines and closing-keyword Issue links so `findUnitLink` on the final body identifies exactly the intended unit under the project's current `unitLinks`. Preserve the required substantive PR template sections and the coder's actual verification statements; do not invent checks.

- [ ] **AC-4** — The PR clearly identifies the handoff ID and historical approved revision. For a file, include the original path and approved full `main` SHA; for an Issue, include its number and approved title/body fingerprint. The approved text and version history remain inspectable through `steward handoff show`; the PR says the historical revision is provenance, not the reviewer's source of truth. Provenance adds no second unit link.

- [ ] **AC-5** — Make one post-execution comparison against the current authoritative file or Issue immediately before PR creation. When it equals the approved snapshot, honor the coder's normal ready/draft choice. When changed or unreadable, still publish the pushed work as a draft and report a handoff discrepancy requiring crew action. Do not monitor changes throughout coding or guarantee detection of races after that comparison.

- [ ] **AC-6** — The `Coder:` provenance names the actual model choices/tools used in the completed execution, using a format the reviewer can interpret for independent model selection; ATC does not trust an arbitrary coder-written `Coder:` line.

- [ ] **AC-7** — Invalid coder PR output, a moved remote head and GitHub publication errors report a recoverable failure with handoff ID, branch and head SHA, preserving the pushed work without automatic re-execution.

- [ ] **AC-8** — Tests cover file/Issue Unit links, moved files, conflicting closing keywords, snapshot changes, unreadable units, draft/ready publication, actual coder provenance, malformed output and publication failures. No real model or GitHub mutation runs.

- [ ] **AC-9** — Document publication and draft discrepancies and remove ST-92 from the 0.3 design marker when implemented.

## Out of scope

- Coder sessions, branch claiming and pushing (ST-91).
- Automatic review, merging and rewriting the reviewer's authoritative unit.
- Automatic resolution of changed requirements or comprehensive source-change race detection.
- Retrying a failed coder session or changing the gate's landing rules.

## Constraints

The reviewer continues to read the unit and project rules from current `main`. In 0.3 publication trusts only the ST-91 expected remote head, not a second model output.

## Context

- `scripts/dispatch/unit.mjs`: `findUnitLink` and `readUnit` determine reviewer-visible unit identity.
- `scripts/dispatch/coder.mjs` currently composes PR content and the `Coder:` footer.
- Playground PR #26's initial wrong `Unit:` path was repaired before independent review; ST-92 makes the path ATC-owned.
- Crew decision, 2026-11-08: retain work from a superseded approved revision, publish a draft on a detected mismatch, and let the reviewer verify against current requirements.

## Open questions

*(none)*
