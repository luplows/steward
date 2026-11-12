---
id: ST-97
title: Generate a reviewable upgrade pull request with verification evidence
tier: normal
kind: product
depends_on: [ST-69]
model: null
blocked: null
---

## Intent

As a crew member upgrading a project, I want the generated draft PR to contain
Steward's actual validation evidence and clearly identify what the crew still
needs to verify, so that its review is not blocked by empty template sections
or stale claims about what the upgrade checked.

## Acceptance criteria

- [x] **AC-1** — For a project's ordinary Markdown PR template containing
      `## What changed`, `## Verification` and `## Docs check` sections,
      `upgrade` populates each section with substantive upgrade-specific
      content rather than appending those sections blank. It preserves
      `Unit:` and unrelated project-defined sections and instructions.
      It does not generate duplicate heading sections.
- [x] **AC-2** — `What changed` identifies installed and target pins, target
      type and version, generated branch, starting `main` commit, generated
      upgrade head and the files the command changed. It says these facts
      describe what `upgrade` *generated*, not what future crew commits may
      add. Any report that it made no project-owned changes is explicitly
      scoped to its generated commit.
- [x] **AC-3** — `Verification` records the actual `steward upgrade` arguments
      used and their successful result, and separately reports the actual
      pin/template, settings and checklist validations performed, with
      outcomes and the version of Steward performing them. It does not invent
      `npm test`, client CI, a reviewer check or other commands not run.
      Failed validation never appears as a successful generated PR.
- [x] **AC-4** — `Docs check` states accurately that the command did not
      inspect or edit the project's README or pin-related documentation,
      and asks the crew to confirm whether documentation must change.
      A clear `Crew action required` / `Not checked` section also calls out
      any project-specific unit link and criteria, a separate unit for
      preparatory work, CI and post-landing behavior, and any remaining
      configuration decisions. These are suggestions, not claims that every
      project's policy requires every item. The body never invents a unit.
- [x] **AC-5** — When no project PR template is found, the generated body still
      contains useful filled-in standard sections. When a custom template
      cannot be mapped to those three headings, preserve its text and explain
      which sections require crew completion; never claim it is automatically
      review-ready. The resulting PR is a draft in every case, and an
      unfilled `Unit:` remains explicitly identified for the crew.
- [x] **AC-6** — Tests using the actual generated upgrade commit and PR body
      cover a standard template, no template, a custom template, project-owned
      config edits, a pin-only upgrade, optional workflows and generation-time
      `land` state. They verify that generated claims are explicitly scoped
      to the generated base/head, that untouched custom fields are preserved,
      and that the body does not claim to validate subsequent crew edits.
- [x] **AC-7** — Update `README.md`'s upgrade guidance with the remaining
      project-specific responsibilities, particularly links to independently
      complete units and docs affected by pin-form changes; resolve
      `**Planned (ST-97)**` in `docs/agent-workflow-design.md`.

## Out of scope

- Automatically creating or choosing the project's `Unit:` or modifying
  project-owned documentation and CI.
- Interpreting arbitrary prose checklists, guaranteeing that every custom PR
  template passes review, or representing tool-reported evidence as independent
  review.
- Editing or revalidating a PR after the crew changes it. A separate future
  read-only upgrade verification capability may address that.
- Filling `init`'s installation template (ST-65), or changing workflow
  comparison and refusals (ST-96, ST-98).
- **After review:** a pull request template with a heading inside fenced code or an HTML comment is read as having that heading: when it repeats one of the sections the template goes to the unfilled fallback, and otherwise the body is filled as if the heading were real, so the crew corrects the draft (crew, 2026-11-12). Follow-up: none.

## Constraints

The command is mechanical and uses only evidence it actually collected.
Preserve the existing draft-PR and crew-approval boundary. Every claim about
files, settings or tests must be scoped to the generated base/head; later
PR edits do not retroactively become part of the generated evidence.

## Context

- `scripts/dispatch/upgrade.mjs` currently creates a custom
  `## Steward upgrade` section and appends the project's unchanged PR
  template. `pullBody` labels some validation, but leaves ordinary
  `What changed`, `Verification` and `Docs check` headings empty.
- The v0.2.0 rollout encountered review blocks on an empty `Unit:`, template
  placeholders and validation described without a real command/result.
  The body also made snapshot claims that could become stale after an
  added crew commit.
- The reviewer continues to inspect the client's current `main`, not
  unverified historical PR prose. ST-96 addresses formatting-only
  workflow differences, not the reviewability of generated descriptions.
- Crew decision, 2026-11-09: show `Verified`, `Crew action required`
  and `Not checked` clearly in the existing PR body. Considered and
  deferred: a new report artifact or generic PR revalidation engine.

## Open questions

*(none)*
