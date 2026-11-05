# ST-48: review installation in two existing projects

The record of [ST-48](../../stories/done/ST-48-validate-review-installation.md): steward installed
in pinpoint and then in tower-workshop-paths from `release/v0.1.0`, each keeping its own units.

`luplows/pinpoint` is private. Its section gives references and summaries, with no links and no
details of the project's work. Its full evidence stays with the crew. `luplows/tower-workshop-paths`
is public, so its links are open.

## Result

| Criterion | pinpoint | tower-workshop-paths |
| --- | --- | --- |
| AC-2 Installation | Demonstrated, with D1 | Demonstrated, after removing the project's old copies, with D5 |
| AC-3 Unit convention | GitHub issues kept | File stories and the `OQ` prefix kept |
| AC-4 Real review | Demonstrated, with D2 | Demonstrated, with D2 |
| AC-4a Activation and automatic review | Demonstrated | Demonstrated, including reviews in turns with pinpoint |
| AC-5 Landing | Demonstrated, with D3 and D4 | Demonstrated |
| AC-6 Deliberate violation | Demonstrated | Not run: one project is required |

No defect prevented a required demonstration.

**The crew's judgment on tower-workshop-paths (2026-11-04).** AC-2 and the Constraints ask for the
project's own approved process, with no bypass of the gate to obtain a landing result. That project's
gate cannot review what installs it, so `review/agent` was removed from its required checks twice, on
the crew's word, to merge #281 and #283 by hand, and restored each time by `steward protect`. The crew
accepts this as meeting AC-2: the landing evidence, #282, went through the real gate. Reaching an
`init` installation also ended that project's coder loop for now, which the crew accepted too.

## Follow-up work

| Defect | Summary | Follow-up |
| --- | --- | --- |
| D1 | `init`'s files can fail a project's Prettier check | [ST-74](../../stories/ST-74-prettier-compatible-init-files.md) |
| D2 | A verdict comment names neither the unit read nor the reviewer used | [ST-77](../../stories/ST-77-include-review-provenance-in-verdicts.md) |
| D3 | A landing starts no workflows triggered by `push` on `main` | [ST-75](../../stories/ST-75-explain-ci-after-steward-landing.md) |
| D4 | A landing does not close the linked issue | [ST-76](../../stories/ST-76-choose-issue-closure-after-runway-landing.md) |
| D5 | An existing checklist is not parsed at installation, and can then refuse every review | [ST-78](../../stories/ST-78-validate-existing-review-rules.md) |

## pinpoint

### Project

| Item | Value |
| --- | --- |
| Project | `luplows/pinpoint` (private, GitHub Free) |
| Date | 2026-11-04 |
| Operator | Steve Luplow (crew), with a Claude Code session running the commands |
| Steward version | `package.json` says `0.0.0` at this commit; `release/v0.1.0`, untagged |
| Resolved commit | `935fb5b81398420acd5e7476d2b94bec94bbad02`, identical to `release/v0.1.0` |
| Command form | `npx --yes --package=github:luplows/steward#935fb5b81398420acd5e7476d2b94bec94bbad02 steward <command>` |
| Prerequisites | Node v24.21.0, npm 11.19.0, gh 2.100.0, Claude Code CLI 2.1.302, an existing `~/.steward/config.json` |
| Configured reviewer | `sol-6.1`: tool `codex`, model `gpt-6.1-sol`, effort `high`, from the user config |
| Activated projects at the start | None |

### AC-3: Unit convention

| | Before | After |
| --- | --- | --- |
| Units | GitHub issues | The same |
| Link from a pull request | `Closes #<n>` | `Unit: #<n>`, plus `Closes #<n>` in the pull request that finishes the issue |
| Settings | None | `unitLinks: ["issue"]` |
| Steward stories, schema or queue | Not used | Not used |

Units and pull requests: installation, #67 and #66; passing review and landing, #68 and #69;
deliberate violation, #70 and #71.

**Expected:** pinpoint keeps its issues. **Actual:** it did. **Defects:** none.

### AC-2: Installation

```sh
steward init --yes --ref 935fb5b81398420acd5e7476d2b94bec94bbad02 --land no --unit-links issue
```

Answers: `--land no` and `--unit-links issue`, as flags. Defaults through `--yes`: `rulesFile`
`REVIEW.md`, inspection yes, `inspectAfterHours` 24, branch `steward/install`.

