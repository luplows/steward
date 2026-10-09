// @vitest-environment node

// OQ-136's behavioural tests, of the clean-up (AC-4) and of the wait and repair (AC-2), in a
// file of its own. The install step's clean-up stops every process that starts during a try in a
// new process group or session, and these tests run that clean-up for real; another test starting
// a detached session meanwhile (spawn.mjs does, on Linux) could be stopped by it. So `npm test`
// leaves `*.alone.test.mjs` out (vite.config.js), and CI runs this file in a step of its own, with
// VITEST_ALONE=1.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOWS = [
  ['ci.yml', path.join(HERE, '..', '..', '.github', 'workflows', 'ci.yml')],
  ['update-screenshots.yml', path.join(HERE, '..', '..', '.github', 'workflows', 'update-screenshots.yml')],
]

// The `run: |` body of the `Setup: Playwright browsers` step, with its indentation removed: the
// lines after `run: |` that are blank or indented deeper than the `run:` key.
function installScriptOf(text) {
  const lines = text.split('\n')
  const nameAt = lines.findIndex((l) => l.trim() === "- name: 'Setup: Playwright browsers'")
  if (nameAt === -1) throw new Error('no "Setup: Playwright browsers" step found')
  const runAt = lines.findIndex((l, i) => i > nameAt && l.trim() === 'run: |')
  if (runAt === -1) throw new Error('the "Setup: Playwright browsers" step has no `run: |` block')
  const keyIndent = lines[runAt].indexOf('run:')
  const body = []
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= keyIndent) break
    body.push(line)
  }
  const bodyIndent = Math.min(...body.filter((l) => l.trim() !== '').map((l) => l.search(/\S/)))
  return body.map((l) => l.slice(bodyIndent)).join('\n')
}

const isLinux = process.platform === 'linux'

// Takes the step's own shell text from the workflow (not a reimplementation of it), and
// substitutes only: the GitHub Actions `${{ }}` expression bash cannot evaluate, the install
// command itself (for a stand-in that can be driven from a test), the 2-minute try limit (for
// test speed), the dpkg lock's path (for a file the test can lock), `sudo` on the probe (the
// test's lock file is its own), and the repair (which needs a real dpkg, so a stand-in command).
function testableScript(text, standinPath, lockPath, { dpkgLock, repair = 'true' }) {
  // No quotes round the paths: the step runs `$cmd` unquoted, and word splitting keeps quote
  // characters, so a quoted path names a file that does not exist (mkdtemp paths have no spaces).
  const standinCmd = `cmd="bash ${standinPath} ${lockPath} $attempt"`
  return installScriptOf(text)
    .replace('${{ steps.playwright-cache.outputs.cache-hit }}', 'true')
    .replaceAll('cmd="npx playwright install-deps chromium"', standinCmd)
    .replaceAll('cmd="npx playwright install --with-deps chromium"', standinCmd)
    .replace('timeout 2m $cmd', 'timeout 2s $cmd')
    .replace('dpkg_lock=/var/lib/dpkg/lock-frontend', `dpkg_lock=${dpkgLock}`)
    .replace('sudo python3 -c "$probe"', 'python3 -c "$probe"')
    .replace('sudo timeout 20s dpkg --configure -a', repair)
}

// GitHub Actions runs a `run:` block as `bash -e {0}`, so the tests do too.
const runStep = (script) => spawnSync('bash', ['-e', '-c', script], { timeout: 20000, encoding: 'utf8' })
const report = (result) =>
  `status ${result.status}, signal ${result.signal}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`

