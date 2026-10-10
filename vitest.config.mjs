import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Every test here is a Node script test. Seven test files have no
    // `@vitest-environment node` pragma; tower-workshop-paths ran them under
    // its jsdom default and setup file, neither of which moved.
    environment: 'node',
  },
})
