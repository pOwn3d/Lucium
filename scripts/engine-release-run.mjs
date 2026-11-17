// Runs the engine suites a release needs and writes their record, which scripts/publish-update.mjs reads before it publishes anything
// (src/main/release-gate.ts): `pnpm test:engine:release`.
//
// IT OPENS REAL WINDOWS and takes the keyboard focus for a long while: run it on a Mac that is not in use, never on your own initiative when you
// are a coding assistant (AGENTS.md).
//
// In order, every step run whatever the one before did:
//   pnpm test:engine             the chain of the engine suites; it writes out-engine/report.json
//   pnpm compat:compare          that report against the reference of the engine (compat/baseline-electron-<version>.json)
//   pnpm test:engine:webstore    the web store suite
//   pnpm test:engine:extwindows  the extensions in three profiles and three windows
//
// Then out-engine/release-run.json: the commit, the exit code of each step, the SHA-256 of the report, the dates. The run passed when the report
// lost nothing against the reference and the two suites that run apart ended with 0: the chain itself is judged by the comparison, since the
// reference holds the checks that are known to fail.
//
// Nothing is started when a tracked file is modified: the suites would run on no commit. The record names the commit the run started on; the
// publication wants it to be the commit the archive was built from.
// Exit code: 0 the suites passed, 1 they did not or the record says why it cannot be used, 2 nothing was started.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (/** @type {NodeJS.ErrnoException} */ (warning).code !== 'MODULE_TYPELESS_PACKAGE_JSON') console.error(`${warning.name}: ${warning.message}`)
})
const { realRecordDeps, runEngineRelease } = await import('../src/main/release-records.ts')
const gate = await import('../src/main/release-gate.ts')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (process.argv.length > 2) {
  console.error('engine-release-run: no option. It runs the four steps and writes out-engine/release-run.json')
  process.exit(2)
}
const result = runEngineRelease({ root }, realRecordDeps(root, (line) => console.log(line), gate))
if (result.ok) console.log('The engine suites passed: this commit can be built and published.')
else {
  console.error(`\nengine-release-run: ${result.file ? 'the suites did not pass' : 'nothing was started'}:\n  ${result.problems.join('\n  ')}`)
  process.exit(result.file ? 1 : 2)
}
