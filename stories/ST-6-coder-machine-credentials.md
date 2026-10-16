---
id: ST-6
title: "Spike: find out how to run coder and reviewer sessions where the crew member's credentials and files cannot be reached"
tier: next
kind: spike
depends_on: [ST-30]
model: sonnet
blocked: "Owner-run with the planning session, not dispatched (owner, 2026-10-09; design doc, R4 and R5)."
---

## Intent

As a member of the crew, I want to know, from trials on my own machine rather
than from reading, whether and how a coder session and a reviewer session can
run where they hold only the work and the agent tool's login, so that the
stories that put them there are written from what works. The guarantee they
serve: a spawned session cannot obtain a GitHub token or use an SSH key from
the machine it runs on, and cannot write outside its own checkout, because
those are unreachable, not because a command was denied. **This is a spike.
Its output is written findings, a recommendation and the stories it
recommends, as drafts, not code.** It is run by the owner with the planning
session, by hand, not dispatched.

## Acceptance criteria

- [ ] **AC-1** — **Only findings and draft stories are committed.** The
      pull request's diff changes `docs/agent-workflow-design.md`, adds the
      stories AC-4 recommends, and moves this story to `stories/done/` with
      its ticks, and nothing else. Any script, image definition or
      configuration used for the trials lives outside the repository's tree
      and is not committed. Its full text is given in the pull request body.
- [ ] **AC-2** — A new subsection under "Platform constraints" in
      `docs/agent-workflow-design.md`, titled "Sessions that cannot reach the
      crew member's credentials", records the trials. For each trial it gives:
      - the mechanism and its version, and the host's Windows version;
      - the image or configuration the trial ran, by its text in the pull
        request body;
      - the command run, and what came back, quoted verbatim;
      - for timings, the same step's time on the host.
- [ ] **AC-3** — The trials answer each of these, and the subsection states
      each answer next to the trial that shows it:
      - **Q1, the mechanism:** what it took on the owner's machine to set up
        each mechanism tried (AC-3a), and which steps needed an administrator.
      - **Q2, the agent tool:** does a session started with
        `buildInvocation`'s arguments, for the coder and for the reviewer
        (`claude -p`), run under the mechanism and return its JSON result?
        Which file or variable of the agent tool's login has to be passed in,
        and what else does that expose to the session?
      - **Q3, the work:** can the coder commit on its branch? A git worktree's
        `.git` file holds an absolute host path: what breaks, and what fixes
        it?
      - **Q4, the checks:** do `npm ci`, `npm test`, `npm run lint` and
        `npm run build` run, and how long does each take against the host?
        For a container, with `node_modules` on a bind mount and on a volume.
      - **Q5, the credential:** for each role, from a `node -e` child, can the
        Windows Credential Manager entries `gh:github.com:` and
        `gh:github.com:<login>` be read? Does
        `git -c credential.helper=manager credential fill` for
        `https://github.com` return a password? Can the owner's SSH agent or
        `~/.ssh` be used, so that `git push` to `origin` over SSH succeeds?
        Each check asserts only whether a value came back, or whether the
        push was refused for want of authorisation.
      - **Q6, ATC:** with the session run through the mechanism, does
        `spawn.mjs` still see its streamed output (the stall check, OQ-76),
        and does a timeout or kill stop it? Is anything left running
        afterwards?
      - **Q7, the reviewer's checkout:** can the reviewer be given its
        checkout read-only, and still run the project's tests?
      - **Q8, local files:** for each role, from a `node -e` child, can the
        session create a new empty file in the controller's worktree, beside
        `~/.claude/settings.json`, and beside `~/.gitconfig`? Each check
        creates only a new empty file, and deletes it when it was created.

      If a question cannot be answered, the subsection says so and why. That
      AC is then ticked only if the reason is stated.
- [ ] **AC-3a** — The trials try each of these mechanisms, or the subsection
      says why one was not tried:
      - a container, in the runtime chosen under Open questions;
      - WSL2, with Claude Code's sandboxed Bash tool turned on;
      - a low integrity level for the session on the host, with the session's
        own writes redirected into its scratch directory;
      - a separate Windows account.
- [ ] **AC-4** — The subsection ends with a **Recommendation**: the mechanism
      chosen, and the stories that build it for each role, in order, naming
      the trial each rests on, and which story takes over OQ-101's dependency
      on OQ-73. The pull request adds each of those stories as a draft, under
      `stories/` with the next unused `ST-<n>`: its intent, the acceptance
      criteria it proposes, and under Open questions what the crew is to
      decide before it is refined. Between them they carry every guarantee
      check listed under Context.
- [ ] **AC-5** — No **Planned (ST-6)** marker is left at this pull request's
      head: each in `docs/agent-workflow-design.md` names, in place of ST-6,
      the drafts AC-4 adds that take over its passage. The story lint fails on
      a marker naming a story in `stories/done/`, and accepts one naming a
      draft.

## Out of scope

- **Building it**: any change to code, prompts, tests, settings or workflows,
  `coder-env.mjs`, `invocation.mjs` and `spawn.mjs` included. That is the
  stories AC-4 recommends.
- **Refining the drafts**, making any of them ready, and having other
  stories, ST-27 among them, cite the drafts in place of ST-6. That
  is the planning session's, with the crew, once this has landed. CI's
  containment check (`scripts/dispatch/story-containment.mjs`) lets this pull
  request add new stories as drafts, but change no story that exists.
- **Changes to the owner's machine** made by anyone but the owner. Installing
  or configuring a mechanism is the owner's, by hand, and Q1 records it.
