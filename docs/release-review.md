# The release review

Instructions for the session that reviews what has landed on `main` since the last release, with the
crew, and cuts the next release. It was called Session B until 2026-10-12. Instructions only. The
role, and why it works as it does, are in [`agent-workflow-design.md`](agent-workflow-design.md),
"The release review". [`AGENTS.md`](../AGENTS.md) applies as well, its "Opening a pull request"
section included, and so does [`planning-session.md`](planning-session.md) whenever this session
writes a story. The words are those of [`glossary.md`](glossary.md).

## When it runs

- Only when the crew asks. Nothing schedules it.
- It is not a gate on merging. Rotations and landings go on while it runs.

## Where it runs

- In a git worktree of its own, `steward.worktrees/release`, as `AGENTS.md`, "Opening a pull
  request", places worktrees, at `origin/main` once fetched.

## What it reviews

- **The batch** is every commit on `main` since the last release's tag: the newest tag matching
  `v*` (`git tag --list "v*" --sort=-v:refname`, after `git fetch --tags origin`), then
  `git log <tag>..origin/main`. With no tag yet, the batch is all of `main`.
- **Its inputs**, as the design doc's "Input assembly" lists them: the pull requests the batch
  merged and the units they link; every `pass-with-observations` verdict on them, read from their
  verdict comments; and every story grounded or deferred during the batch.

## The walkthrough

- Group the batch by **capability**, as a project using steward meets it, not by pull request or
  story. For each capability: what it does now that it did not before, in plain words, and the
  pull requests that built it.
- **Run it as a project would.** On a scratch repository the crew provides: run `init` from the
  batch's head, then open a test pull request there, and have it reviewed and landed with the
  commands the release documents. Report each command and its result. Until `init` exists, the
  walkthrough is steward's own rotations during the batch, read from their verdicts and landings.
- Give each capability one verdict: `accepted`, `accepted-with-followup` or `blocks-release`.
- **A blocker is a `fix` story**, written with the crew as `planning-session.md` says. Nothing is
  tagged while a capability's verdict is `blocks-release`.
- **Something more wanted is a new story, not this release.** "This is broken, or does not match
  what we agreed" blocks; "I now want more" does not.

## The release notes

Write them in `releases/vX.Y.Z-rc.md`, holding:

- the version, and the batch: the tag or commit it starts after, and the commit it ends at;
- each capability, its verdict, the pull requests that built it, and any follow-up stories;
- **For projects**: every change a project must act on when it moves to this tag, such as a
  settings key added, changed or removed, a change to the example checklist, a change to the
  workflow files `init` writes, or a command added, changed or removed. Write "None" when there
  is none.

**The version.** Steward's versions are semantic versions, `0.x.y` for now. Propose the next one,
and the crew decides it: a new minor version when anything a project uses has changed (a setting,
a command, the example checklist or the workflow files), and a new patch version otherwise.

## Cutting the release

1. **One pull request** holds the release notes and the version: `package.json`'s `version` and
   `package-lock.json`'s set to `X.Y.Z`, and nothing else. Its branch is
   `release-notes/vX.Y.Z`, and its `Unit:` line is `none`. Open it as a draft, and mark it ready
   only when the crew accepts the whole batch. The controller reviews and lands it.
2. **Tag the commit the runway made** for that pull request, once it has landed and only on the
   crew's word: an annotated tag, `git tag -a vX.Y.Z <commit> -m "steward vX.Y.Z"`, then
   `git push origin vX.Y.Z`. Check it with `git ls-remote --tags origin`, and report its commit to
   the crew.
3. **Never move, delete or push again a tag that has been pushed**, so that a tag names one
   version for good (`agent-workflow-design.md`, Part 3, "Decided so far", "The release review
   cuts a release through the gate, and a tag is never moved"). A release found wrong after its
   tag is fixed by a new patch release.
