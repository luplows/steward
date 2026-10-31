---
id: ST-65
title: Follow up init's installation pull request for 0.2
tier: later
kind: product
depends_on: [ST-56]
model: null
blocked: null
---

## Intent

As a member of the crew installing steward, I want the parts of `init`'s installation pull
request that 0.1 leaves out to be considered for 0.2, so that they are chosen from real use
rather than built ahead of it. This is a placeholder: it holds the candidates, and is split or
refined into stories once the crew picks among them.

## Acceptance criteria

To be written when the crew chooses which candidates to build (Open questions).

- [ ] **AC-1** — Placeholder: each candidate the crew chooses is refined here, or into a story of
      its own, with acceptance criteria that a reviewer can check against a diff.

## Out of scope

- Anything ST-56 delivers for 0.1.
- Candidates not listed under Open questions, until the crew adds them.

## Constraints

*(none)*

## Context

- ST-56 (`stories/ST-56-init-installation-pr.md`), rescoped by the crew on 2026-10-31 to the happy
  path for 0.1: one member of the crew, one run, an ordinary checkout, made in a fresh clone. Its
  Out of scope names these candidates for 0.2.
- Crew decision, 2026-10-31: the first `init` story goes in 0.1; follow-ups are planned for 0.2
  for now.
- #92, ST-56's earlier implementation, closed 2026-10-31: its eleven reviews show the cases a
  wider contract would meet.

## Open questions

Candidates for 0.2, for the crew to choose among:

- **Remove the clone after a success.** In 0.1 the clone is always kept and the closing message
  asks the person to remove it (crew, 2026-10-31).
- **`--pr-title` and `--pr-body-file`**, deferred from ST-56 (crew, 2026-10-31): a title for
  projects with naming conventions, and a whole body supplied from a file.
- **Fill the template's sections** with the installation's facts, instead of a generated section
  above the template.
- **A rerun that resumes its own branch** after a partial failure, instead of the branch being
  deleted by hand.
- **Unusual Git setups**, if real users meet them: URL rewrites, hooks, signing, filters,
  concurrent installers. Each would name its own bounded threat model
  (`docs/planning-session.md`, "Writing it").
- **The caller's local edits to installation files**: a note when they differ from what was
  installed, which 0.1 ignores.
