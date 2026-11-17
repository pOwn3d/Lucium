// Writes THIRD-PARTY-NOTICES.txt: the npm packages a built Lucium carries, with the licence each declares and the text each ships, read from
// pnpm-lock.yaml and from the installed packages (scripts/notices/third-party-notices.ts says what is written and what is refused).
//
//   node scripts/make-third-party-notices.mjs           writes the file
//   node scripts/make-third-party-notices.mjs --check   writes nothing; exits 1 when the file is not what would be written
//   --root DIR                                          another project folder than this repository (its pnpm-lock.yaml, its node_modules): for the tests
//
// To run after any change of the dependencies (pnpm add, pnpm update, a new override): the test scripts/notices/third-party-notices.test.ts fails
// until the file is written again. Run `pnpm install --frozen-lockfile` first: the texts are read from node_modules.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Node reads the TypeScript of the generator by itself; its notice that the package has no "type" is not news.
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (/** @type {NodeJS.ErrnoException} */ (warning).code !== 'MODULE_TYPELESS_PACKAGE_JSON' && warning.name !== 'ExperimentalWarning') console.error(`${warning.name}: ${warning.message}`)
})
const { NOTICES_FILE, installedReader, parseLock, readPackages, renderNotices } = await import('./notices/third-party-notices.ts')

const rootAt = process.argv.indexOf('--root')
const root = resolve(rootAt === -1 ? join(dirname(fileURLToPath(import.meta.url)), '..') : (process.argv[rootAt + 1] ?? ''))
const target = join(root, NOTICES_FILE)
let wanted
try {
  wanted = renderNotices(readPackages(parseLock(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')), root, installedReader()))
} catch (error) {
  // Whatever makes the notices wrong (a package not installed, another version, no licence, no text) stops here, with its reason.
  console.error(`make-third-party-notices: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

if (process.argv.includes('--check')) {
  if (existsSync(target) && readFileSync(target, 'utf8') === wanted) {
    console.log(`make-third-party-notices: ${NOTICES_FILE} is up to date with pnpm-lock.yaml`)
  } else {
    console.error(`make-third-party-notices: ${NOTICES_FILE} is not what pnpm-lock.yaml gives: run node scripts/make-third-party-notices.mjs and commit the file`)
    process.exit(1)
  }
} else {
  writeFileSync(target, wanted)
  console.log(`make-third-party-notices: ${NOTICES_FILE} written (${wanted.split('\n').length} lines)`)
}
