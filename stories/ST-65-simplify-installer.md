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
  or system Git configuration. To be confirmed by the crew (Open questions).
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

- **Clone or worktree?** A fresh clone avoids the caller's local configuration, replacement refs,
  per-worktree configuration, hooks and worktree bookkeeping. Global and system Git configuration
  (`url.*.insteadOf`, `init.templateDir`, credential helpers) still reach a clone. Does the crew
  want the clone, with `GIT_CONFIG_NOSYSTEM` and an empty `init.templateDir`, or a narrower
  worktree contract?
- **The threat model's exact bounds.** Which of AC-2's exclusions does the crew confirm, and
  which refusals stay (for example URL rewrites, which still change where a clone fetches from)?
- **AC-1a.** With the installation in a clone, should `init` still refuse relevant uncommitted
  changes in the caller's checkout, so the crew is not surprised, or ignore the caller's
  checkout apart from reading `origin`?
- **When.** Is this for 0.1, after #92 lands, or later? Should #92 land first, as `depends_on`
  says, or should ST-56 be narrowed to this instead?
