---
id: OQ-62
title: Remove the reviewer's capability to write, rather than denying the command
tier: normal
kind: workflow
depends_on: []
model: sonnet
blocked: null
---

## Intent

As the owner of the review gate, I need a reviewer session to be unable to write
to the repository or to GitHub *even if it tries*, so that the gate's
independence rests on what the session can reach rather than on it following an
instruction.

## Acceptance criteria

- [ ] **AC-1** — In a session spawned exactly as a reviewer is spawned, an
      attempted `git push` to `origin` fails for want of **authorisation** — no
      usable credential — and not for want of tool permission. The distinction
      is the whole story: a denied command and an impossible one look identical
      until something routes around the denial.
- [ ] **AC-2** — The same holds via the paths that bypass the tool allowlist
      entirely: `node -e` spawning git through `child_process`, and `npm`/`npx`
      running an arbitrary script. These are demonstrated, not assumed, because
      they are how the current guarantee was found to be false.
- [ ] **AC-3** — No GitHub token is reachable from the session: neither in the
      environment, nor via `gh`, nor from any credential helper or keyring the
      session can invoke.
- [ ] **AC-4** — The reviewer can still do its job. `npm test`, `npm run lint`
      and every read-only `git` verb in its allowlist still work, and a review
      of a real PR completes end to end. A reviewer that cannot verify the
      author's claims reviews by reading, which is the failure this must not
      trade for.
- [ ] **AC-5** — `git fetch` of the branch under review still works, since
      `reviewer.md` step 2 requires confirming the head SHA and step 3 requires
      a three-dot diff against the merge base.
- [ ] **AC-6** — The claims in `docs/agent-workflow-design.md` describe what is
      then true. The wording corrected in #109 — "defence in depth, not
      containment", "handed no credentials … on a machine where the capability
      exists" — is updated rather than left describing a gap that has closed.

## Out of scope

- The **coder's** permissions. A coder must commit, push and open a PR; this is
  about the reviewer only, and the two are deliberately asymmetric.
- A second GitHub identity. That is the full answer to self-marking and is
  listed separately in the design's Phase 5; this story is narrower and does not
  depend on it.
- General sandboxing or containerisation of spawned sessions. If that arrives it
  subsumes this, but waiting for it is what leaves the gap open.
- Changing what the reviewer is told to do. `reviewer.md` already says it posts
  nothing; this story makes that true rather than restating it.

## Constraints

- The reviewer must keep running the project's test and lint commands, so the
  answer cannot be "remove `npm`/`node` from the allowlist".
- **`GH_TOKEN=""` does not satisfy AC-3.** `gh` treats an empty value as absent
  and falls back to the keyring, authenticating normally; only a non-empty value
  overrides it. Both directions are verified against this repository. Deleting
  the variables is what works, as `coderEnv` does. This is written down because
  the empty string is the obvious first reach and it fails silently — the
  reviewer would appear de-credentialed and be fully authenticated.

## Context

Found reviewing [#109](https://github.com/luplows/tower-workshop-paths/pull/109),
whose own round-4 verdict established it: the reviewer's allowlist grants
`Bash(npm:*)`, `Bash(npx:*)` and `Bash(node:*)`, so `node -e` can write files
despite `Edit`/`Write` being disallowed, and can spawn `git push` despite the
`Bash(git push:*)` deny rule — which matches a command *prefix* that `node …`
never trips. The reviewer confirmed empirically that `node -e` runs in its own
session.

Running locally, the session runs as the owner, where an SSH key and a `gh`
keyring token are both reachable. So the reviewer is *handed* no credentials and
told to post nothing, on a machine where the capability is present. That is a
weaker property than the design claimed for two review rounds before anyone
tested it.

- `docs/agent-workflow-design.md` — "Invocation shape" and "Credential
  minimalism", both corrected in #109 to state the gap rather than close it
- `.claude/prompts/reviewer.md` — the preamble paragraph on load-bearing flags
- `REVIEW.md`, "Recording a verdict" — the split that exists so the reviewer
  never needs to post

## Open questions

*(none)*
