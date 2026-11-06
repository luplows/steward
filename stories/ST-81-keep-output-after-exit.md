---
id: ST-81
title: Keep a session's output that arrives after its process exits
tier: fix
kind: product
depends_on: []
model: null
blocked: null
---

## Intent

As a member of the crew, I want a session's record to hold everything the
session wrote, so that a session that finished is not reported as
`malformed-output` and its work or verdict thrown away. `runSession`
(`scripts/dispatch/spawn.mjs`) builds its record from the stdout it holds when
the child's `exit` event fires, and Node's documentation for that event says
the child's stdio streams might still be open then.

## Acceptance criteria

- [ ] **AC-1** — After the child's `exit`, `runSession` waits for its stdout to
      end before building the record, for at most `drainMs`, an option of
      `runSession` that defaults to 5000. The default is not exported, and
      `spawnSession` does not pass the option. Data that arrives in that time
      is in `record.stdout`. When stdout has not ended by then, as when a
      descendant holds the pipe, it builds the record from what it has, as
      today.
- [ ] **AC-2** — A test whose injected `spawnFn` returns a stand-in child that
      emits `exit`, then a chunk of stdout, then the end of stdout, finds the
      chunk in `record.stdout`. A second, whose stdout never ends and which
      passes a short `drainMs`, finds `runSession` resolving after about
      `drainMs`, with what arrived before.
- [ ] **AC-3** — A session stopped for its time limit or stall interval is
      reported as today, and every existing test in `spawn.test.mjs` passes
      unchanged, including the test of the module's exports.
- [ ] **AC-4** — The `**Planned (ST-81)**` marker in
      `docs/agent-workflow-design.md` loses `ST-81`.

## Out of scope

- `rateLimitsRpc` in `codex.mjs`, which reads its answer before the exit.
- A Codex session's verdict or report, which is read from its output file.
- Retrying a session that ended `malformed-output`.

## Constraints

*(none)*

## Context

- `scripts/dispatch/spawn.mjs`, `runSession`: the `exit` handler, and the
  `setImmediate` that destroys the pipes so that a descendant holding one
  cannot keep the session open.
- Tower-workshop-paths' CI run 41784405916, on `ubuntu-24.04`, failed
  `spawn.test.mjs`'s "OQ-76/AC-6" test with `expected 'malformed-output' to
  be 'completed'`, in that project's old copy of this code. Not reproduced: on
  2026-11-05 the planning session ran 1,040 sessions on Windows, writing 1 KB
  to 8 MB just before exiting, up to 16 at once, and none lost output. No Linux
  machine was tried.

## Open questions

*(none)*
