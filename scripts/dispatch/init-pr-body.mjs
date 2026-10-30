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

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/
const UNIT_LINE = /^[ \t]*Unit:.*$/

const list = (items) => items.map((item) => `- ${item}`)

const headingTitle = (match) => match[2].trim().replace(/[ \t]+/g, ' ')

/** Quote literal Git names and project headings without letting their backticks open HTML. */
function code(value) {
  if (/[\r\n]/.test(value)) value = JSON.stringify(value)
  const delimiter = (value.match(/`+/g) ?? []).reduce((best, run) => run.length >= best.length ? `${run}\`` : best, '`')
  const pad = value.trim() !== '' && /^[ `]|[ `]$/.test(value) ? ' ' : ''
  return `${delimiter}${pad}${value}${pad}${delimiter}`
}

// Consume escaped pairs and complete same-line code spans before recognizing HTML comments.
const INLINE = /\\.|(`+)(?!`).*?(?<!`)\1(?!`)|`+|<!--.*?(?:-->|$)/g

/**
 * Read visible template lines without editing their source. HTML comments span lines; fenced
 * examples are opaque, and escaped/inline-code comment markers do not open HTML comments.
 * `safe[i]` records boundaries at which generated Markdown cannot fall inside either block.
 */
function templateVisibility(lines) {
  let comment = false
  let fence = null
  const safe = []
  const visible = lines.map((line, index) => {
    safe[index] = !comment && fence === null
    if (fence !== null) {
      if (new RegExp(`^ {0,3}${fence.char}{${fence.length},}[ \\t]*$`).test(line)) fence = null
      return { text: '', comments: [], heading: null }
    }
    const opening = !comment && /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      fence = { char: opening[1][0], length: opening[1].length }
      return { text: '', comments: [], heading: null }
    }
    const comments = []
    let text = line
    if (comment) {
      const closing = line.indexOf('-->')
      const end = closing === -1 ? line.length : closing + 3
      comments.push(line.slice(0, end))
      text = line.slice(end)
      comment = closing === -1
    }
    text = text.replace(INLINE, (token) => {
      if (!token.startsWith('<!--')) return token
      comments.push(token)
      comment = !token.endsWith('-->')
      return ''
    })
    // A comment ending before a hash on the same line must not invent an ATX heading.
    const heading = safe[index] && /^ {0,3}#{1,6}[ \t]/.test(line) ? HEADING.exec(text) : null
    return { text, comments, heading }
  })
  safe[lines.length] = !comment && fence === null
  return { visible, safe }
}

/**
 * The pull request body: `skeleton` (the text of the project's template, or of steward's) with its
 * `Unit:` line set to `none`, each of its What changed, Verification and Docs check sections that
 * it has completed after its own prompts, and, for any of the three it lacks, a labelled
 * "Installation summary" section that holds that part. Generated blocks are placed outside
 * comments/examples; an unfinished trailing block stays after the generated facts.
 *
 * `facts`: `repo`, `branch`, `baseSha`; `version` (the running installer package's version),
 * `pin` (the installation workflow target, as text, even when workflows were preserved) and
 * `workflowsAdded`; `added` (`{ rel, note }` for each file created) and `preserved` (paths left as
 * they were); `land` (`true`, `false`, or `null` when the settings file was not added); `checks`
 * (what `init` verified, one sentence each, every one of which passed); `emptyTemplates` (template
 * directories with no file in them).
 */
export function composePullRequestBody({ skeleton, facts }) {
  const eol = skeleton.includes('\r\n') ? '\r\n' : '\n'
  const lines = skeleton.split(/\r?\n/)
  while (lines.length > 0 && lines.at(-1) === '') lines.pop()

  const { visible, safe } = templateVisibility(lines)
  const unitIndex = lines.findIndex((line, index) => safe[index] && UNIT_LINE.test(line) && UNIT_LINE.test(visible[index].text))
  if (unitIndex !== -1) lines[unitIndex] = 'Unit: none' + visible[unitIndex].comments.map((text) => ` ${text}`).join('')

  const unchecked = visible.filter(({ text }) => /^[ \t]*[-*][ \t]+\[ \]/.test(text)).length
  const others = visible.filter(({ heading }) => heading && !SECTIONS.some((section) => section.pattern.test(headingTitle(heading))))
    .map(({ text }) => text.trim())
  const blocks = {
    changed: changedBlock(facts, { unitFound: unitIndex !== -1, others, unchecked }),
    verification: verificationBlock(facts),
    docs: docsBlock(),
  }

  const missing = []
  const insertions = new Map()
  const add = (index, content) => insertions.set(index, [...(insertions.get(index) ?? []), ...content])
  const safeBoundary = (index, minimum = 0) => {
    while (index >= minimum && !safe[index]) index--
    return index
  }
  for (const section of SECTIONS) {
    const headingIndex = visible.findIndex(({ heading }) => heading && section.pattern.test(headingTitle(heading)))
    if (headingIndex === -1) {
      missing.push(section)
      continue
    }
    let end = lines.length
    for (let i = headingIndex + 1; i < lines.length; i++) {
      if (visible[i].heading) {
        end = i
        break
      }
    }
    while (end > headingIndex + 1 && lines[end - 1].trim() === '') end--
    end = safeBoundary(end, headingIndex + 1)
    if (end <= headingIndex) {
      missing.push(section)
      continue
    }
    add(end, ['', ...blocks[section.key], ...(end < lines.length && lines[end].trim() !== '' ? [''] : [])])
  }

  if (missing.length > 0) {
    const summary = ['', '## Installation summary', '',
      'This section holds what `steward init` knows about the installation, because the template above has no section for it.']
    for (const section of missing) summary.push('', `**${section.title}**`, '', ...blocks[section.key])
    const end = safeBoundary(lines.length)
    add(end, [...summary, ...(end < lines.length ? [''] : [])])
  }
  // Render original lines once; generated content is never scanned as part of the template.
  const body = lines.flatMap((line, index) => [...(insertions.get(index) ?? []), line])
  body.push(...(insertions.get(lines.length) ?? []))
  return `${body.join(eol)}${eol}`
}

function changedBlock(facts, { unitFound, others, unchecked }) {
  const { repo, branch, baseSha, version, pin, workflowsAdded, added, preserved, land, emptyTemplates = [] } = facts
  const left = [
    ...preserved.map(code),
    ...emptyTemplates.map((dir) => `${code(dir)}: an empty template directory, which counts as no pull request template`),
  ]
  const out = [
    `This pull request installs steward's review gate in ${repo}. \`steward init\` made it on branch ${code(branch)}, from \`main\` at commit ${code(baseSha)}. It adds files only: it changes none that already exist.`,
    '',
    'Added:',
    ...list(added.map((a) => `${code(a.rel)}: ${a.note}`)),
    '',
    left.length === 0 ? 'Left as they were: none, since every file steward installs was missing.' : 'Left as they were (already in the project):',
    ...list(left),
  ]
  out.push('')
  out.push(`Generated by steward v${version}. Installation workflow target: ${pin}.`)
  out.push(workflowsAdded
    ? `The workflow files added here run steward ${pin}.`
    : 'No workflow file was added here, so this pull request installs no version of steward. Existing workflow files and pins were preserved; their pins were not validated.')
  if (land === true) out.push('`steward.config.json` sets `land` to `true`: unattended landing was chosen explicitly.')
  if (land === false) out.push('`steward.config.json` sets `land` to `false`: steward reviews pull requests and does not land any unattended; a pull request that has passed review can still be landed on request with `steward land <pr-number>`.')
  out.push(
    '',
    'This pull request is a draft. Before the crew marks it ready:',
    ...list([
      'Review the added files and confirm they suit this project.',
      ...(unitFound ? ['Confirm the `Unit:` line above. The installer set it to `none`, since this pull request implements no unit of the project\'s.'] : []),
      ...(others.length > 0
        ? [`Complete what this project's template asks of a pull request beyond the sections steward fills: ${others.map(code).join(', ')}.`]
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
    'All Git hooks were disabled in the installation worktree, including checkout, commit and push hooks. The crew must run necessary project-specific checks before approving this installation.',
    '',
    'Not run: the project\'s tests, setup and checks, and no steward review. Files left as they were were not validated, and nothing here claims that an existing installation is compatible with this one.',
  ]
}

function docsBlock() {
  return ['`steward init` did not check or change the project\'s README or its other documentation. The crew should check whether any of it needs a note about steward.']
}
