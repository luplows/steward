---
id: ST-56
title: Open a reviewable installation pull request from init
tier: next
kind: product
depends_on: [ST-55]
model: null
blocked: null
---

## Intent

As a developer installing steward into an existing GitHub project, I want `steward init` to
commit its installation on a separate branch and open a reviewable pull request, so that the
crew can inspect and adopt it without manually assembling the commit and pull request.

## Acceptance criteria

- [x] **AC-1** — **Preflight before effects.** Before creating files, labels, user config,
      a branch or a PR, resolve the checkout and its GitHub `origin`, authenticate, fetch
      `origin/main` and capture its full commit SHA as the installation base. Accept a feature
      branch, detached HEAD or checkout behind/ahead of that base, and unrelated staged,
      unstaged, untracked or ignored work. An in-progress merge/rebase alone is not a refusal;
      AC-1a defines the relevant conflicts. Never stage, stash, reset, clean, rebase, commit or
      overwrite the caller's work. Refuse an unreadable/unborn HEAD or invalid checkout with
      exit 2, naming the reason and actionable remedy. Missing/non-GitHub origin,
      missing `main`, invalid flags/answers, and unanswered non-interactive questions also
      refuse before effects. Failed authentication/network requests exit 1, without claiming
      a missing repository or a successful installation. Fetching refs is allowed in preflight.
      AC-1b's unsupported-Git-environment refusal must happen before any fetch or worktree creation.
- [x] **AC-1a** — **Relevant local conflicts.** Before effects, derive installation targets
      and template selection from the captured base and explicit answers, not the caller's
      feature files. Relevant paths are `steward.config.json`, the checklist path selected
      from the base settings or new-install answers, the gate/runway workflows, inspection's
      workflow when requested, and every PR-template file/directory location discovered by
      the existing template finder (including locations where adding/removing a template
      would change discovery). Include ancestor paths whose type or symlink changes affect
      access to those paths. Inspect committed caller changes since its merge base with the
      captured base, staged changes relative to HEAD, unstaged changes relative to the index,
      and untracked/ignored entries. Refuse with exit 2 if any such change affects a relevant
      path, including an addition, modification, deletion, either side of a rename, type change,
      symlink or unmerged index entry. Check each layer independently: a staged change undone
      in working files still counts. Upstream-only changes since the merge base do not count
      as caller changes. With no common ancestor, compare caller HEAD directly with the base
      for relevant differences. Name each conflict and advise resolving it or using another
      checkout; never suggest discarding unrelated work. Refuse if the comparison cannot be
      completed reliably. Never copy local versions into the installation worktree or silently
      ignore a relevant conflict, including on the no-diff path or with a supplied PR body.
- [x] **AC-1b** — **Explicit supported-Git-environment boundary.** Before fetching or
      creating any file, label, user config, branch, worktree or PR, inspect the
      effective Git configuration and Git-related environment affecting the caller checkout.
      For 0.1, refuse (exit 2) with the unsupported key/source and a concrete way to run in
      a simpler checkout if **any** `url.*.insteadOf` or `url.*.pushInsteadOf` rule is
      configured, even one that appears unrelated to `origin`; never try to validate just a
      single step of a possibly chained rewrite. Also refuse any `remote.origin.pushurl`
      (including multiple values), enabled per-worktree config (`extensions.worktreeConfig`
      or a repository `config.worktree`), any relative `core.hooksPath` or hooks path
      resolving inside a Git metadata directory, and inherited `GIT_*` environment
      variables that can alter repository discovery, configuration, transport, identity or
      hooks. Unknown or uninspectable effective configuration refuses rather than
      assuming an ordinary origin. The preflight must bind `origin` to one unambiguous
      GitHub repository and ensure the fetch and create-only push have that same destination;
      never re-feed a once-rewritten URL into Git as if it were the unchanged original.
      Tests cover chained `insteadOf`, `pushInsteadOf`, multiple `pushurl` values,
      per-worktree config, relative `.git/hooks` in both ordinary and linked worktrees,
      inherited Git overrides, and an ordinary valid GitHub origin; every refusal produces
      no mutation and no network write.
