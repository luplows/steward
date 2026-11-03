---
id: ST-66
title: Read and write steward's JSON state files through one small module
tier: next
kind: workflow
depends_on: [ST-60]
model: null
blocked: null
---

## Intent

As a member of the crew, I want every JSON file under `~/.steward/state/` read and written the same
safe way, so that a failed write never costs me my activation records or the coordinator's record,
and so that moving to a database later means changing one module rather than each caller.

## Acceptance criteria

- [ ] **AC-1** — **One module.** A new module, `scripts/dispatch/state-file.mjs`, exports a read and
      a write of a JSON state file. The read returns the parsed value, or says there is no file. It
      does not decide what a valid record is. The write creates the folder, writes a temporary file
      in the same folder as the target, and renames it over the target. Tests cover a read with no
      file, a read and a write of a value, and a read of a file that is not JSON.
- [ ] **AC-2** — **A failed write leaves the file as it was.** What makes this true is the rename in
      AC-1: the target is not opened for writing. If the temporary file's write or the rename fails,
      the write removes the temporary file as best it can and throws the original error. Tests fail
      each step, and show the target byte for byte unchanged, no temporary file left, and the
      original error thrown.
- [ ] **AC-3** — **All three files use it.** `reviews.json`
      (`scripts/dispatch/review-admission.mjs`), `projects.json` (`scripts/dispatch/project.mjs`) and `coordinator.json`
      (`scripts/dispatch/coordinator.mjs`) are read and written only through this module, and
      `writeReviews`' own temporary-file logic is gone. A test searches those three modules and
      shows no direct `readFile`, `readFileSync`, `writeFile` or `writeFileSync` call on those
      files.
- [ ] **AC-4** — **Nothing else changes.** Each module keeps its own validation, and every result,
      refusal and message it gives for a missing, malformed or invalid file is unchanged. Existing
      tests keep their expectations, except where one mocks or inspects a file call this story
      moves, and the body names each such test. Each file's location and format are unchanged, so an
      installation from before this story needs no migration.
- [ ] **AC-5** — **`projects.json` is covered.** A test fails a write during `steward project
      activate` and `deactivate`, and shows the existing records unchanged and the command reporting
      the failure.
- [ ] **AC-6** — The implementing PR resolves this story's **Planned (ST-66)** marker in the design
      of record, and `docs/user-config.md` says how the state files are written.

## Out of scope

The threat model is one member of the crew, one coordinator, one automatic review at a time, on
one machine, and a write that fails while steward is running. Outside it, and not to be guarded against,
for now:

- Two processes writing the same file at once: the last rename wins. Locks and retries are not
  added.
- Power loss or an OS crash during a write: no `fsync`.
- A rename refused because another process has the target open, as Windows may do: the write fails
  as AC-2 says, the file is as it was, and the command reports it. No retry.
- A leftover temporary file from a process killed during a write: it is overwritten by the next
  write and is never read.
- `coordinator.stop`, whose presence is the signal, and `~/.steward/config.json`, which a person
  edits.
- SQLite or any other database, setting a malformed file aside, a backup, or a repair command.
- Moving each module's validation into this one.

## Constraints

- **Threat model:** as under Out of scope. This story need prove no more than that a failed write
  leaves the file as it was.
- Node 24, ESM, no new runtime dependencies. Tests use a temporary home directory; no test writes to
  GitHub or starts a model, or touches the real `~/.steward/`.

## Context

- Crew decision, 2026-11-02, after ST-60's reviews (#108): keep JSON files for now, behind one small
  module. Considered and not chosen: moving to SQLite now (`node:sqlite`, which needs no new
  dependency). 0.1 has one writer per file by design, and JSON files can be read and fixed by hand.
  The crew would revisit a database at the first story that needs two writers at once, such as more
  than one reviewer at a time, coder and fixer sessions sharing state with reviews, or ST-62's
  registration of running work.
- `writeReviews` in `scripts/dispatch/review-admission.mjs` (ST-60) is the write to move.
  `writeProjects` in `scripts/dispatch/project.mjs` and `writeRecord` in
  `scripts/dispatch/coordinator.mjs` overwrite directly.
- `readReviews`, `readProjects` and `readRecord` are the reads, each with its own validation and
  messages.
- `docs/planning-session.md`, "Writing it": a safety criterion names a bounded threat model.
- Suggested size: small.

## Open questions

*(none)*
