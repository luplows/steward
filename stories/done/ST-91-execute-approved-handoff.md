---
id: ST-91
title: Execute an approved handoff to a pushed branch
tier: normal
kind: product
depends_on: [ST-7, ST-89, ST-90]
model: null
blocked: null
---

## Intent

As a crew member, I want one explicitly approved file or Issue implemented by Steward's existing bounded coder, producing a claimed, pushed branch without requiring the client to use Steward's story schema.

## Acceptance criteria

- [x] **AC-1** — A reusable execution operation accepts an ST-89 handoff ID and approved version rather than selecting from `stories/`. It rechecks activation, approved revision and current unit content immediately before the first branch claim or model side effect. When invoked with an active coordinator admission from ST-93, it accepts only the matching admission ID, handoff ID and approved version; a matching active admission is not a duplicate. A held, withdrawn, changed, completed, stopped, stale or differently admitted handoff starts no model session. A refusal because the current unit content differs from the approved version has a distinct result, separate from refusals that can be retried, such as usage or a source that cannot be read at the moment, so that ST-93 records ST-90 AC-3's hold for it. Tests distinguish matching from mismatched admissions, and a changed-content refusal from a retryable one.

- [x] **AC-2** — A file or Issue coder receives the approved text, original source identity and repository in its prompt. The prompt works without `stories/stories.json`, story frontmatter, a `blocked:` field, `stories/done/`, or a mandatory `AGENTS.md`/`REVIEW.md` file; it reads applicable project instructions when present. Injected unit content uses the existing untrusted-block rendering boundary.

- [x] **AC-3** — ATC derives a deterministic valid branch name from the handoff identity, refuses an existing local or remote branch, and creates the existing non-forced remote claim commit before setup or model invocation. It does not push to `main` or create a PR.

- [x] **AC-4** — The operation preserves existing configured coder choices, usage checks, resource/time limits, credential restrictions, worktree safety, and ST-7's project-configured setup. Tool choice defaults to the per-user coder configuration rather than client-specific story `model:` fields. Codex sessions still use the dispatcher commit path.

- [x] **AC-5** — On completion, return a structured result with repository, handoff ID and approved version, branch, pushed head SHA, session outcome, actual choice/tool/model and the coder's parsed proposed PR description. This story does not create or update a PR; ST-92 consumes successful results.

- [x] **AC-6** — Distinct results identify no-model refusals, claim/setup failures, model failures, missing commits, uncommitted changes and push failures. After a failed run, retain an unpushed branch or worktree whenever cleanup would destroy the only copy of committed or uncommitted coder changes, and report its location. No failed result automatically retries a model.

- [x] **AC-7** — Tests with simulated Git/GitHub and sessions cover file and Issue units, projects without a story directory, absent optional instruction files, a changed approval before claiming, duplicate remote branches, usage refusal, bounded Claude/Codex execution, pushed result and recoverable failures. No real model or GitHub mutation runs.

- [x] **AC-8** — Document this project-neutral execution boundary and remove ST-91 from the 0.3 design marker when implemented.

## Out of scope

- Opening or updating PRs and comparing the approved unit after execution (ST-92).
- Coordinator scheduling, admission records and restart reconciliation (ST-93).
- Automatic fixing or model retries following review blocks (0.4).
- Requiring client story ticks, completion moves or a common acceptance-criteria schema.
- Detecting a change made while the pre-claim checks of a run are in progress: to the unit's
  source, the project's activation, the handoff record or the admission. AC-1's checks act on what
  they read, and a change after that read is not detected before the claim (crew, 2026-11-10). A
  change to the unit is still found after coding, by ST-92's post-session comparison.

## Constraints

Single bounded coder on one machine per invocation. ATC holds remote write credentials; spawned coders do not. Do not silently weaken existing tool or budget limits.

## Context

- `scripts/dispatch/coder.mjs`: claim, worktree, session, Codex commit, push and existing cleanup.
- `.claude/prompts/coder.md` and `scripts/dispatch/invocation.mjs` currently assume Steward-style stories and need a project-neutral path.
- ST-7 supplies configured setup with timeout. The playground PG-1 trial demonstrated the existing Codex coder path.

## Open questions

*(none)*
