// Prepares the filter lists the iOS application embeds (docs/ios.md, section 6): fetches each list of the Mac's catalogue, converts it to the
// rules WebKit's content blocker reads, and writes them with a registry of where each list comes from (the application shows it).
//
//   node scripts/ios-filter-lists.mjs                 fetches the lists, writes ios/Lucium/FilterLists/ (not committed)
//   node scripts/ios-filter-lists.mjs --from DIR      reads DIR/<id>.txt instead of fetching: no network
//   node scripts/ios-filter-lists.mjs --out DIR       writes elsewhere
//   node scripts/ios-filter-lists.mjs --only a,b      only these lists
//   node scripts/ios-filter-lists.mjs --fixture       converts scripts/ios-filter-lists/fixtures/proof.txt into ios/LuciumTests/Fixtures/ (committed)
//
// This is a build step of the maintainer's Mac (docs/community/release-process.md), not something the application does: the application
// downloads nothing, and the lists change with it only. The fetch is a plain GET of the public address of each list, with nothing sent.
// Nothing is written unless every list was read, converted and described: a failed fetch leaves the previous folder as it was.
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Node reads the TypeScript of the converter by itself; its notice that the package has no "type" is not news.
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (/** @type {NodeJS.ErrnoException} */ (warning).code !== 'MODULE_TYPELESS_PACKAGE_JSON' && warning.name !== 'ExperimentalWarning') console.error(`${warning.name}: ${warning.message}`)
})
const { convertList, WEBKIT_RULE_LIMIT } = await import('./ios-filter-lists/abp-to-webkit.ts')
const { buildEmbedded, EMBEDDED_LIST_IDS, fixtureFiles } = await import('./ios-filter-lists/embedded-lists.ts')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const valueOf = (flag) => {
  const at = args.indexOf(flag)
  return at === -1 ? undefined : args[at + 1]
}
const fail = (message) => {
  console.error(`ios-filter-lists: ${message}`)
  process.exit(1)
}

if (args.includes('--fixture')) {
  const text = readFileSync(join(root, 'scripts/ios-filter-lists/fixtures/proof.txt'), 'utf8')
  const target = join(root, 'ios/LuciumTests/Fixtures')
  mkdirSync(target, { recursive: true })
  for (const [name, content] of Object.entries(fixtureFiles(convertList(text), text, WEBKIT_RULE_LIMIT))) writeFileSync(join(target, name), content)
  console.log(`ios-filter-lists: fixture written in ${target}`)
  process.exit(0)
}

// The catalogue of the Mac (src/shared/filter-lists.ts) is TypeScript with imports Node does not follow: Vite reads it, as for the application.
const { createServer } = await import('vite')
const server = await createServer({ root, configFile: false, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' })
let catalogue
let catalogueMentions
let setLanguage
let validateFilterList
try {
  const lists = await server.ssrLoadModule('/src/shared/filter-lists.ts')
  const i18n = await server.ssrLoadModule('/src/shared/i18n.ts')
  catalogue = lists.FILTER_LISTS
  validateFilterList = lists.validateFilterList
  setLanguage = i18n.setLanguage
  // The mentions are read in both languages, from the same getters the Mac's settings print.
  const read = (list, field) => {
    setLanguage('en')
    const en = list[field]
    setLanguage('fr')
    const fr = list[field]
    return { en, fr }
  }
  catalogueMentions = new Map(catalogue.map((list) => [list.id, { title: read(list, 'title'), author: read(list, 'author'), license: read(list, 'license') }]))
} finally {
  await server.close()
}

const only = valueOf('--only')?.split(',')
const ids = only ?? EMBEDDED_LIST_IDS
const unknown = ids.filter((id) => !catalogue.some((list) => list.id === id))
if (unknown.length > 0) fail(`not in the catalogue of the Mac: ${unknown.join(', ')}`)
const from = valueOf('--from')
const out = resolve(valueOf('--out') ?? join(root, 'ios/Lucium/FilterLists'))

/** A plain GET of the address of a list, https only, bounded in time. */
async function fetchList(spec) {
  const response = await fetch(spec.url, { redirect: 'follow', signal: AbortSignal.timeout(120_000), headers: { 'user-agent': 'lucium-ios-filter-lists' } })
  if (!response.ok) throw new Error(`${spec.url}: HTTP ${response.status}`)
  return response.text()
}

const inputs = []
const failures = []
for (const id of ids) {
  const spec = catalogue.find((list) => list.id === id)
  try {
    // A copy read from a folder is dated by the file: that is when it was fetched, not when it was converted.
    const file = from ? join(resolve(from), `${id}.txt`) : null
    const text = file ? readFileSync(file, 'utf8') : await fetchList(spec)
    setLanguage('en')
    // The same check as the Mac's, so that a captive-portal page or a cut download is not converted into an empty blocker.
    const verdict = validateFilterList(text, { minRules: spec.minRules })
    if (!verdict.ok) throw new Error(verdict.reason)
    inputs.push({
      source: { id, ...catalogueMentions.get(id), category: spec.category, licenseUrl: spec.licenseUrl, homepage: spec.homepage, sourceUrl: spec.url },
      text,
      fetchedAt: (file ? statSync(file).mtime : new Date()).toISOString().replace(/\.\d+Z$/, 'Z'),
      converted: convertList(text)
    })
  } catch (error) {
    failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
if (failures.length > 0) fail(`nothing written, ${failures.length} list(s) failed:\n- ${failures.join('\n- ')}`)

let embedded
try {
  embedded = buildEmbedded(inputs, new Date().toISOString().replace(/\.\d+Z$/, 'Z'), WEBKIT_RULE_LIMIT)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

// Written beside the target and moved into place: a run that stops half-way leaves the previous folder.
const staging = mkdtempSync(`${out}.tmp-`)
try {
  for (const [name, content] of Object.entries(embedded.files)) writeFileSync(join(staging, name), content)
  rmSync(out, { recursive: true, force: true })
  renameSync(staging, out)
} catch (error) {
  rmSync(staging, { recursive: true, force: true })
  throw error
}

const rows = embedded.registry.lists.map((list) => {
  const network = list.files.find((file) => file.kind === 'network')?.rules ?? 0
  const cosmetic = list.files.find((file) => file.kind === 'cosmetic')?.rules ?? 0
  const left = Object.values(list.dropped).reduce((sum, count) => sum + count, 0)
  return `${list.id.padEnd(20)} ${String(list.filters).padStart(7)} filters → ${String(network).padStart(7)} network + ${String(cosmetic).padStart(6)} cosmetic rules, ${String(left).padStart(6)} filters left out`
})
console.log(`ios-filter-lists: ${embedded.registry.lists.length} lists written in ${out}\n${rows.join('\n')}`)
