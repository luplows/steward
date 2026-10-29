# The release review

Instructions for the session that reviews, with the crew, what has landed on `main` since the last
release, and cuts the next release on a release branch of its own. It was called Session B until
2026-10-12. Instructions only. The role, and why it works as it does, are in
[`agent-workflow-design.md`](agent-workflow-design.md), "The release review" and "A release branch
for each release". [`AGENTS.md`](../AGENTS.md) applies as well, its "Opening a pull request"
section included, and so does [`planning-session.md`](planning-session.md) whenever this session
writes a story. The words are those of [`glossary.md`](glossary.md).

## When it runs

- Only when the crew asks. Nothing schedules it.
- It is not a gate on merging. Work on `main` goes on while it runs: the release is reviewed on its
  own branch.

## Where it runs

- In a git worktree of its own, `steward.worktrees/release`, as `AGENTS.md`, "Opening a pull
  request", places worktrees, at `origin/main` once fetched.

## The batch and its branch

A release is cut from `main`, or, as a patch release, from the newest release's tag.

- **The batch of a release from `main`** is every commit on `main` since the previous release branch
  was cut from it: `git log <base>..origin/main`, where `<base>` is `git merge-base origin/main
  origin/<previous>`, and `<previous>` is the newest release branch, such as `release/v0.1.0`: the
  newest by version of those `git ls-remote --heads origin "release/v*"` lists, without their
  `refs/heads/`. With no release branch yet, the batch is all of `main`. A patch release's branch
  meets `main` where the release it repairs does, since its cherry-picks and reverts are new
  commits, so the same command serves after one.
- **It also takes every capability the previous release deferred**: each one the newest release's
  notes list as deferred, with the pull requests that built it. Its commits predate `<base>`, but
  it is still on `main`, and ships in this release unless it is deferred again, so it gets a
  verdict here like any other.
- **A patch release** repairs the newest release once it is tagged, and only when no release
  branch on `origin` is newer than that release's, so that its version is free: its branch is
  `release/vX.Y.(Z+1)`, cut from the tag `vX.Y.Z`. Its batch is only the pull requests into that
  branch: fixes cherry-picked from `main`, and reverts. An older release is not repaired; the next
  release replaces it.
- **Propose the version.** Steward's versions are semantic versions, `0.x.y` for now: a new minor
  version when anything a project uses has changed (a setting, a command, the example checklist or
  the workflow files), and a new patch version otherwise. The crew decides it.
- **Cut the release branch, on the crew's word**: `release/vX.Y.Z`, from the commit on `main` the
  batch ends at, `git push origin <commit>:refs/heads/release/vX.Y.Z`, or, for a patch release,
  from the tag's commit, `git push origin "vX.Y.Z^{commit}:refs/heads/release/vX.Y.(Z+1)"`.
  Then, also on the crew's word, give it the same branch protection as `main`: `test` and
  `review/agent` required, with `enforce_admins` on. Report the branch's commit to the crew.
- From then on the release branch changes only through pull requests into it, reviewed and landed
  through the gate like any other. Nothing is pushed to it directly.
- **No pull request into a release branch changes anything under `stories/`.** Stories are written
  and moved on `main`: a fix's story is not on the release branch, and a deferred capability's
  story stays done on `main`.

## The walkthrough

- **Its inputs**, as the design doc's "Input assembly" lists them: the pull requests the batch
  merged and the units they link; every `pass-with-observations` verdict on them, read from their
  verdict comments; every story grounded or deferred during the batch; and every capability the
  previous release deferred.
- Group the batch by **capability**, as a project using steward meets it, not by pull request or
  story. For each capability: what it does now that it did not before, in plain words, and the
  pull requests that built it.
- **Run it as a project would**, from the release branch. On a new scratch repository the crew
  provides, with a first commit on `main` pushed to its GitHub `origin`: run `init --ref <commit>`,
  where `<commit>` is the release branch's last commit (`git rev-parse origin/release/vX.Y.Z` once
  fetched), so that the workflow files it writes install steward at that commit, since the tag does
  not exist yet (ST-44). `init` pushes a branch and opens the installation as a draft pull request;
  use the supported Git environment in the README's installation guidance. Installation hooks
  are disabled; run necessary project-specific checks and disclose that bypass before approval.
  Mark it ready and merge it by hand, as nothing has reviewed it (the gate cannot review the pull
  request that installs it), and run `steward protect` in the scratch repository's checkout, from
  steward installed at the same `<commit>`
  (`npx --yes --package=github:luplows/steward#<commit> steward protect`). Then open a test pull
  request there, and have it reviewed and landed, with protection set, with the commands the
  release documents. Report each command and its result, `protect`'s included. Run it again at the
  new last commit whenever a fix or a revert lands into the release branch, on another new scratch
  repository: `init` leaves a file that already exists as it is, so it would not repin the first
  one's workflows (ST-44). The tag's commit differs from the last one walked through only by the
  notes and the version.
- Give each capability one verdict: `accepted`, `accepted-with-followup` or `blocks-release`.
- **A blocker is fixed or deferred.** A fix lands on `main` first, as any `fix` story, written with
  the crew as `planning-session.md` says, and then comes to the release branch as a pull request
  that cherry-picks its changes outside `stories/`. Its body links the same unit as the fix's pull
  request, which ATC reads from `main` whatever the base, as it does the checklist (ST-45). A
  capability the crew defers leaves the release through a pull request into the release branch
  that reverts its changes outside `stories/`, with `Unit: none` and the pull requests it reverts
  named in its body, and stays on `main`. Nothing is tagged while a capability's verdict is
  `blocks-release`.
- **Something more wanted is a new story, not this release.** "This is broken, or does not match
  what we agreed" blocks; "I now want more" does not.

## The release notes

One pull request into the release branch, on a branch `release-notes/vX.Y.Z` with `Unit: none`,
holds the release notes and the version, and nothing else:

- `releases/vX.Y.Z.md`, holding the version; the batch (the commit it starts after and the commit
  the branch was cut at, or, for a patch release, the tag it was cut from); each capability, its
  verdict, the pull requests that built it, and any follow-up stories; every cherry-picked fix;
  every deferred capability, with the pull requests that built it: those deferred from this
  release, and, for a patch release, those its tag's notes list; and **For projects**:
  every change a project must act on when it moves to this tag, such as a settings key added,
  changed or removed, a change to the example checklist, a change to the workflow files `init`
  writes, or a command added, changed or removed. Write "None" when there is none.
- `package.json`'s and `package-lock.json`'s `version` set to `X.Y.Z`. `main`'s stays `0.0.0`:
  `main` is never released directly.

Open it as a draft, and mark it ready only when the crew accepts the whole batch. The controller
reviews and lands it, last of the pull requests into the release branch.

## The tag

1. **Tag the release branch's last commit**, once the notes have landed and only on the crew's
   word: an annotated tag, `git tag -a vX.Y.Z <commit> -m "steward vX.Y.Z"`, where `<commit>` is
   `origin/release/vX.Y.Z` once fetched, then `git push origin vX.Y.Z`. Check it with
   `git ls-remote --tags origin`, and report its commit to the crew.
2. **Never move, delete or push again a tag that has been pushed**, so that a tag names one
   version for good (`agent-workflow-design.md`, Part 3, "Decided so far", "The release review
   cuts each release on a release branch, and a tag is never moved"). A release found wrong after
   its tag is fixed by a patch release, as "The batch and its branch" says, or, when it is no
   longer the newest, by the next release.
3. **Keep the release branch.** It is the release's record, and the next batch is measured from
   where it was cut. Never delete it.
