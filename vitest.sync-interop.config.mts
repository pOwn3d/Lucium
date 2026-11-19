import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The Mac of the interoperability check with the iPhone (scripts/sync-interop/): a long-lived process, not a test of `pnpm test`.
// Run it with scripts/sync-interop/run.sh (or `pnpm test:sync-interop-peer` to start the Mac alone).
export default defineConfig({
  resolve: { alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) } },
  test: {
    include: ['scripts/sync-interop/mac-peer.run.ts'],
    // The peer lives until the iPhone side says stop.
    testTimeout: 3_600_000,
    hookTimeout: 60_000,
    reporters: ['verbose']
  }
})
