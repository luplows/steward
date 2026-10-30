// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { BREAKER_OVERRIDE_LABEL, REVIEW_BLOCKED_LABEL } from '../land/runway.mjs'
import { REVIEW_BLOCKED_LABEL as APPLY_REVIEW_BLOCKED_LABEL } from '../land/apply-review-blocked.mjs'
import { INSPECTION_LABEL } from './inspect.mjs'
import {
  assertAllowedRequest,
  findOnPath,
  GATE_WORKFLOWS,
  INSPECTION_WORKFLOW,
  LABELS,
  QUESTIONS,
  repoFromRemoteUrl,
} from './init.mjs'
import {
  ALL_FLAGS,
  branchFiles,
  bytesOn,
  CLI,
  fakeGitHub,
  fakeTerminal,
  fresh,
  git,
  hasOn,
  labelWrites,
  makePackage,
  makeRepo,
  mergeInstall,
  read,
  readOn,
  REPO,
  ROOT,
  runInit,
  SHA,
  snapshot,
  tree,
  setUpInitFixture,
  writes,
} from './init-fixture.mjs'
import { readUserConfig } from './user-config.mjs'
import { createLandContext, landPullRequest } from './land.mjs'
import { readSettings } from './settings.mjs'
import { runRunway } from '../land/runway.mjs'
import { fakeGitHub as fakeRunwayGitHub, pull as runwayPull } from '../land/runway-fake.mjs'

setUpInitFixture()

