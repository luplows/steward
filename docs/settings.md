# Settings

A project's `steward.config.json`, at its root. `readSettings` in
[`scripts/dispatch/settings.mjs`](../scripts/dispatch/settings.mjs) reads it and is the definition
of what is valid; this page is the reference to it, and the code wins where they differ. The
decisions behind the keys are in [`outline.md`](outline.md), "Defining steward",
"Settings".

- Every key is required. Steward's code holds no default for any of them.
- A missing key, an unknown key, or a value of the wrong form is an error that names the file and
  the key with all its parents, for a key inside `setup`, `check` or `usageLimits` (for example
  `setup.timeoutMinutes` or `usageLimits.coder.weekly`).
- A key that becomes required breaks a project until it adds the key.
- The file is flat apart from `setup`, `check` and `usageLimits`.

## Keys

| Key | Form | What it is for | What `init` will write |
|---|---|---|---|
| `repo` | `owner/name` | The project's GitHub repository. | Not decided. |
| `storyPrefix` | 1 to 8 capital letters | The prefix of a story id, such as `ST` for `ST-18`. | Not decided. |
| `setup` | `null`, or an object (below) | The command that prepares a worktree for a coder session. Nothing is run before a review. | `npm ci`, 5 minutes. |
| `check` | `null`, or an object (below) | The command that checks a change, which the coder runs. | `npm run check`, 10 minutes. |
| `landWhen` | `"all-checks"`, or a non-empty array of distinct, non-empty check names | Which checks must be green before steward lands a pull request. | `"all-checks"`. |
| `land` | `true` or `false` | Whether steward lands pull requests. `false`: steward still reviews, and the project merges. | Not decided. |
| `unitLinks` | An array, possibly empty, of distinct values from `"issue"`, `"file"` and `"other"` | The kinds of link steward reads from a pull request's body to find its unit. | Not decided. |
| `rulesFile` | A relative path with forward slashes, neither absolute nor containing a `..` segment | The file of rules a pull request is reviewed against, read from `main`. | The path where `init` copies steward's example rules file; not decided. |
| `usageLimits` | An object (below) | The share of the plan's usage at or over which steward starts no coder or reviewer session. | Not decided. |

`init` is not built yet. "Not decided" means no decision is recorded for the value `init` will
write; steward's own file (below) shows a value that works.

## `setup` and `check`

Each is `null`, or an object with exactly these keys:

- `command`: a non-empty string, run through the platform's shell. Point it at a script of the
  project's own (such as `npm run check`) rather than chaining commands, since only simple forms
  behave alike in Windows' `cmd` and in `sh`.
- `timeoutMinutes`: a positive integer, the command's time limit.

`null` is written explicitly. For `setup` it means the project needs nothing but the worktree. For
`check` it means the project has no check, which suits only a project without a coder.

## `usageLimits`

An object with exactly the keys `coder` and `reviewer`, each an object with exactly the keys
`session` and `weekly`. Each is an integer from 1 to 100: the percentage of the plan's 5-hour
(`session`) or weekly window (its `weekly_all` row) at or over which that role starts no session.
Coders stop earlier than reviewers, so that work in flight still gets its review. When the usage
cannot be read, nothing starts. `usage.mjs` reads the usage; `reviewPullRequest`, `dispatchCoder`
and `retryStory` make the check.

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
  "storyPrefix": "ST",
  "setup": { "command": "npm ci", "timeoutMinutes": 5 },
  "check": { "command": "npm run check", "timeoutMinutes": 10 },
  "landWhen": "all-checks",
  "land": true,
  "unitLinks": ["file"],
  "rulesFile": "REVIEW.md",
  "usageLimits": {
    "coder": { "session": 70, "weekly": 75 },
    "reviewer": { "session": 90, "weekly": 90 }
  }
}
```

Steward's scripts use `repo`, `storyPrefix`, `rulesFile`, `unitLinks`, `usageLimits` and `land`
today. The other keys are read and validated, and each is taken into use by the story that builds
it (see [`agent-workflow-design.md`](agent-workflow-design.md), the "Planned" markers).
