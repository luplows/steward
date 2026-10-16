---
id: ST-32
title: Run the reviewer through the Codex CLI, chosen in the machine's settings
tier: normal
kind: workflow
depends_on: [ST-22, ST-31, ST-33, ST-34]
model: sonnet
blocked: "Built by hand: changes .claude/prompts/reviewer.md, which a spawned coder session cannot edit (docs/agent-workflow-design.md, A spawned session cannot edit .claude/prompts/)"
---

## Intent

As a member of the crew, I want the reviewer to be able to run through OpenAI's Codex CLI instead
of Claude Code, chosen in the machine's settings, so that a pull request is judged by a model from
another company than the one that wrote it, and so that steward does not depend on one company
(design doc, "Goals", 2 and 3). The reviewer keeps the guarantees it has under Claude Code, shown
by tests before it is used (M3).

## Acceptance criteria

- [ ] **AC-1** — The machine's settings (ST-34) accept `"codex"` as the `tool` of a choice in
      `roles.reviewer.available`, with `effort` one of `low`, `medium`, `high`, `xhigh`, `max`
      and `ultra`. A choice in `roles.coder.available` with `tool` `"codex"` is refused, naming
      its key. When any choice's tool is `"codex"`, the file must also have a key
      `tools.codex.executable`, the path of the `codex` executable, as an absolute path to a file
      that exists; it is refused otherwise, naming the key. Without a Codex choice, `tools` may be
      left out.
- [ ] **AC-2** — When the reviewer's choice has `tool` `"codex"`, `reviewPullRequest` starts it,
      with no shell, as
      `<executable> exec -s read-only -C <checkout> -m <model> -c model_reasoning_effort="<effort>" --json -o <file> --ephemeral -`,
      with the rendered prompt on stdin, in `coderEnv`'s environment (no GitHub credential), and
      `<file>` in the review's scratch directory. Its last message, read from `<file>`, is parsed
      by `parseReviewerVerdict` exactly as a Claude reviewer's is, and a malformed one gets
      OQ-121's one re-run as today. A reviewer whose choice has `tool` `"claude"` is started as
      today.
- [ ] **AC-3** — Before starting a Codex reviewer, ATC reads Codex's usage with no model call: it
      starts `<executable> app-server --listen stdio://`, sends `initialize`, then
      `account/rateLimits/read`, and stops the process. The window whose `windowDurationMins` is
      300 is `session`, and the one whose `windowDurationMins` is 10080 is `weekly`; each one's
      `usedPercent` is checked against `usageLimits.reviewer` as ST-31's `checkUsage` checks
      Claude Code's, giving `over-usage` or going on. The process failing, no answer within 30
      seconds, either window missing, or a `usedPercent` that is not a number is `usage-unknown`.
      Of the answer, nothing is printed, logged or stored beyond each window's percent and reset
      time.
- [ ] **AC-4** — `reviewer.md` keeps one set of rules, with a short section for a reviewer running
      under the Codex CLI (M5), saying: the head is already checked out and there is no network,
      so confirm it with `git rev-parse HEAD` instead of `git fetch`; the base for the three-dot
      diff is the `origin/<base>` already in the checkout; and commands run in Windows PowerShell
      5.1, where `&&` does not parse, so run them one at a time. A test asserts the section's three
      points.
- [ ] **AC-5** — Tests, named `ST-32/AC-<n>`, with the processes injected, showing the reviewer's
      guarantees hold under Codex (M3):
      - the Codex invocation passes `-s read-only` and `-C` with the review's checkout, and none of
        `workspace-write`, `danger-full-access` or `--dangerously-bypass-approvals-and-sandbox`;
      - its environment holds no `GH_TOKEN`, `GITHUB_TOKEN` or `GH_ENTERPRISE_TOKEN`, and its
        `GH_CONFIG_DIR` is the review's empty one;
      - a checkout changed by the first session gets no second, as for Claude Code;
      - the usage read accepts a Plus-shaped answer (a 300-minute and a 10080-minute window), and
        gives `usage-unknown` for a free-plan one (one 43200-minute window) and for a timeout;
      - a coder choice with `tool` `"codex"` is refused.
- [ ] **AC-6** — The pull request records, in `docs/agent-workflow-design.md`, "Trials and
      measurements", "Codex as reviewer", one review of a steward pull request by the built Codex
      reviewer at the pull request's head, with nothing posted: the verdict it returned, whether
      `parseReviewerVerdict` accepted it, and its wall time.
- [ ] **AC-7** — Every `**Planned (…)**` marker naming ST-32 in `docs/agent-workflow-design.md`
      loses `ST-32`, and each passage is corrected wherever what was built differs.

## Out of scope

- A Codex coder. That waits for steward's coder stories (owner, 2026-10-15), and stays in ST-15.
- A tool other than Claude Code and Codex.
- Choosing between the tools by their usage, or by hand for a run: ST-35.
- Whether a sandboxed reviewer can read Windows Credential Manager under `read-only`: left to ST-6
  (owner, 2026-10-15).
- Changing what the gate decides: verdicts, sections, landing.

## Constraints

- Node, ESM, no new runtime dependencies.

## Context

- **The answers, from the owner on 2026-10-15** (design doc, Part 3, "Decided so far", "A Codex
  reviewer runs read-only"), to this story's former open questions:
  1. Codex's usage is read through `codex app-server`, and a Codex reviewer uses the same
     `usageLimits.reviewer` as a Claude one, for now;
  2. the checkout stays where `review.mjs` makes it, under `os.tmpdir()`;
  3. the reviewer runs read-only and runs no tests, as under Claude Code (ST-33);
  4. the Credential Manager probe is left to ST-6;
  5. tool, model and effort are the machine's settings (ST-34), not the project's.
- **The trials** (design doc, "Trials and measurements", "Codex as reviewer"), on codex-cli
  0.162.0-alpha.17.2:
  - the first, 2026-10-15: three `codex exec -s read-only` reviews of #34. The third, with a
    four-line Codex section, returned a `pass-with-observations` that `parseReviewerVerdict`
    accepted;
  - the second, 2026-10-15, on the ChatGPT Plus plan: `account/rateLimits/read` answered in about
    0.76 s with a 300-minute and a 10080-minute window; `codex exec -s read-only` read a file
    under `os.tmpdir()` and under `Temp\claude`, and ran `git rev-parse`, `log`, `diff --stat`
    and `status` in a worktree made as `review.mjs` makes one, leaving it unchanged; `codex exec`
    refuses to run outside a git repository; under `codex sandbox -c sandbox_mode="read-only"`,
    Vitest could not start, and nothing could be written outside the working directory.
- `codex app-server generate-json-schema` lists `account/rateLimits/read` and `model/list`. On
  2026-10-15 `model/list` offered `gpt-6.1-sol` (its default), `gpt-6-astra`, `gpt-6-sol`,
  `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra` and `gpt-5.6-luna`, with efforts from `low` to
  `max` or `ultra`. Which one the reviewer uses is the machine's settings' to say.
- The Codex desktop app installs `codex.exe` under a versioned
  `C:\Program Files\WindowsApps\OpenAI.Codex_<version>…\app\resources\`, not on `PATH`, which is
  why AC-1 asks for its path.
- `docs/agent-workflow-design.md`, "Other companies' models (OQ-114)": M1 to M6, the owner's
  decisions of 2026-10-08. ST-15 keeps the coder's half.

## Open questions

*(none)*
