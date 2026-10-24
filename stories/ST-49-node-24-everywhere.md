---
id: ST-49
title: Run steward on Node 24 everywhere, declared once and set up in each job that runs node
tier: fix
kind: workflow
depends_on: []
model: null
blocked: null
---

## Intent

As a member of the crew of a project that uses steward, I want steward and its workflow files to use
one Node version, 24, wherever steward runs, on my machine and on GitHub's runner, so that the
gate, the runway and inspection install and run in my project instead of failing on the runner's
default npm.

## Acceptance criteria

- [ ] **AC-1** — `package.json` has `engines.node` set to `"24.x"`: any Node 24 release, one
      major version everywhere (owner, 2026-10-23; not chosen: `>=24`, which lets a machine run a
      major CI never tested, and an exact release, which every patch would have to move). It is
      where the version is declared, and AC-4 holds the workflow files to it.
      `package-lock.json`'s root entry (`packages[""]`) carries the same `engines`, as npm
      writes it.
- [ ] **AC-2** — Each job in steward's own `.github/workflows/*.yml` that has a step running
      `node` or `npx` has an `actions/setup-node@v4` step with `node-version: 24` before its first
      such step: `ci.yml`'s `test`, `review-gate.yml`'s `pending` and `verdict`,
      `land-approved.yml`'s `land` and `inspection.yml`'s `inspect`. `ci.yml`'s existing
      `Setup: Node` step moves from Node 22 to 24 and keeps its name and `cache: npm`. The version
      of `actions/setup-node` is the one `ci.yml` uses today.
- [ ] **AC-3** — Each job in the thin templates `templates/workflows/*.yml` has the same step,
      with `node-version: 24` written literally, before its first step running `node` or `npx`.
      The step carries no `{{STEWARD_VERSION}}` placeholder, and is the same step as in the
      matching job of steward's own file.
- [ ] **AC-4** — A test checks AC-2 and AC-3 mechanically. It reads every
      `.github/workflows/*.yml` and every `templates/workflows/*.yml` that exist (not a fixed
      list), and fails when it finds none of either. For each job with a step whose command is
      `node` or `npx` (a folded `run: >-` command included), it requires an earlier
      `actions/setup-node` step in the same job whose `node-version` has the major version that
      `package.json`'s `engines.node` names. Cases show it failing on a job with no setup step, on
      one whose setup step comes after the first `node` step, and on one whose version is 22.
