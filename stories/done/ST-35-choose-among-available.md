---
id: ST-35
title: Let the crew override a role's choice for a run, and let ATC take another choice when one is out of usage
tier: normal
kind: workflow
depends_on: [ST-34]
model: sonnet
blocked: null
---

## Intent

As a member of the crew, I want to be able to run a role on another of the machine's available
choices when I start a run by hand, and I want ATC to start a session on another available choice
when the one it would use is over its usage limit, or its usage cannot be read, and another's is
not, so that work goes on while one company's allowance is spent.

## Acceptance criteria

- [x] **AC-1** — `review.mjs` and both forms of `coder.mjs`'s command line (a dispatch, and
      `retry`) take `--choice <name>`, passed to `reviewPullRequest`, `dispatchCoder` and
      `retryStory` as a `choice` option. The name must be a key of that role's `available` in the
      machine's settings; any other name returns `choice-unavailable`, with the name, before the
      usage is read and before anything is claimed, checked out, installed or started. A named
      choice is final: it runs instead of the unit's choice and the default, whatever its
      `strength` (AC-5) and, for the reviewer, even when its model is the coder's (ST-34's AC-5
      does not apply to it). When its tool's usage is over the role's limit, or cannot be read,
      the call returns `over-usage` or `usage-unknown` as today (ST-31), and ATC takes no other
      choice. Tests cover, for each of the three functions: an unavailable name refused before
      the usage is read; an available name run in place of the unit's choice and the default;
      and a named choice whose tool is over its usage returning `over-usage` with no session
      started on another choice. One reviewer test names a choice whose model is the coder's,
      and that choice runs.
- [x] **AC-2** — Without `--choice`, `reviewPullRequest` tries its choices in this order: the one
      `chooseReviewer` picks, then every other choice in `roles.reviewer.available`, in the file's
      order, whose model differs from every model the coder ran (AC-8). For each choice it reads
      the usage of the choice's tool (`readUsage` for `claude`, `readCodexUsage` for `codex`), at
      most once per tool per call, and starts the first choice whose tool's usage is readable and
      under the reviewer's limits. When no choice's is, it returns the refusal of the first choice
      tried (`over-usage` or `usage-unknown`, as today), with `skipped` (AC-3), and starts no
      session. Tests cover: a Codex default over its usage, with a Claude choice started; a Codex
      default whose usage cannot be read, with a Claude choice started; Claude's usage read once
      when two Claude choices are tried; and every tool over its usage, with the first choice's
      refusal returned and no session started.