- [x] **AC-2** — **One isolated installation branch.** Work in a new worktree beside the main
      checkout, under `<checkout>.worktrees/`, from that captured base SHA. Default branch:
      `steward/install`; `--branch <name>` permits the project's naming convention. Validate
      the name as a git branch, refuse `main` and `release/` names, and refuse any existing
      local or remote branch of that name, including one checked out in another worktree.
      Look for an existing open PR with that exact repository/head/base and print its URL on
      refusal. Do not reuse, move, append to, delete or force-update an existing branch or PR.
      The initial push must atomically require that the remote branch does not exist, so a
      concurrent installer cannot overwrite it. Use a hook-disabled Git environment for the
      installation worktree beginning with `git worktree add`, not only for the commit;
      a post-checkout hook must not create installation targets before they are inventoried.
      Leave the caller's HEAD, branch, index and working files unchanged on success and every
      failure.
- [x] **AC-3** — **Only the installation diff.** Preserve the installer's create-only file
      writes and reporting of files left alone, pinned workflows and optional inspection.
      Only repository files newly created by this invocation may be staged and committed:
      `steward.config.json`, the chosen checklist, the thin gate/runway/optional inspection
      workflows, and a PR template only when none exists. Stage explicit paths, never `add -A`.
      Record each path and generated byte content this invocation actually created. Reject a
      pre-existing path or one created by any other process after the worktree was prepared;
      do not adopt it as a generated file. Before commit and push, verify the installed worktree
      and staged tree match that recorded inventory byte-for-byte, and check that the resulting
      commit's diff against the captured base contains only those additions with their generated
      contents. Unexpected or substituted edits stop the operation.
      An ignored or otherwise local-only file at an installation target in the caller's
      checkout causes a named preflight refusal, rather than being overwritten, copied or
      silently replaced by a generated version in the worktree. Never overwrite a tracked
      file, repin an existing workflow or import unrelated local commits/files into the PR.
- [x] **AC-4** — **Existing and partial installations.** For a partially installed base, add
      only missing files and report every preserved file, even if its contents are invalid or
      different from the package's. If `steward.config.json` exists, read only its `rulesFile`
      to choose the checklist target; validate that path with the existing rules-file path
      validator. Refuse malformed JSON, a missing/invalid `rulesFile`, or a conflicting explicit
      `--rules-file`, before effects, rather than silently writing an unused checklist.
      Preserve the settings bytes and chosen `land` value. When no repository files are
      missing, exit 0 saying no installation PR is needed; create no branch, empty commit,
      push or PR. Existing label/user-config provisioning may still finish, with its
      normal preservation rules. Rerunning after a merged installation is this no-diff case;
      rerunning while its branch exists is AC-2's refusal, with no duplicate PR.
- [x] **AC-5** — **Create and report the draft PR.** For a nonempty verified diff, make one
      installation commit, push only the new branch to `origin`, then create one **draft** PR
      against `main` in that same repository. Print the repository, branch, base, full commit
      SHA and returned PR URL. Do not report completion until GitHub confirms the PR and its
      draft state. For 0.1, an accepted ordinary commit identity has effective Git
      `user.name` and `user.email` both present and nonblank; `commit.gpgSign` must be absent
      or effectively `false`. Refuse an absent/blank identity, unreadable signing setting or
      enabled `commit.gpgSign` (including `true` expressed through Git's accepted boolean
      forms) **before effects**, naming the key and a remedy. Configured signing keys or GPG
      tool paths are permitted when signing is disabled, because they do not sign this commit;
      no identity/signature override is supplied, no new author or attribution is invented,
      and Git's effective identity is used. **Disable all Git hooks in the installation
      worktree**, including checkout and commit hooks, by using a known empty hooks location
      for every installer-owned Git operation; never disable hooks in the caller's checkout.
      Always explain the bypassed installation hooks in command output so the crew can run
      necessary project-specific checks before approving. Include the disclosure in the
      **generated** PR body; AC-6 governs an explicitly supplied verbatim body instead.
      Keep the finished branch;
      remove only the invocation's clean worktree after confirmed success.
