# steward

Steward reviews and lands pull requests for a GitHub project, and is being built to write them too.
A reviewer session, with none of the author's context, checks each pull request against the unit
of work it implements and the project's checklist. Steward merges a pull request only on a passing
verdict and green checks. The people working on the project, its crew, keep the decisions: what to
build, and what is fit to release.

## Where it stands

- **The review side works.** Steward's scripts (ATC) start a reviewer for a pull request, post its
  verdict, and land the pull request once it passes. Steward's own pull requests land this way.
  For now a member of the crew starts each run by hand.
- **The coding side is designed but not built.** Until it is, pull requests are written by people,
  or in their own agent sessions.
- **Steward runs on this repository only.** `init`, which will set up another project, is not built
  yet.

## Setup

To run the review side, you need:

- **Node 22**, which is what CI runs, and **git**.
- **The GitHub CLI, `gh`**, signed in with `gh auth login` as an account with write access to the
  repository. The scripts take its token from `gh auth token`.
- **The Claude Code CLI, `claude`**, on your `PATH`, or its path in `CLAUDE_EXECUTABLE`. Coder
  sessions run in it, and reviewer sessions do unless the machine's settings choose the Codex CLI.
- **The Codex CLI, `codex`**, signed in, only if the machine's settings give the reviewer a choice
  whose tool is `"codex"`. Its path goes in `tools.codex.executable`.
- **The machine's settings file**, `~/.steward/settings.json` (or the file `STEWARD_SETTINGS`
  names). Every machine that runs steward needs it: it holds the plan's usage limits and each
  role's default and available choices of tool, model and effort (and a strength, for a coder's
  choice), and steward has no default for any of them. Each key is described in
  [`docs/machine-settings.md`](docs/machine-settings.md). `review` and `coder` take `--choice <name>`
  to run a role on another of its available choices for one run.

Then, from a checkout of the repository:

```sh
node scripts/dispatch/cli.mjs review <pr-number>   # review the pull request at its head
node scripts/dispatch/cli.mjs land <pr-number>     # land it, once it has passed and is green
node scripts/dispatch/cli.mjs inspect              # raise a merge without a passing verdict, or a stall
```

What the review side reads:

- **`steward.config.json`**, the project's settings: its repository, its setup and check commands,
  when to land, and which checklist to use. Each key is described in
  [`docs/settings.md`](docs/settings.md). What depends on the computer rather than the project is
  in the machine's settings, [`docs/machine-settings.md`](docs/machine-settings.md).
- **The checklist**, [`REVIEW.md`](REVIEW.md) here, read from `main`, so that a pull request cannot
  change the rules it is reviewed against.
  A project's checklist may hold HTML comments; they are removed before the reviewer is given it.
  The package carries an example for another project to start from,
  [`templates/review-checklist.md`](templates/review-checklist.md).
- **Four workflows** in `.github/workflows/`: `ci.yml` runs lint and the tests, `review-gate.yml`
  turns a posted verdict into the `review/agent` status, `land-approved.yml`, the runway, does the
  merge, and `inspection.yml` runs `inspect` once a day (a project keeps it or drops it). Here,
  `main` is protected and requires `test` and `review/agent`.

## Contributing

For everyone:

- **Run the checks:** `npm ci`, then `npm test` (Vitest) and `npm run lint` (oxlint), which are
  what CI runs. Add tests alongside new logic.
- **Every change goes through a pull request.** `main` is protected, and nothing is pushed to it
  directly.
- **Fill in the pull request template**: its `Unit:` line (the file or issue the pull request
  implements, or `none`), and its three sections: what changed, how you verified it (the commands
  you ran and their real results), and whether this README needed updating.
- **Agent sessions** working here follow [`AGENTS.md`](AGENTS.md).

### From the crew

The crew is the repository's owner, members and collaborators (`HONOURED_ASSOCIATIONS`,
`scripts/land/check-author.mjs`). Steward picks up a crew member's pull request once it is marked
ready: it is reviewed against [`REVIEW.md`](REVIEW.md), and lands once it passes and CI is green
([`docs/controller.md`](docs/controller.md)).

### From outside the crew

Open a pull request as usual. Steward does not pick it up on its own: a member of the crew decides
whether to schedule it. Landing a scheduled pull request, with its author's name on the change, is
planned but not yet built ([ST-27](stories/ST-27-land-scheduled-outside-prs.md)). Until then it can
be reviewed, but the runway does not land it.

## Further reading

- [`docs/outline.md`](docs/outline.md): what steward is for, who it is for, and what it must never
  do.
- [`docs/agent-workflow-design.md`](docs/agent-workflow-design.md): how it works, and why. The
  design of record.
- [`docs/glossary.md`](docs/glossary.md): the words these documents use, and what each means.
- [`AGENTS.md`](AGENTS.md): the rules every agent session here follows, whatever tool runs it.
  `CLAUDE.md` imports it for Claude Code.
- [`stories/README.md`](stories/README.md): steward's own queue of work, `ST-<n>`.
