---
id: ST-73
title: Set the release version at the start of stabilization
tier: later
kind: workflow
depends_on: []
model: null
blocked: null
---

## Intent

As the crew preparing a Steward release, I want the release candidate to carry its intended
package version before the installation walkthrough, so that installation PR titles and
the candidate's identity agree with the version we intend to publish.

## Acceptance criteria

Starter criteria for the next release-process refinement; no procedural change is approved
by this story while Open questions remain.

- [ ] **AC-1** — Placeholder: amend `docs/release-review.md` so the proposed version is
      applied through a small, separately reviewed PR near the start of release-branch
      stabilization, before the pinned scratch-project walkthrough.
- [ ] **AC-2** — Placeholder: define that early PR's allowed changes to
      `package.json` and `package-lock.json`, keeping `main` at its development version,
      and revise the final release-notes PR to avoid a second version edit.
- [ ] **AC-3** — Placeholder: preserve the existing review, approval and immutable-tag gates,
      including which release-branch commit each walkthrough validates and when to rerun it
      after a fix.
- [ ] **AC-4** — Placeholder: update the design record for the agreed process, and give an
      explicit procedure for correcting a proposed version without moving a published tag.

## Out of scope

- Changing the existing `init` title or commit-message formatter.
- Changing versions on `main` or publishing a release tag early.
- Running release branch protection, merging a release PR or approving a release on the
  crew's behalf.
- Treating a version bump by itself as evidence the release passed acceptance.

## Constraints

- Release branches change only through reviewed pull requests; the crew owns the final
  release decision and tag authorization.
- This is a proposal for future release reviews. It does not retroactively change the active
  0.1.0 release procedure while the crew is validating that candidate.

## Context

- `docs/release-review.md`, "The release notes", currently combines version changes and
  release notes in the final PR into the release branch. It states that `main` stays at
  `0.0.0` and that the tag follows crew acceptance.
- `scripts/dispatch/init.mjs` builds the installation PR title and commit message from
  `package.json`'s `version`, even when `--ref` pins a full commit SHA.
- The 2026-11-04 release walkthrough saw an installation PR titled
  "Install steward 0.0.0" while testing the untagged 0.1.0 candidate.
- The crew proposed moving the version into a small initial stabilization PR instead of
  the last release-notes PR. The exact procedure still needs agreement.

## Open questions

- Should the version PR be the first reviewed PR after cutting the release branch, or must
  another preflight establish the candidate before the version is set?
- Does the process change apply to the in-progress 0.1.0 release or only later versions?
  If it applies now, what explicit crew authorization and procedure revision are needed?
- If the candidate's version changes during stabilization, how should the notes, walkthrough
  and pinned workflows be updated without changing the meaning of the eventual immutable tag?
- Is a separate protection read-back check needed in the release procedure to catch unrelated
  required checks copied accidentally from another repository?
