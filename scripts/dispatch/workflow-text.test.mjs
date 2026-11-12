import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as prettier from 'prettier'
import { sameWorkflowApartFromPin } from './workflow-text.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const template = readFileSync(path.join(ROOT, 'templates', 'workflows', 'review-gate.yml'), 'utf8')
const fill = (pin) => template.replaceAll('v{{STEWARD_VERSION}}', () => pin)

describe('ST-79/AC-1: a workflow is a template with only the pin different', () => {
  it('ST-79/AC-1: a template filled with two different pins matches, and matches the template itself', () => {
    expect(sameWorkflowApartFromPin(fill('v0.1.0'), fill('v9.9.9'))).toBe(true)
    expect(sameWorkflowApartFromPin(fill('0123456789abcdef0123456789abcdef01234567'), fill('v0.1.0'))).toBe(true)
    expect(sameWorkflowApartFromPin(fill('v0.1.0'), template)).toBe(true)
  })

  it('ST-79/AC-1: line endings are ignored', () => {
    expect(sameWorkflowApartFromPin(fill('v0.1.0').replaceAll('\n', '\r\n'), fill('v0.2.0'))).toBe(true)
  })

  it('ST-79/AC-1: one other line changed, added or removed does not match', () => {
    const text = fill('v0.1.0')
    const lines = text.split('\n')
    const index = lines.findIndex((line) => line.startsWith('name:'))
    expect(index).toBeGreaterThanOrEqual(0)
    const changed = lines.map((line, i) => (i === index ? `${line} (mine)` : line)).join('\n')
    expect(sameWorkflowApartFromPin(changed, text)).toBe(false)
    expect(sameWorkflowApartFromPin(`${text}# more\n`, text)).toBe(false)
    expect(sameWorkflowApartFromPin(lines.filter((_, i) => i !== index).join('\n'), text)).toBe(false)
    expect(sameWorkflowApartFromPin(text.replace('github:luplows/steward#', 'github:someone/else#'), text)).toBe(false)
  })
})

// ------------------------------------------------------------------ ST-96: quotes

/** The one Prettier version steward pins, exactly, as a development dependency. */
const PRETTIER = '3.9.10'
const RELEASES = ['v0.1.0', 'v0.2.0']
const SHA = '0123456789abcdef0123456789abcdef01234567'
const FILES = readdirSync(path.join(ROOT, 'templates', 'workflows')).filter((file) => file.endsWith('.yml')).sort()

/** A managed template at a release tag of steward's repository, or the current one for null. */
const templateAt = (ref, file) =>
  ref === null
    ? readFileSync(path.join(ROOT, 'templates', 'workflows', file), 'utf8')
    : execFileSync('git', ['show', `${ref}:templates/workflows/${file}`], { cwd: ROOT, encoding: 'utf8' })
const filled = (text, pin) => text.replaceAll('v{{STEWARD_VERSION}}', () => pin)

/**
 * Prettier's default options, or `options` over them: only the file's path, from which it picks
 * the YAML parser. Through the API, Prettier resolves no configuration file unless asked to, so no
 * project's settings, nor steward's, take part.
 */
const formatted = (file, text, options = {}) => prettier.format(text, { filepath: `.github/workflows/${file}`, ...options })

