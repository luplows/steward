# User config

Configuration for the invoking OS user, kept outside any checkout. It holds the user's usage
limits, each role's default and available choices of tool, model and effort, and the coordinator
scan cadence. Each OS account has its own file; no administrator privilege is needed. A project's
`steward.config.json` ([`settings.md`](settings.md)) remains separate and unchanged.
`readUserConfig` in
[`scripts/dispatch/user-config.mjs`](../scripts/dispatch/user-config.mjs) reads the file
and is the definition of what is valid; this page is the reference to it, and the code wins where
they differ. The decision behind them is in
[`agent-workflow-design.md`](agent-workflow-design.md), Part 3, "Decided so far", "Per-user
configuration naming and coordinator cadence"; the earlier ST-34 decision is retained there as history.

## The file

- **Path:** `~/.steward/config.json`, using `os.homedir()` for the invoking user on Unix and Windows.
- **Override:** a nonempty `STEWARD_CONFIG` path selects the file instead. An empty value uses the
  home path. The override applies to the invoking process and grants no activation permission.
- **Every user running steward needs a valid file.** Role and usage settings have no defaults, so a
  missing file, invalid JSON, a missing key, an unknown key, or a value of the wrong form is an
  error that names the file and the key with all its parents (for example
  `roles.reviewer.available.opus.effort`, or `roles.coder.available.opus.strength`). Every review
  and every coder run reads the file, and stops without it.
- Each of `reviewPullRequest`, `dispatchCoder` and `retryStory` reads it once per call, before it
  reads the plan's usage.

### Breaking local rename

Existing Steward developers must manually rename `~/.steward/settings.json` to
`~/.steward/config.json`, or select their file with `STEWARD_CONFIG`. Replace any
`STEWARD_SETTINGS` environment assignment with `STEWARD_CONFIG`. The old file and variable are
ignored, even if the new selected file is missing. No automatic migration, compatibility alias or
fallback is provided. This is a breaking local rename before client adoption, not a claim that
deployed installations were migrated. Existing role, tool and usage values can be kept as written.

## Keys

The file is an object with required `usageLimits` and `roles`, optional `tools` (required when a
choice runs on the Codex CLI), and optional `coordinator`. No other top-level key is accepted.

| Key | Form | What it is for |
|---|---|---|
| `usageLimits` | An object (below) | The share of the plan's usage at or over which steward starts no coder or reviewer session. |
| `roles` | An object with exactly the keys `coder` and `reviewer` | For each role, the choice it runs by default, and the choices available. |
| `tools` | An object (below); required when a choice's `tool` is `"codex"`, and may be left out otherwise | What a tool other than Claude Code needs to be started. |
| `coordinator` | Optional object with `scanIntervalMinutes` and, optionally, `landingScanIntervalMinutes` (below) | How often the coordinator scans for new work, and for landing candidates; `steward coordinator start` reads it. |

### `coordinator`

When this entire section is absent from an otherwise valid file, the reader returns
`{ "scanIntervalMinutes": 15 }`. When present, it must contain `scanIntervalMinutes`, a positive
JSON integer, and may contain `landingScanIntervalMinutes`. There is no product-imposed upper bound
or 60-minute cap: multi-day intervals are valid. Values must remain safe integers after conversion
to milliseconds (`scanIntervalMinutes * 60_000`); `validateCoordinator` in `user-config.mjs`
defines that check, for both keys alike.
Zero, negatives, fractions, booleans, malformed objects, missing keys and unknown keys fail with
the file path and offending key. The default never rescues a missing or invalid whole file.

`landingScanIntervalMinutes` (ST-83) is how often the coordinator discovers pull requests that
unattended landing may consider. When it is absent, landing discovery shares the review scan; there
is no default value. When present, landing is due on its own interval, and an idle
coordinator wakes at the earlier of the two due times. An interval makes a scan due; the
coordinator's one-review-at-a-time loop runs it between reviews, so a running review delays it. The
setting is no permission to land: a project's candidates are admitted only where `land` is exactly
`true` on its `main` (`steward.config.json`, [`docs/settings.md`](settings.md)). It is a per-user
setting only; the project owns no cadence key.

