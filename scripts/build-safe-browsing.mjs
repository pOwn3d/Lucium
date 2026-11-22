// Prepares the two lists of Safe browsing that the application carries (shared/safe-browsing.ts): a plain download of the public lists below, packed
// by shared/safe-set.ts into resources/safe-browsing/{phishing,malware}.bin, with SOURCES.json saying where each came from and when.
//
//   node scripts/build-safe-browsing.mjs                                      fetches both lists and writes resources/safe-browsing/
//   node scripts/build-safe-browsing.mjs --phishing FILE --malware FILE       reads the lists from files: no network
//   node scripts/build-safe-browsing.mjs --out DIR                            writes elsewhere
//
// A step of the maintainer's Mac before a release (docs/community/release-process.md), not something the application does: the application downloads
// nothing for this feature. The fetch is a plain GET with nothing sent. Nothing is written unless both lists were read and are not empty.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (/** @type {NodeJS.ErrnoException} */ (warning).code !== 'MODULE_TYPELESS_PACKAGE_JSON' && warning.name !== 'ExperimentalWarning') console.error(`${warning.name}: ${warning.message}`)
})
const { hostsOfList, packHosts, SafeSet, SNAPSHOT_MAX_BYTES } = await import('../src/shared/safe-set.ts')

/** The lists, with what the licence of each lets us do (docs/licences-tierces.md). */
export const SOURCES = {
  phishing: {
    url: 'https://raw.githubusercontent.com/mitchellkrogza/Phishing.Database/master/phishing-domains-ACTIVE.txt',
    name: 'Phishing.Database, phishing-domains-ACTIVE',
    licence: 'MIT'
  },
  malware: {
    url: 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-domains-online.txt',
    name: 'urlhaus-filter, domains online (data of abuse.ch URLhaus)',
    licence: 'CC0-1.0 and MIT'
  }
}
/** Below this a download is a failure, not a list: the real ones are thousands of hosts. */
const MIN_HOSTS = { phishing: 10_000, malware: 500 }

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const valueOf = (flag) => {
  const at = args.indexOf(flag)
  return at === -1 ? undefined : args[at + 1]
}
/** @returns {never} */
const fail = (message) => {
  console.error(`build-safe-browsing: ${message}`)
  process.exit(1)
}

const out = resolve(valueOf('--out') ?? join(root, 'resources/safe-browsing'))
const packed = {}
const facts = {}
for (const kind of /** @type {const} */ (['phishing', 'malware'])) {
  const file = valueOf(`--${kind}`)
  let text
  if (file) text = readFileSync(file, 'utf8')
  else {
    const response = await fetch(SOURCES[kind].url, { redirect: 'follow' })
    if (!response.ok) fail(`${SOURCES[kind].url} answered ${response.status}`)
    text = await response.text()
  }
  const { hosts, skipped } = hostsOfList(text)
  if (hosts.length < MIN_HOSTS[kind]) fail(`the ${kind} list has ${hosts.length} hosts, fewer than ${MIN_HOSTS[kind]}: not written`)
  const bytes = packHosts(hosts)
  const set = SafeSet.read(bytes)
  if (set === null || !hosts.every((host) => set.has(host))) throw new Error(`the packed ${kind} list does not read back`)
  packed[kind] = bytes
  facts[kind] = { ...SOURCES[kind], hosts: set.size, skipped, sha256: createHash('sha256').update(bytes).digest('hex') }
}

const total = Object.values(packed).reduce((sum, bytes) => sum + bytes.length, 0)
if (total > SNAPSHOT_MAX_BYTES) fail(`the packed lists weigh ${total} bytes, more than the ${SNAPSHOT_MAX_BYTES} allowed: not written (choose a smaller source)`)

mkdirSync(out, { recursive: true })
for (const kind of Object.keys(packed)) {
  const target = join(out, `${kind}.bin`)
  writeFileSync(`${target}.tmp`, packed[kind])
  renameSync(`${target}.tmp`, target)
}
writeFileSync(join(out, 'SOURCES.json'), `${JSON.stringify({ builtAt: new Date().toISOString().slice(0, 10), lists: facts }, null, 2)}\n`)
console.log(`build-safe-browsing: ${out}`, Object.fromEntries(Object.entries(facts).map(([kind, f]) => [kind, `${f.hosts} hosts, ${packed[kind].length} bytes`])))
