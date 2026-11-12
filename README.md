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
- **The coding side is built only for approved handoffs.** A member of the crew approves one file or
  Issue at a time (`steward handoff`, below), and the coordinator codes the approved handoffs one at
  a time and opens a pull request for each branch it pushes. The coordinator picks no unit from a
  project's backlog and fixes no pull request: other pull requests are written by people, or in
  their own agent sessions.
- **Another project can use the review side.** Run `steward init` in the project's checkout (see
  "Setting up another project", below). It asks what it needs, creates the labels, and opens a
  draft pull request adding the files the gate needs, for the crew to review and merge. Nothing of
  the coding side is installed.

## Setup

To run the review side, you need:

- **Node 24** (npm 11 or newer), which is what CI runs and `package.json` declares, and **git**.
- **The GitHub CLI, `gh`**, signed in with `gh auth login` as an account with write access to the
  repository. The scripts take its token from `gh auth token`.
- **The Claude Code CLI, `claude`**, on your `PATH`, or its path in `CLAUDE_EXECUTABLE`. Coder
  and reviewer sessions run in it unless the user config chooses the Codex CLI.
- **The Codex CLI, `codex`**, signed in, only if the user config gives the coder or the reviewer a
  choice whose tool is `"codex"`. Its path goes in `tools.codex.executable`. A Codex coder runs on
  Windows only, needs `tools.codex.windowsSandbox`, and its session can read files outside its
  worktree, such as `~/.codex/auth.json` and `~/.claude/.credentials.json`, so what it copies into
  the worktree would be committed and pushed ([`docs/user-config.md`](docs/user-config.md)).
- **The user config file**, `~/.steward/config.json` (or a nonempty `STEWARD_CONFIG`
  path). Each OS user running steward needs it: it holds the plan's usage limits and each
  role's default and available choices of tool, model and effort (and a strength, for a coder's
  choice), and steward has no default for any of them. Each key is described in
  [`docs/user-config.md`](docs/user-config.md). `review` and `coder` take `--choice <name>`
  to run a role on another of its available choices for one run.