**Expected:** a draft pull request adding the gate's files, with nothing copied from steward's
implementation.

**Actual**

| Item | Outcome |
| --- | --- |
| `init` | Exit 0, base `c414d73`, installation commit `d220cf2` |
| Files written | `steward.config.json`, `REVIEW.md`, `.github/workflows/review-gate.yml`, `land-approved.yml`, `inspection.yml`, `.github/pull_request_template.md` |
| Left alone | No repository file; `~/.steward/config.json` |
| Labels created | `review-blocked`, `breaker-override`, `inspection` |
| Diff at `d220cf2` | 6 files, +394/-0, no steward scripts or prompts |
| Workflow pin | Every steward call uses `npx` at the full SHA `935fb5b…` |
| Settings | `steward.config.json`: `land: false`, `landWhen: "all-checks"`, `unitLinks: ["issue"]`, `setup` and `check` null |
| Checklist | `REVIEW.md` |
| CI | Failed at `d220cf2` on the project's lint (D1), passed at `da17c2e` after a formatting-only commit |
| Merged by hand | #66, as `4573ac8e334121948d25cbd747a215c505326834`, with `review/agent` pending, as expected for the pull request that installs the gate |

By hand: the formatting commit, the title "Install steward at 935fb5b", `0.0.0` removed from the body
and the commit message, and the template filled in with `Unit: #67`.

**Branch protection.** `steward protect` exited 1, and `main` reads `protected: false`:

```
branch protection on main: not set. GitHub offers none for this repository on its plan (a private repository on GitHub Free has none).
  Nothing on GitHub then enforces the gate: a merge without a passing review is not stopped. Inspection, if added, raises one after the fact.
```

**No coder** was enabled or dispatched. `land` stays `false`. **Defects:** D1.

### AC-4: Real review

The coordinator reviewed #69 against #68. No `review` or `rotation` was run by hand.

| Item | Value |
| --- | --- |
| Checklist revision | `REVIEW.md` on `main` at `4573ac8e334121948d25cbd747a215c505326834` |
| Reviewer result | `reviews.json`: `recorded`, 1 session, 20:49:56 to 20:50:28 UTC |
| Verdict comment | pass, comment 6641780335 on #69 |
| Reviewed head and pull request head at review | `98c135a452d0119aa25c9fcc7b41825f67c632b0` |
| Marker | `<!-- agent-review head=98c135a452d0119aa25c9fcc7b41825f67c632b0 verdict=pass -->` |
| `review/agent` on that SHA | `success`, 20:50:40 UTC |

**Expected:** the review reads the unit and checklist, and the marker and status bind to its head.
**Actual:** they did. No marker or verdict was written by hand. **Defects:** D2.

### AC-4a: Activation and automatic review

**Not activated: no review.** With #69 open:

```sh
steward coordinator start
```

It started at 20:34:54 UTC, as process 51412. About 20 seconds later, `steward coordinator status`
reported the first three lines below, and `steward project list` the last:

```
running: the coordinator is process 51412, started 2026-11-04T20:34:54.348Z. To stop it: steward coordinator stop
Scan interval: 15 minutes.
Next scan: 2026-11-04T20:49:54.355Z.
No project is activated (<user's home>\.steward\state\projects.json lists none).
```

#69 then had 0 comments, `review/agent` pending and no entry in `reviews.json`.

**Activated: review at the next scan.**

```sh
steward project activate <the project's checkout>
```

It ran at 20:38:18 UTC, exit 0, printing `Nothing was started.` The operator's checkout did not change.
The scan due at 20:49:54 UTC started the review at 20:49:56 UTC, and `steward coordinator status` then
reported, among its lines:

```
Next scan: 2026-11-04T21:05:28.796Z.
Last outcome: luplows/pinpoint pull request #69, head 98c135a452d0119aa25c9fcc7b41825f67c632b0: recorded (verdict), at 2026-11-04T20:50:28.791Z.
```

AC-4's table is the evidence for this review.

`steward coordinator stop` reported: `stopped: the coordinator, process 51412, had no work running; it
has removed its record and exited.`

Reviews in turns are in tower-workshop-paths' section, which ran after this one. **Defects:** none.

### AC-5: Landing

