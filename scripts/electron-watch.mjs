// Is a newer Electron (so a newer Chromium) out than the one this repository declares? Read-only: five public feeds are read (GET, no key, no
// account), nothing is written anywhere, and nothing of the user leaves the machine beyond the requests themselves (docs/mise-a-jour-chromium.md).
//
//   node scripts/electron-watch.mjs                  the report, in French
//   node scripts/electron-watch.mjs --json           the same as JSON (for a workflow or a launchd job)
//   node scripts/electron-watch.mjs --timeout=20000  the wait for each feed, in milliseconds (15 s by default)
//   node scripts/electron-watch.mjs --installed=45.0.0   compare another version than the one of package.json
//
// Exit code: 0 up to date, 10 a newer minor or patch on the installed line, 20 a newer major, 30 a feed could not be read (network, timeout,
// malformed answer: said on stderr, never silent), 2 the installed version or the arguments cannot be read.
//
// The logic (versions, feeds, verdict) is in src/main/electron-watch.ts, with its tests in src/main/electron-watch.test.ts; this file only
// reads package.json, fetches, prints.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The logic is TypeScript that Node runs as is (type stripping, like scripts/perf.mjs and scripts/census-textes-reglages.mjs do); package.json
// has no "type" field, so Node warns once about the module type of the .ts file. That warning alone is kept out of the report (an automation
// reads stderr for the real errors); every other warning still prints.
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (/** @type {NodeJS.ErrnoException} */ (warning).code !== 'MODULE_TYPELESS_PACKAGE_JSON') console.error(`${warning.name}: ${warning.message}`)
})
const { EXIT_USAGE, formatReport, watch } = await import('../src/main/electron-watch.ts')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const USER_AGENT = 'lucium-electron-watch (https://github.com/pOwn3d/Lucium)'

const usage = () => {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'))
}

/** `--name=value` and `--flag`; anything else is an error (a typo must not pass for a default). */
const readArgs = (argv) => {
  const args = { json: false, timeout: 15_000, installed: null, help: false }
  for (const arg of argv) {
    const [key, value] = arg.includes('=') ? arg.split(/=(.*)/s) : [arg, undefined]
    if (key === '--json' && value === undefined) args.json = true
    else if (key === '--help' || key === '-h') args.help = true
    else if (key === '--timeout' && value !== undefined && /^\d+$/.test(value) && Number(value) >= 1000) args.timeout = Number(value)
    else if (key === '--installed' && value) args.installed = value
    else throw new Error(`argument inconnu ou mal formé : ${arg} (voir --help)`)
  }
  return args
}

/** The Electron the repository declares: an exact version in package.json (the project pins it), checked against the binary installed in node_modules. */
const declaredElectron = () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const spec = pkg.devDependencies?.electron ?? pkg.dependencies?.electron
  if (typeof spec !== 'string') throw new Error('package.json ne déclare pas electron')
  const declared = spec.replace(/^[\^~=v]+/, '')
  const installedFile = join(root, 'node_modules/electron/package.json')
  const installed = existsSync(installedFile) ? JSON.parse(readFileSync(installedFile, 'utf8')).version : null
  return { declared, installed, spec }
}

/** GET as JSON, with a timeout; a non-2xx answer is an error naming the status (the feed is then "not read", exit 30 upstream). */
const fetchJson = (timeout) => async (url) => {
  const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(timeout) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

let args
try {
  args = readArgs(process.argv.slice(2))
} catch (error) {
  console.error(`electron-watch: ${error.message}`)
  process.exit(EXIT_USAGE)
}
if (args.help) {
  usage()
  process.exit(0)
}

let electron
try {
  electron = declaredElectron()
} catch (error) {
  console.error(`electron-watch: ${error.message}`)
  process.exit(EXIT_USAGE)
}
const installed = args.installed ?? electron.declared
const outcome = await watch(installed, fetchJson(args.timeout))

const notes = []
if (!args.installed && electron.installed && electron.installed !== electron.declared) notes.push(`node_modules/electron est en ${electron.installed} alors que package.json déclare ${electron.spec} : lancer pnpm install.`)
if (!args.installed && !electron.installed) notes.push('node_modules/electron est absent : la comparaison porte sur la version déclarée dans package.json.')

if (args.json) {
  console.log(JSON.stringify(outcome.kind === 'report' ? { ...outcome, notes, declared: electron } : { ...outcome, notes, declared: electron }, null, 2))
} else if (outcome.kind === 'report') {
  console.log(formatReport(outcome.report))
  for (const n of notes) console.log(`Note : ${n}`)
} else {
  for (const n of notes) console.error(`Note : ${n}`)
}
if (outcome.kind === 'error') console.error(`electron-watch: ${outcome.message} (code ${outcome.exitCode})`)
process.exit(outcome.exitCode)
