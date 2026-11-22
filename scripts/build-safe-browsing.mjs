// Prepares the two lists of Safe browsing that the application carries (shared/safe-browsing.ts): a plain download of the public lists below, packed
// by shared/safe-set.ts into resources/safe-browsing/{phishing,malware}.bin, with SOURCES.json saying where each came from and when.
//
//   node scripts/build-safe-browsing.mjs                                      fetches both lists and writes resources/safe-browsing/
//   node scripts/build-safe-browsing.mjs --phishing FILE --malware FILE       reads the lists from files: no network
//   node scripts/build-safe-browsing.mjs --out DIR                            writes elsewhere
//
// A step of the maintainer's Mac before a release (docs/community/release-process.md), not something the application does: the application downloads
// nothing for this feature. The fetch is a plain GET with nothing sent. Nothing is written unless both lists were read and are not empty, none of the shared
// hosts of SHARED_HOSTS (shared/safe-set.ts) is left in, and the size of each list is within 20 % of the snapshot being replaced (`--force` to go past it).
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (/** @type {NodeJS.ErrnoException} */ (warning).code !== 'MODULE_TYPELESS_PACKAGE_JSON' && warning.name !== 'ExperimentalWarning') console.error(`${warning.name}: ${warning.message}`)
})
const { hostsOfList, packHosts, SafeSet, SHARED_HOSTS, SNAPSHOT_MAX_BYTES, withoutSharedHosts } = await import('../src/shared/safe-set.ts')

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

/** A download longer than this, or slower than this, is not a list: the biggest one today is 11 MB. */
const FETCH_MAX_BYTES = 40_000_000
const FETCH_TIMEOUT_MS = 120_000
/** A list that grew or shrank by more than this since the snapshot being replaced is looked at by a person before it ships. */
const MAX_CHANGE = 0.2

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
const force = args.includes('--force')
const previous = (() => {
  try {
    return JSON.parse(readFileSync(join(out, 'SOURCES.json'), 'utf8')).lists ?? {}
  } catch {
    return {}
  }
})()
const packed = {}
const facts = {}
for (const kind of /** @type {const} */ (['phishing', 'malware'])) {
  const file = valueOf(`--${kind}`)
  let source
  if (file) source = readFileSync(file)
  else {
    const response = await fetch(SOURCES[kind].url, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) fail(`${SOURCES[kind].url} answered ${response.status}`)
    if (Number(response.headers.get('content-length') ?? 0) > FETCH_MAX_BYTES) fail(`${SOURCES[kind].url} is larger than ${FETCH_MAX_BYTES} bytes: not read`)
    source = Buffer.from(await response.arrayBuffer())
    if (source.length > FETCH_MAX_BYTES) fail(`${SOURCES[kind].url} is larger than ${FETCH_MAX_BYTES} bytes: not read`)
  }
  const { hosts: listed, skipped } = hostsOfList(source.toString('utf8'))
  const hosts = withoutSharedHosts(listed)
  const removedShared = listed.length - hosts.length
  if (hosts.length < MIN_HOSTS[kind]) fail(`the ${kind} list has ${hosts.length} hosts, fewer than ${MIN_HOSTS[kind]}: not written`)
  const bytes = packHosts(hosts)
  const set = SafeSet.read(bytes)
  if (set === null || !hosts.every((host) => set.has(host))) throw new Error(`the packed ${kind} list does not read back`)
  const left = SHARED_HOSTS.filter((host) => set.has(host))
  if (left.length > 0) fail(`the packed ${kind} list still holds shared hosts (${left.join(', ')}): not written`)
  const before = previous[kind]?.hosts
  if (!force && typeof before === 'number' && Math.abs(set.size - before) > before * MAX_CHANGE) fail(`the ${kind} list went from ${before} to ${set.size} hosts, more than ${MAX_CHANGE * 100} %: read the source, then run again with --force`)
  packed[kind] = bytes
  facts[kind] = { ...SOURCES[kind], hosts: set.size, skipped, removedShared, sourceSha256: createHash('sha256').update(source).digest('hex'), sha256: createHash('sha256').update(bytes).digest('hex') }
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
