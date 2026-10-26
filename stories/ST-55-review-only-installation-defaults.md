---
id: ST-55
title: Default new installations to review-only operation
tier: next
kind: product
depends_on: [ST-54]
model: null
blocked: null
---

## Intent

As a developer installing steward into an existing project, I want unattended landing disabled
by default and that choice clearly explained, so that receiving independent reviews does not
silently authorize merges and I can still ask for an individual gated landing when I choose.

## Acceptance criteria

- [ ] **AC-1** — **Default and explicit choice.** The `land` question in `init` describes
      unattended landing and defaults to no. A new configuration written after accepting that
      default, interactively or with `--yes`, contains `land: false`. An explicit yes at the
      question or `--land yes` writes `land: true`; `--land no` writes false. Other settings,
      including `landWhen: "all-checks"`, retain their existing defaults. Tests cover each
      route, including injected terminal answers. `readSettings` still requires `land` and
      supplies no implicit default when the key is missing.
- [ ] **AC-2** — **Explain the result.** The prompt and final installation output distinguish
      review-only operation from unattended landing. For a newly written false setting the
      output says that steward can review but will not land unattended, and shows
      `steward land <pr-number>` as the explicit gated manual path supplied by ST-54. For a true
      setting it says unattended landing was explicitly enabled. It explains that merging the
      installation PR does not activate a local scheduler: machine activation is separate work.
      Tests check both outcomes and that `--yes` is not described as consenting to auto-landing.
- [ ] **AC-3** — **Preserve existing authorization.** `init` leaves an existing settings file
      byte-for-byte unchanged, whether it has `land: true` or `land: false`, including on rerun
      with `--yes` or the opposite `--land` flag. It reports the existing file as left alone
      without claiming that its land setting was changed. The completion output says an
      existing configuration governs its own landing authorization. Tests cover true and false
      files, both kinds of conflicting invocation, and two runs of a new installation.
- [ ] **AC-4** — **Install the gate without enabling it to merge unattended.** Review-only
      installation still writes the gate and runway templates, checklist and required settings,
      with the existing pinning and existing-file preservation behaviour. It creates no new
      trigger or authorization outside those files and starts no reviewer, coder, rotation or
      landing. Tests exercise the generated files using ST-54's pilot/runway seams: false
      prevents unattended landing, while a scoped manual request for an otherwise eligible PR
      succeeds through the same gate. The explicit true choice retains unattended eligibility.
- [ ] **AC-5** — **Documentation and decisions.** Update `README.md`'s installation guidance,
      `docs/settings.md`'s `land` description and `init` default, and `init`'s help and examples
      to show the default, explicit opt-in and manual path. Clearly distinguish currently
      delivered commands from the roadmap's planned local coordinator and activation controls.
      Resolve every **Planned** marker naming ST-55 in `docs/`, correcting its passages to the
      delivered behaviour. Existing projects' chosen `land` values, including steward's own
      true setting, are not migrated by this story.

## Out of scope

- Implementing the manual landing exception: ST-54 must be delivered first.
- Automatically changing existing project settings, new configuration keys or a new schema.
- Activating projects on a machine, the coordinator, scheduling, stop/status controls,
  unattended-landing rollout policy, or changing branch protection and `steward protect`.
- Changing unit conventions, planning formats, CI requirements or client repositories.

## Constraints

- Node 24, ESM, no new runtime dependencies. Preserve `init`'s existing no-overwrite rule and
  its refusal of unanswered non-interactive questions. `init` commits, stages and pushes nothing.
- Keep the existing `land` key and `--land yes|no` choice. The changed default is an installer
  choice written into a new file; the settings reader does not invent missing values.

## Context

- Crew decision, 2026-10-26: 0.1 installs review-only by default. Design doc, "Manual landing
  and review-only installation defaults"; product roadmap in `docs/outline.md`.
- `scripts/dispatch/init.mjs`: `QUESTIONS` currently gives `land` default `yes`, and
  `settingsBody` writes `answers.land`; `init.test.mjs` covers existing-file preservation.
- `docs/settings.md`: today the `land` row says default true. `scripts/dispatch/settings.mjs`
  validates a required boolean; that requirement stays.
- `stories/ST-54-manual-landing-review-only.md`: scoped manual authorization and runway
  enforcement of unattended permission. This story changes neither that boundary nor the gate.

## Open questions

*(none)*
