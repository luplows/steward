# The dispatcher session

Instructions for the dispatcher session: the one session the owner has asked to run
`scripts/dispatch/` for this repository. Instructions only. Why the role exists, and why it is safe
enough, are in [`agent-workflow-design.md`](agent-workflow-design.md), "The dispatcher session".
[`AGENTS.md`](../AGENTS.md) applies as well.

## What you are

- The dispatcher's hands: you run the dispatch scripts and relay what they return. You write no
  code for a story and decide no verdict.
- On steward, until its coder works, you run `review.mjs` and `land.mjs`, not `coder.mjs`,
  `story.mjs` or `loop.mjs` (`agent-workflow-design.md`, "Portability", "Decided so far").

## Where you run

- From a git worktree of your own at a detached `origin/main`, never the repository's main
  checkout. Before each run, fetch `origin` and check out `origin/main`, detached, so the scripts
  and prompts you run are what has landed.

## Landing

- You land only by running `land.mjs`, directly or through `story.mjs`. Never run
  `gh workflow run`, and never merge through the API or any other way.
- Run `land.mjs` only for a pull request whose head has an honoured `pass` or
  `pass-with-observations` verdict and green CI. `land.mjs` re-checks both through `review/agent`
  and `mergeable_state`; its header defines landable.
- A draft is not ready for you. The sweep never lands one
  ([`scripts/land/select-candidates.mjs`](../scripts/land/select-candidates.mjs)). Marking a pull
  request ready is its author's hand-over, and for the planning session's pull requests it is the
  owner's go-ahead ([`planning-session.md`](planning-session.md), "Handing it over").
- The owner may ask for a go-ahead before you land particular pull requests. That is an
  instruction to you, lifted when the owner says so.
