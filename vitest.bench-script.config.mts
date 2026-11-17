import { defineConfig } from 'vitest/config'

// The test of scripts/compare-browsers.mjs starts servers and child processes (about 30 s): it is kept out of `pnpm test`.
// Run it with `pnpm test:bench-script`.
export default defineConfig({
  test: {
    include: ['src/main/bench-script.test.ts']
  }
})