- [x] **AC-3** — Every result of `reviewPullRequest`, `dispatchCoder` and `retryStory` returned
      after a session started carries `choice`: its `name`, `tool`, `model` and `effort`, and
      `why`, which is `crew` (AC-1), `unit` (a story's `model:` names it), `default`,
      `coder-model` (the reviewer's default has the coder's model, ST-34's AC-5) or `usage` (ATC
      moved off the choice it would have run, AC-2 or AC-6). A result of an ATC move, and a
      refusal after every choice was tried, carries `skipped`: one entry per choice not started,
      in the order tried, each with the choice's `name`, and the `status` its usage gave
      (`over-usage`, with `window`, `percent` and `limit`; or `usage-unknown`, with `reason`). The
      CLIs print both, as part of the result's JSON. Tests assert `choice.why` for each of the
      five cases, and `skipped`'s entries for one move and one refusal.
- [x] **AC-4** — Every `**Planned (…)**` marker naming ST-35 in `docs/agent-workflow-design.md`
      loses `ST-35`, and each passage is corrected wherever what was built differs.
- [x] **AC-5** — `readMachineSettings` requires a key `strength` on every choice in
      `roles.coder.available`: a positive integer, a larger number being a stronger choice, and
      equal numbers equally strong, whatever the tools. A missing `strength`, or one that is not a
      positive integer, is an error naming the key with all its parents (for example
      `roles.coder.available.opus.strength`). A choice in `roles.reviewer.available` has no
      `strength` key, and one there is refused as an unknown key, as today. Tests cover a valid
      file, a missing `strength`, `0`, `1.5`, `"2"`, and a reviewer choice with `strength`.
- [x] **AC-6** — Without `--choice`, `dispatchCoder` and `retryStory` try first the choice the
      story's `model:` names (or `roles.coder.default` when it is `null`), then every other
      choice in `roles.coder.available`, in the file's order, whose `strength` is at least that
      first choice's. A story never runs on a weaker choice than its own: when none of these has
      a tool whose usage is readable and under the coder's limits, the call returns the first
      choice's refusal, with `skipped` (AC-3), before anything is claimed, made or installed.
      Usage is read as AC-2 says. Tests cover: a story whose choice is over its usage, run on an
      available choice of equal strength; one not run on a weaker choice that is under its usage;
      and a `model: null` story taking the default's `strength`. The tests give a second tool's
      usage reader, since every coder choice runs on `claude` today.
- [x] **AC-7** — `dispatchCoder` opens the pull request with the coder's body, with every line
      that starts `Coder:` removed, followed by a last line `Coder: <name>`, naming the choice
      that ran. `retryStory` replaces the body the same way, its `Coder:` line naming the choices
      on the pull request's current `Coder:` line, then the one that ran, each once, in the order
      first run. Tests cover: an opened body ending in `Coder: opus`; a coder's own `Coder:` line
      removed; a retry on another choice giving `Coder: sonnet, opus`; and a retry on the same
      choice giving `Coder: sonnet`.
- [x] **AC-8** — The models the coder ran, which the reviewer's choice must differ from (ST-34's
      AC-5, AC-2), are those of the choices on the last line of the pull request's body that
      starts `Coder:`: for each name, the `model` of that key of `roles.coder.available`, or the
      name as written when it is not one. When the body has no such line, they are found from the
      unit as today (`unitCoderModel`). A reviewer's choice differs from every one of them. Tests
      cover: a `Coder:` line naming a choice the story's `model:` does not, and the reviewer
      avoiding that choice's model; two names, both models avoided; a name that is not an
      available choice; and a body with no `Coder:` line, reviewed as today.
- [x] **AC-9** — `docs/machine-settings.md` describes `strength` in the table of a choice's keys,
      with the coder's choices in its example given a `strength`; and, under "How the choices are
      used", `--choice` (AC-1), the order in which ATC tries choices for each role (AC-2, AC-6),
      and the `Coder:` line (AC-7, AC-8). The headers of `review.mjs` and `coder.mjs` list
      `--choice` in their usage lines, and their docs list the `choice` option and `skipped`.

## Out of scope

- The machine's settings themselves: ST-34.
- A Codex coder: ST-15. Until it is built, every coder choice runs on `claude`, so AC-6's move
  finds no choice in practice, since Claude Code's usage covers every Claude model.
- Per-model weekly usage (`weekly_scoped`), which `usage.mjs` keeps ignoring; and usage limits per
  tool.
- A `strength` for the reviewer's choices: the reviewer may move to any available choice whose
  model differs from the coder's.
- A tool other than Claude Code and Codex.

## Constraints

- Node, ESM, no new runtime dependencies.

## Context

- **Decided on 2026-10-15 by the owner** (design doc, Part 3, "Decided so far", "The machine
  steward runs on has settings of its own"): three tiers choose among a role's available choices:
  the unit, the crew for a run it starts by hand, and ATC when one choice is out of usage and
  another is not.
- **Decided on 2026-10-16 by the owner**, answering this story's open questions (design doc, Part
  3, "Decided so far", "A choice named by hand is final, and ATC moves off a spent tool"): a
  choice named by hand is final; ATC may move to any available choice, in the file's order, the
  coder only to one at least as strong (`strength`); usage that cannot be read counts as spent;
  `weekly_scoped` stays unread; ATC writes a `Coder:` line, which the reviewer reads.
- `reviewPullRequest` reads its tool's usage after `chooseReviewer` (`scripts/dispatch/review.mjs`);
  `dispatchCoder` and `retryStory` read it after `storyChoiceAt` (`scripts/dispatch/coder.mjs`).
  `checkUsage` (`scripts/dispatch/usage.mjs`) turns one reading into a refusal or `null`.
- **When this lands, the machine's settings file needs a `strength` on each coder choice**, or
  every coder run and review stops on the error AC-5 adds. The crew adds it once the pull request
  has landed: a `strength` added before then is refused as an unknown key.

## Open questions

*(none)*
