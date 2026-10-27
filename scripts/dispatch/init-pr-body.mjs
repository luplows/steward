/**
 * The body of the installation pull request that `steward init` opens (ST-56): the project's own
 * pull request template, with the facts `init` knows filled in, and what it cannot know left for
 * the crew to complete. Pure: it reads nothing, runs nothing and calls no model.
 *
 * It claims only what happened: the files it lists were added or left as they were, and the checks
 * it lists are the ones `init` ran, with their results. It claims no test run, and no check that a
 * file already in the project works with the steward installed here.
 */

/**
 * The three sections `templates/pull_request_template.md` has, and that this fills when the
 * skeleton has them.
 */
const SECTIONS = [
  { key: 'changed', title: 'What changed', pattern: /^what changed$/i },
  { key: 'verification', title: 'Verification', pattern: /^verification$/i },
  { key: 'docs', title: 'Docs check', pattern: /^docs check$/i },
]

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/
const UNIT_LINE = /^[ \t]*Unit:.*$/

const list = (items) => items.map((item) => `- ${item}`)

/** The headings of `lines` that are not one of the three the installer fills, as written. */
function otherHeadings(lines) {
  const found = []
  for (const line of lines) {
    const match = HEADING.exec(line)
    if (match && !SECTIONS.some((s) => s.pattern.test(match[2].trim()))) found.push(line.trim())
  }
  return found
}

/**
 * The pull request body: `skeleton` (the text of the project's template, or of steward's) with its
 * `Unit:` line set to `none`, each of its What changed, Verification and Docs check sections that
 * it has completed after its own prompts, and, for any of the three it lacks, a labelled
 * "Installation summary" section at the end that holds that part.
 *
 * `facts`: `repo`, `branch`, `baseSha`; `pin` (what the added workflow files install, as text) and
 * `workflowsAdded`; `added` (`{ rel, note }` for each file created) and `preserved` (paths left as
 * they were); `land` (`true`, `false`, or `null` when the settings file was not added); `checks`
 * (what `init` verified, one sentence each, every one of which passed); `emptyTemplates` (template
 * directories with no file in them).
 */
export function composePullRequestBody({ skeleton, facts }) {
  const eol = skeleton.includes('\r\n') ? '\r\n' : '\n'
  const lines = skeleton.split(/\r?\n/)
  while (lines.length > 0 && lines.at(-1) === '') lines.pop()

  const unitIndex = lines.findIndex((l) => UNIT_LINE.test(l))
  if (unitIndex !== -1) lines[unitIndex] = 'Unit: none'

  const unchecked = lines.filter((l) => /^[ \t]*[-*][ \t]+\[ \]/.test(l)).length
  const others = otherHeadings(lines)
  const blocks = {
    changed: changedBlock(facts, { unitFound: unitIndex !== -1, others, unchecked }),
    verification: verificationBlock(facts),
    docs: docsBlock(),
  }

  const missing = []
  for (const section of SECTIONS) {
    const headingIndex = lines.findIndex((l) => {
      const match = HEADING.exec(l)
      return match !== null && section.pattern.test(match[2].trim())
    })
    if (headingIndex === -1) {
      missing.push(section)
      continue
    }
    let end = lines.length
    for (let i = headingIndex + 1; i < lines.length; i++) {
      if (HEADING.test(lines[i])) {
        end = i
        break
      }
    }
    while (end > headingIndex + 1 && lines[end - 1].trim() === '') end--
    lines.splice(end, 0, '', ...blocks[section.key])
    // The next heading, when there is one, keeps a blank line before it.
    if (end + 1 + blocks[section.key].length < lines.length && lines[end + 1 + blocks[section.key].length].trim() !== '') {
      lines.splice(end + 1 + blocks[section.key].length, 0, '')
    }
  }

  if (missing.length > 0) {
    lines.push('', '## Installation summary', '')
    lines.push('This section holds what `steward init` knows about the installation, because the template above has no section for it.')
    for (const section of missing) lines.push('', `**${section.title}**`, '', ...blocks[section.key])
  }
  return `${lines.join(eol)}${eol}`
}

function changedBlock(facts, { unitFound, others, unchecked }) {
  const { repo, branch, baseSha, pin, workflowsAdded, added, preserved, land, emptyTemplates = [] } = facts
  const left = [
    ...preserved.map((p) => `\`${p}\``),
    ...emptyTemplates.map((dir) => `\`${dir}\`: an empty template directory, which counts as no pull request template`),
  ]
  const out = [
    `This pull request installs steward's review gate in ${repo}. \`steward init\` made it on branch \`${branch}\`, from \`main\` at commit \`${baseSha}\`. It adds files only: it changes none that already exist.`,
    '',
    'Added:',
    ...list(added.map((a) => `\`${a.rel}\`: ${a.note}`)),
    '',
    left.length === 0 ? 'Left as they were: none, since every file steward installs was missing.' : 'Left as they were (already in the project):',
    ...list(left),
  ]
  out.push('')
  out.push(workflowsAdded ? `The workflow files added here run steward ${pin}.` : 'No workflow file was added here, so this pull request installs no version of steward.')
  if (land === true) out.push('`steward.config.json` sets `land` to `true`: unattended landing was chosen explicitly.')
  if (land === false) out.push('`steward.config.json` sets `land` to `false`: steward reviews pull requests and does not land any unattended; a pull request that has passed review can still be landed on request with `steward land <pr-number>`.')
  out.push(
    '',
    'This pull request is a draft. Before the crew marks it ready:',
    ...list([
      'Review the added files and confirm they suit this project.',
      ...(unitFound ? ['Confirm the `Unit:` line above. The installer set it to `none`, since this pull request implements no unit of the project\'s.'] : []),
      ...(others.length > 0
        ? [`Complete what this project's template asks of a pull request beyond the sections steward fills: ${others.map((h) => `\`${h}\``).join(', ')}.`]
        : []),
      ...(unchecked > 0 ? [`Tick or remove the ${unchecked} unchecked item${unchecked === 1 ? '' : 's'} in the template above that the installer could not decide.`] : []),
      ...(preserved.length > 0
        ? ['Check the files left as they were. The installer did not validate them or check that they work with the steward installed here.']
        : []),
      'Merge it through the project\'s existing process. Steward\'s gate cannot review the pull request that installs it, and where the project already has a gate, its rules still apply: the installer bypassed none.',
      'Merging this starts nothing on any machine: running steward on a machine is a separate step, and nothing here grants permission for it.',
      'Optionally, once it has merged, run `steward protect` to have GitHub stop a merge that has not passed review.',
    ]),
  )
  return out
}

function verificationBlock(facts) {
  return [
    'Checks `steward init` ran while making this pull request, and their results:',
    ...list(facts.checks),
    '',
    'Not run: the project\'s tests, setup and checks, and no steward review. Files left as they were were not validated, and nothing here claims that an existing installation is compatible with this one.',
  ]
}

function docsBlock() {
  return ['`steward init` did not check or change the project\'s README or its other documentation. The crew should check whether any of it needs a note about steward.']
}