describe("ST-96/AC-4: what Prettier's defaults do to each managed template is accepted", () => {
  it('ST-96/AC-4: the Prettier that formats is the one version steward pins, and the templates are the three managed workflows', () => {
    expect(prettier.version).toBe(PRETTIER)
    expect(FILES).toEqual(['inspection.yml', 'land-approved.yml', 'review-gate.yml'])
  })

  it('ST-96/AC-4: each template, current and at v0.1.0 and v0.2.0, filled and formatted, matches the template at its tag, LF or CRLF', async () => {
    let changed = 0
    for (const ref of [null, ...RELEASES]) {
      for (const file of FILES) {
        const original = templateAt(ref, file)
        for (const pin of [ref ?? 'v9.8.7', SHA]) {
          const installed = filled(original, pin)
          const after = await formatted(file, installed)
          if (after !== installed) changed++
          expect(sameWorkflowApartFromPin(after, original), `${ref} ${file} ${pin}`).toBe(true)
          expect(sameWorkflowApartFromPin(after.replaceAll('\n', '\r\n'), filled(original, 'v0.0.1')), `${ref} ${file} ${pin}`).toBe(true)
        }
      }
    }
    // The releases' land-approved.yml and inspection.yml quote values with single quotes, which
    // Prettier's defaults make double: the v0.2.0 rollout's case. Nothing else changes.
    expect(changed).toBe(8)
  })

  it('ST-96/AC-4: the change Prettier made at the releases is to quotes alone: the same lines, each with the same text up to its quote', async () => {
    for (const ref of RELEASES) {
      for (const file of ['inspection.yml', 'land-approved.yml']) {
        const before = filled(templateAt(ref, file), ref).split('\n')
        const after = (await formatted(file, filled(templateAt(ref, file), ref))).split('\n')
        expect(after.length).toBe(before.length)
        const differing = before.map((line, i) => [line, after[i]]).filter(([a, b]) => a !== b)
        expect(differing.length).toBeGreaterThan(0)
        for (const [a, b] of differing) {
          expect(b.startsWith(a.slice(0, a.indexOf("'")))).toBe(true)
          expect(a.endsWith("'") && b.endsWith('"')).toBe(true)
        }
      }
    }
  })

  it("ST-96/AC-4: what Prettier's defaults make of a value holding a single quote is accepted, in either direction", async () => {
    const single = "on:\n  workflow_dispatch:\n    inputs:\n      pr:\n        description: 'the crew''s pull request'\n"
    const double = await formatted('x.yml', single)
    expect(double).toBe('on:\n  workflow_dispatch:\n    inputs:\n      pr:\n        description: "the crew\'s pull request"\n')
    expect(sameWorkflowApartFromPin(double, single)).toBe(true)
    expect(sameWorkflowApartFromPin(single, double)).toBe(true)
  })

  it("ST-96/AC-4: Prettier with settings other than its defaults, indenting by 4 or wrapping at 20 columns, is refused", async () => {
    const cases = [...FILES.map((file) => [file, { tabWidth: 4 }]), ['review-gate.yml', { printWidth: 20 }]]
    for (const [file, options] of cases) {
      const original = templateAt(null, file)
      const after = await formatted(file, filled(original, 'v9.8.7'), options)
      expect(after, `${file} ${JSON.stringify(options)}`).not.toBe(filled(original, 'v9.8.7'))
      expect(sameWorkflowApartFromPin(after, original), `${file} ${JSON.stringify(options)}`).toBe(false)
    }
  })
})

describe("ST-96/AC-1: the one formatting change accepted, a quoted value's quotes", () => {
  const pair = (a, b) => sameWorkflowApartFromPin(`on:\n  push:\nenv:\n  A: ${a}\n`, `on:\n  push:\nenv:\n  A: ${b}\n`)

  it("ST-96/AC-1: single and double quotes holding the same value match, the single quote's escape included", () => {
    expect(pair("'x y'", '"x y"')).toBe(true)
    expect(pair('"x y"', "'x y'")).toBe(true)
    expect(pair("''", '""')).toBe(true)
    expect(pair("'it''s'", '"it\'s"')).toBe(true)
    expect(pair("'# not a comment'", '"# not a comment"')).toBe(true)
    expect(pair("'${{ github.token }}'", '"${{ github.token }}"')).toBe(true)
  })

  it('ST-96/AC-1: a sequence entry with a key matches too', () => {
    expect(sameWorkflowApartFromPin("on:\n  schedule:\n    - cron: '17 6 * * *'\n", 'on:\n  schedule:\n    - cron: "17 6 * * *"\n')).toBe(true)
  })

  it('ST-96/AC-1: a different value, or the escape misread, does not match', () => {
    expect(pair("'x y'", '"x z"')).toBe(false)
    expect(pair("'it''s'", '"it\'\'s"')).toBe(false)
    expect(pair("'it''s'", "'it's'")).toBe(false)
  })

  it('ST-96/AC-1: a double-quoted value with a backslash does not match, whatever it holds', () => {
    expect(pair("'a\\b'", '"a\\\\b"')).toBe(false)
    expect(pair("'say \"hi\"'", '"say \\"hi\\""')).toBe(false)
    expect(pair("'x y'", '"x\\x20y"')).toBe(false)
  })

  it('ST-96/AC-1: a quoted value and a plain one, though YAML may read them alike, do not match', () => {
    expect(pair("'x y'", 'x y')).toBe(false)
    expect(pair('"24"', '24')).toBe(false)
  })
})