describe('OQ-136/AC-4: a detached child holding the lock in a session of its own is killed by the clean-up, so the next try takes the lock, and a process the try did not start survives (skips on non-Linux platforms, named here)', () => {
  it('the script taken from each workflow is the step body, with every substitution applied', () => {
    for (const [, file] of WORKFLOWS) {
      const script = testableScript(readFileSync(file, 'utf8'), '/s', '/l', { dpkgLock: '/d', repair: 'false' })
      expect(script.startsWith('for attempt in 1 2; do\n'), script).toBe(true)
      expect(script.trimEnd().endsWith('exit 1'), script).toBe(true)
      expect(script).toContain('cmd="bash /s /l $attempt"')
      expect(script).toContain('timeout 2s $cmd')
      expect(script).toContain('dpkg_lock=/d\n')
      expect(script).toContain('! python3 -c "$probe" "$dpkg_lock"')
      expect(script).toContain('if ! false; then')
      for (const gone of ['${{', 'npx playwright', 'timeout 2m', 'sudo python3', 'sudo timeout', '/var/lib/dpkg']) {
        expect(script, `still contains ${gone}`).not.toContain(gone)
      }
    }
  })

  it.skipIf(!isLinux)(
    'on attempt 1 the stand-in starts a detached setsid child holding the lock file and outliving its own hang, and an unrelated process starts a child; the clean-up kills the setsid child but not the unrelated one; on attempt 2 the stand-in takes the now-free lock and the step exits 0',
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'oq136-'))
      const standinPath = path.join(dir, 'standin.sh')
      const lockPath = path.join(dir, 'lock')
      writeFileSync(
        standinPath,
        [
          '#!/bin/bash',
          'lockfile="$1"',
          'attempt="$2"',
          'if [ "$attempt" = "1" ]; then',
          // The holder's stdio is closed so that, if the clean-up misses it, it cannot keep the
          // step's output pipes open; it records its pid so the test can stop it either way.
          `  setsid bash -c 'echo $$ > "$0.holder"; exec 9>"$0"; flock 9; sleep 100' "$lockfile" </dev/null >/dev/null 2>&1 &`,
          '  disown',
          '  sleep 100',
          'else',
          '  flock -n "$lockfile" true 2>/dev/null',
          'fi',
        ].join('\n'),
      )

      for (const [label, file] of WORKFLOWS) {
        // A free stand-in for the dpkg lock, so the wait ends at once.
        const script = testableScript(readFileSync(file, 'utf8'), standinPath, lockPath, {
          dpkgLock: path.join(dir, 'dpkg-lock-free'),
        })
        // Already running when the step starts, so not the try's; it starts a child half a second
        // into attempt 1, which the clean-up must leave alone.
        const unrelatedPidFile = path.join(dir, `unrelated-${label}.pid`)
        const unrelated = spawn('bash', ['-c', `sleep 0.5; sleep 30 & echo $! > ${unrelatedPidFile}; wait`], {
          stdio: 'ignore',
        })
        let result
        let unrelatedPid = null
        let unrelatedAlive = false
        try {
          result = runStep(script)
          if (existsSync(unrelatedPidFile)) {
            unrelatedPid = Number(readFileSync(unrelatedPidFile, 'utf8'))
            try {
              process.kill(unrelatedPid, 0)
              unrelatedAlive = true
            } catch {
              // gone
            }
          }
        } finally {
          unrelated.kill('SIGKILL')
          for (const pidFile of [unrelatedPidFile, `${lockPath}.holder`]) {
            if (!existsSync(pidFile)) continue
            const pid = Number(readFileSync(pidFile, 'utf8'))
            try {
              process.kill(pidFile === unrelatedPidFile ? pid : -pid, 'SIGKILL')
            } catch {
              // already gone
            }
          }
        }
        const output = report(result)
        expect(result.status, `expected the step to recover the lock and exit 0 for ${file}\n${output}`).toBe(0)
        expect(result.stdout, output).toContain('Stopping leftover processes from attempt 1')
        expect(unrelatedPid, `the unrelated process never started its child\n${output}`).not.toBeNull()
        expect(
          result.stdout.split(/\s+/),
          `the clean-up stopped the unrelated process's child, pid ${unrelatedPid}\n${output}`,
        ).not.toContain(String(unrelatedPid))
        expect(unrelatedAlive, `the unrelated process's child, pid ${unrelatedPid}, did not survive\n${output}`).toBe(
          true,
        )
      }
    },
    30000,
  )
})

