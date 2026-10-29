/**
 * Test support: a complete `steward.config.json` body. `readSettings` requires
 * every key (ST-18), so a fixture that writes one starts from this and
 * overrides only the keys the test is about. Not imported by any script.
 */
export const FIXTURE_SETTINGS = {
  repo: 'owner/repo',
  setup: { command: 'npm ci', timeoutMinutes: 5 },
  check: { command: 'npm run check', timeoutMinutes: 10 },
  landWhen: 'all-checks',
  land: true,
  unitLinks: ['file'],
  rulesFile: 'REVIEW.md',
  inspectAfterHours: 24,
}

export function fixtureSettings(overrides = {}) {
  return { ...FIXTURE_SETTINGS, ...overrides }
}

/**
 * Test support: a complete user-config body (`user-config.mjs`). The choices are named
 * for their models, so a story's `model: sonnet` names one. The coder's default is `sonnet` and the
 * reviewer's is `opus`; each role has the other as its second choice. The coder's choices have a
 * `strength` (ST-35/AC-5): `opus` is the stronger.
 */
export const FIXTURE_USER_CONFIG = {
  coordinator: { scanIntervalMinutes: 15 },
  usageLimits: {
    coder: { session: 70, weekly: 75 },
    reviewer: { session: 90, weekly: 90 },
  },
  roles: {
    coder: {
      default: 'sonnet',
      available: {
        sonnet: { tool: 'claude', model: 'sonnet', effort: 'medium', strength: 1 },
        opus: { tool: 'claude', model: 'opus', effort: 'high', strength: 2 },
      },
    },
    reviewer: {
      default: 'opus',
      available: {
        opus: { tool: 'claude', model: 'opus', effort: 'high' },
        sonnet: { tool: 'claude', model: 'sonnet', effort: 'high' },
      },
    },
  },
}

export function fixtureUserConfig(overrides = {}) {
  return { ...structuredClone(FIXTURE_USER_CONFIG), ...overrides }
}