`steward land 69`: exit 0, `status: merged`, `mode: manual`, `triggers: 1`.

| Item | Value |
| --- | --- |
| Passing verdict and status | As under AC-4; `review/agent` `success` before the landing at 20:55:22 UTC |
| Checks for `landWhen: "all-checks"` | The project's type check, lint, test and deploy passed |
| Workflow run | 41911182966, `workflow_dispatch`, success |
| Runway log | `Landing authorized: mode="manual" actor="luplows" PR="69" authorized head="98c135a452d0119aa25c9fcc7b41825f67c632b0"` |
| Merged | #69, at 20:55:43 UTC, by `app/github-actions`, as `8c3300f923a0fd17c92655524577246702709fc6` |
| Reviewed, status and landed heads | All `98c135a452d0119aa25c9fcc7b41825f67c632b0` |
| Tree check | The merged commit and reviewed head have the same tree, `f857998` |

**Expected:** a merge through the pilot and runway only after a passing review. **Actual:** so it was.
After the landing, `8c3300f` had no CI push run (D3), and #68 stayed open despite `Closes #68` and was
closed by hand (D4). **Defects:** D3, D4.

### AC-6: Deliberate violation

#71 did what #70 asks and also changed a file #70's Out of scope excludes. Its body declared the
violation as deliberate. The coordinator reviewed it.

| Item | Value |
| --- | --- |
| Head | `fc3714333702b4474c80a687c3d2ec5a1786b5ee`, not AC-5's |
| Verdict | block, comment 6642108890 on #71 |
| Finding | "Conformance to the unit, item 3 (block)": "Disclosing this deliberate violation in the PR body does not satisfy containment" |
| Marker | `<!-- agent-review head=fc3714333702b4474c80a687c3d2ec5a1786b5ee verdict=block -->` |
| `review/agent` on that head | `failure`, 21:06:23 UTC |
| Other checks | CI and deploy passed, so the block is not an unrelated failure |
| Landing attempt | `steward land 71` at 21:07:30 UTC: exit 1, `status: review-failed`, `triggers: 0` |
| After the attempt | Pull request open, no merge commit, `main` unchanged at `8c3300f`, no new landing run. Closed unmerged later, with the crew's agreement |

**Expected:** a block and a refused landing. **Actual:** both. **Defects:** none.

## tower-workshop-paths

### Project

