import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The measure of the work on the state (src/main/state-bench.test.ts) prints timings and is kept out of `pnpm test`.
// Run it with `pnpm test:state-bench`.
export default defineConfig({
  resolve: { alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) } },
  test: {
    include: ['src/main/state-bench.test.ts'],
    // The table is written by a console call: the default reporter keeps the output of a passing file out of sight.
    reporters: ['verbose']
  }
})