- [x] **AC-6** — **Write the body as the project expects.** Use the existing project PR
      template as the body skeleton, retaining its headings and project-specific prompts.
      With one template select it; with several, require `--pr-template <repository-path>`
      naming one discovered template (an interactive question with no default, or a flag;
      `--yes` cannot choose for the crew). An empty template directory counts as no usable
      template and is reported. With no usable template, use the package's template.
      Populate the body with the generated-file list, preserved-file list, steward version or
      explicit pin, actual installer checks and their outcomes, and remaining crew actions.
      Fill the standard What changed, Verification and Docs check sections when present;
      otherwise include these facts in a clearly labelled installation summary within the
      chosen skeleton. Do not claim tests ran, that preserved files were validated, or that
      an existing installation is compatible. Identify project-specific requirements the
      deterministic installer cannot complete as crew follow-up before readiness; do not
      invent issue links, story IDs or completed work. Offer `--pr-title <text>` and
      `--pr-body-file <path>` overrides; read the latter before effects and use its contents
      verbatim, without requiring steward's headings or a `Unit:` schema. With
      `--pr-body-file`, never append the hook disclosure to the supplied body or refuse it
      solely because the disclosure is absent. Instead, print the hook-bypass disclosure
      and a specific instruction to add it to the PR body before marking the installation
      ready; report this outstanding crew action even when the supplied body has no such
      wording. Template selection applies only without a supplied body; that override
      needs no template choice. The default
      title is `Install Steward review gate`. In the generated body, fill an existing `Unit:` line
      with `none` and flag it for crew confirmation; preserve a supplied body's unit link.
      Do not edit an existing project template or impose steward's story format.
- [x] **AC-7** — **Bounded failures with recoverable evidence.** A write, hook, commit, push,
      label, user-config or PR-creation failure exits 1 and stops subsequent mutations.
      A leftover or colliding temporary user-config file that this invocation did not create is
      **never deleted, overwritten or claimed as owned**; report the collision and refuse
      provisioning without falsely returning “user config already exists” or success when the
      intended settings file is absent. Check that the intended target is actually present
      and valid before calling settings provisioning successful.
      Report the failed phase and every resource already created: worktree, local branch,
      commit, remote branch, PR URL if known, labels and user-config path. Keep unfinished
      work for inspection, with concrete instructions to finish the push/PR by hand or inspect
      GitHub before retrying an ambiguous network result. Never retry a mutation blindly,
      delete remote work, remove user work, or roll back labels or user config. A rerun
      does not infer ownership of an existing branch from its name. Labels and the user config
      remain explicitly reported effects outside the PR; neither is claimed atomic
      with it. Install nothing into a project's dependencies and run no project setup/check.
- [x] **AC-8** — **Adoption and activation remain separate.** Keep ST-55's new-install
      review-only default, explicit unattended opt-in, existing-setting preservation and
      explanation of ST-54's manual gated landing path. Never start a reviewer, coder,
      rotation, coordinator or scheduler, register/enable a project locally, request landing,
      enable auto-merge or alter branch protection. Output and generated PR body explain that
      the crew reviews and merges the installation through the project's existing process;
      a fresh install cannot review itself under the gate it introduces. Where a gate already
      exists, its existing rules still apply: init bypasses none. Merging grants no local
      execution permission. Recommend optional `steward protect` only after adoption; do not
      invent or run an activation command that has not been delivered.
- [x] **AC-9** — **Evidence and documentation.** Add Vitest cases named `ST-56/AC-N` using
      temporary real git repositories/worktrees and a bare remote, with GitHub and user config
      injected. Show successful installation from clean main, ahead/behind/divergent
      feature branches and detached HEAD with unrelated committed or staged/unstaged/untracked/
      ignored work; include unrelated in-progress merge/rebase state. Prove the installation
      commit's parent is the captured fetched base and caller HEAD/index/files stay unchanged.
      Refuse relevant conflicts in each AC-1a layer, including deletion, rename source and
      destination, type/symlink changes, unmerged entries and cancelling index/worktree edits.
      Cover upstream-only differences, no common ancestor, comparison failure, ignored target
      collisions, template-discovery changes, no-diff conflicts and local/remote branch collisions,
      a racing push, malformed/conflicting partial settings, preservation of custom rules and
      true/false authorization, a partial addition, no-diff rerun, and failures at each mutation
      phase. Use a two-stage Git URL rewrite that redirects an apparently valid `origin` on its
      second application, a linked-worktree `.git` file with `core.hooksPath=.git/hooks`, a
      `post-checkout` hook creating the checklist, and an unowned `config.json.<pid>.tmp`
      collision to prove the new refusals and ownership checks. Include positive evidence that
      valid `user.name`/`user.email` with unset or false `commit.gpgSign` succeeds even
      when an unused signing key is configured; missing identity and enabled signing refuse
      before effects. Verify generated PR bodies disclose skipped hooks, and a supplied
      `--pr-body-file` lacking the disclosure is preserved byte-for-byte while command
      output explicitly reports both the bypass and the crew action. Assert exact commit/diff
      contents, draft PR arguments/body, no mutation after failure and unchanged caller state. Cover one/multiple/empty templates and both overrides.
      Update the old no-commit/no-push and labels-only assertions to test this bounded contract;
      retain the independent overwrite, pinning, template, settings and protection safeguards.
      Tests send no real GitHub writes or agent invocations. Update README installation guidance,
      command help, affected project-settings and user-config guidance, and release-walkthrough
      instructions. Resolve every **Planned** marker naming ST-56 in `docs/` to the
      delivered behaviour.