- **A second GitHub identity** (the design doc's open question 10).
- **Other secrets beyond those Q5 and Q8 name.** Name anything else found
  reachable instead of pursuing it.
- **macOS and Linux hosts.** The trials run on the owner's Windows machine.
  The findings say what was not tried.
- **Detecting a change to the controller's worktree** during a rotation. That
  is ST-25's AC-5b, and `docs/controller.md`, "Reporting and stopping", until
  ST-25 is built.

## Constraints

- Nothing may store, cache or print the token, the SSH key or the agent tool's
  login, including in the pull request body or the design doc.

## Context

Formerly tower-workshop-paths OQ-73.

- **Its own pull request adds the drafts** (owner, 2026-10-15; design doc,
  Part 3, "Decided so far", "A spike's own pull request adds the stories it
  recommends"). ST-30 lets a story with `kind: spike` do so, which is why
  this story depends on it.
- **Widened on 2026-10-15 to both roles and to local files, with ST-3 folded
  in** (owner, with the planning session; design doc, Part 3, "Decided so
  far"). ST-3 (formerly tower-workshop-paths OQ-62), the reviewer's half, was
  retired the same day, and its guarantee checks are below. The owner's view:
  the danger is a malicious model or a prompt injection, of low likelihood
  while the owner works alone, so this stays a spike for now.
- **Rewritten on 2026-10-09 as a spike**, at the owner's decision. The story
  before the rewrite (tower-workshop-paths,
  `git show eb84893:stories/OQ-73-coder-machine-credentials.md`) had a
  separate Windows account as its candidate mechanism. On 2026-10-08 the
  owner chose a container (design doc, R5), and on 2026-10-09 chose to find
  out how by a spike.
- **What tower-workshop-paths' #209 found** (OQ-73's coder, 2026-10-08,
  closed unmerged on 2026-10-09): a `CredRead` of `gh:github.com:` from a
  `node -e` child of a session spawned as a coder returned the credential,
  with no prompt, which confirmed the risk; and `net user /add` was refused
  (System error 5), so a separate account needs an administrator.
- **`E:\Source` grants `Authenticated Users` modify, inherited by everything
  under it** (`icacls E:\Source`, 2026-10-15), so a separate Windows account
  could write the crew member's worktrees unless that is changed.
- **Claude Code's sandboxed Bash tool** runs on macOS, Linux and WSL2, not on
  native Windows. It confines a command's writes to the working directory and
  a temporary directory, and sends network traffic through a proxy with a
  host allowlist that starts empty (Claude Code Docs, "Configure the
  sandboxed Bash tool", read 2026-10-15).
- **A spawned session can reach local files today.** The reviewer's allowlist
  grants `Bash(node:*)` (`reviewerAllowedTools`,
  `scripts/dispatch/invocation.mjs`), so `node -e` can write anywhere the
  crew member can, the controller's worktree included, from which the pilot
  runs next.
- **The coder's guarantee checks the build must pass**: the pre-rewrite
  story's AC-1 to AC-5, kept as the proof.
  - The owner's stored `gh` token cannot be read from a session spawned as a
    coder, by a child process of `node -e`, because it is absent or
    unreadable to that process, not because a command was denied.
  - `git -c credential.helper=manager credential fill` for
    `https://github.com`, run from that session, returns no password.
  - The coder still commits on its branch and runs `npm test`, `npm run lint`
    and `npm run build`; ATC's push through OQ-84's push function still works.
  - The owner's own `gh` still authenticates.
  - Every copy of the claim that a coder holds no reachable credential says
    what is then true. The pre-rewrite AC-5 lists them, in the design doc,
    `.claude/prompts/coder.md`, `REVIEW.md` and `scripts/dispatch/coder-env.mjs`.
- **The reviewer's guarantee checks**, from ST-3's AC-1 to AC-6:
  - In a session spawned as a reviewer, an attempted `git push` to `origin`
    fails for want of authorisation, not of tool permission, including from
    `node -e` spawning git through `child_process`, and from `npm` or `npx`
    running a script.
  - No GitHub token is reachable from that session: not in the environment,
    nor via `gh`, nor from any credential helper or keyring it can invoke.
    `GH_TOKEN=""` does not do this (design doc, "`GH_TOKEN=""` does not
    remove a credential"); deleting the variables does, as `coderEnv` does.
  - The reviewer still runs the project's tests and lint, every read-only
    `git` command in its allowlist, and `git fetch` of the branch under
    review, and a review of a real pull request completes end to end.
  - The design doc's "Invocation shape" and "Credential minimalism" describe
    what is then true.
- **Why it is owner-run:** the trials run `docker`, `wsl` and `runas`, none of
  which is on the coder's allowlist (`coderAllowedTools`,
  `scripts/dispatch/coder-env.mjs`), and Q1 may need an administrator.
- **The runtime on 2026-10-09:** Docker Desktop's command-line tool 29.7.2 is
  installed per user, under `AppData\Local\Programs\DockerDesktop`. Its engine
  was not running, and WSL was not installed. Docker Desktop on Windows needs
  WSL 2 or Hyper-V under it.
- `scripts/dispatch/coder-env.mjs`: `coderEnv`, which removes the token from
  the environment, and which `review.mjs` uses for the reviewer too, but
  leaves a credential helper's own storage reachable.
- OQ-101 depends on OQ-73 (AC-4).
- `docs/agent-workflow-design.md`, R5: the container decision and its known
  questions (Q3, Q4).

## Open questions

- **Which container runtime** (left open by the owner on 2026-10-09). Docker
  Desktop is installed but not set up (Context); Podman is the other candidate
  named. Settled before the spike is run.