describe('ST-96/AC-2: any other difference does not match, though the YAML parses', () => {
  const PIN = 'v0.1.0'
  const inspection = templateAt(PIN, 'inspection.yml')
  const gate = templateAt(PIN, 'review-gate.yml')
  /** The release's inspection.yml as Prettier's defaults format it, with `edit` applied. */
  const variant = async (edit) => edit(await formatted('inspection.yml', filled(inspection, PIN)))

  it("ST-96/AC-2: the formatted release workflow itself matches, so each edit below is what makes it differ", async () => {
    const text = await variant((t) => t)
    expect(text).toContain('- cron: "17 6 * * *"')
    expect(sameWorkflowApartFromPin(text, inspection)).toBe(true)
  })

  it('ST-96/AC-2: a changed trigger, permission, command, expression or value does not match', async () => {
    for (const edit of [
      (t) => t.replace('"17 6 * * *"', '"17 7 * * *"'),
      (t) => t.replace('  workflow_dispatch:\n', '  push:\n'),
      (t) => t.replace('contents: read', 'contents: write'),
      (t) => t.replace('steward inspect', 'steward runway'),
      (t) => t.replace('${{ github.token }}', '${{ secrets.TOKEN }}'),
      (t) => t.replace('node-version: 24', 'node-version: "24"'),
      (t) => t.replace('- cron: "17 6 * * *"', '- cron: 17 6 * * *'),
    ]) {
      const text = await variant(edit)
      expect(text, String(edit)).not.toBe(await variant((t) => t))
      expect(sameWorkflowApartFromPin(text, inspection), String(edit)).toBe(false)
    }
  })

  it("ST-96/AC-2: an altered or reordered comment, or a comment's quotes changed, does not match", async () => {
    const comment = '  # To read the `review/agent` statuses.\n'
    const plain = await variant((t) => t)
    expect(plain).toContain(`${comment}  statuses: read\n`)
    expect(sameWorkflowApartFromPin(plain.replace(comment, '  # To read statuses.\n'), inspection)).toBe(false)
    expect(sameWorkflowApartFromPin(plain.replace(`${comment}  statuses: read\n`, `  statuses: read\n${comment}`), inspection)).toBe(false)
    const formattedGate = await formatted('review-gate.yml', filled(gate, PIN))
    expect(sameWorkflowApartFromPin(formattedGate, gate)).toBe(true)
    expect(formattedGate).toContain('"no dismissal mechanism"')
    expect(sameWorkflowApartFromPin(formattedGate.replace('"no dismissal mechanism"', "'no dismissal mechanism'"), gate)).toBe(false)
  })

  it("ST-96/AC-2: quotes changed in a block scalar's content do not match", async () => {
    const formattedGate = await formatted('review-gate.yml', filled(gate, PIN))
    expect(formattedGate).toContain("github.event_name == 'issue_comment'")
    expect(sameWorkflowApartFromPin(formattedGate.replace("'issue_comment'", '"issue_comment"'), gate)).toBe(false)
    expect(sameWorkflowApartFromPin('run: |\n  k: "x"\nname: a\n', "run: |\n  k: 'x'\nname: a\n")).toBe(false)
  })

  it('ST-96/AC-2: an added or removed entry does not match', async () => {
    const plain = await variant((t) => t)
    expect(sameWorkflowApartFromPin(plain.replace('  contents: read\n', '  contents: read\n  actions: write\n'), inspection)).toBe(false)
    expect(sameWorkflowApartFromPin(plain.replace('  statuses: read\n', ''), inspection)).toBe(false)
  })

  it('ST-96/AC-2: a pin reference to another repository does not match', async () => {
    const plain = await variant((t) => t)
    expect(plain).toContain('github:luplows/steward#')
    expect(sameWorkflowApartFromPin(plain.replace('github:luplows/steward#', 'github:someone/steward#'), inspection)).toBe(false)
    expect(sameWorkflowApartFromPin('A: "npx github:someone/else#v1"\n', "A: 'npx github:luplows/steward#v1'\n")).toBe(false)
  })

  it('ST-96/AC-2: other formatting does not match: indentation, spacing, a trailing comment or trailing space', async () => {
    const line = '    - cron: "17 6 * * *"\n'
    expect(await variant((t) => t)).toContain(line)
    for (const edit of [
      (t) => t.replace(line, '      - cron: "17 6 * * *"\n'),
      (t) => t.replace(line, '    - cron:  "17 6 * * *"\n'),
      (t) => t.replace(line, '    - cron: "17 6 * * *" # daily\n'),
      (t) => t.replace(line, '    - cron: "17 6 * * *" \n'),
      (t) => t.replace('timeout-minutes: 10', 'timeout-minutes:  10'),
    ]) {
      const text = await variant(edit)
      expect(text, String(edit)).not.toBe(await variant((t) => t))
      expect(sameWorkflowApartFromPin(text, inspection), String(edit)).toBe(false)
    }
  })

  it('ST-96/AC-2: a malformed quoted value does not match', async () => {
    for (const edit of [
      (t) => t.replace('"17 6 * * *"', '"17 6 * * *'),
      (t) => t.replace('"17 6 * * *"', '"17 6 * * *"\''),
      (t) => t.replace('"17 6 * * *"', '"17 6 "* * *"'),
    ]) {
      expect(sameWorkflowApartFromPin(await variant(edit), inspection), String(edit)).toBe(false)
    }
  })

  it("ST-96/AC-2: a template with a quote on a line the comparison cannot place lets no line's quotes differ", () => {
    // The control: with no such quote, the same change of quotes matches.
    expect(sameWorkflowApartFromPin('a: "x"\nrun: echo y\n', "a: 'x'\nrun: echo y\n")).toBe(true)
    // A quote in a plain scalar.
    expect(sameWorkflowApartFromPin('a: "x"\nrun: echo \'y\'\n', "a: 'x'\nrun: echo 'y'\n")).toBe(false)
    // A double-quoted scalar continued over lines, holding what looks like a quoted line.
    expect(sameWorkflowApartFromPin('a: "one\n  k: "two"\n  three"\n', "a: \"one\n  k: 'two'\n  three\"\n")).toBe(false)
    // A sequence entry with no key, which may continue a plain scalar.
    expect(sameWorkflowApartFromPin('a: b\n  - "x"\n', "a: b\n  - 'x'\n")).toBe(false)
    // A block scalar whose header has no key, so its content's indentation is not bounded by it.
    expect(sameWorkflowApartFromPin('a:\n  |\n  k: "x"\n', "a:\n  |\n  k: 'x'\n")).toBe(false)
  })
})

describe('ST-96/AC-5: Prettier is a development dependency only', () => {
  it('ST-96/AC-5: package.json pins it exactly as a development dependency, and as no other kind of dependency', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.devDependencies.prettier).toBe(PRETTIER)
    for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
      expect(pkg[kind]?.prettier, kind).toBeUndefined()
    }
  })

  it('ST-96/AC-5: no script under scripts/ but a test imports or requires it', () => {
    const scripts = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? scripts(path.join(dir, e.name))
          : /\.[cm]?js$/.test(e.name) && !/\.test\.[cm]?js$/.test(e.name)
            ? [path.join(dir, e.name)]
            : [],
      )
    const files = scripts(path.join(ROOT, 'scripts'))
    expect(files).toContain(path.join(ROOT, 'scripts', 'dispatch', 'workflow-text.mjs'))
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/from\s+['"]prettier|import\(\s*['"]prettier|require\(\s*['"]prettier/)
    }
  })
})

describe('ST-96/AC-6: the design document', () => {
  it('ST-96/AC-6: the Planned (ST-96) marker is gone from the design document', () => {
    expect(readFileSync(path.join(ROOT, 'docs', 'agent-workflow-design.md'), 'utf8')).not.toMatch(/Planned \(ST-96\)/)
  })
})