| Item | Value |
| --- | --- |
| Project | [`luplows/tower-workshop-paths`](https://github.com/luplows/tower-workshop-paths) (public) |
| Date | 2026-11-04 and 2026-11-05 UTC |
| Operator | Steve Luplow (crew), with a Claude Code session running the commands |
| Steward version | `package.json` says `0.0.0` at this commit; `release/v0.1.0`, untagged |
| Resolved commit | `935fb5b81398420acd5e7476d2b94bec94bbad02`, identical to `release/v0.1.0` by the compare API |
| Command form | As for pinpoint |
| Prerequisites | As for pinpoint |
| Configured reviewer | As for pinpoint |
| Activated projects at the start | `luplows/pinpoint` |
| Protection before | `main` required `test` and `review/agent`, `enforce_admins` on |

### AC-3: Unit convention

| | Before | After |
| --- | --- | --- |
| Units | File stories, `stories/OQ-<n>-<slug>.md`, moved to `stories/done/` by the pull request that implements them | The same |
| Link from a pull request | None: found from the story's move or the branch name | `Unit: stories/OQ-<n>-<slug>.md`, through a line added to the template in [#279](https://github.com/luplows/tower-workshop-paths/pull/279) |
| Prefix | `storyPrefix` in `steward.config.json` | A local constant, since steward's settings reject that key. The prefix itself is unchanged |
| Settings | `repo`, `storyPrefix` | `unitLinks: ["file"]`, as `init` wrote it |
| Steward stories, schema or queue | Not used | Not used |

Units and pull requests: installation,
[OQ-115](https://github.com/luplows/tower-workshop-paths/blob/main/stories/done/OQ-115-workflow-own-repository.md)
and [#281](https://github.com/luplows/tower-workshop-paths/pull/281); passing review and landing,
[OQ-97](https://github.com/luplows/tower-workshop-paths/blob/main/stories/done/OQ-97-clear-leading-zeros.md)
and [#282](https://github.com/luplows/tower-workshop-paths/pull/282).

**Expected:** the project keeps its file stories and `OQ` prefix. **Actual:** it did. **Defects:**
none, though the prefix's storage had to move.

### AC-2: Installation

This project predates steward's package, and `init` never overwrites a file, so its old copies of the
engine left first, through its old gate. Removing only the workflows and settings failed 76 tests
across 12 files, so the tests that depend on them left at the same time.

| Step | Pull request | Reviewed and merged by | Commit |
| --- | --- | --- | --- |
| Plan, stories and design decision | [#278](https://github.com/luplows/tower-workshop-paths/pull/278) | Old gate, old sweep | `8bb502b` |
| Story tooling stands apart (OQ-148) | [#279](https://github.com/luplows/tower-workshop-paths/pull/279) | Old gate, old sweep | `3d70e0f` |
| Old engine removed (OQ-132): 56 files | [#280](https://github.com/luplows/tower-workshop-paths/pull/280) | Old gate, old sweep, on the crew's word | `405c678` |
| `init`'s pull request (OQ-115) | [#281](https://github.com/luplows/tower-workshop-paths/pull/281) | By hand | `80ceb89` |
| Checklist fix (D5) | [#283](https://github.com/luplows/tower-workshop-paths/pull/283) | By hand | `9a694e6` |

```sh
steward init --yes --ref 935fb5b81398420acd5e7476d2b94bec94bbad02 --land no --unit-links file --rules-file REVIEW.md
```

Answers: `--land no`, `--unit-links file` and `--rules-file REVIEW.md`, as flags. Defaults through
`--yes`: inspection yes, `inspectAfterHours` 24, branch `steward/install`.

**Expected:** a draft pull request adding the gate's files, with nothing copied from steward's
implementation.

**Actual**

| Item | Outcome |
| --- | --- |
| `init` | Exit 0, base `405c678`, installation commit `c9278ea` |
| Files written | `steward.config.json`, `.github/workflows/review-gate.yml`, `land-approved.yml`, `inspection.yml` |
| Left alone | `REVIEW.md`, `.github/pull_request_template.md`, `~/.steward/config.json` |
| Labels | `review-blocked` found and left; `breaker-override` and `inspection` created |
| Diff at `c9278ea` | 4 files, +294/-0, no steward scripts or prompts |
| Workflow pin | All 6 steward calls use `npx` at the full SHA `935fb5b…` |
| Settings | `steward.config.json`: `land: false`, `landWhen: "all-checks"`, `unitLinks: ["file"]`, `rulesFile: "REVIEW.md"`, `inspectAfterHours: 24`, `setup` and `check` null |
| Checklist | `REVIEW.md` |
| CI at `9768c4d` | `test` passed |
| Merged by hand | #281, as `80ceb89965386d353cf08dbc03b6d72544ba117c`, with `review/agent` pending, as expected |

By hand: the `Unit:` line in #279, commit `9768c4d` on `init`'s branch for OQ-115's move and ticks and
the project's design doc, the title "Install steward at 935fb5b", `0.0.0` removed from the body and the
commit message, and the template filled in.

**Branch protection.** `review/agent` was removed from the required checks for #281 and again for #283.
`steward protect` exited 0 each time, restoring `test`, `review/agent` and `enforce_admins`:

```
branch protection on main: already there, so the project's own is kept
  enforce_admins is already on
  added review/agent to its required status checks
  Everything else in it is as it was. The project's own CI checks are the crew's to add.
```

**No coder** was enabled or dispatched by steward. `land` stays `false`. **Defects:** D5.

### AC-4: Real review

The coordinator reviewed #282 against OQ-97. No `review` or `rotation` was run by hand.

| Item | Value |
| --- | --- |
| Unit | `stories/OQ-97-clear-leading-zeros.md`, by its `Unit:` line |
| Checklist revision | `REVIEW.md` on `main` at `9a694e667ed78f95959232d66f7d1436dc995fd2` |
| Reviewer result | `reviews.json`: `recorded`, 1 session, 02:19:44 to 02:21:38 UTC |
| Verdict comment | [pass](https://github.com/luplows/tower-workshop-paths/pull/282#issuecomment-6647927105) |
| Reviewed head and pull request head at review | `91b6bac6477823571dc003b3c3f8decee894aabc` |
| Marker | `<!-- agent-review head=91b6bac6477823571dc003b3c3f8decee894aabc verdict=pass -->` |
| `review/agent` on that SHA | `success`, 02:21:48 UTC, [gate run 41954687215](https://github.com/luplows/tower-workshop-paths/actions/runs/41954687215) |

**Expected:** the review reads the unit and checklist, and the marker and status bind to its head.
**Actual:** they did. No marker or verdict was written by hand on any pull request after #280.
**Defects:** D2, seen again.

### AC-4a: Activation and automatic review

**Not activated: no review.** With #282 open and only pinpoint activated:

```sh
steward coordinator start
```

It started at 01:33:26 UTC, as process 41616. At 01:33:35 UTC, `steward coordinator status` reported:

```
running: the coordinator is process 41616, started 2026-11-05T01:33:26.143Z. To stop it: steward coordinator stop
Scan interval: 15 minutes.
Next scan: 2026-11-05T01:48:26.916Z.
```

#282 then had 0 comments, `review/agent` pending and no entry for this repository in `reviews.json`.

**Activated.**

```sh
steward project activate <the project's checkout>
```

It ran at 01:34:24 UTC, exit 0, printing `Nothing was started.` The operator's checkout did not change.

**In turns.**

The first scan, at 01:48:26 UTC, reviewed pinpoint first, then took #282's turn at 01:48:54 UTC, which
ended in 2 seconds as `rules-unreadable` (D5). No model started. After #283, both projects had a head
waiting at one scan, one review running at a time:

| Project and pull request | Head | Started (UTC) | Ended (UTC) | Result |
| --- | --- | --- | --- | --- |
| `luplows/pinpoint` #73 | `069d9ef` | 02:19:04 | 02:19:43 | `recorded`, 1 session, pass |
| `luplows/tower-workshop-paths` #282 | `91b6bac` | 02:19:44 | 02:21:38 | `recorded`, 1 session, pass |

`steward coordinator status` then reported:

```
running: the coordinator is process 41616, started 2026-11-05T01:33:26.143Z. To stop it: steward coordinator stop
Scan interval: 15 minutes.
Next scan: 2026-11-05T02:36:38.400Z.
Last outcome: luplows/tower-workshop-paths pull request #282, head 91b6bac6477823571dc003b3c3f8decee894aabc: recorded (verdict), at 2026-11-05T02:21:38.396Z.
```

AC-4's table is the evidence for #282's review. For pinpoint #73's:

| Item | Value |
| --- | --- |
| Unit | None: `Unit: none`. #73 exists only to have a head waiting at the same scan. Pinpoint's automatic review of a pull request with a linked unit is #69, above |
| Checklist revision | `REVIEW.md` on `main` at `8c3300f923a0fd17c92655524577246702709fc6` |
| Reviewer result | `reviews.json`: `recorded`, 1 session |
| Verdict comment | pass, comment 6647882267 on #73 |
| Reviewed head and pull request head at review | `069d9efa7bb8dfc1096265e934f2141eef1c8256` |
| Marker | `<!-- agent-review head=069d9efa7bb8dfc1096265e934f2141eef1c8256 verdict=pass -->` |
| `review/agent` on that SHA | `success`, 02:19:56 UTC |

#73 was closed unmerged afterwards. `steward coordinator stop` reported: `stopped: the coordinator,
process 41616, had no work running; it has removed its record and exited.`

**Defects:** D5 delayed this. None otherwise.

### AC-5: Landing

`steward land 282`: exit 0, `status: merged`, `mode: manual`, `triggers: 1`.

| Item | Value |
| --- | --- |
| Passing verdict and status | As under AC-4; `review/agent` `success` before the landing at 02:35:50 UTC |
| Checks for `landWhen: "all-checks"` | `test`, `pending` and `baselines` success, `verdict` skipped |
| Workflow run | [41956225493](https://github.com/luplows/tower-workshop-paths/actions/runs/41956225493), `workflow_dispatch`, success |
| Runway log | `Landing authorized: mode="manual" actor="luplows" PR="282" authorized head="91b6bac6477823571dc003b3c3f8decee894aabc"` |
| Merged | [#282](https://github.com/luplows/tower-workshop-paths/pull/282), by `app/github-actions`, as `0b5c5157c6ed0cacbfdf765cf7059fc84d088de7` |
| Reviewed, status and landed heads | All `91b6bac6477823571dc003b3c3f8decee894aabc` |
| Tree check | Differs from the reviewed head by exactly the 3 files of #283, which reached `main` after that head's base |

**Expected:** a merge through the pilot and runway only after a passing review. **Actual:** so it was.
CI and Deploy ran on `0b5c515` and passed, by `workflow_run`, since this project's own workflows
already trigger on `Land approved PRs`: D3 does not occur here. The story moved to `stories/done/` in
the pull request, so D4 does not apply. **Defects:** none.

### AC-6: Deliberate violation

Not run here. ST-48 requires it in at least one project, and pinpoint shows it.

## Defects

None was fixed under ST-48. Each has its follow-up above.

**D1.** Reproduce: run `init` in a project whose CI runs `prettier --check .`. Expected: CI passes, or
`init` warns. Actual: `steward.config.json`, `land-approved.yml` and `inspection.yml` fail. Impact: a
hand formatting commit in pinpoint's installation pull request.

**D2.** Reproduce: read a verdict comment on a pull request with a `Unit:` line. Expected: the comment
says what was found for the unit. Actual: `describeUnit`'s note goes only to the reviewer, and neither
the comment nor `reviews.json` records the unit or the reviewer used. Impact: this record shows the
unit through the pull request body and the reviewer's wording.

**D3.** Reproduce: `steward land` in a project with CI on `push` to `main`. Expected: CI and deploys
run, or the docs say they will not. Actual: no run on the landed commit, while hand merges each got
one. The runway merges with `github.token`, whose events start no new runs. Impact: none on AC-5, but
pinpoint's deploy did not run for that commit.

**D4.** Reproduce: `steward land` on a pull request with `Closes #<n>` that GitHub lists in
`closingIssuesReferences`. Expected: the issue closes. Actual: it stays open. The cause is the
`github.token` merge: on `luplows/playground`, runway merges stayed open with and without
`issues: write` (#20, #21), and a hand merge with a message holding no closing keyword closed its issue
(#22). Impact: one hand close.

**D5.** Reproduce: have a `REVIEW.md` on `main` with a `## ` section with no line beginning with a
number. Run `init`, merge, `protect`, `project activate`, and let the coordinator reach a pull request.
Expected: `init`, `protect` or `activate` says the checklist will not parse. Actual: `init` says
`left REVIEW.md: already there`, `protect` and `activate` check only that the file exists, and the first
review is refused: `rules-unreadable`, `REVIEW.md: section "Reading the PR body": has no item (a line
beginning "1. ")`. Steward reads the checklist from `main`, so the pull request that repairs it is
refused too, and with protection on the way through is to remove `review/agent` and merge by hand.
Impact: one further hand merge, #283, and a second scan for the turns demonstration.

## State left behind

| Item | pinpoint | tower-workshop-paths |
| --- | --- | --- |
| Activation | Activated | Activated |
| `land` | `false` | `false` |
| Protection | Not available | `test`, `review/agent`, `enforce_admins` |
| Not observed | Inspection had not run when this was written, and may raise #65 and #66 | Inspection had not run when this was written, and may raise #281 and #283 |

The coordinator is stopped. Tower-workshop-paths' coder loop has ended for now, with OQ-72, OQ-94 and
OQ-105 held by `blocked:`.

## Steward itself

The crew installs in steward itself too, outside ST-48's criteria. Decided by the crew, 2026-11-04,
after tower-workshop-paths showed what conversion takes: `init` runs once here, and converting
steward's own gate to the thin workflows moves to 0.2.

```sh
steward init --yes --ref 935fb5b81398420acd5e7476d2b94bec94bbad02 --land no --unit-links file --rules-file REVIEW.md
```

Exit 0, against steward's `main` at `65f73cf`. It left `steward.config.json`, `REVIEW.md`,
`review-gate.yml`, `land-approved.yml`, `inspection.yml` and the pull request template in place, found
`review-blocked` and `inspection`, created `breaker-override`, and made no branch, commit, push or pull
request. Its message, `the installation is already complete`, means only that those files exist: steward's
workflows are its own, not `init`'s thin ones, so this is no installation at the pin.
