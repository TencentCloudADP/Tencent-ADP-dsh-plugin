import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/live/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    passWithNoTests: true,
  },
})
