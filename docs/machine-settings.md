# Machine settings

The settings of the computer steward runs on, kept outside any checkout. They hold what depends on
the computer and the plan it is signed in to, rather than on the project: the usage limits, and
for each role a default choice of tool, model and effort, with the choices available besides it. A
project's settings ([`settings.md`](settings.md)) make no assumption about which models a computer
uses. `readMachineSettings` in
[`scripts/dispatch/machine-settings.mjs`](../scripts/dispatch/machine-settings.mjs) reads the file
and is the definition of what is valid; this page is the reference to it, and the code wins where
they differ. The decision behind them is in
[`agent-workflow-design.md`](agent-workflow-design.md), Part 3, "Decided so far", "The machine
steward runs on has settings of its own".

## The file

- **Path:** `~/.steward/settings.json`, in the user's profile (`<homedir>/.steward/settings.json`).
- **Override:** when the environment variable `STEWARD_SETTINGS` is set, the file it names is read
  instead.
- **Every machine that runs steward needs the file.** Steward holds no default for any value, so a
  missing file, invalid JSON, a missing key, an unknown key, or a value of the wrong form is an
  error that names the file and the key with all its parents (for example
  `roles.reviewer.available.opus.effort`). Every review and every coder run reads the file, and
  stops without it.
- Each of `reviewPullRequest`, `dispatchCoder` and `retryStory` reads it once per call, before it
  reads the plan's usage.

## Keys

The file is an object with exactly the keys `usageLimits` and `roles`.

| Key | Form | What it is for |
|---|---|---|
| `usageLimits` | An object (below) | The share of the plan's usage at or over which steward starts no coder or reviewer session. |
| `roles` | An object with exactly the keys `coder` and `reviewer` | For each role, the choice it runs by default, and the choices available. |

### `usageLimits`

An object with exactly the keys `coder` and `reviewer`, each an object with exactly the keys
`session` and `weekly`. Each is an integer from 1 to 100: the percentage of the plan's 5-hour
(`session`) or weekly window (its `weekly_all` row) at or over which that role starts no session.
Coders stop earlier than reviewers, so that work in flight still gets its review. When the usage
cannot be read, nothing starts. `usage.mjs` reads the usage; `reviewPullRequest`, `dispatchCoder`
and `retryStory` make the check. A reviewer run through another tool takes the same limits for now.

### `roles.<role>`

Each of `roles.coder` and `roles.reviewer` is an object with exactly the keys `default` and
`available`.

| Key | Form | What it is for |
|---|---|---|
| `available` | A non-empty object mapping a choice's name to a choice (below) | The choices the role may run, in the order they are tried. |
| `default` | The name of a key of `available` | The choice the role runs when nothing else picks one. |

A choice's name matches `/^[a-z0-9][a-z0-9._-]*$/`. A choice is an object with exactly these keys:

| Key | Form | What it is for |
|---|---|---|
| `tool` | `"claude"` | The tool the session runs in. Claude Code is the only tool accepted until ST-32. |
| `model` | A non-empty string | The model, as the tool names it (`--model`). |
| `effort` | `low`, `medium`, `high`, `xhigh` or `max` | The effort level (`--effort`). |

## How the choices are used

- **The coder** runs the choice its unit names. When a story's `model:` is the name of a key of
  `roles.coder.available`, the coder runs that choice's `model` and `effort`. When it is `null`,
  the coder runs `roles.coder.default`. When it names no available choice, `dispatchCoder` and
  `retryStory` return `choice-unavailable` with the story's id and the name, before anything is
  claimed, made or installed.
- **The reviewer** runs its `default` choice, unless that choice's model is the coder's, compared
  by the models' names (`review.mjs`, `chooseReviewer`): one name containing the other, in either
  case, is the same model. The coder's model is that of the choice the unit's `model:` names, or,
  when the unit's `model:` is `null`, that of `roles.coder.default`. A reviewer then runs the first
  other choice in `roles.reviewer.available`, in the file's order, whose model differs. When none
  differs, `reviewPullRequest` returns `reviewer-unavailable` and starts no session.

## An example

```json
{
  "usageLimits": {
    "coder": { "session": 70, "weekly": 75 },
    "reviewer": { "session": 90, "weekly": 90 }
  },
  "roles": {
    "coder": {
      "default": "sonnet",
      "available": {
        "sonnet": { "tool": "claude", "model": "sonnet", "effort": "medium" },
        "opus": { "tool": "claude", "model": "opus", "effort": "high" }
      }
    },
    "reviewer": {
      "default": "opus",
      "available": {
        "opus": { "tool": "claude", "model": "opus", "effort": "high" },
        "sonnet": { "tool": "claude", "model": "sonnet", "effort": "high" }
      }
    }
  }
}
```

With this file, a story whose `model:` is `opus` runs the coder on `opus` at `high` effort, and its
reviewer moves to `sonnet` at `high` effort, since `opus` is the coder's model. A story whose
`model:` is `null` runs the coder on `sonnet` at `medium` effort, and its reviewer on `opus`.
