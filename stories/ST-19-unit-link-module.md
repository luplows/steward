---
id: ST-19
title: Find and read a pull request's unit from the link in its body
tier: next
kind: workflow
depends_on: [ST-18]
model: sonnet
blocked: null
---

## Intent

As a member of the crew, I want steward to find the unit a pull request implements from a link its
body gives, deterministically and by the kinds of link the project uses, and to read that unit as it
stands on `main`, so that the reviewer judges the work against the unit as it was approved, whatever
form the project keeps its units in. This story builds the module; ST-22 puts it into the review.

## Acceptance criteria

- [ ] **AC-1** — A new module, `scripts/dispatch/unit.mjs`, exports `findUnitLink(body,
      unitLinks)`, a pure function. It reads:
      - lines whose whole content, after leading spaces, is `Unit:` followed by text: `Unit: none`
        (any letter case) is the explicit "no unit"; `Unit: #<n>` is an issue link; text with
        no whitespace and no URL scheme (`<scheme>://`) is a file link; anything else, such as a
        URL, is an `other` link;
      - when `unitLinks` includes `"issue"`, GitHub's closing keywords followed by `#<n>`
        (`close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`,
        `resolved`, in any letter case), as issue links.
      A link of a kind not in `unitLinks` is reported as such, not read. A `#<n>` that names
      another repository (`owner/name#<n>`) is not an issue link of this one.
- [ ] **AC-2** — `findUnitLink` returns exactly one of: `{ kind: 'link', type, target }`;
      `{ kind: 'none' }` for `Unit: none`; `{ kind: 'missing' }` when the body has no `Unit:`
      line and no closing keyword it reads; or `{ kind: 'several', links }` when it finds more
      than one distinct link. A closing keyword naming the same issue as a `Unit: #<n>` line is
      one link, not two. With `unitLinks` empty it returns `{ kind: 'missing' }` or
      `{ kind: 'none' }` only, and reports any `Unit:` text as unread.
- [ ] **AC-3** — `readUnit(link, { repoDir, base, ctx })` reads a link `findUnitLink` returned:
      - a file, with `git show <remote>/<base>:<path>` in `repoDir`, so the copy on `main`, never
        the pull request's head; a path that is absolute, contains a `..` segment, or is not on
        `main` is unreadable, with the reason;
      - an issue of this repository, through `scripts/dispatch/github.mjs`, as its title and
        body; a number that is a pull request, or that does not exist, is unreadable, with the
        reason;
      - an `other` link is not read: its text is returned as given.
      It returns `{ read: true, text }` or `{ read: false, reason }`, and never throws for an
      unreadable link.
- [ ] **AC-4** — `github.mjs` gains one read: getting one issue by number (`GET
      /repos/<repo>/issues/<n>`), added to its request allowlist, with a test that the allowlist
      admits it and still refuses any other new request. No write is added.
- [ ] **AC-5** — `describeUnit(found, read)` returns the note the reviewer will be given, one of
      four, stated in fixed words: a link it read, with what it read; a link it could not read,
      and why; `Unit: none`; or no `Unit:` line at all. `several` is described as such, listing
      the links, none read.
- [ ] **AC-6** — Tests in `scripts/dispatch/unit.test.mjs`, named `ST-19/AC-<n>`, cover each
      form in AC-1 and each result in AC-2 and AC-3, with the git and GitHub reads injected or
      against a temporary repository; including a file present at the head but not on `main`,
      which is unreadable.
- [ ] **AC-7** — The `**Planned (ST-19)**` marker in `docs/agent-workflow-design.md` loses
      `ST-19`, and the passage is corrected wherever what was built differs.

## Out of scope

- Using the module in `review.mjs`, removing `resolveStory`, and the reviewer prompt: ST-22.
- Deciding whether a missing link blocks: the reviewer decides, by the project's rules
  (`docs/harness-outline.md`, "Review").
- Links into other repositories or other trackers beyond passing their text on as `other`.
- Requiring a `Unit:` line, and the pull request template: ST-26.

## Constraints

- Node, ESM, no new runtime dependencies.
- No model takes part in finding or reading the link.

## Context

- `docs/harness-outline.md`, "Defining steward", "Review", "Refined 2026-10-11 by the owner: how
  the link is written and read": the decisions this story builds.
- `scripts/dispatch/review.mjs`'s `resolveStory`: today's way of finding the unit, from the story
  file the diff moves into `stories/done/`, read at the head. It stays until ST-22.
- `scripts/dispatch/github.mjs`: `assertAllowedRequest` and its `ALLOWED` table, which refuse any
  request the module's `build*` functions do not produce.
- GitHub's closing keywords: "Linking a pull request to an issue" in GitHub's documentation.

## Open questions

*(none)*
