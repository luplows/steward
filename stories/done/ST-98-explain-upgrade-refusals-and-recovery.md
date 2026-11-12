---
id: ST-98
title: Explain upgrade refusals with evidence and safe recovery steps
tier: normal
kind: product
depends_on: [ST-96]
model: null
blocked: null
---

## Intent

As a crew member whose upgrade is refused, I want to know what Steward could
not validate, which file or pin is involved and what safe action is needed,
so that I can repair the issue without guessing or weakening the review gate.

## Acceptance criteria

- [x] **AC-1** — For preflight refusals involving absent or inconsistent
      managed-workflow pins, an unresolvable target or installed pin, a
      missing installed or target template, an invalid project settings
      file, or an invalid configured review checklist, `upgrade` reports
      the relevant path/pin, the failed condition and an actionable
      corrective step. It distinguishes a crew-owned project repair
      from retrying after an external-read failure. It does not claim
      that the upgrade partially succeeded when it has not.
- [x] **AC-2** — For a workflow that is not equivalent to its installed
      template under ST-96, the refusal identifies each affected path
      and installed pin, says the file differs by more than the changes
      ST-96 accepts (the pin, line endings and quotes), and explains the
      safe choices: restore the installed version's managed template via
      a project PR, or reconcile the intended target change by hand.
      Steward compares workflows as text and does not parse YAML, so the
      refusal says it cannot tell whether the file is valid YAML or which
      permission or command changed, rather than guessing.
- [x] **AC-3** — The failure report explicitly identifies what was and
      was not created (`clone`, local branch, remote branch or PR) using
      the existing progress tracking. It gives a rerun precondition,
      and does not advise deleting an open PR's head or an uncertain
      push without checking it. A refused preflight creates no branch,
      push or PR; the command never auto-fixes client files.
- [x] **AC-4** — Diagnostics identify paths and conditions without
      dumping full client workflow or checklist contents, secrets
      or credentials to logs. Missing details are labelled as
      `could not verify` rather than `valid`. Multiple managed
      workflow mismatches are all reported rather than stopping at
      the first. Tests prove failure details are redacted as needed.
- [x] **AC-5** — Offline tests cover each AC-1 failure class, at
      least two simultaneous workflow mismatches, formatting-only
      success from ST-96, a difference outside ST-96's accepted
      changes, a failed external read and failures before and after
      cloning. Assert
      the suggested next action and actual remaining artifacts
      for each, with no live GitHub mutation.
- [x] **AC-6** — Update the upgrade troubleshooting section in
      `README.md` and resolve `**Planned (ST-98)**` in
      `docs/agent-workflow-design.md` when implemented.

## Out of scope

- Automatically merging customized workflows, bypassing validation,
  modifying project policies or changing approval and landing.
- Attempting broad semantic YAML diffs or interpreting arbitrary
  project-specific checklist text as a migration plan.
- Human-readable success evidence within the generated PR (ST-97),
  reviewer's `cannot-review` diagnostics or same-head retries.
- A new JSON report schema or `steward upgrade verify` command.

## Constraints

The upgrade runs under ordinary crew access to one repository and its
current managed files. It reports failures as diagnostics, not as
an alternative authorization path. If comparison or access is
uncertain, refuse without claiming the workflow was validated.

## Context

- `scripts/dispatch/upgrade.mjs` has preflight `Refusal` messages and
  `failureReport`, which already tracks some remaining artifacts;
  `scripts/dispatch/workflow-text.mjs` provides shared matching logic.
- The v0.2.0 rollout included a refusal reported only as
  `differs from steward's template by more than the pin`, without
  distinguishing formatting from substantive differences.
- ST-96 establishes when formatting-only differences are accepted.
  ST-97 separately fills actual verification evidence into a
  successful upgrade's draft PR.
- Crew decision, 2026-11-09: refusals should say why they failed and
  what to do next, without weakening strict validation. Considered
  and deferred: auto-repair, arbitrary YAML semantic analysis and
  additional machine-readable reports.
- Crew decision, 2026-11-12, before dispatch: AC-2 no longer tells a
  workflow whose YAML does not parse apart from a well-formed one.
  ST-96 compares lines of text (`scripts/dispatch/workflow-text.mjs`),
  and steward has no runtime dependencies (`package.json`), so making
  that distinction would need a YAML parser. Considered and rejected:
  a hand-written partial parse check, and a YAML runtime package.

## Open questions

*(none)*
