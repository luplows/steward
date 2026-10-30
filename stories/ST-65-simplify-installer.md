---
id: ST-65
title: Simplify init's installation to a bounded threat model, made in a fresh clone
tier: normal
kind: product
depends_on: [ST-56]
model: null
blocked: null
---

## Intent

As a member of the crew installing steward in a project, I want `init`'s installation pull request
to be made by a small installer whose safety promises are bounded and stated, so that it can be
read, reviewed and maintained, and so that a review can finish it rather than find one more case.

## Acceptance criteria

Provisional: these are written for the crew to settle with the Open questions below, and may
change before the story is ready.

- [ ] **AC-1** — **A fresh clone, not the caller's repository.** `init` makes the installation in
      a new clone of the checked GitHub `origin` URL, in a temporary directory this invocation
      creates and owns. It adds no worktree, branch, ref or configuration to the caller's
      repository, and runs no `git fetch` there. Tests show the caller's `.git` directory
      unchanged after a successful installation, a no-diff run and a failed push.
- [ ] **AC-2** — **A stated threat model.** The installer's safety promises cover one member of
      the crew running one installation from an ordinary checkout. What it does not cover is
      named in `docs/agent-workflow-design.md` and in this story's Out of scope. Every refusal
      the installer keeps names the case it guards and the remedy.
- [ ] **AC-3** — **Code made unnecessary is removed.** Each safeguard and its tests that exist
      only because the installation shared the caller's repository are removed. The pull request
      body lists each one removed, with the reason the clone makes it unnecessary, and gives the
      before and after line counts of the `init` modules and their tests.
- [ ] **AC-4** — **Behaviour kept.** Every behaviour of ST-56 inside the threat model is kept and
      still tested under its `ST-56/AC-N` name: the fetched base, additions only, existing files
      and `land` preserved, the no-diff exit 0, the template-based body, the create-only push,
      the draft pull request, and the failure report with retained evidence.
- [ ] **AC-5** — **Documentation.** `README.md`, `init`'s help and the design record describe the
      clone and the threat model, and every **Planned (ST-65)** marker is resolved.

## Out of scope

- Any new safeguard beyond those AC-2's threat model names.
- Concurrent installers on the same branch name beyond the create-only push and the open pull
  request check; another local process changing the clone while `init` runs; adversarial global
  or system Git configuration; filenames the platform cannot check out. To be confirmed by the
  crew (Open questions).
- Activation, the coordinator, protection and landing, which stay as ST-55, ST-56 and ST-57 left
  them.

## Constraints

*(none)*

## Context

- ST-56 (`stories/ST-56-init-installation-pr.md`; #92) installs through a worktree of the caller's
  repository. Its AC-1b, AC-2, AC-3 and AC-5 promise safety across the caller's Git environment
  and against concurrent processes. #92 was blocked nine times through head `628288a`, each time
  on a new case inside those promises: remote names shaped like URLs, replacement refs, ignored
  files at cleanup, publishing a mutable ref, commented template headings, pathspec magic and a
  same-SHA push race.
- At `628288a`, #92 adds 5843 lines and removes 535 across 18 files
  (`git diff --shortstat origin/main...628288a`). `scripts/dispatch/init.mjs` is 1376 lines and
  `scripts/dispatch/init-install.mjs` 870; `scripts/dispatch/init-install.test.mjs` alone is
  2072.
- `docs/agent-workflow-design.md`, "Installation through a reviewable pull request", and the
  ST-56 revision of 2026-10-27 above it, record the current contract and what the crew narrowed
  then.
- `docs/planning-session.md`, "Writing it": a safety AC names a bounded threat model (added with
  this story).

## Open questions

- **Clone or worktree.** Answered in part (crew, 2026-10-30): "init sets up a clean worktree and
  goes from there", and a clean checkout of its own is acceptable too. The planning session
  recommends the clone: a worktree, however clean, shares the caller's `.git` (its configuration,
  refs, replacement refs, hooks and worktree bookkeeping), through which most of #92's blocks
  came, while a clone has its own and only global and system Git configuration
  (`url.*.insteadOf`, `init.templateDir`, credential helpers) still reach it. Still to confirm:
  the clone, as AC-1 drafts it, or a clean worktree, with AC-1 rewritten.
- **The threat model's exact bounds.** Proposed, for the crew to confirm: the installer only adds
  files and opens a draft pull request, which the crew and the gate review before anything lands,
  so it need prove no more than that. In scope: one member of the crew running one `init` from
  an ordinary checkout, with clear refusals for a wrong directory, existing files, an existing
  installation branch or pull request, an `origin` that is not one GitHub repository, a URL
  rewrite that sends `origin` elsewhere (it would still reach a clone), missing identity or
  enabled signing, and a failure part-way, which keeps its evidence. Out of scope: the
  exclusions listed under Out of scope.
- **AC-1a.** Proposed, for the crew to confirm: no check of the caller's checkout beyond reading
  its root and `origin`. The installation is made from the fetched `origin/main` in its own
  clone and touches none of the caller's files, so a refusal on uncommitted changes adds
  friction and code and protects nothing. The closing output says the installation was made from
  `origin/main` at its SHA and that the checkout was not changed.
- **When.** The crew is inclined to 0.2 (2026-10-30), and decides once #92's place in the release
  is settled. Whether #92 lands first, as `depends_on` says, follows from that.