## Out of scope

- Implementing or revising ST-54's manual landing authorization, ST-55's defaults, or ST-53's
  waiting policy. This story consumes them and changes only installation delivery.
- Coordinator activation, discovery, scheduling, stop/status controls, coding or fixing.
- Arbitrary base branches, fork/upstream PRs, non-GitHub installation, upgrades, repairing or
  migrating existing files, repinning, or automatic recovery/reuse of an existing branch.
- Parsing project planning prose, migrating unit conventions, creating adoption issues or
  stories, adding CI, running a client's tests, or installing in client repositories now.
- Merging the installation, granting a gate exception, setting protection, **running hooks in
  the installer-owned worktree**, adding credentials/secrets, or changing the user-config
  schema. Supporting complex URL rewrites, pushurl, per-worktree Git configuration, repository
  environment overrides, **enabled commit signing**, or custom hook execution is separate
  future compatibility work.

## Constraints

- Node 24, ESM, no new runtime dependencies or model calls. Keep git operations as argument
  arrays without shell interpolation; scope the GitHub request allowlist to the installation's
  repository and operations. No push to main, release branches or tags, and no force overwrite.
- Existing files remain create-only. The narrow read of an existing project's `rulesFile`
  selects its native checklist; it does not migrate settings or validate preserved file content.
- Any rejection of unsupported Git configuration is a **read-only preflight refusal**; never
  “normalize” or repair the caller's repository configuration. Hook bypass is restricted to the
  installer-owned worktree and must not be represented as running the project's commit checks.

## Context

- Crew request, 2026-10-26: init creates a reviewable installation PR; write its body as the
  project expects. Design doc, "Installation through a reviewable pull request"; roadmap 0.1.
- Crew decision, 2026-10-27: allow unrelated local work and feature branches; the captured
  fetched base and relevant-path checks protect installation without requiring a clean caller.
- `scripts/dispatch/init.mjs`: `run`, `writeNew`, `findPullRequestTemplates`, `ensureLabels`,
  `createInitContext` and `assertAllowedRequest`; current git calls only read root/origin.
- `scripts/dispatch/init.test.mjs`: ST-44's overwrite, pinning, user config and no-commit
  tests; ST-50's protection exclusions and closing-message tests. No PR is created today.
- `scripts/dispatch/rules-file-path.mjs`: existing checklist-path validation.
- ST-55 precedes this story, and ST-54 precedes ST-55. ST-55's no-commit constraint applies
  to its own implementation; this story deliberately supersedes that delivery contract later.
  Neither story's acceptance criteria or stable IDs are changed here.
- Crew decision, 2026-10-27, following three blocked reviews of implementation PR #92:
  narrow ST-56 from arbitrary Git-configuration compatibility to an explicit, observable
  supported subset. Prefer refusing complex remotes, worktree configuration, hooks and
  environment overrides over trying to prove them safe through one-step stand-in checks;
  installer-owned hooks are intentionally disabled and must be disclosed. Keep the useful
  independent caller-work protections in AC-1a.
- Size: one installer transaction and its refusal/reporting paths. Keep recovery manual and
  existing branches immutable to avoid a second resume/ownership mechanism in this story.

## Open questions

*(none)*
