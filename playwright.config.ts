// End-to-end and visual tests of the real application (Electron), run with `pnpm test:e2e`. They open windows and take the focus: run them
// when the machine is not in use. The application they start reaches nothing outside the machine (tests/e2e/launch.ts).
import { defineConfig } from '@playwright/test'

/** A runner of the CI (GitHub sets `CI`): the run nobody watches, where a shortcut left in a test must fail instead of passing for a full run. */
const onRunner = !!process.env['CI']

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  // One application at a time: each test starts its own copy with its own data folder.
  workers: 1,
  fullyParallel: false,
  // A `test.only` left in a file would cut the nightly run down to one test, and the run would pass: on a runner it fails the run.
  forbidOnly: onRunner,
  // No retry: a test that passes on its second try is an unstable test, and the nightly run is where that is measured.
  retries: 0,
  // On a runner the failures are also written on the run's page (github) and in a file kept with the results (junit), not only in the raw log.
  reporter: onRunner ? [['list'], ['github'], ['junit', { outputFile: 'test-results/junit.xml' }]] : [['list']],
  // The reference pictures of the visual test (tests/e2e/settings.spec.ts) are compared on the machine that drew them: the pixels depend on the
  // screen, the fonts and the version of macOS. Two sets, by their name: `-ci` (drawn by the runner of the E2E workflow, kept in Git) and `-local`
  // (drawn on the machine at hand, not in Git).
  snapshotPathTemplate: `{testDir}/{testFileName}-snapshots/{arg}-{platform}-${onRunner ? 'ci' : 'local'}{ext}`,
  // A runner never draws a reference by itself: a missing one fails the test (the workflow's manual switch passes `--update-snapshots`, which wins).
  ...(onRunner ? { updateSnapshots: 'none' as const } : {}),
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: 'disabled' }
  },
  use: {
    trace: 'retain-on-failure'
  }
})
