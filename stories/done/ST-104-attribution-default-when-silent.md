---
id: ST-104
title: Leave the coder's own attribution default in place when a project says nothing
tier: normal
kind: product
depends_on: []
model: null
blocked: null
---

## Intent

As a member of the crew running ATC on a project whose agent instructions say nothing about
attribution, I want steward's coder prompts and docs to say what actually happens there, that the
coder's tool keeps its own default attribution, so that a project which wants none knows it has to
say so, and the prompts stop asking the coder for something its tool does not do.

## Acceptance criteria

- [x] **AC-1** — The attribution rule in `.claude/prompts/coder.md` and
      `.claude/prompts/coder-handoff.md`, "Follow this repository's (project's) own rules on
      attribution", says: add the attribution the agent instructions require, leave out what they
      forbid, and, when they say nothing on it or there are none, apply no rule of your own,
      neither adding attribution nor removing what your tool adds by default. "Apply no other rule
      on it" and "ATC copies what you write unchanged" stay.
- [x] **AC-2** — The `## Commit message` passage of both prompts says the same for a Codex coder's
      commit message: the attribution the instructions require, none when they forbid it, and,
      when they say nothing, whatever the coder would write by default. ATC still commits the text
      unchanged.
- [x] **AC-3** — `README.md`, "Contributing", where it says a project that uses steward keeps its
      own attribution policy, adds that where a project's instructions say nothing, the coder's
      tool default applies, so a project that wants no AI attribution says so in its agent
      instructions.
- [x] **AC-4** — `docs/agent-workflow-design.md`'s attribution passage (crew, 2026-11-10) no longer
      says the coder "defaults to none when silent", and this story's **Planned** marker there is
      removed.
- [x] **AC-5** — The tests that assert the prompts' wording (`coder.test.mjs`, "ST-99/AC-3: the
      coder prompts leave attribution to the consuming project") assert the new rule for a silent
      project in both prompts, in place of "add none when they say nothing".
- [x] **AC-6** — ATC's code is unchanged: it adds no attribution, removes none the coder wrote,
      and keeps the `Coder:` line.

## Out of scope

- Enforcing "none when silent", or any check of the coder's output for attribution.
- Steward's own repository policy. Steward forbids AI attribution in its own repository
  (`README.md`, "Contributing", and `scripts/dispatch/attribution-check.mjs`), so its coders leave
  it out there, and this story does not change that.
- Changing what ATC's own claim commits carry: still no AI attribution.

## Constraints

- Docs and prompts only, with their tests. No change to `scripts/dispatch/` outside test files.

## Context

- Found in the 0.3.0 release review. Every coordinator coder on tower-workshop-paths, whose rules
  say nothing on attribution, committed with `Co-Authored-By` (H-1, 2026-11-17; H-2, 2026-11-18;
  H-3's commit `67e2fda` in tower-workshop-paths #297, 2026-11-25), although both prompts say "add
  none when they say nothing". On 2026-11-18 the crew said a tool's default on a silent project is
  acceptable, and that only attribution a project suppresses must not appear. On 2026-11-25 the
  crew chose to document that default, outside the 0.3.0 release, whose notes list it as a known
  issue and as ST-99's follow-up.
- ST-99 (`stories/done/ST-99-project-attribution-and-neutral-identity.md`) built the current rule.

## Open questions

*(none)*
