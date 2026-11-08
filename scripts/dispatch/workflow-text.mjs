// Comparing an installed workflow with a template, apart from the pin. Pure: text in, answer out.
// `init` uses it to tell its own workflows from a project's (ST-79); ST-69 imports it to compare an
// installed workflow with a template read from GitHub at another pin.

/** The pin in a thin workflow: the reference after `github:luplows/steward#`, up to whitespace. */
const PIN_RE = /github:luplows\/steward#\S+/g

const normalised = (text) => text.replace(/\r\n?/g, '\n').replace(PIN_RE, 'github:luplows/steward#<pin>')

/**
 * Whether `installed` is `template` with only the pin different. The pin is the reference after
 * `github:luplows/steward#`, whatever it is, in the installed text and in the template alike (the
 * template may still hold its `{{STEWARD_VERSION}}` placeholder, or a filled pin). Line endings are
 * ignored. Any other line changed, added or removed makes it false.
 */
export function sameWorkflowApartFromPin(installed, template) {
  return normalised(installed) === normalised(template)
}