describe('OQ-136/AC-2: the wait sees an fcntl lock like the one apt and dpkg take, and a failing repair still leaves the second try (skips on non-Linux platforms, named here)', () => {
  // Takes an fcntl lock on its file the way apt and dpkg do, says so by writing `<file>.held`, and
  // keeps it for the given seconds.
  const HOLDER = [
    'import fcntl, sys, time',
    'f = open(sys.argv[1], "a")',
    'fcntl.lockf(f, fcntl.LOCK_EX)',
    'open(sys.argv[1] + ".held", "w").close()',
    'time.sleep(float(sys.argv[2]))',
  ].join('\n')

  // Fails attempt 1 at once and succeeds on attempt 2, so the wait and the repair between them
  // are what the step's time and output are about.
  function writeStandin(dir) {
    const standinPath = path.join(dir, 'standin.sh')
    writeFileSync(standinPath, ['#!/bin/bash', '[ "$2" = "2" ]'].join('\n'))
    return standinPath
  }

  function waitFor(file, ms) {
    const until = Date.now() + ms
    while (!existsSync(file) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    return existsSync(file)
  }

  it.skipIf(!isLinux)(
    'while another process holds an fcntl lock on the stand-in dpkg lock for 4s, the wait goes on, then ends once it lets go, logging a wait above zero, and the second try runs',
    () => {
      for (const [, file] of WORKFLOWS) {
        const dir = mkdtempSync(path.join(tmpdir(), 'oq136-wait-'))
        const dpkgLock = path.join(dir, 'lock-frontend')
        // Already running when the step starts, in this process's group and session, so the
        // clean-up leaves it alone, as it would leave a lock holder the try did not start.
        const holder = spawn('python3', ['-c', HOLDER, dpkgLock, '4'], { stdio: 'ignore' })
        try {
          expect(waitFor(`${dpkgLock}.held`, 5000), 'the holder never took its lock').toBe(true)
          // The lock is fcntl's, as apt's is: a flock probe, the step's old one, does not see it.
          expect(spawnSync('flock', ['-n', dpkgLock, 'true']).status, 'flock saw the fcntl lock').toBe(0)
          const script = testableScript(readFileSync(file, 'utf8'), writeStandin(dir), path.join(dir, 'x'), {
            dpkgLock,
          })
          const result = runStep(script)
          const output = report(result)
          expect(result.status, `expected exit 0 for ${file}\n${output}`).toBe(0)
          const waited = Number(result.stdout.match(/Waited (\d+)s for /)?.[1])
          expect(waited, output).toBeGreaterThanOrEqual(2)
          expect(waited, output).toBeLessThan(30)
          expect(result.stdout, output).toContain('Playwright install attempt 2 of 2')
        } finally {
          holder.kill('SIGKILL')
        }
      }
    },
    30000,
  )

  it.skipIf(!isLinux)(
    'when the repair fails, the step logs so and still makes the second try, under bash -e',
    () => {
      for (const [, file] of WORKFLOWS) {
        const dir = mkdtempSync(path.join(tmpdir(), 'oq136-repair-'))
        const script = testableScript(readFileSync(file, 'utf8'), writeStandin(dir), path.join(dir, 'x'), {
          dpkgLock: path.join(dir, 'lock-frontend'),
          repair: 'false',
        })
        const result = runStep(script)
        const output = report(result)
        expect(result.status, `expected exit 0 for ${file}\n${output}`).toBe(0)
        expect(result.stdout, output).toContain('Waited 0s for ')
        expect(result.stdout, output).toContain(
          'dpkg --configure -a failed or ran past 20s; making the second try anyway',
        )
        expect(result.stdout, output).toContain('Playwright install attempt 2 of 2')
      }
    },
    30000,
  )
})
