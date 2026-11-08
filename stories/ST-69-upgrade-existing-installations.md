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

As a member of the crew using steward in an existing project, I want a mostly automatic upgrade from v0.1.0 to v0.2.0 through a reviewable pull request, so I can adopt improvements without reinstalling or losing project choices. The crew also wants to try an upgrade before a release is tagged, on a release candidate or a commit on `main`, so the command can pin any steward commit as well as a release.

## Acceptance criteria

- [ ] **AC-1** — `steward upgrade --to vX.Y.Z` or `steward upgrade --ref <full SHA>`, exactly one of the two, prepares a draft pull request targeting the project's `main`, reporting its URL. It does not merge or mark ready, change protection, activate the project, start or stop the coordinator, or authorize coding.
- [ ] **AC-2** — The target pin is checked against `luplows/steward` on GitHub before anything is cloned, branched or pushed:
      - `--to` must name a tag there of the form `vX.Y.Z`;
      - `--ref` must be a full commit SHA, 40 hexadecimal characters, of a commit there. A tag or a short SHA is refused, as `init --ref` refuses them.

      Giving both, or neither, is refused. Each refusal names the value and the condition it failed.
- [ ] **AC-3** — The pin the command writes is the tag, or the SHA in lower case. The pull request's title and body say which: a release, or a commit, with the version its `package.json` gives at that commit. So a commit is described as a candidate of that version, or as a development commit when that version is `0.0.0`. They never say a commit is a release.
- [ ] **AC-4** — Identify the installed version from managed workflow references on `main`. The managed workflows are `review-gate.yml` and `land-approved.yml`, and `inspection.yml` when present (`GATE_WORKFLOWS` and `INSPECTION_WORKFLOW`, `scripts/dispatch/init.mjs`).
      - All of them must carry the same pin, and it must resolve in `luplows/steward` to a tag or a commit. Missing, inconsistent or unresolvable references cause refusal naming the findings.
      - When the installed pin and the target resolve to the same commit, the upgrade is a reported no-op: no clone, branch or pull request.
      - When GitHub's comparison of the installed commit with the target's reports the target `behind`, it is refused as a downgrade. `ahead` and `diverged` targets are upgraded; a release branch diverges from `main`.
- [ ] **AC-5** — Compare each installed managed workflow with the template of the same name in `templates/workflows/` of `luplows/steward` at the installed pin, read from GitHub. Only the pin may differ, through ST-79's comparison. A customized file, or one with no template at the installed pin, causes refusal naming each file and explaining manual reconciliation, without silently replacing or attempting a general merge.
- [ ] **AC-6** — Propose the managed workflows from `templates/workflows/` at the target pin, read from GitHub and filled with the target pin as `init` fills them (`fillPin`, `scripts/dispatch/init.mjs`), preserving which optional workflows were installed. A managed workflow with no template at the target is refused, naming it. Tests inspect resulting workflow contents and references. Do not change unrelated project files.
- [ ] **AC-7** — Inspect `steward.config.json` and its configured review-rules file from `main`. Preserve compatible choices, explicitly including `land`, `landWhen`, `unitLinks` and `rulesFile`; an upgrade never grants unattended landing. Propose only target-release changes established by explicit, unambiguous migration rules, explaining each project-owned edit. Where a project-policy decision is required, report it without guessing. The optional per-user landing scan interval is not a project migration.
- [ ] **AC-8** — Validate the proposed result against the running package's settings requirements and ST-78's review-rule parser before claiming the upgrade is ready for crew consideration. An invalid result identifies the affected file and reason and is not reported as validated.
- [ ] **AC-9** — The draft PR names:
      - the installed pin and the target pin, and whether the target is a release or a commit, with its version;
      - the changed managed files, and any justified project-owned changes;
      - the validation outcome, unresolved actions and manual post-merge steps.

      It makes no claim the project was already upgraded.
- [ ] **AC-10** — On failed preparation report any remaining branch, clone or PR and how to recover. Tests, with GitHub's answers injected, cover:
      - a no-op, including a tag installed and its own commit given as `--ref`;
      - each way AC-2 refuses;
      - a downgrade;
      - an upgrade from each of v0.1.0's pins (`v0.1.0`, `0b1d8b3ae9fd295506fa0af39b7e19bab207e430` and `935fb5b81398420acd5e7476d2b94bec94bbad02`) to a commit, and from a commit to a tag;
      - inconsistent and unresolvable pins, customized workflows, and a template missing at either pin;
      - invalid proposed rules;
      - a failed preparation.

      Do not claim rollback without evidence.
- [ ] **AC-11** — Document the bounded upgrade process, approval and effective-pin verification, and any *manual* coordinator stop/restart required. Say to run the command from steward installed at the target pin, since the settings validation of AC-8 is the running package's. The command never changes local coordinator or per-user state. `docs/release-review.md`'s walkthrough adds the upgrade:
      - on a project installed at the previous release's pin, run `steward upgrade --ref <commit>`, `<commit>` being the release branch's last commit, and again after each fix lands into the branch;
      - after the tag, a project upgraded to a candidate moves to the release with `steward upgrade --to vX.Y.Z`.
- [ ] **AC-12** — Resolve the `**Planned (ST-69)**` marker in `docs/agent-workflow-design.md` in the implementing PR, correcting the design passage if necessary.

## Out of scope

- Downgrades, general migration engines, automatic rollback or conflict resolution.
- Versioned migrations of project-owned settings (draft ST-87). An upgrade makes only the explicit, unambiguous changes of AC-7.
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
- Crew decision, 2026-11-07: the templates on both sides are read from `luplows/steward` at the pins, so nothing extra is shipped, any steward commit can be a target before a release is cut, and the installed pin need not be one of a fixed list. `--ref` lets the release review try the upgrade on the release branch's exact candidate commit, as `init --ref` does for a fresh installation (`docs/release-review.md`, "The walkthrough").
- `templates/workflows/` holds `inspection.yml`, `land-approved.yml` and `review-gate.yml` at `v0.1.0`, at `935fb5b` and on `main`, and `git diff v0.1.0 c0d4654 -- templates/` is empty. GitHub serves a file at any commit (`repos/luplows/steward/contents/<path>?ref=<pin>`) and compares two commits (`repos/luplows/steward/compare/<a>...<b>`, whose `status` is `ahead`, `behind`, `diverged` or `identical`).
- `init --ref` checks only the SHA's form. This command also checks that the commit is steward's.
- The templates install steward as `github:luplows/steward#<pin>` (`templates/workflows/`).

## Open questions

*(none)*
