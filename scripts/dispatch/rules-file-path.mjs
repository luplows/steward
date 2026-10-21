// The one definition of a valid `rulesFile`, the settings' path to the project's checklist
// (ST-40). `readSettings` (`settings.mjs`) refuses a settings file whose `rulesFile` fails it, and
// the reviewer's prompt takes it inline as `{{RULES_FILE}}` (`invocation.mjs`, `TRUSTED_INLINE`)
// only when it passes, so a settings file that reads can never make a review's prompt refuse it.
// Pure: it imports nothing, reads nothing and starts nothing.

/**
 * Whether `value` is a valid `rulesFile`: a non-empty relative path with forward slashes, neither
 * absolute (no leading `/`, no drive letter) nor holding a backslash, an empty segment or a `..`
 * segment; and, since the prompt gives it inside inline code in a sentence, holding no control
 * character (a newline among them), no backtick, and no `<` or `>`, so that it can carry neither
 * a heading nor a marker (`<!-- … -->`). Windows allows no `<` or `>` in a file name either.
 */
export function isRulesFilePath(value) {
  if (typeof value !== 'string' || value === '') return false
  const isControl = (ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f
  if ([...value].some(isControl) || /[`<>]/.test(value)) return false
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  return value.split('/').every((segment) => segment !== '' && segment !== '..')
}
