---
id: ST-69
title: Upgrade an existing Steward installation to a newer release
tier: next
kind: product
depends_on: [ST-56, ST-78, ST-79]
model: null
blocked: null
---

## Intent

As a member of the crew using steward in an existing project, I want a mostly automatic upgrade from v0.1.0 to v0.2.0 through a reviewable pull request, so I can adopt improvements without reinstalling or losing project choices. The crew also wants to try that upgrade on a release candidate before the release is tagged, so the command can pin a candidate commit as well as the release.

## Acceptance criteria

- [ ] **AC-1** — `steward upgrade --to v0.2.0 [--ref <full SHA>]` prepares a draft pull request targeting the project's `main`, reporting its URL. It does not merge or mark ready, change protection, activate the project, start or stop the coordinator, or authorize coding.
- [ ] **AC-2** — `--to` must be `v` followed by the running package's own `package.json` version; any other value is refused, naming both. `--ref`, when given, must be a full commit SHA, 40 hexadecimal characters (a tag or a short SHA is refused, as `init --ref` refuses them), of a commit in `luplows/steward` whose `package.json` at that commit gives the same version as `--to`. Each failure is refused with the reference and the condition it failed. These checks come before anything is cloned, branched or pushed.
- [ ] **AC-3** — The pin the command writes is `v<version>`, the release tag, without `--ref`; with `--ref`, it is that SHA in lower case, a release candidate. The pull request's title and body call a candidate pin a candidate of that version at that commit, and never say the version is released.
- [ ] **AC-4** — Identify the installed version from managed workflow references on `main`. The managed workflows are `review-gate.yml` and `land-approved.yml`, and `inspection.yml` when present (`GATE_WORKFLOWS` and `INSPECTION_WORKFLOW`, `scripts/dispatch/init.mjs`). All of them must carry the same pin, and it is recognized as one of:
      - **a v0.1.0 installation:** exactly one of three pins, `v0.1.0`, the tag's commit `0b1d8b3ae9fd295506fa0af39b7e19bab207e430`, or `935fb5b81398420acd5e7476d2b94bec94bbad02`;
      - **a candidate of the target:** a full SHA, other than the pin AC-3 would write, of a commit in `luplows/steward` whose `package.json` gives the `--to` version;
      - **already upgraded:** the pin AC-3 would write, or the target's tag.

      A v0.1.0 installation or a candidate is upgraded to the pin AC-3 gives. An installation already upgraded is a reported no-op: no clone, branch or pull request. When it carries the target's tag and `--ref` was given, the report says so, and that a candidate pin is not proposed over the release. Missing, inconsistent or unrecognized references cause refusal naming the findings.
- [ ] **AC-5** — Compare installed Steward-managed workflow files with templates, allowing only version-pin substitution, through ST-79's comparison: a v0.1.0 installation with the v0.1.0 templates, and a candidate's with the running package's templates. Customized managed files cause refusal naming each file and explaining manual reconciliation, without silently replacing or attempting a general merge.
- [ ] **AC-6** — Propose v0.2.0 managed workflows with the pin AC-3 gives, preserving which optional workflows were installed. Tests inspect resulting workflow contents and references. Do not change unrelated project files.
- [ ] **AC-7** — Inspect `steward.config.json` and its configured review-rules file from `main`. Preserve compatible choices, explicitly including `land`, `landWhen`, `unitLinks` and `rulesFile`; an upgrade never grants unattended landing. Propose only target-release changes established by explicit, unambiguous migration rules, explaining each project-owned edit. Where a project-policy decision is required, report it without guessing. The optional per-user landing scan interval is not a project migration.
- [ ] **AC-8** — Validate the proposed result against the target release's applicable settings requirements and ST-78's review-rule parser before claiming the upgrade is ready for crew consideration. An invalid result identifies the affected file and reason and is not reported as validated.
- [ ] **AC-9** — The draft PR names the source and target versions, the pin written and whether it is the release or a candidate, changed managed files, any justified project-owned changes, validation outcome, unresolved actions and manual post-merge steps; it makes no claim the project was already upgraded.
- [ ] **AC-10** — On failed preparation report any remaining branch, clone or PR and how to recover. Tests cover:
      - a no-op, with and without `--ref`, on the target's tag;
      - an invalid `--to`, and each way AC-2 refuses `--ref`;
      - an upgrade from v0.1.0 to a candidate, and from a candidate to the release;
      - inconsistent pins, customized workflows and invalid proposed rules;
      - a failed preparation.

      Do not claim rollback without evidence.
