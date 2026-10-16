/**
 * Test support: a complete `steward.config.json` body. `readSettings` requires
 * every key (ST-18), so a fixture that writes one starts from this and
 * overrides only the keys the test is about. Not imported by any script.
 */
export const FIXTURE_SETTINGS = {
  repo: 'owner/repo',
  storyPrefix: 'ST',
  setup: { command: 'npm ci', timeoutMinutes: 5 },
  check: { command: 'npm run check', timeoutMinutes: 10 },
  landWhen: 'all-checks',
  land: true,
  unitLinks: ['file'],
  rulesFile: 'REVIEW.md',
  usageLimits: {
    coder: { session: 70, weekly: 75 },
    reviewer: { session: 90, weekly: 90 },
  },
}

export function fixtureSettings(overrides = {}) {
  return { ...FIXTURE_SETTINGS, ...overrides }
}
