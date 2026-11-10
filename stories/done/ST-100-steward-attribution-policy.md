---
id: ST-100
title: Review against and check steward's no-AI-attribution rule
tier: normal
kind: workflow
depends_on: [ST-99]
model: null
blocked: null
---

## Intent

As the crew of steward's own repository, I want its no-AI-attribution rule, already in `AGENTS.md`,
reviewed against and enforced by a check, so that steward's history and pull requests carry no AI
attribution and a contributor learns of a slip before it lands.

## Acceptance criteria

- [x] **AC-1** — The rule in `AGENTS.md`'s "Every pull request" ("No AI attribution anywhere")
      keeps its meaning and gains a pointer to the check in AC-3, without restating how the check
      works.
- [x] **AC-2** — `REVIEW.md`'s "Every pull request" section gains a numbered item that blocks a pull
      request whose body, or any commit message in its range, carries a `Co-Authored-By:` trailer or
      a "Generated with" line. The `Coder:` line is not a finding.
- [x] **AC-3** — A script, run by `ci.yml`'s `test` job on a pull request as the containment check
      is, fails when any commit in the pull request's range, base to head, has a `Co-Authored-By:`
      trailer, or when the pull request body has a "Generated with" line. The body and the commit
      messages reach it as data, through the environment or a file, never interpolated into a shell
      command. Commits already on `main` are not checked. Vitest tests cover a clean range, a trailer
      in one commit of several, a trailer in a merge's own message, a body with and without the line,
      a `Coder:` line, and a trailer-like line inside a commit body that is not a trailer.
- [x] **AC-4** — The Claude Code sessions that ATC starts in this repository add no attribution of
      their own: a committed project setting turns off Claude Code's default commit trailer and pull
      request line. The pull request names the setting, and the Claude Code documentation it was taken
      from, in its body. Codex sessions commit nothing themselves and are unaffected.
- [x] **AC-5** — `README.md`'s contributing notes state the policy for contributors, and say that a
      project using steward keeps its own policy: the coder follows that project's instructions
      (ST-99), and pull requests ATC opens there carry the `Coder:` provenance line.
- [x] **AC-6** — `.github/pull_request_template.md` and `templates/pull_request_template.md` ask for
      no attribution line. Any instruction in `docs/planning-session.md`, `docs/controller.md`,
      `.claude/prompts/` or `docs/release-review.md` that asks for a trailer or a "Generated with"
      line is removed.
- [x] **AC-7** — Resolve `**Planned (ST-100)**` in `docs/agent-workflow-design.md`.

## Out of scope

- Rewriting existing history: commits already on `main` keep their trailers.
- Any project other than steward. A client's policy is its own; the coder follows it (ST-99).
- Human co-authorship through some other mechanism; the policy bans the trailer, whoever it names.
- The `Coder:` line itself and the reviewer's use of it (ST-92).

## Constraints

The pull request implementing this story must itself pass the check it adds: none of its commits
carries a `Co-Authored-By:` trailer and its body has no "Generated with" line.

## Context

- `AGENTS.md` states the rule since the pull request that added this story (crew, 2026-11-10).
  `REVIEW.md` and `docs/settings.md` say nothing about attribution, nothing checks it, and most of
  steward's earlier commit messages carry `Co-Authored-By:` trailers.
- Pinpoint's `AGENTS.md`: "No AI attribution anywhere: no `Co-Authored-By` trailers in commits, and
  no "Generated with …" lines in PRs or issues."
- `ci.yml` runs `scripts/dispatch/story-containment.mjs` on a pull request, with the branch name
  passed through `env` because it is attacker-chosen text. The same applies to a pull request's body
  and commit messages.
- ST-92 makes `Coder: model=<id>` the literal model the review reads when it excludes a same-model
  reviewer, which is why the line is provenance.
- Crew decision, 2026-11-10: adopt pinpoint's rule for steward, keeping the `Coder:` line.
  Considered and not chosen: banning the `Coder:` line too, and keeping attribution.

## Open questions

*(none)*
