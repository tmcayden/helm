import { defineConfig } from 'vitest/config'

/**
 * `core`, `cli` and `pi` have unit tests, and that is the point: they are the packages with
 * logic worth testing in isolation, precisely because it does not need a window
 * to run. The desktop package's behaviour is covered by the spike harness
 * (`pnpm fidelity`, `pnpm claude-check`), which drives a real Electron window.
 */
export default defineConfig({
  test: {
    include: ['packages/core/src/**/*.test.ts', 'packages/cli/src/**/*.test.ts', 'packages/pi/src/**/*.test.mjs'],
    environment: 'node',
    // Native modules and temp directories: a worker per file keeps a failing
    // test from leaving an open SQLite handle in a process another test reuses.
    pool: 'forks',
    testTimeout: 30_000,
    reporters: process.env['CI'] ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'reports/vitest-junit.xml' }
  }
})