For example, `"coordinator": { "scanIntervalMinutes": 10080 }` selects a week. A later read sees
a valid manual edit. The reader starts no scan loop, daemon, reviewer or session and writes no
activation, ownership, reservation or other state. Operational state is kept under
`~/.steward/state/`, separate from this editable file: activation records in
`~/.steward/state/projects.json` and owned checkouts under `~/.steward/state/checkouts/`
(`scripts/dispatch/project.mjs`, README "Activating a project"), and the coordinator's record,
`~/.steward/state/coordinator.json`, a stop request for it, `~/.steward/state/coordinator.stop`
(`scripts/dispatch/coordinator.mjs`, README "The coordinator"), and its note of each automatic
review, `~/.steward/state/reviews.json` (`scripts/dispatch/review-admission.mjs`), and the approved
coding handoffs, `~/.steward/state/handoffs.json` (`scripts/dispatch/handoff.mjs`, README "Approving a
coding handoff"). Those four JSON
files are read and written through `scripts/dispatch/state-file.mjs`: a write goes to a temporary
file beside its target, `<file>.tmp`, and is renamed over it, so a write that fails leaves the file
as it was. That covers a failed write only, and is no guard against two processes writing the same
file. `coordinator.stop`, whose presence is the signal, is not written this way, and neither is
this page's file, which a person edits.
`STEWARD_CONFIG` does not move that folder. `steward coordinator start` reads the value through
this reader and refuses, starting nothing, when the reader throws, so a change takes effect at the
next `start`, and `steward coordinator status` reports the interval in effect. The interval governs
the discovery of new work, not the delay between reviews already discovered (README, "The
coordinator"). Runtime watching and configuration-editing commands are not implemented.

### `usageLimits`

An object with exactly the keys `coder` and `reviewer`, each an object with exactly the keys
`session` and `weekly`. Each is an integer from 1 to 100: the percentage of the plan's 5-hour
(`session`) or weekly window (its `weekly_all` row) at or over which that role starts no session.
Coders stop earlier than reviewers, so that work in flight still gets its review. When the usage
cannot be read, it counts as spent: nothing starts on that tool. `usage.mjs` reads the usage;
`reviewPullRequest`, `dispatchCoder` and `retryStory` make the check. A reviewer run through the Codex CLI takes the same limits for now,
checked against Codex's own usage, which `readCodexUsage` (`scripts/dispatch/codex.mjs`) reads
from `codex app-server` with no model call.

### `roles.<role>`

Each of `roles.coder` and `roles.reviewer` is an object with exactly the keys `default` and
`available`.

| Key | Form | What it is for |
|---|---|---|
| `available` | A non-empty object mapping a choice's name to a choice (below) | The choices the role may run, in the order ATC tries them (below). |
| `default` | The name of a key of `available` | The choice the role runs when nothing else picks one. |

A choice's name matches `/^[a-z0-9][a-z0-9._-]*$/`. A choice is an object with exactly these keys,
and a coder's choice has `strength` besides:

| Key | Form | What it is for |
|---|---|---|
| `tool` | `"claude"` or `"codex"` | The tool the session runs in: Claude Code, or the Codex CLI. A coder choice on `"codex"` is refused on a platform other than Windows, the only one it has been tried on. |
| `model` | A non-empty string | The model, as the tool names it (`--model`). |
| `effort` | `low`, `medium`, `high`, `xhigh` or `max`; for a `"codex"` choice, `ultra` too | The effort level: Claude Code's `--effort`, or Codex's `model_reasoning_effort`. |
| `strength` | A positive integer; a coder's choices only | How strong the choice is: a larger number is stronger, and equal numbers are equally strong, whatever the tools. A story is never run on a weaker choice than its own. A reviewer's choice has no `strength`, and one there is refused as an unknown key. |

### `tools`

An object whose only key is `codex`, itself an object with the keys `executable` and
`windowsSandbox`. `executable` is the absolute path of the `codex` executable, which must name a
file that exists. The Codex desktop app
installs it under a versioned folder,
`C:\Program Files\WindowsApps\OpenAI.Codex_<version>…\app\resources\`, which is not on `PATH`, so
the path changes when the app updates; the file is then refused, naming this key, until it is
corrected. In JSON, each backslash in the path is written twice.

`windowsSandbox` is `"elevated"` or `"unelevated"`, any other value being refused. It is required
when a coder choice's tool is `"codex"`, and the error then names `tools.codex.windowsSandbox`. It
is the Windows sandbox mode a Codex coder session is started with (`-c windows.sandbox=…`). The
session ignores the user's own Codex configuration, which is where that mode is otherwise set, and
without a mode every command in it is refused. In the trial only `elevated` ran a whole story. A
file that gives Codex to the reviewer alone may leave it out.

## How the choices are used

- **The coder** runs the choice its unit names. When a story's `model:` is the name of a key of
  `roles.coder.available`, the coder runs that choice's `model` and `effort`. When it is `null`,
  the coder runs `roles.coder.default`. When it names no available choice, `dispatchCoder` and
  `retryStory` return `choice-unavailable` with the story's id and the name, before anything is
  claimed, made or installed.
- **The reviewer** runs its `default` choice, unless that choice's model is one the coder ran,
  compared by the models' names (`review.mjs`, `chooseReviewer`): one name containing the other, in
  either case, is the same model. A reviewer then runs the first other choice in
  `roles.reviewer.available`, in the file's order, whose model differs from every model the coder
  ran. When none differs, `reviewPullRequest` returns `reviewer-unavailable` and starts no session.
- **The models the coder ran** are those of the choices on the last line of the pull request's body
  that starts `Coder:`: for each name, the `model` of that key of `roles.coder.available`, or the
  name as written when it is not one. When the body has no such line, it is the model of the choice
  the unit's `model:` names, or, when the unit's `model:` is `null`, that of
  `roles.coder.default`. The line is ATC's: `dispatchCoder` opens the pull request with the coder's
  body, every line of it that starts `Coder:` removed, followed by a last line `Coder: <name>`
  naming the choice that ran, and `retryStory` replaces the body the same way, its line naming the
  choices on the current line, then the one that ran, each once, in the order first run (for
  example `Coder: sonnet, opus`).
- **`--choice <name>`** on `review.mjs`, and on `coder.mjs` (a dispatch, and `retry`), runs the role
  on that key of its `available` for this run, passed as the `choice` option of
  `reviewPullRequest`, `dispatchCoder` and `retryStory`. It is final: it runs instead of the unit's
  choice and the default, whatever its `strength`, and a reviewer's runs even when its model is the
  coder's. A name that is not a key returns `choice-unavailable`, with the name, before the usage
  is read or anything is claimed, checked out, installed or started. When the named choice's tool
  is over the role's usage limit, or its usage cannot be read, the call returns `over-usage` or
  `usage-unknown`, and ATC takes no other choice.
- **When a choice is out of usage**, and no choice was named, ATC tries a role's choices in order
  and starts the first whose tool's usage is readable and under the role's limits. A tool's usage
  is read at most once per call, however many of its choices are tried (`readUsage` for `claude`,
  `readCodexUsage` for `codex`), and a usage that cannot be read counts as spent. The reviewer
  tries the choice `chooseReviewer` picks, then every other choice in
  `roles.reviewer.available`, in the file's order, whose model differs from every model the coder
  ran. The coder tries the choice the story's `model:` names (or `roles.coder.default`), then
  every other choice in `roles.coder.available`, in the file's order, whose `strength` is at least
  that first choice's; a story never runs on a weaker one. When no choice's tool can start, the
  call returns the first choice's refusal, `over-usage` or `usage-unknown`, before anything is
  claimed, made or installed and with no session started. With only Claude choices the move finds no
  other tool in practice, since `claude`'s usage covers every Claude model; a Codex coder choice is
  a second tool for it to move to, and back from.
- **A result reports the choice.** Every result returned after a session started carries `choice`:
  its `name`, `tool`, `model` and `effort`, and `why`, which is `crew` for a named choice, `unit`
  for the choice a story's `model:` names, `default`, `coder-model` for a reviewer's default that
  has the coder's model, or `usage` when ATC moved off the choice it would have run. A result of
  a move, and a refusal after every choice was tried, carry `skipped`: one entry per choice not
  started, in the order tried, with the choice's `name` and the `status` its usage gave
  (`over-usage`, with `window`, `percent` and `limit`; or `usage-unknown`, with `reason`). The
  command lines print both, as part of the result's JSON.
- **A coder choice whose `tool` is `"codex"`** runs `codex exec -s workspace-write` in the coder's
  worktree (`spawnCodexCoder`, `codex.mjs`), with the same prompt a Claude coder gets on stdin, its
  `model`, its `effort` as `model_reasoning_effort`, and `tools.codex.windowsSandbox`. What the
  session may do:
  - It may write only to the worktree and to a temporary folder of its own, which ATC makes in the
    dispatch's scratch directory and names in `TMP`, `TEMP` and `TMPDIR`. It runs with no network
    and no GitHub credential, and with `--ignore-user-config`, so that none of the user's Codex
    plugins or `notify` programs run in it.
  - It cannot run `git add`, `git mv` or `git commit`: the sandbox refuses them. **ATC commits for
    it**, after a session that ended `completed`, in `dispatchCoder`, in `retryStory` and in
    `executeHandoff`, before the push. The commit holds what the session left in the worktree, new,
    changed, deleted and moved files, untracked ones included; it is made as the git identity of
    the checkout the run works in; its message is the session's own, the `## Commit message`
    section of its PR block, unchanged, else the title of the block, or `<story or handoff id>: the coder's
    work` when the block did not parse; and it, and the push that follows, run with git's hooks
    off, since the worktree may hold hook scripts the session could edit. A session that left nothing gives `nothing-committed`, as a Claude one does.
  - It can edit files under `.claude/prompts/`, which the sandbox allows. For any tool, ATC pushes
    nothing when the branch's commits beyond its base change one, and returns
    `prompt-change-refused` with the paths. The commits stay on the local branch.
  - **It can read files outside its worktree**, such as `~/.codex/auth.json` and
    `~/.claude/.credentials.json`. What it copies into the worktree would be committed and pushed,
    and ATC does not check what the commit holds. Keeping a session from reading credentials is
    isolation, which is planned for 0.5 (`docs/outline.md`); the threat model here is an honest
    model that makes mistakes, run by one member of the crew.
  - The flags were tried on codex-cli 0.163.0 on Windows, and nowhere else
    (`docs/agent-workflow-design.md`, "Trials and measurements", "Codex as coder"), which is why a
    coder choice on `"codex"` is refused on another platform. The crew's first run of `coder.mjs`
    on one has not yet been made.
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
        "sonnet": { "tool": "claude", "model": "sonnet", "effort": "medium", "strength": 1 },
        "opus": { "tool": "claude", "model": "opus", "effort": "high", "strength": 2 }
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

To review through the Codex CLI instead, the reviewer's part and `tools` become (`windowsSandbox`
is only needed with a Codex coder choice):

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
Codex's usage is checked before each review. `opus` is there for when Codex's usage is spent or
cannot be read: ATC then reviews on `opus`, unless the coder ran `opus` on that pull request (its
story's `model:` is `opus`, or its `Coder:` line names `opus`). Then no choice is left whose model
differs from the coder's, and the review returns `over-usage` or `usage-unknown` and starts
nothing.

To run the coder through the Codex CLI too, on Windows, the coder's part gains a choice, and
`tools.codex` gains `windowsSandbox`:

```json
    "coder": {
      "default": "sonnet",
      "available": {
        "sonnet": { "tool": "claude", "model": "sonnet", "effort": "medium", "strength": 1 },
        "sol-6.1": { "tool": "codex", "model": "gpt-6.1-sol", "effort": "high", "strength": 2 }
      }
    }
  },
  "tools": {
    "codex": { "executable": "C:\\Program Files\\WindowsApps\\...\\codex.exe", "windowsSandbox": "elevated" }
  }
```

A story whose `model:` is `sol-6.1` then runs the coder on `gpt-6.1-sol` through the Codex CLI, and
its reviewer runs on a model other than `gpt-6.1-sol`, as `chooseReviewer` picks it.
