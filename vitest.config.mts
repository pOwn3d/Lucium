import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) } },
  test: {
    // The pure modules of scripts/site-captures.mjs and scripts/site-film/film.mjs are tested beside them (scripts/site-*/*.test.ts), and the drawing of
    // the logo (scripts/logo/fan-logo.ts) with the pictures made from it, and the licence notices (scripts/notices/) with the file written from the lockfile,
    // and the icon of the probe extension (scripts/probe-icon/) with the file drawn from it, and the converter of the filter lists of the iOS blocker (scripts/ios-filter-lists/), and the finishing of the pictures of the iOS store listing (scripts/ios-store-shots/).
    include: ['src/**/*.test.ts', 'scripts/site-captures/**/*.test.ts', 'scripts/site-film/**/*.test.ts', 'scripts/logo/**/*.test.ts', 'scripts/notices/**/*.test.ts', 'scripts/probe-icon/**/*.test.ts', 'scripts/ios-filter-lists/**/*.test.ts', 'scripts/ios-store-shots/**/*.test.ts'],
    // Run on their own with `pnpm test:bench-script` (vitest.bench-script.config.mts), `pnpm test:snapshot-bench` (vitest.snapshot-bench.config.mts)
    // and `pnpm test:state-bench` (vitest.state-bench.config.mts).
    exclude: [...configDefaults.exclude, 'src/main/bench-script.test.ts', 'src/main/snapshot-bench.test.ts', 'src/main/state-bench.test.ts'],
    // A stylesheet is read as text by the tests that measure it (the tokens, the surfaces, the migrated sheets, the error pages): without this, vitest gives a `.css?raw` back empty.
    css: { include: [/\.css/] },
    // A measured run is several times slower: the tests keep their logic and get more time, so that the measure does not fail on the clock.
    ...(process.argv.includes('--coverage') ? { testTimeout: 60_000 } : {}),
    // `pnpm test:coverage`: which lines of the product the unit tests run. Measured on the product only: the tests, their supports, the engine
    // suites (they need a real Electron), the witnesses of the linter and the code of other projects are left out. A file no test imports counts too, at zero.
    // No threshold: the figure is there to find the code nothing runs, not to be reached with tests that prove nothing.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*test-support.ts', 'src/main/smoke*.ts', 'src/main/translate/vendor/**', 'src/**/*.d.ts', 'src/**/lint-witness.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      // The figure is wanted even when a test fails: a measured run is slower, and a test close to its time limit can pass it.
      reportOnFailure: true
    }
  }
})
