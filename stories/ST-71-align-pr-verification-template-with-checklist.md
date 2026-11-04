---
id: ST-71
title: Align pull request Verification guidance with the checklist
tier: later
kind: product
depends_on: [ST-68]
model: null
blocked: null
---

## Intent

As a project using Steward's example pull request template, I want its Verification guidance
to match the checklist, so that the template explains what evidence reviewers actually require.

## Acceptance criteria

- [ ] **AC-1** — The Verification HTML comments in
      `templates/pull_request_template.md` and `.github/pull_request_template.md` give the
      same guidance: list commands actually run and their actual results, give numbers when a
      result is a measurement, explain why no project check applies if none does, and show a
      command and its output demonstrating what changed in that case. A check not run is
      identified with its reason.
- [ ] **AC-2** — Both Verification comments include a concrete measured-result example and
      a documentation-only example that explains why no project check applies and includes
      a diff command with example output. Neither example demands measurements when none
      exist or presents an unsupported assertion as a test result.
- [ ] **AC-3** — Only the Verification comment changes in either pull request template; the
      Unit, What changed and Docs check portions retain their existing project-specific text.
      Both revised comments agree with Integrity items 1 and 2 in
      `templates/review-checklist.md` and `REVIEW.md`.
- [ ] **AC-4** — Remove the `**Planned (ST-71)**` marker from the corresponding decision in
      `docs/agent-workflow-design.md` once the updated templates are implemented.

## Out of scope

- Rewriting the reviewer prompt or changing verdict rules.
- Requiring numerical measurements for changes that have nothing to measure.
- Guaranteeing a passing review solely because the template was followed.
- Changing already-installed or customized client templates; upgrades belong to ST-69.

## Constraints

*(none)*

## Context

- The crew's 2026-11-04 release walkthrough observed a documentation-only PR blocked for
  missing an explanation that no project check applied, although the template omitted it.
- ST-68 revised Integrity item 1 in `templates/review-checklist.md` and `REVIEW.md`, but
  explicitly left the two PR templates unchanged.
- Both templates still have "Numbers, not claims" in their Verification comment; their
  other instructions are not identical and must be retained.
- Crew decision, 2026-11-04: align the shared guidance and include both kinds of example.

## Open questions

*(none)*
