---
id: ST-48
title: Validate review installation manually in two existing projects
tier: next
kind: workflow
depends_on: [ST-25, ST-42, ST-44, ST-47]
model: null
blocked: "Crew-only manual validation in two client projects; no coder may take this story."
---

## Intent

As a member of the crew, I want to install and exercise steward's review gate in two existing
projects with different work-unit conventions, so that we have evidence that review and landing
work outside steward's own repository without adopting its story convention or copying its
implementation scripts.

## Acceptance criteria

- [ ] **AC-1** — A manual validation record, `docs/validation/ST-48-review-installation.md`,
      has separate sections for pinpoint and tower-workshop-paths. Each identifies the project,
      date, operator, steward version and resolved commit, prerequisites, and the project's
      existing unit convention. The crew validates pinpoint first, then tower-workshop-paths,
      as the recorded adoption order specifies.
- [ ] **AC-2** — In each project, the crew installs the review gate through the installed
      steward package and `init`, using ST-42's thin workflows. Its record gives the exact
      commands and answers, their outcomes, the installation pull request and resulting commit,
      the workflow pin, and the settings and checklist paths. The installation diff contains
      no copied steward implementation scripts or prompts. The record identifies files left
      alone by `init`, any manual configuration, and the branch-protection outcome of `steward
      protect` (ST-50), including when protection is unavailable. No coder is enabled or
      dispatched.
- [ ] **AC-3** — Each project's record compares its unit convention before and after
      installation, with links to the relevant units and pull requests. Pinpoint continues to
      use GitHub issues; tower-workshop-paths continues to use its file stories and `OQ` prefix.
      The settings and validation pull requests use the corresponding unit links. Neither
      project is migrated to steward's `ST` stories, schema, queue or completion convention.
- [ ] **AC-4** — In each project, an actual steward reviewer session reviews a pull request
      against its linked unit and the project's checklist. The record links the unit, checklist
      revision, pull request, reviewer result and posted verdict comment, and records the full
      reviewed head SHA. The verdict marker's head matches that SHA and the pull request head
      at review; the gate records the corresponding `review/agent` state on that same commit.
      A hand-written marker or injected verdict does not satisfy this criterion.
- [ ] **AC-5** — In each project, at least one pull request lands through steward's pilot and
      runway after a passing real review. The record links the passing verdict, successful
      `review/agent` status, checks required by that project's `landWhen`, landing command and
      workflow run, and merged pull request and commit. The reviewed SHA, successful status's
      SHA and head accepted for landing are the same; the record establishes that review and
      the required checks passed before the merge. A direct manual merge does not satisfy
      this criterion.
- [ ] **AC-6** — In at least one project, the crew exercises a pull request with a deliberate,
      documented violation of its linked unit or checklist. A real review returns `block`,
      and `review/agent` is `failure` on that head. A steward landing attempt leaves the pull
      request unmerged because of the blocking review. The record links the violation,
      verdict, head SHA, status, landing attempt and its refusal, and the still-unmerged pull
      request at that time. Unrelated failures alone do not demonstrate the gate's refusal.
      This may precede a fix and passing review of a new head used for AC-5, provided the
      evidence distinguishes the two heads and outcomes.
- [ ] **AC-7** — Each project's section separately records the procedure, expected and actual
      outcomes, evidence for AC-2 through AC-6 as applicable, and defects found, or explicitly
      says none were found. Each defect has reproduction steps, expected and actual behaviour,
      impact on validation, and a link to separate follow-up work in the repository responsible
      for it. Defect fixes are excluded from this story's completion diff. If a defect prevents
      a required demonstration, that criterion remains undelivered until the follow-up lands
      and a recorded rerun demonstrates it; reporting the defect alone is not success.
- [ ] **AC-8** — The crew's completion pull request in steward includes the validation record,
      ticks only criteria actually demonstrated, and moves this story to `stories/done/`.
      Every **Planned** marker naming ST-48 in `docs/agent-workflow-design.md` is resolved,
      correcting its passage wherever the outcome differs from the recorded plan.

## Out of scope

- Implementing ST-25, ST-42, ST-44 or ST-47, or repairing validation defects: separate work.
- Automated coding, dispatching client stories, or changing either project's planning process.
- New unit conventions, new tracker integrations, and moving units into steward's story schema.
- Cutting a release, changing release policy, or replacing the release review's scratch-project
  walkthrough. This story validates existing projects after its dependencies are delivered.
- Publishing private client implementation details in steward's public validation record without
  the crew's approval. Keep restricted evidence in the client project and record only approved
  summaries and references in steward.

## Constraints

- Manual execution by the crew. Keep `blocked:` set so that no coder takes this story; a member
  of the crew starts its execution session once the dependencies are done and the installation
  version is available. Preparing this story authorizes no client installation or execution.
- Use the projects' own approved pull-request processes for installation and validation changes.
  Do not copy steward's implementation into either project or bypass the review gate to obtain
  a successful landing result.

## Context

- Crew decision, 2026-10-21: manually validate both review installations, preserving each
  project's units, with separate evidence and defects; repairs are separate follow-up work.
  `docs/agent-workflow-design.md`, Part 3, "Decided so far", "The crew validates review
  installation in two existing projects" records the decision and alternatives.
- Design doc, "Steward installs in another project as a review gate, through `init`": the
  adoption order and the two projects' unit conventions, already recorded there.
- ST-25, `stories/done/ST-25-review-pass.md`: the review-and-land rotation.
- ST-42, `stories/done/ST-42-gate-runs-installed-steward.md`: installed gate commands and thin
  workflow files, with no project copy of steward's implementation.
- ST-44, `stories/done/ST-44-init.md`: installation, project settings and existing-file
  preservation. ST-50, `stories/ST-50-protect-apart-from-init.md`: `steward protect`, which
  sets branch protection apart from `init` and reports when it cannot be set.
- ST-47: merged-head deletion protection and the runway's status-pagination fix; the crew
  requires these fixes before client validation (2026-10-21).
- `stories/README.md`, "Status": crew-only manual work keeps a reason in `blocked:`.

## Open questions

*(none)*
