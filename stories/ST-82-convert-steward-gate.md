---
id: ST-82
title: Convert steward's own gate to the thin workflows
tier: later
kind: workflow
depends_on: [ST-79]
model: null
blocked: "The v0.3.0 release tag is not yet published; this post-release maintenance conversion must pin that tag"
---

## Intent

As a crew member, I want steward's own gate and inspection to run the same
release-pinned thin workflows that clients install, so that steward uses what
it ships without putting its 0.3.0 release review at risk.

## Acceptance criteria

- [ ] **AC-1** — After `v0.3.0` is published, replace only steward's
      `.github/workflows/review-gate.yml`, `land-approved.yml` and
      `inspection.yml` with the corresponding `templates/workflows/` files
      from that exact tag, with every `{{STEWARD_VERSION}}` placeholder
      filled as `v0.3.0`. The first conversion is a hand edit on ST-82's
      ordinary implementation branch, not an `init` or `upgrade` run:
      neither command treats steward's existing checkout-run workflows as
      installed managed templates. `ci.yml` remains unchanged.

- [ ] **AC-2** — Before the implementation PR is marked ready, its
      verification records a reproducible, read-only comparison against
      the published `v0.3.0` templates: all three checked-in files match
      `fillPin`'s output exactly, all `github:luplows/steward#` pin
      references in them name `v0.3.0`, and none invokes the old
      checkout-local `node scripts/dispatch/cli.mjs` path. Record actual
      command results, not an assertion that a future PR has already passed
      the new gate. The verification identifies the existing base-commit
      review gate that will review the conversion; no hand merge or
      post-landing outcome is claimed as pre-landing evidence.

- [ ] **AC-3** — Update current, non-historical passages in
      `docs/agent-workflow-design.md` that describe steward's own GitHub
      Actions workflows running from its checkout. Check `README.md`,
      `docs/controller.md`, `docs/settings.md` and `docs/glossary.md`
      for the same claim, and change only text made inaccurate by this
      conversion; descriptions of manual `node scripts/dispatch/cli.mjs`
      commands remain valid. The implementation PR's Docs check identifies
      which of these files needed changes and which did not.

- [ ] **AC-4** — Resolve the `**Planned (ST-82)**` marker in
      `docs/agent-workflow-design.md` when the conversion is implemented.

- [ ] **AC-5** — The implementation PR names the separate post-landing
      smoke check: observe `review/agent` and the normal gated landing of
      the next ordinary steward PR under the newly installed thin workflows,
      and record its PR/run evidence. The ST-82 implementation PR does not
      claim that this post-merge validation has already happened.

## Out of scope

- Changing the decisions enforced by review, runway or inspection, branch
  protection, or steward's own `ci.yml`.
- Extending `init` or `upgrade` to recognize or overwrite steward's
  pre-conversion checkout-run workflows.
- Requiring an already-landed PR as acceptance evidence for the PR that
  implements ST-82; AC-5 records a separate operational smoke check.
- Automatically repinning for future releases, or changing the commands
  crew members run manually from a checkout.

## Constraints

The v0.3.0 tag must exist before this story is unblocked or dispatched.
Its first conversion is an ordinary reviewable PR against `main`. The
current `review-gate.yml` checks out the PR's base commit, so it can
review the conversion before it lands; the existing runway remains the
landing authority. After the conversion, subsequent pin updates use
`steward upgrade` to propose a draft PR for normal review and landing,
not direct edits or automatic repinning.

## Context

- `.github/workflows/review-gate.yml` currently checks out the PR's
  base commit and runs checkout-local dispatch commands; the current
  `land-approved.yml` and `inspection.yml` also run checkout-local
  commands. `templates/workflows/` supplies the thin equivalents.
- `scripts/dispatch/init.mjs` leaves existing workflows in place;
  `scripts/dispatch/upgrade.mjs` accepts already managed pinned
  templates, not the legacy workflow form. The first switch therefore
  uses a hand-edited implementation PR. Later repins can use `upgrade`.
- ST-79 established how `init` identifies unowned workflows. ST-96,
  ST-97 and ST-98 improve future upgrade comparison, PR evidence and
  refusal guidance; they are part of the 0.3 release plan, not a
  substitute for the first manual conversion.
- Steward's earlier self-conversion plan targeted 0.2 (2026-11-04),
  then 0.3 (2026-11-07). Crew decision, 2026-11-11: perform the
  conversion as post-0.3.0 maintenance, pinned directly to the
  `v0.3.0` release, with normal review and runway landing. The
  scratch-repository installation exception does not apply to steward,
  because it already has a gate. Alternatives not chosen: an interim
  `main` commit pin plus a later tag repin, a hand merge, and making
  conversion part of release stabilization.

## Open questions

*(none)*
