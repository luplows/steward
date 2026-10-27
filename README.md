# steward

Steward reviews and lands pull requests for a GitHub project, and is being built to write them too.
A reviewer session, with none of the author's context, checks each pull request against the unit
of work it implements and the project's checklist. Steward merges a pull request only on a passing
verdict and green checks. The people working on the project, its crew, keep the decisions: what to
build, and what is fit to release.

## Where it stands

The crew's [product roadmap](docs/outline.md#product-roadmap) describes the planned milestones
from 0.1 through 1.0. Those targets are distinct from the implemented behaviour described here.

- **The review side works.** Steward's scripts (ATC) start a reviewer for a pull request, post its
  verdict, and land the pull request once it passes. Steward's own pull requests land this way.
  For now a member of the crew starts each run by hand, with one command for the whole review side.
- **The coding side is designed but not built.** Until it is, pull requests are written by people,
  or in their own agent sessions.
- **Another project can use the review side.** Run `steward init` in the project's checkout (see
  "Setting up another project", below). It asks what it needs, adds the files the gate needs on a
  branch of its own and opens them as a draft pull request, and creates the labels. Nothing of the
  coding side is installed.

## Setup

To run the review side, you need:

- **Node 24** (npm 11 or newer), which is what CI runs and `package.json` declares, and **git**.
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
node scripts/dispatch/cli.mjs land <pr-number>     # one explicit, gated landing
node scripts/dispatch/cli.mjs rotation             # one run of the review side: review what needs it, land what has passed, then inspect
node scripts/dispatch/cli.mjs inspect              # raise a merge without a passing verdict, or a stall, on main or a release branch
```

In another project, the crew runs steward from the package at the tag the project's workflow files
pin, the form those files use, from the project's checkout:

```sh
npx --yes --package=github:luplows/steward#v<version> steward <command>
```

with `<command>` one of the commands of
[`scripts/dispatch/cli.mjs`](scripts/dispatch/cli.mjs), such as `review <pr-number>`. The project's
`package.json` does not pin steward: the version is in the workflow files and in the commands the
crew types.

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
  `main` is protected and requires `test` and `review/agent`. `review-gate.yml` and
  `land-approved.yml` hold only their triggers, permissions and environment, the set-up of Node,
  and run steward's commands (`mark-pending`, `apply-verdict`, `apply-review-blocked`, `runway` and
  `delete-merged-heads`) from this checkout. The package carries the same two files in thin form,
  and `inspection.yml` too, in [`templates/workflows/`](templates/workflows/): they run those
  commands from steward installed alone at a pinned tag, with a placeholder for the tag, which
  `init` fills. Inspection's keeps a checkout of the project, for its settings.

## Setting up another project

In the project's checkout, with `gh` signed in and Node 24 (npm 11 or newer):

```sh
npx --yes --package=github:luplows/steward#v<version> steward init
```

`init` runs no model. It asks each question at the terminal, showing its default; every question
has a flag, and `--yes` takes the default of each one no flag answers. With no terminal and a
question unanswered it refuses, names the question's flag, and writes nothing. It needs the
checkout to have a commit, and `origin` to be a GitHub repository with a `main` branch. It fetches
`origin/main`, makes a worktree of its own beside the checkout (`<checkout>.worktrees/`) on a new
branch from that commit, and creates there the files that `origin/main` does not have. It never
overwrites a file: one already there is named and left. It commits what it created, pushes the
branch, and opens a **draft pull request** against `main`; it prints the repository, the branch,
the commit and the pull request's address. What it creates:

- `steward.config.json`, with `repo` from the `origin` remote ([`docs/settings.md`](docs/settings.md)
  says what it writes for each key), and the example checklist at its `rulesFile` path (for a
  project that already has a `steward.config.json`, the path that file names);
- the thin workflow files for the gate and the runway, and for inspection when asked, in
  `.github/workflows/`, pinned to the version of the steward that ran it (`--ref <commit>` pins a
  commit's full SHA instead);
- a pull request template, only when the project has none.

Outside the pull request, and after it, it creates the labels steward reads and applies,
`review-blocked`, `breaker-override` and `inspection`, and the machine's settings
(`~/.steward/settings.json`), only when that file is missing. Neither is part of the pull request
or rolled back with it.

The pull request's body is written from the project's own pull request template (a project with
more than one names the one to use with `--pr-template <path>`, and `--yes` cannot choose; a
project with none gets steward's own). Its `Unit:` line is set to `none` for the crew to confirm,
and it lists the files added and left, the steward version, the checks `init` actually ran and what
the crew still has to do. It claims no test run and no check of files that were already there.
`--pr-title <text>` replaces the title (`Install Steward review gate`), `--pr-body-file <path>` uses
a file as the whole body, and `--branch <name>` replaces the branch name `steward/install`. `init`
never reuses, moves or deletes an existing branch or pull request of that name: it names it and
stops.

The checkout need not be clean, on `main` or up to date: a feature branch, a detached `HEAD`, and
committed, staged, unstaged, untracked or ignored work of its own are left exactly as they are, and
the installation is made from the commit fetched from `origin/main` whatever the checkout holds.
The one exception is a change of the checkout's own to a file the installation adds (or to a pull
request template location, or a directory above them): `init` names each and stops, before it
writes anything. It also refuses such a file that is marked `assume-unchanged` or `skip-worktree`,
since `git status` would not show an edit to it, and says how to clear the mark. Before anything is
made it also refuses an `origin` whose fetch or push URL, after git's own rewriting, is not a
GitHub URL naming the repository it installs into (`remote.origin.pushurl`, `url.<base>.insteadOf`,
`url.<base>.pushInsteadOf`, more than one URL), a `core.worktree` setting,
and, with `extensions.worktreeConfig`, an identity, signing or hooks setting in the checkout's own
worktree configuration that the new worktree would not read. It pushes the branch alone (no tags,
no signing, no push options), runs git without the caller's repository environment variables
(`GIT_DIR`, `GIT_INDEX_FILE` and the rest), commits as the caller's configuration and
`GIT_AUTHOR_*`/`GIT_COMMITTER_*` say, and writes the machine's settings whole or not at all. When a
step fails after it has started, `init` exits 1, says which step and what it has made (found by asking git),
leaves all of it in place, and says how to finish by hand. When `origin/main` already has every
file, it says no installation pull request is needed and opens none.

`init` asks whether steward may land pull requests unattended, and the default is no, with `--yes`
too: a new `steward.config.json` has `land: false`, so steward reviews and the project merges. Only
a yes at that question, or `--land yes`, writes `land: true`. Either way, `steward land <pr-number>`
asks for one landing of one pull request that has passed review, through the same gate
([below](#landing-unattended-and-manual)). `init` leaves a `steward.config.json` that is already
there as it is, byte for byte, whatever its `land` says or what `--yes` or `--land` are given, and
its closing output says that file governs its own landing authorization. Merging the installation
pull request starts nothing on any machine. Running steward on a machine without starting each
command by hand (a local coordinator, with activation, stop and status controls) is planned
([`docs/outline.md`](docs/outline.md), "Product roadmap") and not built; the commands in this
README are what exists now.

It never marks the pull request ready, merges it, requests a landing or alters branch protection,
and does not touch the project's `package.json`, its CI or its stories. Set up this way, a project
uses steward as it is: this is a complete set-up, which a person or a group within a larger project
may use alone. The order is:

1. Run `init`. It opens the draft pull request.
2. Review it, mark it ready, and merge it as the project normally merges. The gate cannot review
   the pull request that installs it, since the gate runs from `main`, where it is not yet
   installed, and reads the checklist from `main`; where the project already has a gate, its rules
   still apply to this pull request.
3. Optionally, run `steward protect`, once that pull request has merged.

`steward protect` sets branch protection on `main` so that GitHub stops a merge that has not passed
review. It asks no question, takes no flag but `--repo owner/name` (the repository is otherwise the
`repo` of the working directory's `steward.config.json`), and runs with `gh` signed in as an
account that can administer the repository. Before it sets anything it reads `main` on GitHub, and
refuses, naming what is missing and exiting 1, unless `main` holds `steward.config.json`, the
checklist that file names, `.github/workflows/review-gate.yml` and
`.github/workflows/land-approved.yml`. Once they are there it makes `main` require `review/agent`
with `enforce_admins` on. Protection already there is kept, and only those two are added to it
(where it requires no status checks, it is rebuilt with every setting it had, plus those two); the
project's own CI checks are the crew's to add. Where GitHub offers none, as on a private repository
on GitHub Free, or the account cannot set it, it says so plainly, says that nothing on GitHub then
enforces the gate, and exits 1.

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
([`docs/controller.md`](docs/controller.md)), where the project has opted into unattended landing.

### Landing: unattended and manual

There are two authorizations. The `land` setting of `steward.config.json` is the project's standing
permission for unattended landing; `true` is the opt-in. A rotation lands only where it is `true`,
and the runway reads it from `main` and merges nothing unattended where it is `false`, whatever
the caller's own settings say. With `land: false` steward still reviews and posts `review/agent`,
and the crew can land a pull request that has passed with `steward land <pr-number>`: one manual
request, valid with either value of `land`, for that pull request at the head it first reads. It
changes no setting, label or standing permission, and it goes through the same gate as any landing:
the runway still requires every condition it requires of an unattended one, and merges with
`--match-head-commit`. If the head changes, or the pull request is merged or closed at another
head, the request ends (`head-changed`) and the crew must ask again.

`land-approved.yml` takes the same two paths when dispatched directly. Its inputs are `pr`, `mode`
(`unattended`, the default, or `manual`) and `head`. A dispatch with no mode, or with only a pull
request, is unattended and so lands nothing where `land` is `false`. A manual one names
`mode: manual`, one pull request and its full 40-character head SHA, and is started by someone
GitHub says has write, maintain or admin permission on the repository; the workflow takes that
actor from its own event, never from an input. A mode is an explicit authorization, not proof that
a person is at a terminal or that credentials are isolated: a tool holding the crew's write
credential can send a manual request too.

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
