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

- **The batch** is every commit on `main` since the previous release branch was cut from it:
  `git log <base>..origin/main`, where `<base>` is
  `git merge-base origin/main origin/release/<previous>`, and `<previous>` is the newest
  `release/v*` branch on `origin` (`git ls-remote --heads origin "release/v*"`, sorted by version).
  With no release branch yet, the batch is all of `main`.
- **Propose the version.** Steward's versions are semantic versions, `0.x.y` for now: a new minor
  version when anything a project uses has changed (a setting, a command, the example checklist or
  the workflow files), and a new patch version otherwise. The crew decides it.
- **Cut the release branch, on the crew's word**: `release/vX.Y.Z`, from the commit on `main` the
  batch ends at, `git push origin <commit>:refs/heads/release/vX.Y.Z`. Then, also on the crew's
  word, give it the same branch protection as `main`: `test` and `review/agent` required, with
  `enforce_admins` on. Report the branch's commit to the crew.
- From then on the release branch changes only through pull requests into it, reviewed and landed
  through the gate like any other. Nothing is pushed to it directly.

## The walkthrough

- **Its inputs**, as the design doc's "Input assembly" lists them: the pull requests the batch
  merged and the units they link; every `pass-with-observations` verdict on them, read from their
  verdict comments; and every story grounded or deferred during the batch.
- Group the batch by **capability**, as a project using steward meets it, not by pull request or
  story. For each capability: what it does now that it did not before, in plain words, and the
  pull requests that built it.
- **Run it as a project would**, from the release branch. On a scratch repository the crew
  provides: run `init`, then open a test pull request there, and have it reviewed and landed with
  the commands the release documents. Report each command and its result. Until `init` exists,
  the walkthrough is steward's own rotations during the batch, read from their verdicts and
  landings.
- Give each capability one verdict: `accepted`, `accepted-with-followup` or `blocks-release`.
- **A blocker is fixed or deferred.** A fix lands on `main` first, as any `fix` story, written with
  the crew as `planning-session.md` says, and then comes to the release branch as a pull request
  that cherry-picks it. A capability the crew defers leaves the release through a pull request into
  the release branch that reverts it, and stays on `main`. Nothing is tagged while a capability's
  verdict is `blocks-release`.
- **Something more wanted is a new story, not this release.** "This is broken, or does not match
  what we agreed" blocks; "I now want more" does not.

## The release notes

One pull request into the release branch, on a branch `release-notes/vX.Y.Z` with `Unit: none`,
holds the release notes and the version, and nothing else:

- `releases/vX.Y.Z.md`, holding the version; the batch (the commit it starts after and the commit
  the branch was cut at); each capability, its verdict, the pull requests that built it, and any
  follow-up stories; every cherry-picked fix and every deferred capability; and **For projects**:
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
   its tag is fixed by a new patch release, on a new release branch cut from that tag.
3. **Keep the release branch.** It is the release's record, and the next batch is measured from
   where it was cut. Never delete it.
