---
id: OQ-73
title: "Spike: find out how to run a coder session in a container that cannot reach the owner's credentials"
tier: next
kind: workflow
depends_on: []
model: sonnet
blocked: "Owner-run with Session A, not dispatched (owner, 2026-10-09), and held until the move: it is run in steward (design doc, R4 and R5)."
---

## Intent

As the owner, I want to know, from trials on my own machine rather than from
reading, whether and how a coder session can run in a container that holds only
the work and the agent tool's login, so that the stories that put coder sessions
there are written from what works. The guarantee they serve is OQ-63's: a
spawned coder cannot obtain a GitHub token from the machine it runs on, not only
from its environment. **This is a spike. Its output is written findings and a
recommended split into stories, not code.** It is run by the owner with Session
A, by hand, not dispatched.

## Acceptance criteria

- [ ] **AC-1** — **Only findings are committed.** The pull request's diff
      changes `docs/agent-workflow-design.md`, plus this story's move to
      `stories/done/` and its ticks, and nothing else. Any script, image
      definition or configuration used for the trials lives outside the
      repository's tree and is not committed. Its full text is given in the
      pull request body.
- [ ] **AC-2** — A new subsection under "Platform constraints" in
      `docs/agent-workflow-design.md`, titled "A coder session in a
      container", records the trials. For each trial it gives:
      - the container runtime and its version, and the host's Windows version;
      - the image the trial ran, by its definition's text in the pull request
        body;
      - the command run, and what came back, quoted verbatim;
      - for timings, the same step's time on the host.
- [ ] **AC-3** — The trials answer each of these, and the subsection states
      each answer next to the trial that shows it:
      - **Q1, the runtime:** what it took on the owner's machine to install
        and start the runtime chosen under Open questions, and which steps
        needed an administrator.
      - **Q2, the agent tool:** does a session started with
        `buildInvocation`'s arguments for the coder (`claude -p`) run inside
        the container and return its JSON result? Which file or variable of
        the agent tool's login has to be passed in, and what else does that
        expose to the session?
      - **Q3, the work:** with the worktree mounted, can the session commit on
        its branch? A git worktree's `.git` file holds an absolute host path:
        what breaks, and what fixes it?
      - **Q4, the checks:** do `npm ci`, `npm test`, `npm run lint` and
        `npm run build` run inside, and how long does each take against the
        host? With `node_modules` on a bind mount and on a volume.
      - **Q5, the credential:** from a `node -e` child inside the container,
        can the Windows Credential Manager entries `gh:github.com:` and
        `gh:github.com:<login>` be read? Does
        `git -c credential.helper=manager credential fill` for
        `https://github.com` return a password? Are the owner's `~/.ssh`, user
        profile or any keyring reachable? Each check asserts only whether a
        value came back.
      - **Q6, the dispatcher:** with the session run through the runtime,
        does `spawn.mjs` still see its streamed output (the stall check,
        OQ-76), and does a timeout or kill stop it? Is the container gone
        afterwards?
      - **Q7, the reviewer:** can the same image give a reviewer session a
        read-only mount of the worktree (OQ-62)?

      If a question cannot be answered, the subsection says so and why. That
      AC is then ticked only if the reason is stated.
- [ ] **AC-4** — The subsection ends with a **Recommendation**: the stories
      that build coder sessions in a container, in order, each with its intent
      and the acceptance criteria it would carry, naming the trial each rests
      on. Between them they carry every guarantee check listed under Context.
      It also says which story takes over OQ-101's dependency on OQ-73, and
      which takes over the **Planned (OQ-73)** markers. It is a recommendation
      only. Writing the stories is Session A's, with the owner.
- [ ] **AC-5** — The **Planned (OQ-73)** markers in
      `docs/agent-workflow-design.md` are left in place, since this story
      builds nothing. The pull request body says so, and that the stories
      written from AC-4 take them over.

## Out of scope

- **Building it**: any change to code, prompts, tests, settings or workflows,
  `coder-env.mjs`, `invocation.mjs` and `spawn.mjs` included. That is the
  stories AC-4 recommends.
- **Changes to the owner's machine** made by anyone but the owner. Installing
  or configuring the runtime is the owner's, by hand, and Q1 records it.
- **A second GitHub identity** (the design doc's open question 10).
- **Other secrets beyond those Q5 names.** Name anything else found reachable
  instead of pursuing it.
- **macOS and Linux hosts.** The trials run on the owner's Windows machine.
  The container was chosen partly so the same image runs elsewhere (R5); the
  findings say what was not tried.

## Constraints

- Nothing may store, cache or print the token or the agent tool's login,
  including in the pull request body or the design doc.

## Context

- **Rewritten on 2026-10-09 as a spike**, at the owner's decision. The story
  before the rewrite (`git show eb84893:stories/OQ-73-coder-machine-credentials.md`)
  had a separate Windows account as its candidate mechanism. On 2026-10-08 the
  owner chose a container instead (design doc, R5), and on 2026-10-09 chose to
  find out how by a spike, run by the owner with Session A, whose outcome is
  the stories that build it.
- **What #209 found** (OQ-73's coder, 2026-10-08, closed unmerged on
  2026-10-09): a `CredRead` of `gh:github.com:` from a `node -e` child of a
  session spawned as a coder returned the credential, with no prompt, which
  confirmed the risk; and `net user /add` was refused (System error 5), so the
  separate account needed an administrator.
- **The guarantee checks the build must pass**: the pre-rewrite story's AC-1
  to AC-5, kept as the proof.
  - The owner's stored `gh` token cannot be read from a session spawned as a
    coder, by a child process of `node -e`, because it is absent or
    unreadable to that process, not because a command was denied.
  - `git -c credential.helper=manager credential fill` for
    `https://github.com`, run from that session, returns no password.
  - The coder still commits on its branch and runs `npm test`, `npm run lint`
    and `npm run build`; the dispatcher's push through OQ-84's push function
    still works.
  - The owner's own `gh` still authenticates.
  - Every copy of the claim that a coder holds no reachable credential says
    what is then true. The pre-rewrite AC-5 lists them, in the design doc,
    `.claude/prompts/coder.md`, `REVIEW.md` and `scripts/dispatch/coder-env.mjs`.
- **The runtime on 2026-10-09:** Docker Desktop's command-line tool 29.7.2 is
  installed per user, under `AppData\Local\Programs\DockerDesktop`. Its engine
  was not running, and WSL was not installed. Docker Desktop on Windows needs
  WSL 2 or Hyper-V under it.
- **Why it is owner-run:** `docker` is not on the coder's allowlist
  (`coderAllowedTools`, `scripts/dispatch/coder-env.mjs`), and Q1 may need an
  administrator.
- `scripts/dispatch/coder-env.mjs`: `coderEnv`, which removes the token from
  the environment but leaves a credential helper's own storage reachable.
- OQ-62: the reviewer's counterpart (Q7). OQ-101 depends on OQ-73 (AC-4).
- `docs/agent-workflow-design.md`, R5: the container decision and its known
  questions (Q3, Q4).

## Open questions

- **Which container runtime** (left open by the owner on 2026-10-09). Docker
  Desktop is installed but not set up (Context); Podman is the other candidate
  named. Settled before the spike is run.
