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

The file is an object with the keys `usageLimits` and `roles`, and `tools` when a choice runs on
the Codex CLI. It has no other key.

| Key | Form | What it is for |
|---|---|---|
| `usageLimits` | An object (below) | The share of the plan's usage at or over which steward starts no coder or reviewer session. |
| `roles` | An object with exactly the keys `coder` and `reviewer` | For each role, the choice it runs by default, and the choices available. |
| `tools` | An object (below); required when a choice's `tool` is `"codex"`, and may be left out otherwise | What a tool other than Claude Code needs to be started. |

### `usageLimits`

An object with exactly the keys `coder` and `reviewer`, each an object with exactly the keys
`session` and `weekly`. Each is an integer from 1 to 100: the percentage of the plan's 5-hour
(`session`) or weekly window (its `weekly_all` row) at or over which that role starts no session.
Coders stop earlier than reviewers, so that work in flight still gets its review. When the usage
cannot be read, nothing starts. `usage.mjs` reads the usage; `reviewPullRequest`, `dispatchCoder`
and `retryStory` make the check. A reviewer run through the Codex CLI takes the same limits for now,
checked against Codex's own usage, which `readCodexUsage` (`scripts/dispatch/codex.mjs`) reads
from `codex app-server` with no model call.

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
| `tool` | `"claude"`, or `"codex"` for a reviewer | The tool the session runs in: Claude Code, or the Codex CLI. A coder choice must be `"claude"`. |
| `model` | A non-empty string | The model, as the tool names it (`--model`). |
| `effort` | `low`, `medium`, `high`, `xhigh` or `max`; for a `"codex"` choice, `ultra` too | The effort level: Claude Code's `--effort`, or Codex's `model_reasoning_effort`. |

### `tools`

An object whose only key is `codex`, itself an object with exactly the key `executable`: the
absolute path of the `codex` executable, which must name a file that exists. The Codex desktop app
installs it under a versioned folder,
`C:\Program Files\WindowsApps\OpenAI.Codex_<version>…\app\resources\`, which is not on `PATH`, so
the path changes when the app updates; the file is then refused, naming this key, until it is
corrected. In JSON, each backslash in the path is written twice.

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
- **A reviewer choice whose `tool` is `"codex"`** runs `codex exec -s read-only` in the review's
  checkout, with the same prompt a Claude reviewer gets on stdin, its `model`, and its `effort` as
  `model_reasoning_effort` (`spawnCodexReviewer`, `codex.mjs`). Its last message is parsed as a
  Claude reviewer's verdict is.

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

To review through the Codex CLI instead, the reviewer's part and `tools` become:

```json
    "reviewer": {
      "default": "sol-6.1",
      "available": {
        "sol-6.1": { "tool": "codex", "model": "gpt-6.1-sol", "effort": "high" },
        "opus": { "tool": "claude", "model": "opus", "effort": "high" }
      }
    }
  },
  "tools": {
    "codex": { "executable": "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1007.9446.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe" }
  }
```

Every pull request is then reviewed on `gpt-6.1-sol`, since no coder choice has that model, and
Codex's usage is checked before each review. `opus` is there for when a choice is unavailable to
the reviewer, as ST-35 plans.