describe('ST-44/AC-1: init never overwrites, and names what it left', () => {
  it('ST-44/AC-1: a second run, once the installation has merged, writes nothing and names every file it wrote the first time', async () => {
    const cwd = makeRepo()
    const gh = fakeGitHub()
    const machine = path.join(fresh('home'), 'config.json')
    const pkg = makePackage()
    const first = await runInit(['--yes'], { cwd, gh, machine, pkg })
    expect(first.code).toBe(0)
    const wrote = [...first.out.matchAll(/^wrote (.+)$/gm)].map((m) => m[1])
    expect(wrote.length).toBeGreaterThanOrEqual(7)
    mergeInstall(cwd)
    const before = tree(cwd).map((rel) => [rel, read(cwd, rel)])
    const settingsBefore = readFileSync(machine, 'utf8')

    const second = await runInit(['--yes'], { cwd, gh, machine, pkg })
    expect(second.code).toBe(0)
    expect(second.out).not.toMatch(/^wrote /m)
    for (const rel of wrote.filter((w) => !w.includes("the user config"))) expect(second.out).toContain(`left ${rel}: `)
    expect(second.out).toContain(`left ${machine}`)
    expect(tree(cwd).map((rel) => [rel, read(cwd, rel)])).toEqual(before)
    expect(readFileSync(machine, 'utf8')).toBe(settingsBefore)
  })

  it('ST-44/AC-1: a file already there, with other content, keeps it', async () => {
    const cwd = makeRepo({ files: { 'REVIEW.md': 'my rules\n', '.github/workflows/review-gate.yml': 'mine\n', 'steward.config.json': '{"rulesFile":"REVIEW.md"}\n' } })
    const { code, out, err } = await runInit(['--yes'], { cwd })
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(read(cwd, 'REVIEW.md')).toBe('my rules\n')
    expect(read(cwd, '.github/workflows/review-gate.yml')).toBe('mine\n')
    expect(read(cwd, 'steward.config.json')).toBe('{"rulesFile":"REVIEW.md"}\n')
    expect(readOn(cwd, 'REVIEW.md')).toBe('my rules\n')
    expect(readOn(cwd, '.github/workflows/review-gate.yml')).toBe('mine\n')
    expect(readOn(cwd, 'steward.config.json')).toBe('{"rulesFile":"REVIEW.md"}\n')
    for (const rel of ['REVIEW.md', '.github/workflows/review-gate.yml', 'steward.config.json']) {
      expect(out).toContain(`left ${rel}: already there`)
    }
  })

  it('ST-44/AC-1: is a command of cli.mjs, runs no model, and a checkout that is not a git repository is refused', () => {
    const dir = fresh('not-a-repo')
    let result
    try {
      // The fixture's GIT_* confinement is itself refused by AC-1b. This subprocess exercises
      // ordinary checkout discovery, with no repository or remote on which it could act.
      const profile = fresh('cli-profile')
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
      execFileSync(process.execPath, [CLI, 'init', '--yes'], { cwd: dir, env: { ...env, HOME: profile, USERPROFILE: profile, XDG_CONFIG_HOME: profile }, encoding: 'utf8', stdio: 'pipe' })
    } catch (error) {
      result = error
    }
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/not in a git repository/)
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('ST-44/AC-2: asking', () => {
  it('ST-44/AC-2: every question answered by flags asks nothing, and refuses nothing with no terminal', async () => {
    const cwd = makeRepo()
    const terminal = fakeTerminal()
    const { code, err, view } = await runInit(ALL_FLAGS, { cwd, terminal })
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(terminal.prompts).toEqual([])
    const settings = await readSettings(view)
    expect(settings).toMatchObject({ unitLinks: ['file', 'issue', 'other'], rulesFile: 'docs/RULES.md', land: false, inspectAfterHours: 48 })
  })

  it('ST-44/AC-2: --yes alone takes every default', async () => {
    const cwd = makeRepo()
    const machine = path.join(fresh('home'), 'config.json')
    const gh = fakeGitHub()
    const { code, view } = await runInit(['--yes'], { cwd, machine, gh })
    expect(code).toBe(0)
    expect(await readSettings(view)).toMatchObject({ unitLinks: ['file', 'issue'], rulesFile: 'REVIEW.md', land: false, inspectAfterHours: 24 })
    expect(hasOn(cwd, '.github/workflows/inspection.yml')).toBe(true)
    expect(writes(gh).some((r) => r.rest === '/branches/main/protection')).toBe(false)
  })

  it('ST-44/AC-2: with no terminal and no answer it refuses, names each question and its flag, and writes nothing', async () => {
    const cwd = makeRepo()
    const gh = fakeGitHub()
    const machine = path.join(fresh('home'), 'config.json')
    const before = tree(cwd)
    const { code, err } = await runInit([], { cwd, gh, machine })
    expect(code).toBe(2)
    for (const flag of ['--unit-links', '--rules-file', '--land', '--inspect-after-hours', '--inspection', '--coder-session-limit']) {
      expect(err).toContain(flag)
    }
    expect(err).toContain('Nothing was written')
    expect(tree(cwd)).toEqual(before)
    expect(existsSync(machine)).toBe(false)
    expect(gh.requests).toEqual([])
  })

  it('ST-44/AC-2: one question left unanswered is the one named', async () => {
    const cwd = makeRepo()
    const flags = ALL_FLAGS.filter((_, i) => !(i >= 2 && i <= 3))
    const { code, err } = await runInit(flags, { cwd })
    expect(code).toBe(2)
    expect(err).toContain('--rules-file')
    expect(err).not.toContain('--unit-links:')
    expect(tree(cwd)).toEqual(['package.json'])
  })

  it('ST-44/AC-2: an answer at the terminal is used, and the prompt shows its default', async () => {
    const cwd = makeRepo()
    const terminal = fakeTerminal(['issue', '', 'no', '12', 'no', '', '', '', ''])
    const { code, view } = await runInit([], { cwd, terminal })
    expect(code).toBe(0)
    expect(terminal.prompts.length).toBe(9)
    expect(terminal.prompts[0]).toContain('[file,issue]')
    expect(terminal.prompts[1]).toContain('[REVIEW.md]')
    expect(terminal.prompts[4]).toContain('[yes]')
    expect(await readSettings(view)).toMatchObject({ unitLinks: ['issue'], rulesFile: 'REVIEW.md', land: false, inspectAfterHours: 12 })
    expect(hasOn(cwd, '.github/workflows/inspection.yml')).toBe(false)
  })

  it('ST-44/AC-2: a wrong answer at the terminal is asked again; a wrong flag is refused before anything is written', async () => {
    const cwd = makeRepo()
    const terminal = fakeTerminal(['everything', 'none', ...Array(8).fill('')])
    const { code, view } = await runInit([], { cwd, terminal })
    expect(code).toBe(0)
    expect(terminal.prompts.length).toBe(10)
    expect(terminal.written.join('')).toMatch(/'everything' is not one of/)
    expect((await readSettings(view)).unitLinks).toEqual([])

    const other = makeRepo()
    const refused = await runInit(ALL_FLAGS.map((x) => (x === 'file,issue,other' ? 'wiki' : x)), { cwd: other })
    expect(refused.code).toBe(2)
    expect(refused.err).toMatch(/--unit-links wiki/)
    expect(tree(other)).toEqual(['package.json'])
  })

  it('ST-44/AC-2: every question has its own flag, and a flag init does not know is refused', async () => {
    expect(new Set(QUESTIONS.map((q) => q.flag)).size).toBe(QUESTIONS.length)
    const cwd = makeRepo()
    const { code, err } = await runInit(['--yes', '--nope'], { cwd })
    expect(code).toBe(2)
    expect(err).toMatch(/--nope/)
    expect(tree(cwd)).toEqual(['package.json'])
  })
})

describe('ST-44/AC-3: steward.config.json', () => {
  it('ST-44/AC-3: it has a value for every key, and readSettings reads it', async () => {
    const cwd = makeRepo()
    const { view } = await runInit(['--yes'], { cwd })
    const text = JSON.parse(read(view, 'steward.config.json'))
    expect(Object.keys(text).sort()).toEqual(['check', 'inspectAfterHours', 'land', 'landWhen', 'repo', 'rulesFile', 'setup', 'unitLinks'])
    expect(await readSettings(view)).toEqual({
      repo: REPO, setup: null, check: null, landWhen: 'all-checks', land: false, unitLinks: ['file', 'issue'], rulesFile: 'REVIEW.md', inspectAfterHours: 24,
    })
  })

  it('ST-44/AC-3: repo is read from an https or an ssh URL of origin', async () => {
    expect(repoFromRemoteUrl('https://github.com/acme/widgets.git')).toBe('acme/widgets')
    expect(repoFromRemoteUrl('https://github.com/acme/widgets')).toBe('acme/widgets')
    expect(repoFromRemoteUrl('https://x-token@github.com/acme/widgets.git')).toBe('acme/widgets')
    expect(repoFromRemoteUrl('git@github.com:acme/widgets.git')).toBe('acme/widgets')
    expect(repoFromRemoteUrl('ssh://git@github.com/acme/widgets.git')).toBe('acme/widgets')
    expect(repoFromRemoteUrl('https://gitlab.com/acme/widgets.git')).toBeNull()
    expect(repoFromRemoteUrl('../elsewhere')).toBeNull()
    const cwd = makeRepo({ origin: 'git@github.com:acme/gadgets.git' })
    const { view, code } = await runInit(['--yes'], { cwd })
    expect(code).toBe(0)
    expect((await readSettings(view)).repo).toBe('acme/gadgets')
  })

  it('ST-56/AC-1: with no origin, or an origin that is not a GitHub repository, init refuses before writing anything and asks GitHub for nothing', async () => {
    // This replaces ST-44/AC-3's case, in which init wrote everything but the settings file and
    // went on.
    for (const origin of [null, 'https://gitlab.com/acme/widgets.git']) {
      const cwd = makeRepo({ origin })
      const gh = fakeGitHub()
      const machine = path.join(fresh('home'), 'config.json')
      const { code, err } = await runInit(['--yes'], { cwd, gh, machine })
      expect(code).toBe(2)
      expect(err).toMatch(/origin/)
      expect(err).toMatch(/GitHub repository/)
      expect(tree(cwd)).toEqual(['package.json'])
      expect(existsSync(`${cwd}.worktrees`)).toBe(false)
      expect(existsSync(machine)).toBe(false)
      expect(gh.requests).toEqual([])
    }
  })

  it('ST-44/AC-3: unitLinks none is written as an empty array, and setup, check and landWhen are fixed', async () => {
    const cwd = makeRepo()
    const { view } = await runInit(['--yes', '--unit-links', 'none'], { cwd })
    expect(await readSettings(view)).toMatchObject({ unitLinks: [], setup: null, check: null, landWhen: 'all-checks' })
  })

  it('ST-44/AC-3: the question about unitLinks says what other covers', () => {
    const q = QUESTIONS.find((x) => x.flag === '--unit-links')
    expect(q.prompt).toMatch(/other.*tracker steward cannot read yet.*passed to the reviewer unread/)
    expect(q.default).toBe('file,issue')
  })
})

describe('ST-44/AC-4: the example checklist', () => {
  it('ST-44/AC-4: is copied byte for byte to the rulesFile path', async () => {
    const cwd = makeRepo()
    await runInit(['--yes', '--rules-file', 'docs/rules/CHECKLIST.md'], { cwd })
    expect(bytesOn(cwd, 'docs/rules/CHECKLIST.md')).toEqual(readFileSync(path.join(ROOT, 'templates', 'review-checklist.md')))
  })

  it('ST-44/AC-4: a file already at the path is left and reported', async () => {
    const cwd = makeRepo({ files: { 'docs/RULES.md': 'mine' } })
    const { out } = await runInit(['--yes', '--rules-file', 'docs/RULES.md'], { cwd })
    expect(read(cwd, 'docs/RULES.md')).toBe('mine')
    expect(out).toContain('left docs/RULES.md: already there')
  })
})

describe('ST-44/AC-5: the thin workflow files', () => {
  it('ST-44/AC-5: from a steward whose version is 9.8.7, each file has v9.8.7 and no placeholder', async () => {
    const cwd = makeRepo()
    await runInit(['--yes'], { cwd, pkg: makePackage('9.8.7') })
    for (const file of [...GATE_WORKFLOWS, INSPECTION_WORKFLOW]) {
      const text = readOn(cwd, `.github/workflows/${file}`)
      expect(text).toContain('--package=github:luplows/steward#v9.8.7 steward ')
      expect(text).not.toMatch(/\{\{[A-Z_]+\}\}/)
      expect(text).not.toContain('STEWARD_VERSION')
    }
    expect(readOn(cwd, '.github/workflows/review-gate.yml')).toBe(
      readFileSync(path.join(ROOT, 'templates/workflows/review-gate.yml'), 'utf8').replaceAll('v{{STEWARD_VERSION}}', () => 'v9.8.7'),
    )
  })

  it('ST-44/AC-5a: --ref fills every workflow file with that commit, in place of v<version>', async () => {
    const cwd = makeRepo()
    const { code } = await runInit(['--yes', '--ref', SHA], { cwd, pkg: makePackage('9.8.7') })
    expect(code).toBe(0)
    for (const file of [...GATE_WORKFLOWS, INSPECTION_WORKFLOW]) {
      const text = readOn(cwd, `.github/workflows/${file}`)
      expect(text).toContain(`--package=github:luplows/steward#${SHA} steward `)
      expect(text).not.toContain('v9.8.7')
      expect(text).not.toMatch(/\{\{[A-Z_]+\}\}/)
    }
  })

  it('ST-44/AC-5a: --ref is not asked by a question, and --yes leaves it unset', async () => {
    expect(QUESTIONS.some((q) => q.flag === '--ref')).toBe(false)
    const cwd = makeRepo()
    await runInit(['--yes'], { cwd, pkg: makePackage('9.8.7') })
    expect(readOn(cwd, '.github/workflows/land-approved.yml')).toContain('#v9.8.7 steward')
  })

  it('ST-44/AC-5a: a tag, a short SHA or a SHA of the wrong length is refused, writing nothing', async () => {
    for (const ref of ['v0.1.0', SHA.slice(0, 12), `${SHA}0`, 'g'.repeat(40), '']) {
      const cwd = makeRepo()
      const gh = fakeGitHub()
      const { code, err } = await runInit(['--yes', '--ref', ref], { cwd, gh })
      expect(code, ref).toBe(2)
      expect(err).toMatch(/--ref/)
      expect(tree(cwd)).toEqual(['package.json'])
      expect(gh.requests).toEqual([])
    }
  })
})

describe('ST-44/AC-6: inspection', () => {
  it('ST-44/AC-6: on a yes it writes the thin inspection workflow, pinned, and warns of the first run', async () => {
    const cwd = makeRepo()
    const { out } = await runInit(['--yes', '--inspection', 'yes'], { cwd })
    expect(readOn(cwd, '.github/workflows/inspection.yml')).toContain('run: npx --yes --package=github:luplows/steward#v9.8.7 steward inspect')
    expect(out).toMatch(/first run may raise, as issues, earlier merges and commits on main within its window that had no passing verdict/)
    expect(out).toMatch(/crew closes each once/)
  })

  it('ST-44/AC-6: on a no it writes no inspection workflow and gives no warning, and still creates the inspection label', async () => {
    const cwd = makeRepo()
    const gh = fakeGitHub()
    const { out } = await runInit(['--yes', '--inspection', 'no'], { cwd, gh })
    expect(hasOn(cwd, '.github/workflows/inspection.yml')).toBe(false)
    expect(out).not.toMatch(/first run may raise/)
    expect(gh.requests.some((r) => r.method === 'POST' && r.body.name === 'inspection')).toBe(true)
  })

  it('ST-44/AC-6: the inspection label is not created again when the repository has it', async () => {
    const gh = fakeGitHub({ labels: ['inspection'] })
    await runInit(['--yes', '--inspection', 'no'], { cwd: makeRepo(), gh })
    expect(gh.requests.some((r) => r.method === 'POST' && r.body.name === 'inspection')).toBe(false)
  })
})

describe('ST-44/AC-7: labels', () => {
  const labelConstants = (file) =>
    [...readFileSync(path.join(ROOT, file), 'utf8').matchAll(/\b[A-Z_]*LABEL\s*=\s*'([^']+)'/g)].map((m) => m[1])

  it('ST-44/AC-7: LABELS holds exactly the labels the gate\'s, the runway\'s and inspection\'s commands apply and read', () => {
    expect(LABELS.map((l) => l.name).sort()).toEqual([BREAKER_OVERRIDE_LABEL, INSPECTION_LABEL, REVIEW_BLOCKED_LABEL].sort())
    expect(APPLY_REVIEW_BLOCKED_LABEL).toBe(REVIEW_BLOCKED_LABEL)
    const named = new Set(
      ['scripts/land/apply-review-blocked.mjs', 'scripts/land/runway.mjs', 'scripts/dispatch/inspect.mjs'].flatMap(labelConstants),
    )
    expect([...named].sort()).toEqual(LABELS.map((l) => l.name).sort())
  })

  it('ST-44/AC-7: creates each missing label, leaves one that exists, and prints each', async () => {
    const gh = fakeGitHub({ labels: ['breaker-override'] })
    const { out, code } = await runInit(['--yes'], { cwd: makeRepo(), gh })
    expect(code).toBe(0)
    expect(labelWrites(gh).map((r) => r.body.name)).toEqual(['review-blocked', 'inspection'])
    expect(out).toContain('label review-blocked: created')
    expect(out).toContain('label breaker-override: found, left as it is')
    expect(out).toContain('label inspection: created')
  })

  it('ST-44/AC-7: init asks GitHub for nothing outside the labels and the installation pull request (ST-56/AC-9 lists the pull request\'s requests)', () => {
    expect(() => assertAllowedRequest(REPO, { method: 'DELETE', url: `https://api.github.com/repos/${REPO}/labels/inspection` })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'POST', url: `https://api.github.com/repos/${REPO}/issues`, body: {} })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'GET', url: `https://api.github.com/repos/${REPO}/labels/other` })).toThrow(/refusing/)
    expect(() => assertAllowedRequest(REPO, { method: 'GET', url: `https://api.github.com/repos/${REPO}/labels/inspection` })).not.toThrow()
  })
})

