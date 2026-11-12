// Comparing an installed workflow with a template, apart from the pin, line endings and one change
// of formatting. Pure: text in, answer out. `init` uses it to tell its own workflows from a
// project's (ST-79), and `upgrade` (ST-69) to compare an installed workflow with a template read
// from GitHub at another pin.
//
// The change of formatting (ST-96) is the only one Prettier's default options make to steward's
// managed workflow templates, current and at `v0.1.0` and `v0.2.0`, which `workflow-text.test.mjs`
// checks with the Prettier version steward's `package.json` pins as a development dependency;
// nothing here imports Prettier or reads any formatter's settings. It is a line `key: <scalar>`
// (after any `- `), its scalar quoted and ending the line, written with single quotes in one text
// and double quotes, with no backslash, in the other, holding the same value. The template's line
// must be outside block scalar content, and the template must have no line that `mayDiffer`,
// below, cannot place. Every other line must be the same text. A difference it cannot prove to be
// that change makes the workflow differ. It is not a YAML parser, and recognises no other
// formatting.

/** The pin in a thin workflow: the reference after `github:luplows/steward#`, up to whitespace. */
const PIN_RE = /github:luplows\/steward#\S+/g

const normalised = (text) => text.replace(/\r\n?/g, '\n').replace(PIN_RE, 'github:luplows/steward#<pin>')

/**
 * A line whose value is one quoted scalar ending the line: indentation, any sequence entries
 * (`- `), a plain key of letters, digits, `_` and `-` (`key: `), then a single-quoted scalar
 * (whose one escape is `''`) or a double-quoted scalar with no backslash in it. Group 1 is the
 * line up to the quote, group 2 the scalar. A plain key is required because `: ` cannot occur in
 * a plain scalar, so such a line is never the continuation of one.
 */
const QUOTED_LINE = /^( *(?:- +)*[\w-]+: +)('(?:[^']|'')*'|"[^"\\]*")$/

/** A line ending as a block scalar header does: `|` or `>`, any indicators, maybe a comment. */
const BLOCK_HEADER = /(?:^|\s)[|>][-+0-9]*\s*(?:#.*)?$/

/** A line starting, after indentation and any sequence entries, with a plain key (`key: `). */
const KEYED = /^ *(?:- +)*[\w-]+: /

/** The parts of a line `QUOTED_LINE` matches, with its scalar's value, or null. */
function quotedLine(line) {
  const m = QUOTED_LINE.exec(line)
  if (m === null) return null
  const scalar = m[2]
  return { prefix: m[1], value: scalar.startsWith("'") ? scalar.slice(1, -1).replaceAll("''", "'") : scalar.slice(1, -1) }
}

/**
 * For each of the template's lines, whether its quotes may differ: whether it is a `QUOTED_LINE`
 * outside a block scalar's content. Null when the template has a quote, outside full-line comments
 * and block scalar content, on a line that is not a `QUOTED_LINE` (a quoted scalar continued on
 * the next line, a flow sequence holding a quoted scalar, a quote in a plain scalar or a trailing
 * comment), or a line ending in a block scalar's indicator that does not start with a plain key
 * (`KEYED`): then no line's may. A block scalar's content is taken to be every line after its
 * header that is blank or indented more than the header line. The header starts with a plain key,
 * and YAML indents the content more than that key, so these are never fewer lines than YAML counts.
 */
function mayDiffer(lines) {
  const result = []
  let header = null
  for (const line of lines) {
    const indent = line.length - line.trimStart().length
    if (header !== null && (line.trim() === '' || indent > header)) {
      result.push(false)
      continue
    }
    header = null
    const trimmed = line.trimStart()
    if (trimmed === '' || trimmed.startsWith('#')) {
      result.push(false)
      continue
    }
    const quoted = quotedLine(line) !== null
    if (!quoted && /['"]/.test(line)) return null
    if (!quoted && BLOCK_HEADER.test(line)) {
      if (!KEYED.test(line)) return null
      header = indent
    }
    result.push(quoted)
  }
  return result
}

/**
 * Whether `installed` is `template` apart from the pin, line endings and the change of quotes
 * described at the top of this file. The pin is the reference after `github:luplows/steward#`,
 * whatever it is, in the installed text and in the template alike (the template may still hold its
 * `{{STEWARD_VERSION}}` placeholder, or a filled pin). Otherwise it is true only when the two have
 * the same number of lines and each line of the installed text is the template's, or the
 * template's line is one whose quotes may differ (`mayDiffer`) and the installed line is a
 * `QUOTED_LINE` with the same text up to the quote and a scalar of the same value.
 */
export function sameWorkflowApartFromPin(installed, template) {
  const [mine, theirs] = [normalised(installed), normalised(template)]
  if (mine === theirs) return true
  const [a, b] = [mine.split('\n'), theirs.split('\n')]
  if (a.length !== b.length) return false
  const allowed = mayDiffer(b)
  if (allowed === null) return false
  return b.every((line, i) => {
    if (a[i] === line) return true
    if (!allowed[i]) return false
    const [x, y] = [quotedLine(a[i]), quotedLine(line)]
    return x !== null && x.prefix === y.prefix && x.value === y.value
  })
}