- [ ] **AC-11** — Document the bounded v0.1.0-to-v0.2.0 process, approval and effective-pin verification, and any *manual* coordinator stop/restart required. The command never changes local coordinator or per-user state. `docs/release-review.md`'s walkthrough adds the upgrade:
      - once the release branch's first pull request has set its version, it runs `steward upgrade --to vX.Y.Z --ref <commit>` from the release branch's package, `<commit>` being the release branch's last commit, on a project at a v0.1.0 pin;
      - after the tag, a project upgraded to a candidate moves to the release with `steward upgrade --to vX.Y.Z`.
- [ ] **AC-12** — Resolve the `**Planned (ST-69)**` marker in `docs/agent-workflow-design.md` in the implementing PR, correcting the design passage if necessary.

## Out of scope

- Arbitrary historical upgrades, downgrades, general migration engines, automatic rollback or conflict resolution.
- Moving an installation between anything other than v0.1.0, a candidate of the target, and the target.
- Automatic approval, merge, local activation, coordinator lifecycle changes or authorization to code.
- Arbitrary Git configurations, concurrent upgrade processes and mid-preparation external edits.
- Changing the client's unit conventions or planning artifacts.
- ST-65's first-install conveniences, ST-73's release stabilization apart from the walkthrough step AC-11 adds, and ST-74's fresh-install formatting.
- Repairing the initial installation/protection/activation checklist defect (ST-78).
- Turning on unattended landing in a project. That is the crew's own settings pull request, never an effect of upgrading.

## Constraints

- Changes enter a client through a crew-reviewed PR, never a direct push to `main`.
- Managed workflow files may be updated when unmodified. Project configuration and review rules are project-owned but may be read and receive explicitly justified, deterministic proposed edits.
- The bounded threat model is one crew member running an upgrade from an ordinary checkout without a concurrent modifying process. Do not promise broader Git safety.

## Context

- Crew decision, 2026-11-04: target an automatic but reviewable 0.1-to-0.2 upgrade, refusing customized managed workflows and disagreeing pins; leave coordinator follow-up manual; validate the proposed result.
- ST-44 and ST-56 establish initial installation and its draft PR. Repeating `init` does not repin installed workflows.
- ST-65, ST-73 and ST-74 cover first-install convenience, release-version preparation and fresh-install formatting respectively; avoid overlapping those stories.
- ST-78 provides shared review-rule validation; ST-48 records installation validation evidence.
- `templates/workflows/`, `scripts/dispatch/init.mjs` and `docs/release-review.md` supply the existing installed-workflow and release context.
- The three pins (crew, 2026-11-05): pinpoint and tower-workshop-paths pin every managed workflow to `935fb5b`'s full SHA, `init` with no `--ref` writes `v0.1.0`, and `--ref` takes only a full SHA, such as the tag's commit. `git diff --stat 935fb5b v0.1.0^{commit}` shows `package.json`, `package-lock.json` and `releases/v0.1.0.md`, and no other file.
- ST-79 builds the comparison of a workflow with its template, apart from the pin, that AC-5 uses.
- Crew decision, 2026-11-07: 0.2 is the landing-and-upgrade release, not the coding slice.
  Project `land` permission already exists, and a separate landing interval is per-user.
  Any substantial newly discovered migration of project-owned configuration is a
  separate story, not an expansion of this bounded command.
- Crew decision, 2026-11-07: `--ref` lets the release review try the upgrade on the release branch's exact candidate commit before the tag exists, as `init --ref` does for a fresh installation (`docs/release-review.md`, "The walkthrough"). A project upgraded to a candidate then moves to the release tag with the same command.
- `init --ref` (`scripts/dispatch/init.mjs`) checks only the SHA's form. This command also checks that the commit is steward's and carries the target version, so that a candidate pin names a real candidate of that version.
- The templates install steward as `github:luplows/steward#<pin>` (`templates/workflows/`).

## Open questions

*(none)*
