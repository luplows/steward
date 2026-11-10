---
id: ST-99
title: Follow the project's attribution rules, and drop tower-workshop-paths' identities
tier: normal
kind: product
depends_on: [ST-91]
model: null
blocked: null
---

## Intent

As a member of the crew running ATC on a project, I want the commits and pull request text that
ATC and its coder produce there to follow that project's own rules on attribution, under my own git
identity, so that steward leaves nothing in a project's history that names tower-workshop-paths or
adds AI attribution the project forbids.

## Acceptance criteria

- [ ] **AC-1** — ATC's own commits, the claim commit and the commit of a Codex session's work, are
      authored and committed as the git identity configured for the checkout ATC works in
      (`user.name` and `user.email`, as `git config --get` resolves them there), in place of
      `DISPATCH_IDENTITY`'s `tw-dispatch <dispatch@tower-workshop-paths.invalid>`. That holds for
      `dispatchCoder`, `retryStory` and `executeHandoff`. The identity is read before anything is
      claimed, installed or spawned. When either value is unset or empty, the run refuses with a
      distinct result that names the missing value, and nothing is claimed.
- [ ] **AC-2** — No commit message or pull request text that ATC writes itself carries AI
      attribution: no `Co-Authored-By:` trailer and no "Generated with" line. This covers the claim
      commit, the Codex work commit and any pull request title or body ATC composes. ATC's
      machine-read `Coder:` line is provenance the review reads, not attribution, and is unchanged.
- [ ] **AC-3** — `.claude/prompts/coder.md` and `.claude/prompts/coder-handoff.md` tell the coder
      to follow the project's own instructions on attribution in its commits and its PR text, and,
      where those instructions say nothing about it, to add no AI attribution: no `Co-Authored-By:`
      trailer and no "Generated with" line. Neither prompt asks for attribution anywhere.
- [ ] **AC-4** — The machine label in a claim commit is read from `STEWARD_MACHINE_LABEL`, and from
      `TW_MACHINE_LABEL` only when `STEWARD_MACHINE_LABEL` is unset or empty, with the same
      validation as today and the same `bad-machine-label` refusal. Documentation names the new
      variable and the fallback.
- [ ] **AC-5** — `coder.mjs` no longer treats untracked files under `e2e/__screenshots__/` as
      anything but ordinary changes: they block a push and are included in a Codex work commit like
      any other untracked file, as `classifyStatus`'s other cases are today. `SCREENSHOT_DIR` and
      the `screenshots` result field go, along with every comment and doc line describing them.
- [ ] **AC-6** — The scratch directories ATC makes are named `steward-coder-*`, `steward-review-*`
      and `steward-stop-*`, in place of `tw-coder-*`, `tw-review-*` and `tw-stop-*`, and anything that
      finds them by prefix uses the new names.
- [ ] **AC-7** — `scripts/dispatch/ci.mjs`'s `CI_WORKFLOW_PATH` and `Setup: ` step prefix are
      described, in its comments and in the docs that mention them, as steward's own repository's CI
      conventions, read only by steward's own story loop (`story.mjs`). A test asserts that none of
      `handoff-coder.mjs`, `review.mjs`, `land.mjs`, `inspect.mjs` and the runway's scripts imports
      `ci.mjs`.
- [ ] **AC-8** — A Vitest test scans `scripts/` (other than test files and `fixtures/`),
      `.claude/`, `.github/` and `templates/` and fails on `tw-dispatch`,
      `tower-workshop-paths.invalid`, `tw-coder-`, `tw-review-`, `tw-stop-` or `e2e/__screenshots__`,
      and on `TW_MACHINE_LABEL` anywhere but AC-4's fallback. Each check fails without this story's
      change.
- [ ] **AC-9** — Tests cover AC-1 for each of the three entry points, with an identity set and with
      each value missing; AC-2 for the claim commit, the Codex commit and a composed PR body; AC-4's
      new name, fallback and precedence; and AC-5's screenshot files, now committed or blocking. No
      real model, GitHub mutation or `~/.steward/` access runs.
- [ ] **AC-10** — Resolve `**Planned (ST-99)**` in `docs/agent-workflow-design.md`, and update
      `README.md` and `docs/agent-workflow-design.md` wherever they name the old identity, variable,
      screenshot rule or scratch names, outside dated records.

## Out of scope

- Reviewing against and checking steward's own rule, which `AGENTS.md` states (ST-100).
- A settings key for a project's attribution policy, or ATC checking what the coder wrote: the
  coder follows the project's own instructions (crew, 2026-11-10).
- Removing or changing the `Coder:` line, which ST-92 writes into handoff pull requests.
- `OQ-<n>` references in comments and docs, which `AGENTS.md` defines; CI-log test fixtures from
  tower-workshop-paths; dated records such as `docs/steward-bootstrap.md`.
- Rewriting commits already pushed under the old identity.

## Constraints

Reading the identity from git does not make the commit depend on whatever happens to be configured
at commit time: ATC reads it once, before the claim, and passes it explicitly to every commit it
makes in that run.

## Context

- `scripts/dispatch/coder.mjs`: `DISPATCH_IDENTITY` (line 82 at `d70dacf`), used by the claim
  commit and `commitSessionWork`; `SCREENSHOT_DIR` (line 155) and `classifyStatus`, whose comment
  gives tower-workshop-paths' `CLAUDE.md` as the reason; `machineLabel` reading `TW_MACHINE_LABEL`;
  `mkdtemp` prefixes `tw-coder-` here, `tw-review-` in `review.mjs` and `tw-stop-` in `story.mjs`.
- ST-91 (#155) exports `DISPATCH_IDENTITY` and reuses it for handoffs, so without this story a
  handoff in a client project would commit as `dispatch@tower-workshop-paths.invalid`.
- Pinpoint's `AGENTS.md` forbids AI attribution anywhere: no `Co-Authored-By` trailers in commits,
  and no "Generated with" lines in PRs or issues. The design record, R3 under "Decided so far",
  noted that attribution would matter once a second project had a coder.
- Tower-workshop-paths' `CLAUDE.md` forbids committing locally generated screenshot baselines.
  Once AC-5 lands, a coder there follows that rule from the project's own instructions, or the
  project ignores those files in `.gitignore`.
- `TW_MACHINE_LABEL` is set on the machine that runs ATC today, so AC-4 keeps the old name working.
- Crew decisions, 2026-11-10: the coder follows the project's instructions, and adds no AI
  attribution where they are silent; ATC commits as the crew member's git identity; the four
  leftovers in AC-4 to AC-7 go with it. Considered and not chosen: a settings key for the policy, a
  fixed neutral `steward` identity, an identity in the user config.

## Open questions

*(none)*
