# Review Checklist

The checklist a pull request is reviewed against. A section applies when its
`Applies when:` line says so, and a section without one always applies.

<!-- Your project's own sections go below the ones here, each a "## " heading,
     then one "Applies when:" line in plain words (leave it out for a section
     that always applies), then its items, numbered from 1. Delete this
     comment when you no longer need it. Nothing in a comment reaches the
     reviewer: steward removes every comment before it gives the reviewer this
     file. -->

## Reading the pull request body

<!-- This section names the pull request template steward's init wrote and its
     sections. If your project's template differs, name your template and its
     sections here instead, and change item 1 to match. -->

Every PR uses the project's pull request template
(`.github/pull_request_template.md`), which has a `Unit:` line and three
required sections: **What changed**, **Verification**, and **Docs check**.

**Check the content of each section, not that the heading exists.** A template
auto-populates, so an unfilled one is structurally identical to a filled one.
These do not satisfy the requirement:

- A section left as its HTML comment placeholder, or emptied to a blank.
- `Verification: N/A`, `tests pass`, `all green`, or any claim without the
  command and its actual result.
- `Docs check: none needed` with no statement of what was considered.

A section that restates the PR title in other words is also unfilled.

1. The `Unit:` line and all three template sections are present and
   substantively filled, per above.

## Every pull request

1. Commit granularity: one commit is right for most changes.
2. The diff matches the **What changed** description. No unrelated changes
   riding along.
3. A change to code links the unit it implements, with a `Unit:` line in its
   body. `Unit: none` is accepted only where no unit could exist, such as a
   pull request that writes the unit itself. The review's note on the unit
   says which it found: a link read, a link not read and why, `Unit: none`, or
   no `Unit:` line, and several links are reported as such.

<!-- Your project's own items for this section go here, numbered on from 3. -->

## Changes to code

Applies when: the diff changes code, tests, workflow files or prompts.

1. No test was skipped, disabled, quarantined, weakened, or deleted in order to
   make something pass.

## Integrity

1. The **Verification** section reports real results — actual numbers, taken
   the same way across a before/after comparison — rather than an assertion
   that checks passed.
2. A check that could not be run is stated as such, with the reason, rather
   than quietly omitted from the list.
3. No local workaround is left in the diff. A path, config, or flag patched
   in order to get a check running locally must be reverted before pushing.
4. Scope was not widened beyond the task the PR set out to do.

## Conformance to the unit

Applies when: the pull request implements a unit.

1. **Completeness** — every acceptance criterion in the unit is delivered.
   Name any that are not.
2. **Fidelity** — each acceptance criterion is genuinely satisfied, not merely
   named in a test. A test named for an acceptance criterion that does not
   exercise it fails this item.
3. **Containment** — nothing in the diff falls under what the unit puts out of
   scope, and nothing implements a decision the unit left open.