- [ ] **AC-5** — The existing sync tests keep passing and still test what they tested: steward's
      own files and the thin files differ only in how steward is started (ST-42/AC-5 and
      ST-44/AC-6 in `scripts/land/thin-workflows.test.mjs`), so the setup step is in both, in the
      same place. The two assertions there that the thin files contain no `setup-node` (the test
      "neither file checks out the project, installs its dependencies or sets up Node", and the
      one on inspection's file ending `not.toMatch(/npm ci|npm install|setup-node/)`) are changed
      to match the story: they keep their other assertions (the gate's and the runway's thin files
      check out nothing, inspection's keeps its checkout, and none runs `npm ci` or `npm install`)
      and no longer assert there is no `setup-node`.
- [ ] **AC-6** — `README.md` asks for Node 24 (npm 11 or newer), for working on steward and for
      running it from the package: in "Setup" (today "**Node 22**, which is what CI runs") and in
      "Setting up another project" (today "and Node 22"). Where `README.md` says what
      `review-gate.yml` and `land-approved.yml` hold ("hold only their triggers, permissions and
      environment" today), it includes the Node set-up. After the change,
      `grep -rn "Node 22" README.md docs AGENTS.md CLAUDE.md` finds only
      `docs/steward-bootstrap.md`'s B6, a dated record of what `ci.yml` was extracted with, and
      the lines of the design document's entry for this decision that say what Node 22 was.
- [ ] **AC-7** — Every **Planned** marker naming ST-49 in `docs/agent-workflow-design.md` is
      resolved, as its "Reading this document" note says: the id taken out of each marker (three
      today: in the `init` entry of "Decided so far", in the entry added with this story, and in
      "What ties the workflow to this repository today"), the new entry's passage made a plain
      statement and corrected wherever what was built differs, and the passage in the `init` entry
      kept as a dated record, its words unchanged and a plain pointer to the new entry left in
      place of the marker. The passage in "What ties the workflow to this repository today" that
      says the workflows hold only their triggers, permissions, concurrency and environment
      includes the Node set-up.

## Out of scope

- Steward refusing at start-up on a Node it does not support: `engines.node` is declared, not
  enforced.
- Installing steward from GitHub's tarball URL in place of `github:luplows/steward#v<version>`.
- Carrying this fix into `release/v0.1.0`: the release review's, as a cherry-pick pull request
  (`docs/release-review.md`, "The walkthrough").
- Node release and end-of-life dates, in the story, the design document or `README.md`.
- `docs/steward-bootstrap.md`: its B6 (Node 22) and B15 (Node 24.21.0) are dated records.
- A project's own CI, and which Node a project's code needs: the thin files set up Node for
  steward's commands only.

## Constraints

- Node, ESM, no new runtime dependencies.
- Comments added to the workflow files must pass the tests that read them
  (`scripts/land/thin-workflows.test.mjs`, "ST-42/AC-6" and "ST-44/AC-6"): no story id, date,
  issue number or file of steward's repository a project lacks.

## Context

- **Decided on 2026-10-23 by the owner**, with the planning session, from the release review of
  `v0.1.0` (design doc, Part 3, "Decided so far", the entry added with this story). Its goal is one
  Node version for all of steward, its workflows and running it locally.
- **The finding.** The release review's walkthrough ran `init --ref <commit>` on a scratch
  repository. The thin files run `npx --yes --package=github:luplows/steward#v{{STEWARD_VERSION}}
  steward <command>` on the runner's default Node and npm, because no thin template has an
  `actions/setup-node` step (ST-42, AC-4, and Context: "Neither workflow runs
  `actions/setup-node`"). On npm 10.x the install fails with `npm error GitFetcher requires an
  Arborist constructor to pack a tarball`. The release review reproduced it on npm 10.8.2 and
  10.9.2 and saw the install work on npm 11.0.0, 11.6.2 and 11.19.0; the planning session
  reproduced it on npm 10.9.2, and saw the same install work there from
  `https://codeload.github.com/luplows/steward/tar.gz/<sha>`. Node 22 ships npm 10 and Node 24
  ships npm 11. `README.md` asks for Node 22 and `ci.yml` sets up Node 22. Every thin step fails:
  the gate, landing and inspection.
- Considered and not chosen: Node 22 with the install switched to GitHub's tarball URL, which
  works on npm 10, but Node 22 leaves long-term support sooner and the command is less readable;
  `npx --yes npm@11 exec …` in every step, which is odd and fragile; publishing to the npm
  registry, a bigger decision.
- ST-42 and ST-44 (`stories/done/`) built the thin files and `init`, which fills their
  `{{STEWARD_VERSION}}` and copies the rest unchanged (`fillPin`, `scripts/dispatch/init.mjs`), so
  `init` needs no change.
- `.github/workflows/`: `ci.yml`'s `test`, `review-gate.yml`'s `pending` and `verdict`,
  `land-approved.yml`'s `land` and `inspection.yml`'s `inspect` are all the jobs there are, and
  each runs `node` (`ci.yml` also `npm`). Only `ci.yml` has a setup-node step today.
- `scripts/dispatch/ci.test.mjs`, "OQ-118/AC-3", requires every setup step in `ci.yml` to be named
  with the `Setup: ` prefix. It reads `ci.yml` only (line 354), so the prefix is `ci.yml`'s alone.
- The route to the release branch is the release review's: this fix lands on `main` first, then
  comes to `release/v0.1.0` as a cherry-pick pull request that changes nothing under `stories/`
  (`docs/release-review.md`, "The walkthrough", "A blocker is fixed or deferred").
- ST-50, written with this story, edits `README.md`'s "Setting up another project" opening
  sentence, which also names Node 22 (`README.md` line 83 today). Whichever lands second keeps
  both changes.

## Open questions

*(none)*
