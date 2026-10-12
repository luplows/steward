# steward

A harness that takes units of work through a code, review and merge loop. A story is written with
the owner. A coder session builds it on a branch and opens a pull request. A reviewer session on a
different model checks the diff against the story, and the gate lands it only on a recorded
verdict. The owner keeps the decisions: what to build, and what is fit to release.

- [`docs/harness-outline.md`](docs/harness-outline.md): what steward is for, who it is for, and
  what it must never do.
- [`docs/agent-workflow-design.md`](docs/agent-workflow-design.md): how it works, and why. The
  design of record.
- [`AGENTS.md`](AGENTS.md): the rules every session here follows, whatever tool runs it.
  `CLAUDE.md` imports it for Claude Code.
- [`stories/README.md`](stories/README.md): the story queue, `ST-<n>`.

steward was moved out of [tower-workshop-paths](https://github.com/luplows/tower-workshop-paths)
with its history; [`docs/steward-bootstrap.md`](docs/steward-bootstrap.md) records how. An
`OQ-<n>` in this repository means a tower-workshop-paths story.

## Running it

CI runs it on Node 22. `npm ci`, then `node scripts/dispatch/cli.mjs <command>`, where
`<command>` is one of `coder`, `review`, `story`, `land`, `loop`, `queue`, `lint` or `verdicts`.
A project's own `steward.config.json` names its repository and its story prefix.
