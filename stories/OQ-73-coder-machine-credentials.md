---
id: OQ-73
title: Put the owner's stored GitHub token out of a coder session's reach
tier: next
kind: workflow
depends_on: []
model: sonnet
blocked: null
---

## Intent

As the owner of the review gate, I need a spawned coder to be unable to obtain
a GitHub API token from the machine it runs on, not only from its environment,
so that OQ-63's guarantee (a coder cannot set its own `review/agent` status or
dispatch `land-approved.yml`) holds against a coder that goes looking, and not
only against one that happens not to.

## Acceptance criteria

- [ ] **AC-1** — In a session spawned exactly as a coder is spawned
      (`coderEnv` environment, `coderAllowedTools` allowlist), the owner's
      stored `gh` token cannot be read. On the owner's Windows machines that
      token is the Credential Manager entries `gh:github.com:` and
      `gh:github.com:<login>`. A test makes the attempt from a child process of
      `node -e`, which bypasses the tool allowlist entirely, and asserts it
      fails **because the credential is absent or unreadable to that process**,
      not because a command was denied. The test must never print, log or
      assert on the secret's value. Checking that a value came back is enough.
- [ ] **AC-2** — The same holds for any git credential helper that session can
      invoke. `git -c credential.helper=manager credential fill` for
      `https://github.com`, run non-interactively from inside the spawn, returns
      no password. The session's own `-c` override is what makes a global
      config setting insufficient on its own.
- [ ] **AC-3** — The coder can still do its job. It pushes its assigned branch
      over SSH, and `npm test`, `npm run lint` and `npm run build` still run.
      This is demonstrated by a real push of a throwaway branch from inside the
      spawn, not assumed.
- [ ] **AC-4** — The owner's own `gh`, as used by whatever spawns the coder,
      still authenticates afterwards. A fix that works by logging the machine
      out breaks the dispatcher, which needs that credential (see
      `docs/agent-workflow-design.md`, "Credential minimalism").
- [ ] **AC-5** — Every copy of the claim this story finds false says what is
      then true:
      - `docs/agent-workflow-design.md`, "Invocation shape": the paragraph
        ending *"none of those paths can read a token that was never in the
        environment"*
      - `docs/agent-workflow-design.md`, "Credential minimalism": the paragraph
        beginning *"So the coder's credential is scoped rather than removed"*
      - `.claude/prompts/coder.md`, the preamble paragraph headed *"The coder
        holds no GitHub API credential"*, including *"none of them can conjure
        a token that was never in the environment to begin with"*
      - `.claude/prompts/coder.md`, Environment: *"no GitHub API credential is
        reachable from this session"*
      - `REVIEW.md`, "For the coder: opening a PR": *"The coder holds no
        credential capable of a commit status…"*
      - `scripts/dispatch/coder-env.mjs`, the header comment, and `coderEnv`'s
        own doc comment, which leaves *"a credential helper's own storage"*
        untouched on purpose and presents that as safe. After AC-2 it must say
        what keeps that storage out of reach.
      If the `coder.md` heading is reworded, update
      `stories/done/OQ-65-spawn-sessions.md`, which cites it by name. Grep for
      further copies before calling this done.
      The `coder.md` edits go through the emit-a-diff route, because a spawned
      coder cannot write to `.claude/prompts/`.

## Out of scope

- **The reviewer.** OQ-62 is the reviewer's half of this problem, and its AC-3
  already names keyrings and credential helpers. The two will probably share a
  mechanism, and whichever lands second should reuse the first's. This story
  does not deliver OQ-62, and OQ-62 does not wait for it.
- **A second GitHub identity.** That is open question 10 in the design doc and
  is the complete answer to self-marking. This story is narrower. It may choose
  a separate *operating-system* account for spawns, but not a separate GitHub
  account.
- **Other secrets on the machine.** SSH keys, browser sessions and other
  services' tokens are all reachable by a same-user process too. This story is
  about the credential that can clear this repository's gate. Name anything
  else found along the way instead of fixing it.
- **Platforms the loop does not run on.** The loop runs on the owner's Windows
  machines. macOS Keychain and Linux Secret Service have the same shape and
  are not in scope.

## Constraints

- Nothing in the repository may store, cache or print the token, including in
  test output or fixtures.
- The fix cannot be "remove `node` from the allowlist". The coder needs it, and
  OQ-63's reasoning about why a command denial is not containment applies
  unchanged.

## Context

Found on 2026-09-23 while setting up a second machine for the loop.

- **What `coderEnv` does and does not do.** It deletes `GH_TOKEN`,
  `GITHUB_TOKEN` and `GH_ENTERPRISE_TOKEN`, and points `GH_CONFIG_DIR` at an
  empty directory. That stops `gh` from *finding* the owner's login, because
  `gh` looks the login up through its config. It does not stop another process
  from reading the stored token directly. `gh auth status` on the owner's
  machine reports the token as stored in the **keyring**, and `cmdkey /list`
  shows it as the two entries AC-1 names.
- **Believed, not yet demonstrated.** Windows Credential Manager generic
  entries are readable by any process running as the same user (Win32
  `CredRead`), with no prompt. A coder can reach that API by starting
  PowerShell through `node -e`. The first part of AC-1 is to confirm this. If
  it turns out to be false, this story narrows to AC-2 and AC-5, and the
  context here should be corrected rather than dispatched as written.
- **The credential helper half.** Git for Windows configures Git Credential
  Manager system-wide. The second machine's clone initially used an HTTPS
  `origin`, so GCM was the push path. The clone has since been switched to SSH,
  and `credential.https://github.com.helper` was set to empty in the owner's
  global config. That removes the easy path, but not a session's own
  `git -c credential.helper=manager`, hence AC-2. That machine change is setup,
  not a deliverable, and is recorded here so AC-2 is not mistaken for already
  done.
- **Candidate mechanism, not a requirement:** run spawns as a separate local
  Windows account that has the SSH key needed to push and nothing in its
  Credential Manager. That is also the shape the design doc names for the
  reviewer ("a reviewer that runs with no SSH agent, no keyring access and no
  push-capable credential").
- `scripts/dispatch/coder-env.mjs`: `coderEnv`
- OQ-63, in `stories/done/`: the guarantee this story makes true
- OQ-62: the reviewer's counterpart
- `docs/agent-workflow-design.md`, "`GH_TOKEN=""` does not remove a
  credential": a previous instance of a de-credentialing step that looked
  complete and was not

## Open questions

*(none)*
