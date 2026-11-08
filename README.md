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
  `main` is protected and requires `test` and `review/agent`. `review-gate.yml` and
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
start the coordinator ([below](#the-coordinator)), which reviews and never lands.

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

It reads the project's `main` and steward from GitHub, and clones nothing until it has decided (choosing
the project's pull request template, with `--pr-template`, needs the clone's files: that refusal, if any,
leaves the clone, which it names).
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

The pull request's body names the installed and target pins, and whether the target is a release or
a commit with the version its `package.json` gives, the files changed, the validation, anything
left for the project to decide, and the steps after merging. The command does not merge, mark ready,
change protection, activate the project, or start or stop the coordinator. Once the crew has
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

### The coordinator

The coordinator is one long-running process per OS user, across that user's terminals and
activated projects, that schedules their automatic reviews until it is stopped, and discovers the
pull requests unattended landing may consider. It reviews and discovers, nothing more: it never
lands, runs the runway or a rotation, inspects, or starts a coder or a fixer, whatever a project's
`land` says, and verdicts go through the existing gate.

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
scan's candidates are in the record and shown by `status`. Nothing lands from them yet: a later
story hands them to the pilot, whose checks and the runway's keep the final say. The intervals make
scans due; they do not run beside a review. Review turns and scans run one after another, so a
review that outlasts a due time delays that scan until the turns have finished, and the idle
wake-up is the earlier of the two due times.

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

`status` starts nothing and changes nothing. It reports `running`, `stopping` or `stopped`, with
the process id and start time when there is a record, and `--json` prints the same as one JSON
object. For a running coordinator it adds what the coordinator wrote to its record as these changed:
the review under way, with its project, pull request and full head, the effective intervals, the next
scan when known, the landing candidates last found, the last outcome, and the usage and failure reasons above. It also lists, from
`reviews.json`, the heads not reviewed again automatically, or says that file cannot be read. A
write of these fields that fails is not fatal: the coordinator carries on, and what it writes next
replaces them, so `status` can be behind until then. The record's only other writes are at the start
and on a stop. On Windows a write can be refused while another process is reading the file, so a
`start` that is watching for the record can occasionally cost the first scan's note of the next
scan.

`stop` leaves a stop request, `~/.steward/state/coordinator.stop`, which the coordinator looks for
a few times a second. On seeing it, the coordinator admits no more work, and that is the
acknowledgement `stop` waits for. With no admitted work running, the coordinator removes its record
and exits, and `stop` reports `stopped`. Otherwise `stop` returns at once, reporting `stopping`,
without waiting for that work; the coordinator removes its record and exits once the work has
finished, and `status` then reports `stopped`. Running `stop` again, or when nothing is running, is
harmless. A graceful stop terminates nothing, and is not the shared emergency stop (E-stop) planned
before 1.0, which will terminate running work and block new commands.

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