**Breaking local rename:** existing developers must manually rename `~/.steward/settings.json`
to `~/.steward/config.json` and replace `STEWARD_SETTINGS` with `STEWARD_CONFIG` where used.
The old names are ignored; there is no migration or fallback. Optional
`coordinator.scanIntervalMinutes` defaults to 15 only in an otherwise valid file. Reading it
starts no coordinator or session; `steward coordinator start` reads it ([below](#the-coordinator)).
See [`docs/user-config.md`](docs/user-config.md) for validation and multi-day intervals.

Then, from a checkout of the repository:

```sh
node scripts/dispatch/cli.mjs review <pr-number>   # review the pull request at its head
node scripts/dispatch/cli.mjs land <pr-number>     # one explicit, gated landing
node scripts/dispatch/cli.mjs rotation             # one run of the review side: review what needs it, land what has passed, then inspect
node scripts/dispatch/cli.mjs inspect              # raise a merge without a passing verdict, or a stall, on main or a release branch
```

For coordinator integration, [`scripts/dispatch/review-work.mjs`](scripts/dispatch/review-work.mjs)
exports `listReviewCandidates` and `reviewCandidate`: discovery reports eligible PR/head pairs
and skip reasons in PR-number order; execution attempts one named pair through the existing
reviewer. It binds the expected full head SHA at reviewer admission and starts no model if the
head or eligibility changed. This operation only reviews, with either value of `land`; it requests
no landing and runs no coding or inspection. The coordinator schedules it
([below](#the-coordinator)), for the projects local activation names
([below](#activating-a-project)).

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
  [`docs/settings.md`](docs/settings.md). What depends on the user rather than the project is
  in the user config, [`docs/user-config.md`](docs/user-config.md).
- **The checklist**, [`REVIEW.md`](REVIEW.md) here, read from `main`, so that a pull request cannot
  change the rules it is reviewed against.
  A project's checklist may hold HTML comments; they are removed before the reviewer is given it.
  The package carries an example for another project to start from,
  [`templates/review-checklist.md`](templates/review-checklist.md).
- **Four workflows** in `.github/workflows/`: `ci.yml` runs lint and the tests, `review-gate.yml`
  turns a posted verdict into the `review/agent` status, `land-approved.yml`, the runway, does the
  merge, and `inspection.yml` runs `inspect` once a day (a project keeps it or drops it). Here,
  `main` is protected and requires `test` and `review/agent`, and so is every release branch,
  `release/*`. `review-gate.yml` and
  `land-approved.yml` hold only their triggers, permissions and environment, the set-up of Node,
  and run steward's commands (`mark-pending`, `apply-verdict`, `apply-review-blocked`, `runway` and
  `delete-merged-heads`) from this checkout. The package carries the same two files in thin form,
  and `inspection.yml` too, in [`templates/workflows/`](templates/workflows/): they run those
  commands from steward installed alone at a pinned tag, with a placeholder for the tag, which
  `init` fills. Inspection's keeps a checkout of the project, for its settings.

## Setting up another project

In the project's checkout, whose `origin` is the project on GitHub, with `gh` signed in as an
account that can write to it, git able to clone and push it, and Node 24 (npm 11 or newer):

```sh
npx --yes --package=github:luplows/steward#v<version> steward init
```

`init` runs no model. It asks each question at the terminal, showing its default; every question
has a flag, and `--yes` takes the default of each one no flag answers. With no terminal and a
question unanswered it refuses, names the question's flag, and writes nothing.

Of your checkout it reads only its root and `origin`, and it changes nothing there: your branch and
your own work, committed or not, are not looked at. It clones `origin`'s `main` into a new
temporary folder, adds there the files below that `main` does not have, commits exactly those on a
new branch, `steward/install` (or `--branch <name>`), pushes it, and opens a **draft** pull request
from it against `main`. Git runs as your own configuration makes it run, hooks and signing
included. It never overwrites a file: one `main` already has is named and left, and from an
existing `steward.config.json` it reads only `rulesFile`, to find the checklist. The files are:

- `steward.config.json`, with `repo` from the `origin` remote ([`docs/settings.md`](docs/settings.md)
  says what it writes for each key), and the example checklist at its `rulesFile` path;
- the thin workflow files for the gate and the runway, and for inspection when asked, in
  `.github/workflows/`, pinned to the version of the steward that ran it (`--ref <commit>` pins a
  commit's full SHA instead);
- a pull request template, only when the project has none.

The checklist's path, at the question or with `--rules-file`, must name a Markdown file, ending in
`.md` in any case, and no segment of it may start with `-`; `init` refuses any other answer, saying
why. An existing `steward.config.json` is not held to this: its `rulesFile` is read as before.

Each file `init` adds is as Prettier's default options print it, checked by steward's tests with
the one Prettier version steward's `package.json` pins. The one exception is a checklist added at
the path an existing `steward.config.json` names, when that path does not end in `.md` or has a
segment starting with `-`: it is not covered, and the pull request's body names it as left out of
its formatting command, or, when it is the only file added, says so with no command. `init` runs
no formatter, and the project needs none.

A project whose own formatting settings differ may format only the newly installed files, on
the installation's branch before merging it, for example, for the files a `--yes` run adds to a
project with no pull request template:

```sh
npx prettier --write steward.config.json REVIEW.md .github/workflows/review-gate.yml \
  .github/workflows/land-approved.yml .github/workflows/inspection.yml \
  .github/pull_request_template.md
```

The pull request's body gives the command for the files it added other than such a checklist, and
no command when that checklist is all it adds.
Not every project needs to.
`steward upgrade` refuses a managed workflow that differs from steward's template at its pin by
more than the pin and line endings, so a workflow that this formatting changes is refused by a
later upgrade.

Outside the pull request it also creates the labels steward reads and applies, `review-blocked`,
`breaker-override` and `inspection`, and writes the user config (`~/.steward/config.json`), only
when that file is missing.

The pull request's title names steward and its version. Its body is a section saying what was
added, what was left, what the installation means for landing and what to check before marking it
ready, followed by the project's own pull request template, unchanged, for the crew to fill (with
several templates, `--pr-template <path>` chooses; with none, steward's own is used). A checklist
`main` already has is read from `main` and parsed as the reviewer parses it. One that does not
parse is left as it is, and the installation goes ahead: `init`'s output and, at the top of the
draft pull request's body, a warning name the file and each problem, such as a section with no
numbered item, and say to repair it before merging the installation (see
[When the checklist does not parse](#when-the-checklist-does-not-parse)). When `main`
already has every file, `init` compares each workflow it would write with its own template,
apart from the pin. If all match, it says the installation is already complete and makes no
branch, commit, push or pull request. If any does not, it names it, says the installation is not
this version's and that a project's own workflows with those names must be removed or renamed
before `init` can install, makes no branch, commit, push or pull request, and exits 1. When some
files are missing, a kept workflow that does not match is named as such in the pull request's list
of files left, and in the closing message. It refuses, with exit 2, when the branch is already
on `origin` or a pull request is open from it. When a step fails it stops, says which, with Git's
or GitHub's own message, what now exists and what to do next, and undoes nothing. It keeps its
clone after every run, and its closing message gives the folder's path, to remove when you are
done with it.

`init` asks whether steward may land pull requests unattended, and the default is no, with `--yes`
too: a new `steward.config.json` has `land: false`, so steward reviews and the project merges. Only
a yes at that question, or `--land yes`, writes `land: true`. Either way, `steward land <pr-number>`
asks for one landing of one pull request that has passed review, through the same gate
([below](#landing-unattended-and-manual)). `init` leaves a `steward.config.json` that is already
there as it is, byte for byte, whatever its `land` says or what `--yes` or `--land` are given, and
its closing output says that file governs its own landing authorization. Merging the installation
pull request starts nothing on any machine. To have steward review a project's pull requests
without starting each command by hand, activate the project ([below](#activating-a-project)) and
start the coordinator ([below](#the-coordinator)), which reviews, and lands only where the project's
`main` has `land: true`.

It never marks its pull request ready or merges it, does not touch the project's `package.json`,
its CI or its stories, and does nothing about branch protection. Set up this way, a project uses
steward as it is: this is a complete set-up, which a person or a group within a larger project may
use alone. The order is:

1. Run `init`.
2. Review the draft pull request it opened, fill in the template in its body, and mark it ready.
3. Merge that pull request as the project normally merges. The gate cannot review the pull request
   that installs it, since the gate runs from `main`, where it is not yet installed, and reads the
   checklist from `main`.
4. Optionally, run `steward protect`, once that pull request has merged.
5. Remove the folder `init` cloned into, which its closing message names.

Installation and explicit local activation are separate: see
[Activating a project](#activating-a-project).

`steward protect` sets branch protection on `main` so that GitHub stops a merge that has not passed
review. It asks no question, takes no flag but `--repo owner/name` (the repository is otherwise the
`repo` of the working directory's `steward.config.json`), and runs with `gh` signed in as an
account that can administer the repository. Before it sets anything it reads `main` on GitHub, and
refuses, naming what is missing and exiting 1, unless `main` holds `steward.config.json`, the
checklist that file names, `.github/workflows/review-gate.yml` and
`.github/workflows/land-approved.yml`. It also refuses, naming the file and each problem and
setting nothing, when that checklist, as `main` holds it, does not parse as the reviewer parses it.
Once they are there it makes `main` require `review/agent`
with `enforce_admins` on. Protection already there is kept, and only those two are added to it
(where it requires no status checks, it is rebuilt with every setting it had, plus those two); the
project's own CI checks are the crew's to add. Where GitHub offers none, as on a private repository
on GitHub Free, or the account cannot set it, it says so plainly, says that nothing on GitHub then
enforces the gate, and exits 1.

### Running a rotation by hand

`steward rotation` (the installed form of `node scripts/dispatch/cli.mjs rotation`, above) reviews
what needs it, lands what has passed where the project's `land` is `true`, and inspects, once. It
works in a checkout of the project that is **detached and has nothing uncommitted**. It refuses to
run from a checkout with a branch checked out, before it fetches or does anything else, and stops,
doing nothing more, when there are uncommitted changes. Preparing that checkout is the crew's:
steward does not create, repair or delete it. Prepare it with Git, from the project's own checkout,
`<path>` being a folder that does not exist yet, beside the checkout for instance:

```sh
git fetch origin main
git worktree add --detach <path> origin/main
cd <path>
npx --yes --package=github:luplows/steward#v<version> steward rotation
```

Run the last line, from `<path>`, for each rotation. The rotation itself fetches `origin` and
brings `<path>` to `origin`'s `main`, detached, before it reads the project's settings, so the
worktree can be kept and reused, and `git worktree remove <path>` removes it when it is no longer
wanted. `--max-reviews N` caps the reviews a rotation starts.

A rotation for another repository, `steward rotation --repo owner/name` naming one that is not the
`origin` of the checkout it is run from, does not work in that checkout. It works in a checkout of
that repository that steward keeps under `~/.steward/state/manual-checkouts/`, detached by steward
itself, so the checkout it is run from is not checked and may have a branch checked out. Of that
checkout only `origin` is read.

A rotation prints a line for each open pull request against `main` or a release branch. One it
skips because a verdict is already at its head says which verdict, as
`skipped: a verdict is already at its head (pass)`, with `pass-with-observations` or `block` in
place of `pass` where that is the verdict. No new review is started for it.

### Upgrading steward in a project

To move a project that has steward installed to another pin of `luplows/steward`, run, from steward
installed at the pin you are moving to, in the project's checkout:

```
npx --yes --package=github:luplows/steward#<pin> steward upgrade --to vX.Y.Z
npx --yes --package=github:luplows/steward#<pin> steward upgrade --ref <full SHA>
```

Give exactly one of the two: `--to` names a tag of `luplows/steward` of the form `vX.Y.Z`, and
`--ref` the full SHA of any commit of it, such as a release candidate (a tag is not accepted
there). Run it from steward installed at the target pin, because it validates the proposed result
with the steward it is running (`readSettings` and the reviewer's checklist parser).

It reads steward from GitHub, and the project's files at the commit its `main` names when the
command starts, and clones nothing until it has decided (choosing the project's pull request
template, with `--pr-template`, needs the clone's files: that refusal, if any, leaves the clone,
which it names).
It reads the pin that the project's managed workflows (`review-gate.yml`, `land-approved.yml`, and
`inspection.yml` when there is one) carry. It refuses, naming each finding, when a managed
workflow is missing, when they do not all carry the same pin, when that pin is not a tag or a
commit of `luplows/steward`, when a workflow is not steward's own template at that pin apart from
the pin (reconcile it by hand, through a pull request of the project), when the target is behind
the installed commit (a downgrade), when the target has no template for a workflow the project has,
or when the proposed `steward.config.json` or checklist is not valid. When the project is already
on the target it says so and does nothing. Otherwise it opens one draft pull request, from a new
branch (`steward/upgrade-<pin>`, or `--branch`), that replaces each managed workflow with steward's
template at the target pin, filled in as `init` fills it. It leaves the project's other files as
they are, `steward.config.json` and the checklist included, unless a release makes an explicit,
unambiguous change to one, which the pull request's body explains. It never changes `land`:
unattended landing stays as the project set it.

The pull request's branch starts from the commit of `main` the command read (the base): if `main`
has moved since, the pull request starts from that earlier commit. The body says what the command
generated and checked, of the base and the one commit it made on it (the head), and nothing of
commits or edits after them. When the project's pull request template has one `## What changed`,
one `## Verification` and one `## Docs check` heading, and at most one `## Crew action required`,
the command adds its text at the end of each and keeps the rest of the template. With no
template, or an empty one, it uses steward's `Unit:` line and those three sections. Any other
template follows the command's text as it is, unfilled, with its headings named for the crew to
complete. **What changed** names the installed and target pins, whether the target is a release
or a commit with the version its `package.json` gives, the branch, the base, the head and the
files the head changes. **Verification** gives the command's arguments and the version of the
steward that ran it, each check it made under **Verified**, and under **Not checked** what it did
not run: the project's tests and CI, the workflows, a review. **Docs check** says that, apart from
the checklist and the pull request template, it did not inspect `README.md` or other
documentation. A **Crew action required** section lists suggestions, the project's own rules
deciding which apply, among them:

- The `Unit:` line. The command names no unit: if the project's review needs one, the crew links a
  unit this pull request implements.
- Work the upgrade needs first, such as documentation or CI changes, as a unit and pull request of
  its own, complete without this one. Commits added to the upgrade's branch are not part of what the
  command checked.
- Documentation that names the old pin, or says whether steward is pinned to a tag or a commit,
  which a move from a tag to a commit, or back, makes stale.
- What the project's CI reports, any decision a migration leaves to the project, and the steps
  after merging.

The command does not merge, mark ready, change protection, activate the project, or start or stop
the coordinator. Once the crew has
reviewed the pull request and merged it as the project normally merges, check that every
`github:luplows/steward#` in `.github/workflows/` on `main` names the target pin. A coordinator
running for the project is stopped and started again by hand, from steward installed at the target
pin, when the crew wants that machine on it. If a step fails after the clone, its message says
what exists (the clone, the branch) and what to do next. A push or a pull request that was tried and
failed is reported as uncertain, with the commands to check it (`git ls-remote`, the open pull
requests from the branch); it rolls nothing back.

### When the checklist does not parse

The reviewer reads the checklist from `main`. While the checklist there does not parse, steward
refuses to review any pull request of the project, the one that repairs it included, so none gets
a verdict and none passes `review/agent`. `init` warns of it, and `steward protect` and
`steward project activate` refuse it, but each checks `main` only as it found it when it ran: a
change to the checklist merged afterwards can break it again. Steward does not repair the
checklist, rewrite it or relax anything to get past it: the repair is the crew's.

- **Before `steward protect` has been run**, or where protection does not require `review/agent`,
  repair the checklist through a pull request and merge it as the project normally merges. Then
  run `steward protect` if you want protection.
- **Once `main` requires `review/agent`**, with `enforce_admins` on, GitHub refuses to merge the
  repair, admins included. A member of the crew with admin access to the repository decides to
  remove `review/agent` from the required status checks of `main`'s branch protection, in
  GitHub's settings, for the time it takes; merges the pull request that repairs the checklist,
  as the project normally merges; and runs `steward protect` again, which reads the repaired
  checklist from `main`, refuses if it still does not parse, and otherwise makes `review/agent`
  required again, with `enforce_admins` on.

Do not post a verdict marker by hand, or have anything else write one, to get a pull request past
the gate: a marker is a reviewer's verdict on a head, and one written for any other reason is not
a review. Steward has no bypass of its own.

### Activating a project

Installation and explicit local activation are separate: the installation pull request, and
`init`, create no permission for steward to review the project unattended on any machine. Each
member of the crew who wants that on their own machine activates the project there, as their own
OS user:

```sh
steward project activate <checkout-path>   # permit unattended review of that checkout's repository
steward project list                       # the activated repositories and their checkouts
steward project deactivate <owner/name>    # take that permission away again
```

`activate` reads only the checkout's root and `origin`'s URL, which must name a GitHub repository,
and changes nothing in that checkout: not its branch, its files or its refs. It checks the
installation on `origin`'s `main`, not on the branch the checkout is on, in a checkout of its own,
the owned checkout, a clone of `origin` at `~/.steward/state/checkouts/<owner>/<name>`, detached at
`origin`'s `main`: cloned when it is not there, fetched and checked out when it is. `main` must have
a valid `steward.config.json` whose `repo` is that repository, and files at the checklist's path it
names and at `.github/workflows/review-gate.yml`, and that checklist must parse as the reviewer
parses it. When it does, `activate` records the project in
`~/.steward/state/projects.json`, one record per repository holding the repository, the root of
the checkout it was given and the owned checkout, and no credentials; activating it again, from
any checkout of it, updates that record and reuses the owned checkout. When it does not,
`activate` names each check that failed, records nothing (a record already there is left as it
was), keeps the owned checkout for the next
attempt and exits 1. `list` reads the records, and marks a checkout that is no longer there as
missing, and one that is not a usable Git checkout as invalid; a records file it cannot read fails
visibly, and counts as permission for no project.
`deactivate` removes the repository's record. The owned checkout is retained for reuse, by a later
activation, and is never cleaned up automatically: remove it by hand if you no longer want it.
None of these commands starts a review or a coordinator.

### Approving a coding handoff

Coding is never chosen from a project's backlog. A member of the crew approves one unit at a time,
a file on an activated project's `main` or one of its GitHub Issues, as that OS user:

```sh
steward handoff add --repo <owner/name> --file <relative-path>   # approve a file on main
steward handoff add --repo <owner/name> --issue <number>         # approve an Issue
steward handoff list                                              # the approvals, oldest first
steward handoff show <id>                                         # one approval, with its text
steward handoff reapprove <id>                                    # read the source again
steward handoff withdraw <id>                                     # stop it being selected
```

`add` brings the project's owned checkout to `origin`'s `main` and refuses, recording nothing,
when the project is not activated, when its `unitLinks` on `main` lacks `file` (or `issue`),
when the path is not one repository-relative path (no `..`, `.` or empty part, no backslash,
control character or drive letter), when the file is not on `main`, or when the Issue cannot be read or is a pull request. A file need not
follow the story schema. Steward reads an Issue and writes nothing to GitHub.

Each approval is kept in `~/.steward/state/handoffs.json`, not in the project, `config.json` or
`projects.json`, with a stable ID (`H-1`, `H-2`, ...) that is also its place in one order across
every project, the exact approved text, the repository and source, and where the text was read:
for a file the full commit of `main`, for an Issue its number, title, body and a fingerprint of
its text. `show` only reads that file. `list` reads it and also reads each pending handoff's
source, as selection does (below), and writes no record. None of these commands starts a model or a
coder.

`add` again for a source already approved and not yet taken reports the existing handoff when the
text is the same, and refuses, pointing to `reapprove`, when it differs. `reapprove` reads the
source again. When a pending handoff's text is unchanged it changes nothing. Otherwise it appends
the version approved so far to the handoff's history and makes the new text the current, pending
version, keeping the ID and the place in order. `withdraw` stops a pending or held handoff being
selected and keeps its history. A handoff that is admitted or completed is neither reapproved nor
withdrawn, and a source whose handoff is admitted or completed is not added again; a withdrawn one
can be, as a new handoff. The coordinator moves a handoff on from `pending`: it is `admitted` while
it is being coded, then `completed`, or `stopped` or `interrupted` (see "The coordinator", below);
no command releases a stopped or interrupted one, and `add`, `reapprove` and `withdraw` refuse it as
they refuse an admitted one. A records file that is not valid refuses every command, and is never
read as an approval. The write goes to a temporary file renamed over the old one, so a write that
fails leaves the file as it was. Every write, by a command or by the coordinator, which are separate
processes, takes a lock (`handoffs.json.lock`, beside the file, made with exclusive creation and
holding the process id and the time), reads the file afresh, changes only the record it concerns,
writes, and releases the lock, all after any source has been read: `add` and `reapprove` refuse,
changing nothing, when the records changed while they read the source, and a record the coordinator
admitted or completed in the meantime is never put back as it was. A write that finds the lock held
waits, a few milliseconds at a time, for up to 5 seconds (`LOCK_WAIT_MS` in `handoff.mjs`), and then
refuses and writes nothing; the coordinator treats that as a failed write. A lock is never taken
over, whoever made it: if the lock file is still there after the wait, the error names the file and
the process and time it records, and says to delete the file if that process is not running. Only
the writer that made a lock deletes it, when it is done. Reading (`list`, `show`, `status`,
selection) takes no lock. A second coordinator, or a writer that ignores the lock, is not guarded
against.

Which handoff is coded next is chosen by selection, an operation the coordinator calls
(`selectHandoff` in `scripts/dispatch/handoff.mjs`; there is no command for it). It takes the oldest
pending handoff, in the order approved across every project, that is eligible now, and skips the
others, which keep their places. A pending handoff is eligible when its project is still activated,
its source can be read, and the source still has exactly the approved text: for a file that text on
`origin`'s `main`, for an Issue its title and body. New commits on `main` that leave the unit's text
unchanged do not matter. A withdrawn, held, admitted, completed, stopped or interrupted handoff is
never eligible. Selection starts no coder, claims no branch and reserves nothing; the step that
starts coding checks again (below).

- If the source was read and its text differs from the approved text, selection **holds** the
  handoff, recording why in its record. A hold stays until `steward handoff reapprove <id>`, even if
  the source later has the approved text again, and reapproval keeps the handoff's place in order.
- If the source could not be read (the project was deactivated, the owned checkout or GitHub could
  not be read, the file is no longer on `main`, the Issue is gone or is now a pull request), the
  handoff is **temporarily ineligible**: selection reports why, holds nothing, and a later selection
  that reaches it reads it again. Nothing needs reapproving when the source comes back unchanged.
  Selection stops at the first eligible handoff, so it reads no handoff after that one.
- If `handoffs.json` is not valid, selection fails and selects nothing. `projects.json` is read
  when selection reads a pending handoff's source: if it is not valid then, selection fails and
  selects nothing, and with no pending handoff it is not read.
- When none is eligible the result says so. Selection never waits or retries by itself.

`steward handoff list` shows each held handoff and each pending one that is not eligible now, under
"Not eligible now", with its repository, source, position (its place in the approval order), and
what to do. It only reports: a pending handoff whose unit has changed is shown as `changed`. A
selection holds it when it reaches that handoff and its content still differs, not when it is
listed. An Issue's title and body, and a file's text, are compared exactly, trailing whitespace
included. For a handoff the coordinator has taken (admitted, completed, stopped or interrupted),
`list` and `show` add what the record knows: why, when, the branch, the pull request, the head and
the work kept, and what the crew does next.

### Executing an approved handoff

`executeHandoff` in `scripts/dispatch/handoff-coder.mjs` codes one approved handoff with the bounded
coder, to a branch pushed to the project's remote. There is no command for it: the coordinator calls
it, once for each admission ("The coordinator", below). It is project-neutral. It needs no
`stories/` folder, story frontmatter, `blocked:` field or `AGENTS.md`/`REVIEW.md` in the project;
its prompt (`.claude/prompts/coder-handoff.md`) gives the coder the approved text exactly, where it
came from and the repository, and tells it to read the project's checklist (its `rulesFile` setting)
and whichever of `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md` and `README.md` it has. The story
coder, which takes steward's own `stories/`, is unchanged.

It is given a handoff's ID and the approved version, and starts no model session unless the handoff
passes a check: its version is the current one, its status is `pending` (or, when the coordinator
passes its admission, `admitted` and the admission's ID, handoff and version match and the admission
is still active), and its project is activated with its source readable and its text exactly the
approved text. It checks at the start and again just before the branch is claimed, after the usage
check, unless an earlier step has already refused. When a check finds the source as approved, it
then asks whether the admission is still active and, with nothing awaited after that, reads the
projects and the records again and decides from them, so a handoff withdrawn, a project
deactivated or an admission stopped during the source read or the admission query is refused. A
change to the source after the source read is not seen before the claim. It writes no handoff
record, so a refusal changes nothing in the records; the coordinator decides what to record. A
refusal is a `status` of the
result:

- `unit-changed`: the source was read and its text differs from the approved version. This is the
  one the coordinator answers with a hold, as selection does. It is not retryable.
- `source-unavailable` (the source cannot be read now, or `main` or the remote's branches cannot
  be read), `over-usage` and `usage-unknown` (also when the usage reader fails): the same handoff
  may be executed again later. The result says `retryable: true`; no other refusal does.
- `handoff-unknown`, `version-not-current`, `not-executable` (held, withdrawn, completed, or admitted
  with no admission passed), `admission-mismatch`, `admission-inactive` (also when it cannot be asked), `records-unreadable`,
  `no-git-identity` (`user.name` or `user.email` is unset or empty in the project's owned checkout), `choice-unavailable` (also when the user config cannot be read), `bad-machine-label` and
  `branch-exists`.

Then it works as the story coder does. The branch is `handoff/<id>-<source>`, named from the
handoff's ID and its source (the file's path in lower-case letters and digits, or
`issue-<number>`), so it is the same for every execution of one handoff. An existing local or
remote branch is refused. ATC makes the claim commit on it and pushes it, creating the branch on
the remote and never replacing one, before the project's `setup` (read from the revision the
worktree is made from) runs or the coder starts. It never pushes to `main` and opens no pull
request. The coder is the user config's default coder choice (or the one its caller names), with
the same usage limits, time limits, allowed tools and credential-free environment as for a story,
and a Codex choice is committed by ATC, with the coder's own commit message when it supplied one (else the PR title) and, like the claim commit, as the git identity of the owned checkout (read once, before the claim). The machine label of the claim commit is `STEWARD_MACHINE_LABEL`, or `TW_MACHINE_LABEL` when that is unset or empty. It does not read a unit's own choice of model.

When the coder finishes, the result has `status: "pushed"` with the repository, handoff ID and
version, the branch, the pushed `headSha`, the session's outcome, the choice that ran (its name,
tool and model) and `proposedPr`, the title, body and draft flag the coder wrote. Opening the pull
request is `publishHandoff`'s, below. A run that stops short has its own `status`: `claim-failed`,
`install-failed`, `session-failed`, `nothing-committed`, `uncommitted-changes`,
`prompt-change-refused`, `commit-failed`, `push-failed` or `pr-block-invalid` (the branch is pushed, with no description).
A step that throws once the claim begins (the claim, the setup, starting the session, ATC's commit
or push) is the result of that step's kind, not a throw. A call starts at most one session, and no
failure starts another. After any failure that started the session, `pr-block-invalid` included,
the result's `retained` names the worktree (and its branch) when the worktree holds uncommitted
changes or untracked files, and the branch when it holds commits that are not on the remote; both
are left in place. The claim commit stays on the remote after any failure that follows it.

### Publishing a handoff's pull request

`publishHandoff` in `scripts/dispatch/handoff-publish.mjs` opens the pull request for the `pushed`
result of `executeHandoff`. There is no command for it: the coordinator calls it, once for each
`pushed` result. It runs no model, claims and pushes nothing and writes no handoff record. It trusts
only the branch and head SHA that were pushed, and resolves a result, never a throw.

It opens a pull request into `main` only when the handoff record names that project, version and
branch, the remote branch's tip is still the pushed head SHA, the model the session ran can be
written as one `Coder:` token (letters, digits and `. _ : / @ + [ ] -`, starting with a letter or
digit), and the coder's body has no line starting `Unit:` and no closing keyword followed by an
issue reference (`coder-link-conflict`, which names the lines and rewrites nothing). Then it compares
the unit's source with the approved text once, just before opening the pull request, and reads the
project's `unitLinks` from the checkout that comparison refreshed: when they no longer include the
unit's kind it refuses (`unit-link-refused`), never opening a draft. Nothing watches the source
while the coder works. A source that changed then and still differs when the comparison is made is
found by it; a change after the comparison is not detected. When the source is as approved,
the pull request is ready or a draft as the coder asked. When the source changed or could not be
read, it is a draft with a "Handoff discrepancy" section in its body, and the result's
`discrepancy` (`changed` or `unreadable`, with the reason) is for the crew to act on; the coder's
work is not redone.

The body is ATC's frame around the coder's text, and the reviewer still reads the unit as it
stands now on `main`:

- `Unit:` is ATC's: the original file path on `main` (not where the coder moved the file), or
  `#<number>`. For an Issue, one `Closes #<number>` follows it. A file has no closing reference.
- The coder's body is kept as written, verification statements included, except for its outer
  blank space, its line endings (written as `\n`) and that every `Coder:` line is removed, since ATC never trusts a coder-written one. A body with a line starting
  `Unit:`, or any closing keyword followed by an issue reference (`Closes #9`, `fixes owner/name#9`,
  also inside a quoted command), is refused rather than rewritten. ATC adds no attribution and
  removes none the coder wrote.
- A "Handoff provenance" section gives the handoff's ID, the approved revision, the original path
  and approved `main` SHA (or the Issue's number and its approved title and body fingerprint) and the
  tool, choice and model that ran. It says the approved revision is provenance, not the reviewer's
  source of truth; `steward handoff show <id>` has the approved text and version history.
- The last line is `Coder: model=<id>`, the model that actually ran. The reviewer reads a
  `model=` token as that literal model, whatever `roles.coder.available` holds now, and reads a
  choice-name token as before.

Before sending, it reads the body with `findUnitLink` under the current `unitLinks` and sends it
only when that names exactly the intended unit and the body has the intended closing references.
A failure has `recoverable: true`, the handoff ID, branch and head SHA, and leaves the pushed
branch alone and re-executes nothing: `not-a-pushed-result`, `handoff-mismatch`,
`records-unreadable`, `bad-model-id`, `pr-invalid` (no title or body, or a draft flag that is not
true or false), `coder-link-conflict`, `head-moved` (with the tip found, or `null`), `head-unverified`,
`unit-link-refused`, `unit-link-ambiguous` and `publish-failed` (GitHub's error).

### The coordinator

The coordinator is one long-running process per OS user, across that user's terminals and activated
projects, that schedules their automatic reviews until it is stopped, and discovers the pull
requests unattended landing may consider, and asks for their landing, and codes the handoffs the
crew has approved. It reviews, discovers, requests landing and codes approved handoffs, nothing
more: it runs no rotation, inspects nothing, and starts no fixer or story coder. It lands only where
a project's `main` has `land: true`, by asking the pilot, which the runway then follows; it merges
nothing itself. Verdicts go through the existing gate.

```sh
steward coordinator start            # start it in the background
steward coordinator status [--json]  # running, stopping or stopped, and what it is doing
steward coordinator stop             # admit no more work; exit once admitted work has finished
```

`start` launches the coordinator detached, so it keeps running after the terminal that started it
closes, and reports `started` only once the new process has written its record,
`~/.steward/state/coordinator.json`: its process id, start time and state, what `status` shows
(below), and no credentials. `start` first reads `coordinator.scanIntervalMinutes`, and the optional
`coordinator.landingScanIntervalMinutes`, from the user config, and refuses, starting nothing and
changing nothing, when it cannot read that config. A change to an interval takes effect at the next
`start`. If the process ends, or writes no record
in time, `start` says it did not start and exits 1. When the recorded process is running, `start`
starts nothing, reports `already-running` with its process id and start time, and exits 1. When the
record's process is no longer running, `start` says so, replaces the record and starts a new
coordinator. A record whose process is gone is reported by `status` as `stopped`, noting that the
previous coordinator ended without removing its record.

On starting, the coordinator scans at once. A scan reads the activation records and lists each
activated project's candidates (`listReviewCandidates`), keeping one entry for each pull request and
head. It then reviews the eligible heads it found in fair, round-robin turns by `owner/name`: each
turn belongs to the next project with a head left,
brings that project's owned checkout to `origin`'s `main`, reads the records again just before
admitting, reviews one head and awaits it, so one automatic review runs at a time across the OS
user's projects. The interval governs the discovery of new work, not the delay between reviews
already discovered: when no known head is left, the coordinator starts nothing and scans again after
`coordinator.scanIntervalMinutes`. The position in the order is kept in memory, so a restart begins
a new round. Manual commands neither count towards the one review nor change the position.

The same scan discovers landing candidates (`landingCandidates`, `coordinator-scheduler.mjs`), by
default, or on a due time of its own when `coordinator.landingScanIntervalMinutes` is set. For each
activated project it brings the owned checkout to `origin`'s `main` and reads that `main`'s
`steward.config.json`; only `land` exactly `true` admits the project's candidates. `land: false`
admits none, silently, as that is the project's choice. Settings that are malformed or unreadable
admit none too, and `status` gives the reason, as a landing problem that stops no review. A
candidate is an open, non-draft pull request on a supported base, whether or not this coordinator
reviewed it, and including a current head that already has a verdict. One by an author the gate does
not honour, or labelled `review-blocked`, is left out, as the pilot would refuse it. It is identified by `{ repo, number, headSha }`,
once for each repository, number and head however many times discovery lists it, and the latest
scan's candidates are in the record and shown by `status`. They go to the pilot, as follows, and its
checks and the runway's keep the final say. The intervals make
scans due; they do not run beside a review. Review turns and scans run one after another, so a
review that outlasts a due time delays that scan until the turns have finished, and the idle
wake-up is the earlier of the two due times.

After a scan's review turns, the coordinator takes that scan's landing candidates one at a time.
Just before each it checks that the project is still activated, that its current `main` still has
`land: true`, and that the pull request is open at the head the scan found; one that fails a check
is not sent, and the last landing in `status` says why. It reads activation again once the checkout,
settings and pull request have been read, and sends nothing if the project was deactivated
meanwhile. Otherwise it admits one call of the pilot, `landPullRequest`, in unattended `once` mode,
with the project's `landWhen`. That call waits for no check or process of unknown length, with one
bounded exception: a pull request that is not landable yet is returned at once as `not-landable`,
with its reason, and one that was dispatched is polled for its merge for one sweep run's bound only.
The exception is a pull request whose head passed review in the same pass of the scheduler's loop,
by a review this coordinator recorded as `pass` or `pass-with-observations`: its attempt is given
that head as `passedAt`, and the pilot reads its `review/agent` status every 15 seconds, for up to
two minutes, while GitHub has not yet recorded it as `success` (pending, absent, `failure` or
`error`), and, unless the pull request changes meanwhile, returns `not-landable` with the reason
`gate-lag` when that bound passes. Nothing else gains a wait, the dispatch names the pull request
only, with no head, and the pass is kept in memory for that pass alone, so a candidate found without
a review in the same pass, or after a restart, keeps the one look. Attempts never overlap
each other or a review, because the coordinator does one piece of admitted work at a time, so a scan
that falls due during an attempt waits for it (ST-85 is to separate them). The coordinator keeps no
ledger of attempts: a head whose attempt did not merge is tried again at a later scan, after the
same checks, and so is a still-eligible one after a restart. The runway checks each request again
and decides.

Each pass ends with one coding turn (`codeNextHandoff`,
[`scripts/dispatch/handoff-coding.mjs`](scripts/dispatch/handoff-coding.mjs)), unless coding is
blocked (below), after the scans, review turns and landing attempts that were due. If another scan
came due during those, for example a landing scan on its own interval while a long review ran, it is
run first, and coding is admitted only when nothing is due. It selects the oldest eligible approved
handoff (above) and, in one write to `handoffs.json` and before any branch is claimed, setup run or
model started, makes it `admitted` and gives it an admission: a unique ID, the handoff, the approved
version, the repository, the branch it will be coded on and the time. The record is read again
first, so a handoff reapproved or withdrawn since it was selected is not admitted. The turn calls
`executeHandoff` with that admission, which it confirms against the same file each time it checks,
and, for a branch that was pushed, `publishHandoff`, once; it waits for both before anything else is
looked at. So the coordinator runs at most one coder at a time, and **a coding session, which can
last as long as a coder session does, delays any scan, review or landing attempt that falls due
meanwhile** until the turn has ended. A graceful stop waits for the turn too. After a turn that
ended a handoff as `completed`, `stopped` or `held`, the next pass starts at once, with a scan if
one is due and then another coding turn; after any other turn the coordinator waits for the next
scan, so a handoff returned to pending is never tried again in a loop. How a turn ends is written to
the handoff's record, with the admission cleared, in one write:

- **A pull request was opened:** `completed`, with the pull request, branch and head. A later scan
  or a restart does not code it again.
- **A refusal before any claim or model, that may pass later** (`over-usage`, `usage-unknown`, or
  `source-unavailable`, which covers a deactivated project, a failed GitHub read and a source,
  checkout or remote that cannot be reached): the admission is cleared and the handoff is `pending`
  again, to be reconsidered at the next scan.
- **`unit-changed`, the source no longer has the approved text:** the admission is cleared and the
  handoff is `held` with the reason, as selection holds it. The source later matching the approval
  again does not release it; `steward handoff reapprove` does.
- **Anything else:** another refusal, a failure after the claim, the session or the push, an error
  thrown by the run, or a pushed branch whose pull request was not opened. The handoff is `stopped`,
  with the reason and what is known: the branch, the head, the pull request, and the worktree or
  branch `executeHandoff` kept. Nothing is retried, and the coordinator never codes it again.
- **A write that fails:** if the admission cannot be written, nothing was started and the handoff
  stays `pending`; if the admission cannot be cleared, or the ending written, the handoff stays
  `admitted`, and what the run is known to have left (the branch, head, pull request and any
  worktree or branch kept) is in the message, in `status` (also as `lastCoding.evidence` in
  `--json`) while the coordinator runs, and in `~/.steward/state/coding-evidence.json`, which only
  the coordinator writes, with the admission ID. That file outlasts the coordinator: `status` and
  `steward handoff list` show it for the admitted handoff whether or not a coordinator is running,
  and the next `start` puts it into the `interrupted` record and removes its entry. In either case
  the coordinator admits no more coding until it is restarted, `status` says why, and reviews and
  landing carry on. A selection that fails (an unreadable file, for instance) is not this: it is
  reported, and the next scan selects again.

A coordinator that ends during coding leaves its handoff `admitted`. The next `start`, with the
reviews' interruption below, moves each `admitted` handoff to `interrupted`, with the branch the
admission named and any evidence the coordinator kept for it, and says which. That handoff is not
coded again automatically. `start` does not resume it, run a model, look for or stop a surviving
worker, claim its branch again or remove a worktree it left: the crew inspects the branch on the
remote, any pull request from it, and `git worktree list` in the project's owned checkout. A `start`
that cannot read or update `handoffs.json` names the file and starts nothing. A turn that finds a
handoff `admitted` with nothing in the running coordinator coding it admits nothing.

- A project's failed GitHub discovery, or a failure to bring its owned checkout to `origin`'s
  `main`, starts no review of it and stops no other project; the next scan tries it again.
- Records that cannot be read prevent every automatic review, and never activate anything; each
  scan reads them again.
- When a review returns `over-usage` or `usage-unknown`, no model has started. The coordinator
  starts no more reviews until the next scan, where the reviewer checks usage again. Another refusal
  that started no model ends that head's turn, and a later scan may consider it again.
- A head whose review counted as a model-consuming failure, `interrupted` included, is not reviewed
  again automatically: the coordinator checks at each scan and just before each admission, and the
  count survives a restart. A new head of that pull request is eligible, and a manual review remains
  available.

`status` starts nothing and changes nothing. It reports `running`, `stopping` or `stopped`, with the
process id and start time when there is a record, and `--json` prints the same as one JSON object.
For a running coordinator it adds what the coordinator wrote to its record as these changed: the
review under way, with its project, pull request and full head, the landing attempt under way (shown
apart from a review), the effective intervals, the next scan when known, the landing candidates last
found, the last outcome, the last landing attempt's project, pull request, head, time, status and
reason, and the usage and failure reasons above. Only a last landing of `merged` is a merge the
pilot saw; `sweep-pending` and any other status are not a confirmed merge, and one whose result
carries a positive `triggers` count says that the landing workflow was dispatched. An error from the
pilot after a dispatch is reported as `threw`, which does not say whether a landing request was
sent. The pilot reads the head itself, so the head shown is the one it reports, with the head the
scan found beside it when they differ; when it reports none, because it found the pull request
already merged or closed, the head is shown as unknown. It also lists, from `reviews.json`, the
heads not reviewed again automatically, or says that file cannot be read.

`status` also lists the coding work, from `handoffs.json`, whether or not a coordinator is running,
so stopped work stays inspectable after it has exited. Each handoff is under `queued` (pending),
`running` (admitted), `completed`, `stopped` (stopped or interrupted) or `held`, with its
repository, ID, unit, version and, when the record knows them, why, when, the branch, the pull
request, the head, the work kept, and the next thing the crew does; withdrawn handoffs are not
listed. In `--json` this is `coding`, each handoff as `steward handoff list` reports it. A running
coordinator adds the handoff being coded, which shows no next scan until it ends, the last coding
turn's outcome, and why coding has stopped, or a selection failed. `status` and `steward handoff
list` are how the crew learns of stopped work: there is no other alert. A write of these fields that
fails is not fatal: the coordinator carries on, and what it writes next replaces them, so `status`
can be behind until then. The record's only other writes are at the start and on a stop. On Windows
a write can be refused while another process is reading the file, so a `start` that is watching for
the record can occasionally cost the first scan's note of the next scan.

`stop` leaves a stop request, `~/.steward/state/coordinator.stop`, which the coordinator looks for a
few times a second. On seeing it, the coordinator admits no more work, and that is the
acknowledgement `stop` waits for. With no admitted work running, the coordinator removes its record
and exits, and `stop` reports `stopped`. Otherwise `stop` returns at once, reporting `stopping`,
without waiting for that work; the coordinator removes its record and exits once the work has
finished, and `status` then reports `stopped`. Once the stop is acknowledged no coding turn is
admitted: a handoff already admitted is finished and recorded, and the others stay pending for the
next `start`. Running `stop` again, or when nothing is running, is harmless. A graceful stop
terminates nothing, and is not the shared emergency stop (E-stop) planned before 1.0, which will
terminate running work and block new commands.

Manual commands, `review`, `rotation` and `land` among them, never ask the coordinator, and run the
same whether it is running, stopping or stopped. A project deactivated during a review is not
admitted afterwards, and the review under way may finish.

So that a later scan will not start, and pay for, a review already started, the coordinator notes
each automatic review in `~/.steward/state/reviews.json` before starting it, and how it ended
afterwards (`admitReview`,
[`scripts/dispatch/review-admission.mjs`](scripts/dispatch/review-admission.mjs)). A repository,
pull request and full head with a `running` entry is not started again; a new head is a new review.
This prevents duplicate coordinator-dispatched work only, and is not a lock. Manual commands neither
read nor write that file, so a manual review may overlap an automatic one, or another manual one,
and the possible duplicate costs and verdict races are the crew's to manage.

An ended review counts as a verdict, a refusal that started no model, or a failure that may have
paid for one (`reviewEnding`, in `review-admission.mjs`). Those counts survive a stop and a restart,
and no reset is needed after either. A coordinator that dies during a review leaves its entry
`running`. The next `start`, before launching a coordinator, moves the entry to `ended` with
`interrupted`, which counts as a failure, says which repository, pull request and full head were
interrupted, and carries on. That head is not reviewed again automatically; a manual review of it,
or a new head, is how it gets a verdict. `start` looks for no surviving reviewer, kills nothing and
checks no verdict, so a reviewer that outlived its coordinator may still post a verdict, which the
gate binds to the head reviewed: the crew accepts that risk. A `start` that finds a coordinator
running changes no entry, and `status` and `stop` never do.

Each write of `reviews.json` goes to a temporary file beside it, renamed over it, so a write that
fails leaves the file as it was and the entry `running`, for `start` to move. A coordinator that
cannot read that file, or write to it, admits nothing more and exits. A `start` that cannot read or
update the file names the file, says why and starts nothing, and leaves the coordinator's record and
any stop request as they were. A malformed file, from hand-editing for instance, is refused in this
way until it is fixed or removed.

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
- **No AI attribution in this repository**: no `Co-Authored-By:` trailer in a commit message and no
  "Generated with" line in a pull request body, issue or comment. CI fails a pull request whose
  commits or body carry one (`scripts/dispatch/attribution-check.mjs`), and `.claude/settings.json`
  turns off the attribution Claude Code adds by default. This is steward's own policy. A project
  that uses steward keeps its own: the coder follows that project's instructions, and the pull
  requests ATC opens there carry the `Coder:` provenance line.

### From the crew

The crew is the repository's owner, members and collaborators (`HONOURED_ASSOCIATIONS`,
`scripts/land/check-author.mjs`). Steward picks up a crew member's pull request once it is marked
ready: it is reviewed against [`REVIEW.md`](REVIEW.md), and lands once it passes and CI is green
([`docs/controller.md`](docs/controller.md)), where the project has opted into unattended landing.

### Landing: unattended and manual

There are two authorizations. The `land` setting of `steward.config.json` is the project's standing
permission for unattended landing; `true` is the opt-in. A rotation lands only where it is `true`, and
so does the coordinator ([above](#the-coordinator)). The runway reads it from `main` and merges
nothing unattended where it is `false`, whatever the caller's own settings say. With `land: false`
steward still reviews and posts `review/agent`, and the crew can land a pull request that has passed with `steward land <pr-number>`: one manual
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

Closing the Issue a pull request completes is part of the runway's landing, for a project whose
`unitLinks` includes `issue`. After a merge into `main` succeeds, the runway closes an Issue only
when the pull request body has exactly one `Unit: #<n>` and every closing reference in it, `Closes
#<n>` or another of GitHub's closing keywords, names that same Issue of this repository (repeating
the reference is fine). A bare `Unit: #<n>` closes nothing, and neither does a body with no closing
reference. A closing reference that does not qualify (no `Unit:`, a file or `none` unit, several
`Unit:` lines, a different Issue, or a closing reference to any other Issue besides) closes nothing
and puts a warning, saying why, in the workflow log. A merge into a release branch closes no Issue.
The runway uses the workflow's own `github.token`, which `land-approved.yml` grants `issues: write`
for. If reading or closing the Issue fails, the pull request is still reported as landed and a
warning in the log names the pull request and the Issue: close the Issue by hand. A project that
installed the workflows earlier gets the permission with `steward upgrade`. Closure is never a
condition of merging.

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
