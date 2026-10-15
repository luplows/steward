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
- **The Claude Code CLI, `claude`**, on your `PATH`, or its path in `CLAUDE_EXECUTABLE`. Reviewer
  sessions run in it.

Then, from a checkout of the repository:

```sh
node scripts/dispatch/cli.mjs review <pr-number>   # review the pull request at its head
node scripts/dispatch/cli.mjs land <pr-number>     # land it, once it has passed and is green
```

What the review side reads:

- **`steward.config.json`**, the project's settings: its repository, its setup and check commands,
  when to land, and which checklist to use. Each key is described in
  [`docs/settings.md`](docs/settings.md).
- **The checklist**, [`REVIEW.md`](REVIEW.md) here, read from `main`, so that a pull request cannot
  change the rules it is reviewed against.
- **Three workflows** in `.github/workflows/`: `ci.yml` runs lint and the tests, `review-gate.yml`
  turns a posted verdict into the `review/agent` status, and `land-approved.yml`, the runway, does
  the merge. Here, `main` is protected and requires `test` and `review/agent`.

## Contributing

- **Run the checks:** `npm ci`, then `npm test` (Vitest) and `npm run lint` (oxlint), which are
  what CI runs. Add tests alongside new logic.
- **Every change goes through a pull request.** `main` is protected, and nothing is pushed to it
  directly.
- **Fill in the pull request template's three sections**: what changed, how you verified it (the
  commands you ran and their real results), and whether this README needed updating.
- **Steward reviews and lands its own pull requests**, against [`REVIEW.md`](REVIEW.md), once CI
  is green. Only pull requests from the repository's owner, members and collaborators are landed
  (`HONOURED_ASSOCIATIONS`, `scripts/land/check-author.mjs`), and only theirs are reviewed
  ([`docs/controller.md`](docs/controller.md)).
- **Agent sessions** working here follow [`AGENTS.md`](AGENTS.md).

## Further reading

- [`docs/outline.md`](docs/outline.md): what steward is for, who it is for, and what it must never
  do.
- [`docs/agent-workflow-design.md`](docs/agent-workflow-design.md): how it works, and why. The
  design of record.
- [`docs/glossary.md`](docs/glossary.md): the words these documents use, and what each means.
- [`AGENTS.md`](AGENTS.md): the rules every agent session here follows, whatever tool runs it.
  `CLAUDE.md` imports it for Claude Code.
- [`stories/README.md`](stories/README.md): steward's own queue of work, `ST-<n>`.
