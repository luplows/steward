# Settings

A project's `steward.config.json`, at its root. `readSettings` in
[`scripts/dispatch/settings.mjs`](../scripts/dispatch/settings.mjs) reads it and is the definition
of what is valid; this page is the reference to it, and the code wins where they differ. The
decisions behind the keys are in [`outline.md`](outline.md), "Defining steward",
"Settings".

- Every key is required. Steward's code holds no default for any of them.
- A missing key, an unknown key, or a value of the wrong form is an error that names the file and
  the key with all its parents, for a key inside `setup` or `check` (for example
  `setup.timeoutMinutes`).
- A key that becomes required breaks a project until it adds the key.
- The file is flat apart from `setup` and `check`.
- What depends on the OS user rather than the project, the usage limits and each role's tool,
  model and effort, is not in this file. It is in the user config, described in
  [`user-config.md`](user-config.md). A `usageLimits` key here is an unknown key.

## Keys

| Key | Form | What it is for | What `init` writes |
|---|---|---|---|
| `repo` | `owner/name` | The project's GitHub repository. | The `origin` remote's repository, from an `https` or an `ssh` URL. With no `origin` that reads as a GitHub repository, no file is written. |
| `setup` | `null`, or an object (below) | The command that prepares a worktree for a coder session. Nothing is run before a review. | `null`. |
| `check` | `null`, or an object (below) | The command that checks a change, which the coder runs. | `null`. |
| `landWhen` | `"all-checks"`, or a non-empty array of distinct, non-empty check names | Which checks must be green before steward lands a pull request. | `"all-checks"`. |
| `land` | `true` or `false` | Standing permission for unattended landing: the rotation's landing, and a workflow dispatch that names no mode. The runway reads it from `main`. It does not stop `steward land <pr-number>`, a manual request ([below](#land)). | Asked; default `false` (`--yes` takes it too), so a new installation reviews and does not land unattended. A yes at the question, or `--land yes`, writes `true`. A file already there is left as it is. |
| `unitLinks` | An array, possibly empty, of distinct values from `"issue"`, `"file"` and `"other"` | The kinds of link steward reads from a pull request's body to find its unit. | Asked; default `["file", "issue"]`. |
| `rulesFile` | A relative path with forward slashes, neither absolute nor containing a `..` segment, with no control character, backtick, `<` or `>` (`isRulesFilePath`, `scripts/dispatch/rules-file-path.mjs`) | The file of rules a pull request is reviewed against, read from `main`. | Asked; default `REVIEW.md`. `init` copies steward's example checklist there. |
| `inspectAfterHours` | A positive integer | How many hours a pull request may stay pending or holding before inspection raises it. | Asked; default 24. |

`steward init` (`scripts/dispatch/init.mjs`) writes the file, as the last column says: a question
it asks at the terminal has a flag and, under `--yes`, its default (`QUESTIONS` there), and a file
that is already there is left as it is. The decision is in `agent-workflow-design.md`, Part 3,
"Decided so far". Steward's own file (below) shows values that work here.

## `land`

`land` is the project's standing permission for unattended landing, and `true` is the opt-in.
`steward init` writes `false` unless it is told yes at the question or by `--land yes`, and never
changes a file that is already there, so a project's chosen value stays. The reader, `readSettings`,
supplies no default: a file without `land` is refused.

- Unattended: the rotation's landing, and a dispatch of `land-approved.yml` that names no mode (or
  `mode: unattended`, with or without a pull request). The runway reads `land` from `main`, and
  merges nothing unattended unless it is `true`. A caller's own copy of the setting changes nothing
  there, and a `land` or `landWhen` that is missing, malformed or unreadable on `main` refuses
  the merge.
- Manual: `steward land <pr-number>`, one explicit request for one pull request at the head the
  command first reads, valid whether `land` is `true` or `false`. It does not change `land`. A
  dispatch of the workflow with `mode: manual`, `pr` and the full 40-character `head` is the same
  request, and is honoured only from an actor GitHub gives write, maintain or admin permission on
  the repository, taken from the workflow's event, never from an input. If the pull request's head
  differs from the one named, at the pilot or at the runway, it merges nothing.
- A mode is an explicit authorization, not proof that a person is at a terminal or that credentials
  are isolated: a tool holding the crew's write credential can send a manual request too.

Manual landing changes only this restriction. It still requires an open non-draft pull request
against a supported base, an honoured author, no `review-blocked`, the circuit breaker and its
exemptions, `review/agent` `success` on the head, the checks `landWhen` names, a `mergeable_state`
GitHub would merge in, and the runway's `--match-head-commit` merge.

## `setup` and `check`

Each is `null`, or an object with exactly these keys:

- `command`: a non-empty string, run through the platform's shell. Point it at a script of the
  project's own (such as `npm run check`) rather than chaining commands, since only simple forms
  behave alike in Windows' `cmd` and in `sh`.
- `timeoutMinutes`: a positive integer, the command's time limit.

`null` is written explicitly. For `setup` it means the project needs nothing but the worktree. For
`check` it means the project has no check, which suits only a project without a coder.

## `unitLinks`

- `"issue"`: `Unit: #<n>`, or a closing keyword, in the body.
- `"file"`: `Unit: <path>` in the body.
- `"other"`: `Unit:` and any text, passed to the reviewer unread.

An empty `unitLinks` means the project links no units: the reviewer works from the pull request
body and the rules.

## This repository's file

```json
{
  "repo": "luplows/steward",
  "setup": { "command": "npm ci", "timeoutMinutes": 5 },
  "check": { "command": "npm run check", "timeoutMinutes": 10 },
  "landWhen": "all-checks",
  "land": true,
  "unitLinks": ["file"],
  "rulesFile": "REVIEW.md",
  "inspectAfterHours": 24
}
```

Steward's scripts use `repo`, `rulesFile`, `unitLinks`, `land`, `landWhen` and
`inspectAfterHours` today: the pilot and the runway land on the checks `landWhen` names, and
inspection raises a pull request pending or holding longer than `inspectAfterHours`. The other keys
are read and validated, and each is taken into use by the story that builds it (see
[`agent-workflow-design.md`](agent-workflow-design.md), the "Planned" markers).
