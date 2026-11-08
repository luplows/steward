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

As the crew preparing a Steward release after v0.1.0, I want the release version and initial
notes committed before the installation walkthrough, so that the candidate identifies itself
accurately while the final notes still record the crew's acceptance decision.

## Acceptance criteria

- [ ] **AC-1** — `docs/release-review.md` states that the crew chooses a fixed version before
      the branch is cut; after cutting and protecting the branch, the release review reads
      protection back and confirms the intended required checks and administrator enforcement.
      Unexpected requirements are corrected before the first release PR proceeds.
- [ ] **AC-2** — `docs/release-review.md` requires the first reviewed PR into a new release
      branch to set `package.json` and `package-lock.json` to the preselected version and
      create `releases/vX.Y.Z.md`. That file records the known version, batch boundaries and
      candidate capabilities and uses literal `Pending release review` placeholders for
      unresolved verdicts, deferrals, project upgrade actions and other required release-note
      entries. This first PR changes no runtime code; `main` keeps its development version.
- [ ] **AC-3** — The procedure runs the scratch installation walkthrough after the first PR
      lands, pinning its current release-branch commit. After each fix or revert into that
      branch, the procedure reruns the walkthrough from the new last commit as before.
- [ ] **AC-4** — The last PR into the release branch updates only the same
      `releases/vX.Y.Z.md` file: it replaces all `Pending release review` placeholders with
      actual capability verdicts, follow-ups, deferrals, upgrade actions and other required
      evidence, or an explicit "None" where appropriate. It makes no version or runtime
      changes. It is made ready and landed only after crew acceptance, before tagging.
- [ ] **AC-5** — `docs/release-review.md` keeps the crew's explicit authorization for the
      immutable tag and the rule that no tag or already-tagged release branch moves. It says
      the early-version process starts with the release after v0.1.0, which was reviewed and
      tagged under the earlier procedure on 2026-11-05. The selected version is not routinely revised
      during stabilization: an exceptional proposed change stops for a separate crew decision.
- [ ] **AC-6** — Remove the `**Planned (ST-73)**` marker from the corresponding decision in
      `docs/agent-workflow-design.md` when the revised release procedure is implemented.

## Out of scope

- Changing `scripts/dispatch/init.mjs`'s PR title or commit-message formatting.
- Altering v0.1.0's release branch, release notes or tag.
- Changing the walkthrough's upgrade step, which ST-69 added to `docs/release-review.md`. It
  stays part of the walkthrough, which AC-3 places after the first release PR lands.
- Supporting automatic version renegotiation or re-cutting a release branch after an
  exceptional crew decision.
- Automatically changing branch protection or tagging without crew authorization.
- Treating a version bump or provisional notes as evidence that acceptance is complete.

## Constraints

- Release branches still change only through reviewed PRs, and `main` retains its
  development version. The crew alone authorizes the final tag.
- A draft release note makes no claim that a pending capability was accepted.

## Context

- `docs/release-review.md` currently combines release notes and version changes in the
  final PR. Its scratch walkthrough pins a full release-branch SHA; its tag is immutable.
- `scripts/dispatch/init.mjs` titles installation PRs using `package.json`'s version,
  including when the installer is pinned with `--ref`.
- The 2026-11-04 scratch walkthrough generated "Install steward 0.0.0" for the untagged
  v0.1.0 candidate.
- v0.1.0 was tagged on 2026-11-05, at `0b1d8b3`, after this story was written; its review
  followed the earlier procedure.
- ST-69 (landed) added "Run the upgrade as a project would" to the walkthrough in
  `docs/release-review.md`: an installation at the previous release is upgraded with
  `steward upgrade --ref <commit>`, the release branch's last commit.
- Crew decision, 2026-11-04: starting after v0.1.0, the first release PR carries a fixed
  version and provisional notes, and the final PR completes the notes. Branch protection
  is read back before that first PR; no routine version changes are expected.

## Open questions

*(none)*