describe('ST-44/AC-8: the pull request template', () => {
  const TEMPLATE = path.join(ROOT, 'templates', 'pull_request_template.md')

  it('ST-44/AC-8: with none in the project, it writes the package\'s, which names neither AGENTS.md nor README.md', async () => {
    const cwd = makeRepo()
    await runInit(['--yes'], { cwd })
    const text = readOn(cwd, '.github/pull_request_template.md')
    expect(text).toBe(readFileSync(TEMPLATE, 'utf8'))
    expect(text).toMatch(/^Unit:/m)
    expect(text.match(/^## .+$/gm)).toEqual(['## What changed', '## Verification', '## Docs check'])
    expect(text).toMatch(/which documentation this change affects and what you updated, or why\s+none needed it/i)
    expect(text).not.toMatch(/AGENTS\.md|README\.md/)
  })

  it('ST-44/AC-8: steward\'s own template is not the package\'s, and is unchanged', () => {
    expect(readFileSync(path.join(ROOT, '.github', 'pull_request_template.md'), 'utf8')).toMatch(/README\.md/)
  })

  it('ST-44/AC-8: a template in docs/ with no Unit: line is left, edited not, and reported by name', async () => {
    const cwd = makeRepo({ files: { 'docs/pull_request_template.md': '## Summary\n' } })
    const { out } = await runInit(['--yes'], { cwd })
    expect(readOn(cwd, 'docs/pull_request_template.md')).toBe('## Summary\n')
    expect(hasOn(cwd, '.github/pull_request_template.md')).toBe(false)
    expect(out).toContain('docs/pull_request_template.md has no Unit: line')
  })

  it('ST-44/AC-8: a template in .github/ with a Unit: line is left, and nothing is said of the line', async () => {
    const cwd = makeRepo({ files: { '.github/pull_request_template.md': 'Unit:\n\n## Summary\n' } })
    const { out } = await runInit(['--yes'], { cwd })
    expect(readOn(cwd, '.github/pull_request_template.md')).toBe('Unit:\n\n## Summary\n')
    expect(out).toContain('left .github/pull_request_template.md: the project\'s pull request template')
    expect(out).not.toMatch(/no Unit: line/)
  })

  it('ST-44/AC-8: a template at the root, in any case, or in a PULL_REQUEST_TEMPLATE/ directory counts as one', async () => {
    for (const files of [{ 'PULL_REQUEST_TEMPLATE.md': 'x' }, { '.github/PULL_REQUEST_TEMPLATE/bug.md': 'x' }, { 'docs/PULL_REQUEST_TEMPLATE/a.md': 'Unit:' }]) {
      const cwd = makeRepo({ files })
      // A project with two templates must choose one for the body (ST-56/AC-6): none of these has
      // two.
      const { code } = await runInit(['--yes'], { cwd })
      expect(code).toBe(0)
      expect(hasOn(cwd, '.github/pull_request_template.md')).toBe(false)
      expect(hasOn(cwd, 'steward.config.json')).toBe(true)
    }
  })
})

describe('ST-44/AC-9: the user config', () => {
  it('ST-44/AC-9: a missing file is written from the defaults, and readUserConfig reads it', async () => {
    const machine = path.join(fresh('home'), 'sub', 'config.json')
    const { code } = await runInit(['--yes'], { cwd: makeRepo(), machine })
    expect(code).toBe(0)
    const settings = await readUserConfig({ env: { STEWARD_CONFIG: machine }, homedir: '/nowhere' })
    expect(settings.roles.reviewer.default).toBe('opus')
    expect(settings.roles.coder.default).toBe('sonnet')
    expect(settings.roles.coder.available).toMatchObject({
      sonnet: { tool: 'claude', model: 'sonnet', strength: 1 },
      opus: { tool: 'claude', model: 'opus', strength: 2 },
    })
    expect(settings.usageLimits).toEqual({ coder: { session: 70, weekly: 75 }, reviewer: { session: 90, weekly: 90 } })
    expect(settings.tools).toBeUndefined()
  })

  it('ST-44/AC-9: a limit given by flag is written', async () => {
    const machine = path.join(fresh('home'), 'config.json')
    await runInit(['--yes', '--coder-session-limit', '50', '--reviewer-weekly-limit', '95'], { cwd: makeRepo(), machine })
    const { usageLimits } = await readUserConfig({ env: { STEWARD_CONFIG: machine }, homedir: '/nowhere' })
    expect(usageLimits).toEqual({ coder: { session: 50, weekly: 75 }, reviewer: { session: 90, weekly: 95 } })
  })

  it('ST-56/AC-7: an invalid existing user config file is preserved but cannot claim successful provisioning', async () => {
    const machine = path.join(fresh('home'), 'config.json')
    writeFileSync(machine, 'not even json')
    const before = statSync(machine).mtimeMs
    const terminal = fakeTerminal(['file,issue', '', '', '', ''])
    const { code, out, err } = await runInit([], { cwd: makeRepo(), machine, terminal })
    expect(code).toBe(1)
    expect(readFileSync(machine, 'utf8')).toBe('not even json')
    expect(statSync(machine).mtimeMs).toBe(before)
    expect(out).not.toContain(`left ${machine}`)
    expect(err).toContain('invalid JSON')
    expect(terminal.prompts.some((p) => /usage/.test(p))).toBe(false)
  })

  it('ST-44/AC-9: a Codex choice is offered only when codex is found or its path given', async () => {
    const withoutCodex = fakeTerminal(['', '', '', '', '', '', '', '', ''])
    await runInit([], { cwd: makeRepo(), terminal: withoutCodex })
    expect(withoutCodex.prompts.some((p) => /codex/i.test(p))).toBe(false)

    const exe = path.join(fresh('bin'), 'codex.exe')
    writeFileSync(exe, '')
    const offered = fakeTerminal(['', '', '', '', '', '', '', '', '', '', ''])
    await runInit([], { cwd: makeRepo(), terminal: offered, codex: exe })
    expect(offered.prompts.some((p) => /codex/i.test(p))).toBe(true)

    const refused = await runInit(['--yes', '--reviewer', 'codex', '--codex-model', 'm', '--codex-effort', 'high'], { cwd: makeRepo() })
    expect(refused.code).toBe(2)
    expect(refused.err).toMatch(/--reviewer codex.*--codex-path/)
  })

  it('ST-44/AC-9: when the crew takes Codex, its model and effort have no default, and the path is written as tools.codex.executable', async () => {
    const exe = path.join(fresh('bin'), 'codex.exe')
    writeFileSync(exe, '')
    const missing = await runInit(['--yes', '--reviewer', 'codex'], { cwd: makeRepo(), codex: exe })
    expect(missing.code).toBe(2)
    expect(missing.err).toContain('--codex-model')
    expect(missing.err).toContain('--codex-effort')
    expect(existsSync(missing.machine)).toBe(false)

    const machine = path.join(fresh('home'), 'config.json')
    const { code } = await runInit(['--yes', '--reviewer', 'codex', '--codex-model', 'gpt-x', '--codex-effort', 'ultra'], { cwd: makeRepo(), machine, codex: exe })
    expect(code).toBe(0)
    const settings = await readUserConfig({ env: { STEWARD_CONFIG: machine }, homedir: '/nowhere' })
    expect(settings.roles.reviewer.default).toBe('codex')
    expect(settings.roles.reviewer.available.codex).toEqual({ tool: 'codex', model: 'gpt-x', effort: 'ultra' })
    expect(settings.tools.codex.executable).toBe(exe)
  })

  it('ST-44/AC-9: --codex-path names the executable when codex is not on the PATH, and must be a file that exists', async () => {
    const exe = path.join(fresh('bin'), 'codex')
    writeFileSync(exe, '')
    const machine = path.join(fresh('home'), 'config.json')
    const ok = await runInit(['--yes', '--reviewer', 'codex', '--codex-path', exe, '--codex-model', 'm', '--codex-effort', 'low'], { cwd: makeRepo(), machine })
    expect(ok.code).toBe(0)
    expect((await readUserConfig({ env: { STEWARD_CONFIG: machine }, homedir: '/nowhere' })).tools.codex.executable).toBe(exe)
    const bad = await runInit(['--yes', '--codex-path', path.join(fresh('no-codex'), 'no-such-codex')], { cwd: makeRepo() })
    expect(bad.code).toBe(2)
    expect(bad.err).toMatch(/--codex-path/)
  })

  it('ST-44/AC-9: findOnPath, as on Windows, tries each of PATHEXT\'s extensions as written', () => {
    const dir = fresh('bin')
    // Named as PATHEXT writes it, so that the file is found on a case-sensitive file system too.
    writeFileSync(path.join(dir, 'codex.CMD'), '')
    expect(findOnPath('codex', { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32')).toBe(path.join(dir, 'codex.CMD'))
    expect(findOnPath('codex', { PATH: dir, PATHEXT: '.EXE' }, 'win32')).toBeNull()
    expect(findOnPath('codex', { PATH: '' }, 'win32')).toBeNull()
  })

  it('ST-44/AC-9: findOnPath, as on POSIX, tries the bare name and wants an executable bit', () => {
    const dir = fresh('bin')
    writeFileSync(path.join(dir, 'codex.cmd'), '')
    chmodSync(path.join(dir, 'codex.cmd'), 0o755)
    expect(findOnPath('codex', { PATH: dir }, 'linux')).toBeNull()
    expect(findOnPath('codex', { PATH: '' }, 'linux')).toBeNull()
    writeFileSync(path.join(dir, 'codex'), '')
    chmodSync(path.join(dir, 'codex'), 0o755)
    expect(findOnPath('codex', { PATH: dir }, 'linux')).toBe(path.join(dir, 'codex'))
  })

  it.skipIf(process.platform === 'win32')('ST-44/AC-9: on a POSIX host a file without an executable bit is not found', () => {
    const dir = fresh('bin')
    writeFileSync(path.join(dir, 'codex'), '')
    chmodSync(path.join(dir, 'codex'), 0o644)
    expect(findOnPath('codex', { PATH: dir }, 'linux')).toBeNull()
  })

  it('ST-44/AC-9: a relative PATH entry gives an absolute executable, which readUserConfig reads', async () => {
    const dir = fresh('rel')
    mkdirSync(path.join(dir, 'bin'))
    writeFileSync(path.join(dir, 'bin', 'codex'), '')
    chmodSync(path.join(dir, 'bin', 'codex'), 0o755)
    const before = process.cwd()
    process.chdir(dir)
    let found
    try {
      found = findOnPath('codex', { PATH: './bin' }, 'linux')
    } finally {
      process.chdir(before)
    }
    expect(path.isAbsolute(found)).toBe(true)
    const machine = path.join(fresh('home'), 'config.json')
    const { code } = await runInit(['--yes', '--reviewer', 'codex', '--codex-model', 'm', '--codex-effort', 'low'], { cwd: makeRepo(), machine, codex: found })
    expect(code).toBe(0)
    expect((await readUserConfig({ env: { STEWARD_CONFIG: machine }, homedir: '/nowhere' })).tools.codex.executable).toBe(found)
  })
})

describe('ST-44/AC-7 and AC-12: a label that fails to create', () => {
  it('ST-44/AC-7: a 422 whose errors say already_exists counts as found', async () => {
    const { code, out } = await runInit(['--yes'], { cwd: makeRepo(), gh: fakeGitHub({ labelCreate: 'already_exists' }) })
    expect(code).toBe(0)
    expect(out).toContain('label review-blocked: found, left as it is')
  })

  it('ST-44/AC-12: a 422 with another error stops init with a non-zero exit, writing no user config', async () => {
    const machine = path.join(fresh('home'), 'config.json')
    const { code, err } = await runInit(['--yes'], { cwd: makeRepo(), gh: fakeGitHub({ labelCreate: 'other' }), machine })
    expect(code).toBe(1)
    expect(err).toMatch(/422/)
    expect(existsSync(machine)).toBe(false)
  })
})

describe('ST-44/AC-11: what it leaves alone', () => {
  it('ST-56/AC-1: HEAD, the index, the working files and package.json are unchanged, and nothing under stories/ is read or written (ST-44/AC-11 said init left the files it wrote untracked in the checkout; it now writes none there)', async () => {
    const cwd = makeRepo({ files: { 'stories/stories.json': '{ not json', 'stories/ST-1.md': 'x' } })
    git(cwd, 'config', 'user.name', 'Crew')
    const head = git(cwd, 'rev-parse', 'HEAD')
    const index = git(cwd, 'ls-files', '-s')
    const packageJson = read(cwd, 'package.json')
    const stories = ['stories/stories.json', 'stories/ST-1.md'].map((f) => [f, read(cwd, f), statSync(path.join(cwd, f)).mtimeMs])
    const { code, out } = await runInit(['--yes'], { cwd })
    expect(code).toBe(0)
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(cwd, 'ls-files', '-s')).toBe(index)
    expect(git(cwd, 'diff', '--cached', '--name-only')).toBe('')
    expect(read(cwd, 'package.json')).toBe(packageJson)
    expect(stories.map(([f]) => [f, read(cwd, f), statSync(path.join(cwd, f)).mtimeMs])).toEqual(stories)
    expect(tree(cwd).filter((f) => f.startsWith('stories/'))).toEqual(['stories/ST-1.md', 'stories/stories.json'])
    expect(git(cwd, 'status', '--porcelain')).toBe('')
    expect(tree(cwd)).toEqual(['package.json', 'stories/ST-1.md', 'stories/stories.json'])
    const settings = JSON.parse(readOn(cwd, 'steward.config.json'))
    expect(settings).not.toHaveProperty('storyPrefix')
    expect(branchFiles(cwd).filter((f) => f.startsWith('stories/'))).toEqual(['stories/ST-1.md', 'stories/stories.json'])
    expect(out).toMatch(/draft pull request/)
  })

  it('ST-44/AC-11: it writes no after-sweep trigger and touches no workflow of the project\'s', async () => {
    const cwd = makeRepo({ files: { '.github/workflows/ci.yml': 'name: CI\n' } })
    await runInit(['--yes'], { cwd })
    expect(readOn(cwd, '.github/workflows/ci.yml')).toBe('name: CI\n')
    expect(branchFiles(cwd).filter((f) => f.startsWith('.github/workflows/')).sort()).toEqual([
      '.github/workflows/ci.yml',
      '.github/workflows/inspection.yml',
      '.github/workflows/land-approved.yml',
      '.github/workflows/review-gate.yml',
    ])
    for (const file of GATE_WORKFLOWS) expect(readOn(cwd, `.github/workflows/${file}`)).not.toMatch(/workflow_run/)
  })

  it('ST-44/AC-11: its source neither imports the story prefix nor names stories/ outside a comment', () => {
    for (const file of ['init.mjs', 'init-install.mjs', 'init-pr-body.mjs']) {
      const source = readFileSync(path.join(ROOT, 'scripts/dispatch', file), 'utf8')
      expect(source, file).not.toMatch(/story-prefix|stories\.json/)
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(code, file).not.toMatch(/stories\//)
    }
  })
})

describe('ST-44/AC-12: exit codes', () => {
  it('ST-44/AC-12: a failed request to GitHub exits 1, writing nothing more', async () => {
    for (const gh of [fakeGitHub({ labelStatus: 500 })]) {
      const machine = path.join(fresh('home'), 'config.json')
      const { code, err } = await runInit(['--yes'], { cwd: makeRepo(), gh, machine })
      expect(code).toBe(1)
      expect(err).toMatch(/init stopped: .*(500|boom)/)
      expect(existsSync(machine)).toBe(false)
    }
  })

  it('ST-44/AC-12: a refusal for want of an answer exits 2, and a checkout that is not a git repository exits 2', async () => {
    expect((await runInit([], { cwd: makeRepo() })).code).toBe(2)
    expect((await runInit(['--yes'], { cwd: fresh('plain') })).code).toBe(2)
  })

  it('ST-44/AC-12: it exits 0 when it finished with everything left alone', async () => {
    const cwd = makeRepo()
    const gh = fakeGitHub({ labels: LABELS.map((l) => l.name) })
    const machine = path.join(fresh('home'), 'config.json')
    const pkg = makePackage()
    await runInit(['--yes'], { cwd, gh, machine, pkg })
    mergeInstall(cwd)
    expect((await runInit(['--yes'], { cwd, gh, machine, pkg })).code).toBe(0)
  })
})

describe('ST-44/AC-13: the README and settings.md', () => {
  it('ST-44/AC-13: the README says how to set up another project with init, and how the crew runs steward in one', () => {
    const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
    expect(readme).not.toMatch(/Steward runs on this repository only/)
    expect(readme).toMatch(/steward init/)
    expect(readme).toContain('npx --yes --package=github:luplows/steward#v<version> steward <command>')
  })

  it('ST-44/AC-13: settings.md no longer says init is not built, and says what init writes for each key', () => {
    const settings = readFileSync(path.join(ROOT, 'docs', 'settings.md'), 'utf8')
    expect(settings).not.toMatch(/not built yet/)
    expect(settings).not.toMatch(/Planned \(ST-44\)/)
    expect(settings).toMatch(/What `init` writes/)
  })
})

// What the person running a command reads: nothing of steward's own source or stories (ST-50/AC-11).
const MENTIONS_STEWARD_INTERNALS = /ST-\d|AC-\d|scripts\/|\.mjs/

describe('ST-50/AC-1: init no longer touches branch protection', () => {
  const PROTECTION_URLS = ['', '/required_signatures', '/required_status_checks/contexts', '/enforce_admins']

  it('ST-50/AC-1: --protect-main is refused as an unknown flag, exit 2, nothing written and nothing asked of GitHub', async () => {
    const cwd = makeRepo()
    const gh = fakeGitHub()
    const machine = path.join(fresh('home'), 'config.json')
    const { code, err } = await runInit(['--yes', '--protect-main', 'yes'], { cwd, gh, machine })
    expect(code).toBe(2)
    expect(err).toMatch(/--protect-main: not a flag of init/)
    expect(tree(cwd)).toEqual(['package.json'])
    expect(existsSync(machine)).toBe(false)
    expect(gh.requests).toEqual([])
    expect(QUESTIONS.some((q) => q.id === 'protectMain' || q.flag === '--protect-main')).toBe(false)
  })

  it('ST-50/AC-1: a run with every question answered, and a --yes run, make no request about protection', async () => {
    for (const args of [ALL_FLAGS, ['--yes']]) {
      const gh = fakeGitHub()
      const { code } = await runInit(args, { cwd: makeRepo(), gh })
      expect(code).toBe(0)
      expect(gh.requests.length).toBeGreaterThan(0)
      expect(gh.requests.filter((r) => /protection|branches/.test(r.rest))).toEqual([])
    }
  })

  it('ST-50/AC-1: where GitHub answers every protection request 404 Branch not found, init exits 0 after writing its files and creating its labels', async () => {
    const cwd = makeRepo()
    const gh = fakeGitHub({ noMain: true })
    const { code, out, err } = await runInit(['--yes'], { cwd, gh })
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(branchFiles(cwd)).toContain('steward.config.json')
    expect(branchFiles(cwd)).toContain('.github/workflows/review-gate.yml')
    expect(labelWrites(gh).map((r) => r.body.name)).toEqual(['review-blocked', 'breaker-override', 'inspection'])
    expect(out).toContain('label review-blocked: created')
  })

  it('ST-50/AC-1: its allowlist refuses every request about protection', () => {
    const base = `https://api.github.com/repos/${REPO}/branches/main/protection`
    for (const suffix of PROTECTION_URLS) {
      for (const method of ['GET', 'PUT', 'POST', 'DELETE']) {
        expect(() => assertAllowedRequest(REPO, { method, url: `${base}${suffix}` }), `${method} ${suffix}`).toThrow(/refusing/)
      }
    }
    expect(() => assertAllowedRequest(REPO, { method: 'GET', url: `https://api.github.com/repos/${REPO}/branches/main` })).toThrow(/refusing/)
  })

  it('ST-50/AC-1: its source holds no question, flag, request builder or allowlist entry about protection', () => {
    const source = readFileSync(path.join(ROOT, 'scripts/dispatch/init.mjs'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/protection|--protect-main|protectMain|PROTECTION/i)
  })
})

describe('ST-50/AC-2: init\'s closing message', () => {
  const closing = async (args) => {
    const { code, out } = await runInit(args, { cwd: makeRepo(), gh: fakeGitHub() })
    expect(code).toBe(0)
    return out.split('\n')
  }

  it('ST-56/AC-8: its last lines say the draft pull request is the crew\'s to review and merge through the project\'s process, that a fresh install cannot review itself, and recommend steward protect (ST-50/AC-2 had the crew commit and open the pull request)', async () => {
    for (const args of [['--yes'], ALL_FLAGS]) {
      const lines = await closing(args)
      const last = lines.slice(-3).join('\n')
      expect(last).toMatch(/The pull request is a draft\. The crew reviews and merges it through the project's existing process/)
      expect(last).toMatch(/a fresh install cannot be reviewed by the gate it introduces/)
      expect(last).not.toMatch(/Commit what was written/)
      expect(lines.at(-1)).toMatch(/Steward is then set up\. .*run `steward protect` once it has merged\.$/)
    }
  })

  it('ST-50/AC-2: that recommendation is the only place its output names protection or protect, and it is not a trial', async () => {
    const lines = await closing(['--yes'])
    expect(lines.filter((l) => /protect/i.test(l))).toEqual([lines.at(-1)])
    expect(lines.join('\n')).not.toMatch(/trial|unfinished|incomplete|not yet set up/i)
  })
})

describe('ST-50/AC-11: what init prints is written for the person running it', () => {
  it('ST-50/AC-11: each case of ST-50/AC-1 and AC-2 prints no story or criterion id, script or module file', async () => {
    const cases = [
      ['--yes'],
      ALL_FLAGS,
      ['--yes', '--protect-main', 'yes'],
      ['--nope'],
      [],
    ]
    for (const args of cases) {
      const { out, err } = await runInit(args, { cwd: makeRepo(), gh: fakeGitHub() })
      expect(`${out}\n${err}`, args.join(' ')).not.toMatch(MENTIONS_STEWARD_INTERNALS)
    }
    const noMain = await runInit(['--yes'], { cwd: makeRepo(), gh: fakeGitHub({ noMain: true }) })
    expect(`${noMain.out}\n${noMain.err}`).not.toMatch(MENTIONS_STEWARD_INTERNALS)
    const notRepo = await runInit(['--yes'], { cwd: fresh('plain') })
    expect(`${notRepo.out}\n${notRepo.err}`).not.toMatch(MENTIONS_STEWARD_INTERNALS)
  })

  it('ST-50/AC-11: the allowlist\'s error names no source file of steward\'s own', () => {
    let message = ''
    try {
      assertAllowedRequest(REPO, { method: 'DELETE', url: `https://api.github.com/repos/${REPO}/labels/inspection` })
    } catch (error) {
      message = error.message
    }
    expect(message).toMatch(/refusing/)
    expect(message).not.toMatch(MENTIONS_STEWARD_INTERNALS)
  })
})

// ------------------------------------------------------------------ ST-55: review-only by default

const LAND_ANSWERS = (land) => ['', '', land, '', '', '', '', '', '']
const NEW_FILES = [
  '.github/pull_request_template.md',
  '.github/workflows/inspection.yml',
  '.github/workflows/land-approved.yml',
  '.github/workflows/review-gate.yml',
  'REVIEW.md',
  'package.json',
  'steward.config.json',
]
const bytes = (dir, rel) => readFileSync(path.join(dir, rel))

describe('ST-55/AC-1: the land question defaults to no, and an explicit yes writes true', () => {
  it('ST-55/AC-1: the question describes unattended landing and its default is no', () => {
    const q = QUESTIONS.find((x) => x.id === 'land')
    expect(q.default).toBe('no')
    expect(q.flag).toBe('--land')
    expect(q.prompt).toMatch(/unattended/)
    expect(q.prompt).toMatch(/without anyone asking/)
    expect(q.prompt).toContain('steward land <pr-number>')
  })

  it('ST-55/AC-1: accepting the default at the terminal writes land false, and the other settings keep their defaults', async () => {
    const cwd = makeRepo()
    const terminal = fakeTerminal(LAND_ANSWERS(''))
    const { code } = await runInit([], { cwd, terminal })
    expect(code).toBe(0)
    expect(terminal.prompts[2]).toContain('[no]')
    expect(await readSettings(snapshot(cwd))).toEqual({
      repo: REPO, setup: null, check: null, landWhen: 'all-checks', land: false, unitLinks: ['file', 'issue'], rulesFile: 'REVIEW.md', inspectAfterHours: 24,
    })
  })

  it('ST-55/AC-1: --yes writes land false, with landWhen and every other setting as before', async () => {
    const cwd = makeRepo()
    expect((await runInit(['--yes'], { cwd })).code).toBe(0)
    expect(JSON.parse(readOn(cwd, 'steward.config.json'))).toEqual({
      repo: REPO, setup: null, check: null, landWhen: 'all-checks', land: false, unitLinks: ['file', 'issue'], rulesFile: 'REVIEW.md', inspectAfterHours: 24,
    })
  })

  it.each([['yes'], ['y'], ['true']])('ST-55/AC-1: an explicit %s at the terminal writes land true', async (answer) => {
    const cwd = makeRepo()
    const { code } = await runInit([], { cwd, terminal: fakeTerminal(LAND_ANSWERS(answer)) })
    expect(code).toBe(0)
    expect(await readSettings(snapshot(cwd))).toMatchObject({ land: true, landWhen: 'all-checks' })
  })

  it('ST-55/AC-1: an explicit no at the terminal writes land false', async () => {
    const cwd = makeRepo()
    await runInit([], { cwd, terminal: fakeTerminal(LAND_ANSWERS('no')) })
    expect(await readSettings(snapshot(cwd))).toMatchObject({ land: false })
  })

  it('ST-55/AC-1: --land yes writes true, with --yes or with every question answered; --land no writes false', async () => {
    const withYes = makeRepo()
    await runInit(['--yes', '--land', 'yes'], { cwd: withYes })
    expect(await readSettings(snapshot(withYes))).toMatchObject({ land: true, landWhen: 'all-checks', rulesFile: 'REVIEW.md' })

    const allAnswered = makeRepo()
    await runInit(ALL_FLAGS.map((x, i) => (ALL_FLAGS[i - 1] === '--land' ? 'yes' : x)), { cwd: allAnswered })
    expect(await readSettings(snapshot(allAnswered))).toMatchObject({ land: true, rulesFile: 'docs/RULES.md' })

    const no = makeRepo()
    await runInit(['--yes', '--land', 'no'], { cwd: no })
    expect(await readSettings(snapshot(no))).toMatchObject({ land: false })

    const equals = makeRepo()
    await runInit(['--yes', '--land=yes'], { cwd: equals })
    expect(await readSettings(snapshot(equals))).toMatchObject({ land: true })
  })

  it('ST-55/AC-1: readSettings still requires land, and holds no default for it', async () => {
    const cwd = makeRepo()
    const { view } = await runInit(['--yes'], { cwd })
    const body = JSON.parse(read(view, 'steward.config.json'))
    delete body.land
    writeFileSync(path.join(view, 'steward.config.json'), JSON.stringify(body))
    await expect(readSettings(view)).rejects.toThrow(/missing required key 'land'/)
    writeFileSync(path.join(view, 'steward.config.json'), JSON.stringify({ ...body, land: 'no' }))
    await expect(readSettings(view)).rejects.toThrow(/land/)
  })
})

describe('ST-55/AC-2: the output tells review-only from unattended landing', () => {
  it('ST-55/AC-2: a new land false says steward reviews and does not land unattended, and shows the manual path', async () => {
    const { out, code } = await runInit(['--yes'], { cwd: makeRepo() })
    expect(code).toBe(0)
    expect(out).toMatch(/land set to false: steward can review pull requests but will not land any unattended/)
    expect(out).toContain('`steward land <pr-number>`')
    expect(out).not.toMatch(/explicitly enabled/)
  })

  it('ST-55/AC-2: a new land true says unattended landing was explicitly enabled', async () => {
    const { out } = await runInit(['--yes', '--land', 'yes'], { cwd: makeRepo() })
    expect(out).toMatch(/land set to true: unattended landing was explicitly enabled/)
    expect(out).not.toMatch(/will not land any unattended/)
  })

  it('ST-55/AC-2: --yes is said not to consent to unattended landing, and is never described as enabling it', async () => {
    const { out } = await runInit(['--yes'], { cwd: makeRepo() })
    expect(out).toMatch(/--yes took the default for the landing question, no: it does not consent to unattended landing/)
    for (const line of out.split('\n').filter((l) => l.includes('--yes'))) expect(line).toMatch(/does not consent/)
    // An explicit --land yes is the person's own answer; --yes is not blamed or credited for it.
    const explicit = await runInit(['--yes', '--land', 'yes'], { cwd: makeRepo() })
    expect(explicit.out).not.toMatch(/--yes took the default/)
    const terminal = await runInit([], { cwd: makeRepo(), terminal: fakeTerminal(LAND_ANSWERS('')) })
    expect(terminal.out).not.toMatch(/--yes/)
  })

  it('ST-55/AC-2: the prompt and the usage text say that --yes and the default do not enable unattended landing', async () => {
    const q = QUESTIONS.find((x) => x.id === 'land')
    expect(q.prompt).toMatch(/\(no: steward reviews, the project merges/)
    const { err } = await runInit(['--nope'], { cwd: makeRepo() })
    expect(err).toMatch(/--yes takes the default of --land, which is no, and only --land yes/)
    expect(err).toContain('steward init --yes --land yes')
  })

  it('ST-55/AC-5: the printed usage shows the manual path, steward land <pr-number>, with land false', async () => {
    const { err } = await runInit(['--nope'], { cwd: makeRepo() })
    expect(err).toMatch(/With land false, `steward land <pr-number>` asks steward to land one pull request that has passed review/)
  })

  it('ST-55/AC-2: both outcomes say merging the installation pull request starts nothing on any machine', async () => {
    for (const args of [['--yes'], ['--yes', '--land', 'yes']]) {
      const { out } = await runInit(args, { cwd: makeRepo() })
      expect(out).toMatch(/Merging it starts nothing on any machine: running steward on a machine is a separate step/)
    }
  })

  it('ST-55/AC-2: what it prints for either outcome names no story or criterion id, script or module file', async () => {
    for (const args of [['--yes'], ['--yes', '--land', 'yes']]) {
      const { out, err } = await runInit(args, { cwd: makeRepo() })
      expect(`${out}\n${err}`).not.toMatch(MENTIONS_STEWARD_INTERNALS)
    }
    expect(QUESTIONS.find((x) => x.id === 'land').prompt).not.toMatch(MENTIONS_STEWARD_INTERNALS)
  })
})

describe('ST-55/AC-3: an existing settings file keeps its authorization', () => {
  const existing = (land) => `${JSON.stringify({
    repo: REPO, setup: null, check: null, landWhen: 'all-checks', land, unitLinks: ['file'], rulesFile: 'REVIEW.md', inspectAfterHours: 6,
  }, null, 4)}\n`

  it.each([
    ['true', true, ['--yes']],
    ['false', false, ['--yes']],
    ['true', true, ['--yes', '--land', 'no']],
    ['false', false, ['--yes', '--land', 'yes']],
    ['false', false, ['--yes', '--land', 'no']],
    ['true', true, ['--yes', '--land', 'yes']],
  ])('ST-55/AC-3: a file with land %s is left byte for byte by %j', async (_name, land, args) => {
    const text = existing(land)
    const cwd = makeRepo({ files: { 'steward.config.json': text } })
    const before = bytes(cwd, 'steward.config.json')
    const { code, out } = await runInit(args, { cwd })
    expect(code).toBe(0)
    expect(bytes(cwd, 'steward.config.json').equals(before)).toBe(true)
    expect(read(cwd, 'steward.config.json')).toBe(text)
    expect(out).toContain('left steward.config.json: already there')
    expect(out).not.toMatch(/wrote steward\.config\.json/)
    // It does not claim its land setting was set, changed or enabled.
    expect(out).not.toMatch(/land set to (true|false)|explicitly enabled|will not land any unattended|took the default/)
    expect(out).toMatch(/An existing steward\.config\.json governs its own landing authorization: init read only its rulesFile, to find the existing checklist, and did not change its land setting/)
  })

  it('ST-55/AC-3: answering the question at the terminal does not change an existing file either', async () => {
    // With a settings file on main the checklist question is not asked (the file names the
    // checklist), so the answers are those of ST-55's LAND_ANSWERS without the second one.
    for (const land of [true, false]) {
      const text = existing(land)
      const cwd = makeRepo({ files: { 'steward.config.json': text } })
      const terminal = fakeTerminal(['', land ? 'no' : 'yes', '', '', '', '', '', ''])
      const { code } = await runInit([], { cwd, terminal })
      expect(code).toBe(0)
      expect(terminal.prompts.some((p) => /checklist/.test(p))).toBe(false)
      expect(terminal.prompts[1]).toMatch(/unattended/)
      expect(read(cwd, 'steward.config.json')).toBe(text)
      expect(readOn(cwd, 'steward.config.json')).toBe(text)
    }
  })

  it('ST-55/AC-3: two runs of a new installation: once the first has merged, the second leaves every file as the first wrote it', async () => {
    for (const land of ['no', 'yes']) {
      const cwd = makeRepo()
      const machine = path.join(fresh('home'), 'config.json')
      const pkg = makePackage()
      const first = await runInit(['--yes', '--land', land], { cwd, machine, pkg })
      const written = Object.fromEntries(branchFiles(cwd).map((rel) => [rel, bytesOn(cwd, rel)]))
      expect(JSON.parse(readOn(cwd, 'steward.config.json')).land).toBe(land === 'yes')
      mergeInstall(cwd)
      const opposite = land === 'yes' ? 'no' : 'yes'
      const second = await runInit(['--yes', '--land', opposite], { cwd, machine, pkg })
      expect(second.code).toBe(0)
      expect(tree(cwd)).toEqual(Object.keys(written))
      // (A checkout on a machine with core.autocrlf writes CRLF; the blobs, which `written` holds,
      // hold LF.)
      const lf = (buffer) => buffer.toString('utf8').replaceAll('\r\n', '\n')
      for (const [rel, content] of Object.entries(written)) expect(lf(bytes(cwd, rel)), rel).toBe(lf(content))
      expect(first.out).toContain('wrote steward.config.json')
      expect(second.out).toContain('left steward.config.json: already there')
      expect(second.out).not.toMatch(/land set to/)
    }
  })
})

describe('ST-55/AC-4: the gate is installed, and review-only installation does not let it merge unattended', () => {
  const alice = { alice: 'write' }
  /** A fake pull request 1 with everything the gate wants, and the settings file `init` wrote. */
  const world = (cwd) => fakeRunwayGitHub({ pulls: [runwayPull(1)], settingsText: readOn(cwd, 'steward.config.json'), permissions: alice })
  const HEAD = 'c'.repeat(39) + '1'
  const asGate = { repo: 'owner/project', eventName: 'workflow_dispatch', actor: 'alice' }

  it('ST-55/AC-4: a review-only installation writes the same files as one with land true, and nothing else', async () => {
    const off = makeRepo()
    const on = makeRepo()
    const gh = fakeGitHub()
    await runInit(['--yes'], { cwd: off, gh })
    await runInit(['--yes', '--land', 'yes'], { cwd: on })
    expect(branchFiles(off)).toEqual(NEW_FILES)
    expect(branchFiles(on)).toEqual(branchFiles(off))
    for (const rel of branchFiles(off).filter((r) => r !== 'steward.config.json')) {
      expect(bytesOn(off, rel).equals(bytesOn(on, rel)), rel).toBe(true)
    }
    for (const file of [...GATE_WORKFLOWS, INSPECTION_WORKFLOW]) {
      const text = readOn(off, `.github/workflows/${file}`)
      expect(text, file).toContain('#v9.8.7 steward')
      expect(text, file).not.toContain('{{STEWARD_VERSION}}')
      // Inspection's workflow has a schedule of its own, from before; the gate's and the runway's
      // have none.
      if (GATE_WORKFLOWS.includes(file)) expect(text, file).not.toMatch(/^\s*schedule:/m)
    }
    // Only the installation's draft pull request and the labels are created, and no reviewer,
    // coder, rotation or landing is started (ST-55 allowed only labels; ST-56 adds the pull
    // request).
    expect(writes(gh).map((r) => `${r.method} ${r.rest}`)).toEqual(['POST /pulls', 'POST /labels', 'POST /labels', 'POST /labels'])
  })

  it('ST-55/AC-4: with land false the runway lands nothing unattended, but lands a scoped manual request for an eligible pull request', async () => {
    const cwd = makeRepo()
    await runInit(['--yes'], { cwd })

    for (const inputs of [{}, { prInput: '1' }, { prInput: '1', modeInput: 'unattended' }]) {
      const w = world(cwd)
      const result = runRunway({ ...asGate, ...inputs }, w.deps)
      expect(result.landed).toBeNull()
      expect(result.refused).toMatch(/land is false/)
      expect(w.merges).toEqual([])
    }

    const w = world(cwd)
    expect(runRunway({ ...asGate, prInput: '1', modeInput: 'manual', headInput: HEAD }, w.deps)).toEqual({ landed: 1 })
    expect(w.merges).toEqual([['1', '--repo', 'owner/project', '--squash', '--match-head-commit', HEAD]])
  })

  it('ST-55/AC-4: with land true the runway keeps its unattended eligibility', async () => {
    const cwd = makeRepo()
    await runInit(['--yes', '--land', 'yes'], { cwd })
    for (const inputs of [{}, { prInput: '1' }]) {
      const w = world(cwd)
      expect(runRunway({ ...asGate, ...inputs }, w.deps)).toEqual({ landed: 1 })
      expect(w.merges).toEqual([['1', '--repo', 'owner/project', '--squash', '--match-head-commit', HEAD]])
    }
  })

  /** A GitHub for `landPullRequest`: pull request 7 is open and landable until it is dispatched. */
  function landWorld() {
    const requests = []
    const SHA7 = 'a'.repeat(40)
    const fetch = async (url, init) => {
      requests.push({ method: init.method, url })
      const ok = (json, code = 200) => ({ ok: true, status: code, json: async () => json })
      if (init.method === 'POST') return ok(null, 204)
      if (url.includes('/check-runs')) return ok({ total_count: 1, check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }] })
      if (url.includes('/commits/')) return ok({ statuses: [{ id: 1, context: 'review/agent', state: 'success' }] })
      const dispatched = requests.some((r) => r.method === 'POST')
      return ok({ head: { sha: SHA7 }, state: 'open', merged: dispatched, draft: false, labels: [], mergeable_state: 'clean' })
    }
    return { requests, fetch }
  }
  const land = async (settings, g, mode) => {
    const ctx = createLandContext({ repo: REPO, landing: settings.land, landWhen: settings.landWhen, fetch: g.fetch, getToken: async () => 't' })
    return landPullRequest({ number: 7, ctx, mode, once: true, sleep: async () => {}, latencyLog: path.join(fresh('log'), 'latency.jsonl') })
  }

  it('ST-55/AC-4: with the settings init wrote, the pilot lands nothing unattended and sends no request, and a manual request is dispatched', async () => {
    const cwd = makeRepo()
    await runInit(['--yes'], { cwd })
    const settings = await readSettings(snapshot(cwd))
    expect(settings.land).toBe(false)

    const unattended = landWorld()
    expect(await land(settings, unattended, 'unattended')).toMatchObject({ status: 'landing-off', triggers: 0 })
    expect(unattended.requests).toEqual([])

    const manual = landWorld()
    expect(await land(settings, manual, 'manual')).toMatchObject({ status: 'merged', mode: 'manual', triggers: 1 })
    const dispatch = manual.requests.filter((r) => r.method === 'POST')
    expect(dispatch.map((r) => r.url)).toEqual([`https://api.github.com/repos/${REPO}/actions/workflows/land-approved.yml/dispatches`])
  })

  it('ST-55/AC-4: with the settings init wrote for an explicit yes, the pilot dispatches an unattended landing', async () => {
    const cwd = makeRepo()
    await runInit(['--yes', '--land', 'yes'], { cwd })
    const settings = await readSettings(snapshot(cwd))
    expect(settings.land).toBe(true)
    const g = landWorld()
    expect(await land(settings, g, 'unattended')).toMatchObject({ status: 'merged', mode: 'unattended', triggers: 1 })
    expect(g.requests.filter((r) => r.method === 'POST')).toHaveLength(1)
  })
})
