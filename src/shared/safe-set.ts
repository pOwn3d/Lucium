// A set of host names kept as short hashes, the way the lists of Safe browsing travel in the application: sorted, 6 bytes a host, looked up by
// binary search. 392,000 phishing hosts are 2.4 MB instead of 11 MB of text, and nothing is parsed or allocated per host when the set is read.
// A host is a 48-bit hash: two different hosts meet with a chance of about 1 in 10^9 for a list of that size, and a meeting only means that a warning
// page (with « Continue anyway ») shows for a harmless site. No import here: scripts/build-safe-browsing.mjs reads this file with Node directly.

/** The first bytes of a packed set: « Lucium Safe Browsing », version 1. */
const MAGIC = [0x4c, 0x53, 0x42, 0x31] as const
const HEADER_BYTES = 8
const ENTRY_BYTES = 6
/** A host name is at most 253 characters; a longer line is not one. */
const HOST_MAX_CHARS = 253

/** The most the packed lists may weigh together, in bytes: they travel in every download of the application. 4 MB is 1.7 times today's snapshot (2.36 MB). */
export const SNAPSHOT_MAX_BYTES = 4_000_000

/** Two 32-bit halves of the 48-bit hash of a host (cyrb53-style mixing: fast, spreads well, and nothing a list could be crafted against). */
export function hashHost(host: string): { hi: number; lo: number } {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < host.length; i++) {
    const code = host.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return { hi: (h2 >>> 0) & 0xffff, lo: h1 >>> 0 }
}

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9-]{2,63}$/
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/

/** The host of a line of a list as it is compared: lower case, no final dot; null for a line that is not a plain host name or IPv4 address. */
export function listedHost(line: string): string | null {
  const host = line.trim().toLowerCase().replace(/\.$/, '')
  if (host.length === 0 || host.length > HOST_MAX_CHARS) return null
  return DOMAIN.test(host) || IPV4.test(host) ? host : null
}

/** The hosts a list of text names: one a line, `#` and `!` lines left out, a line that is not a plain host name dropped (counted by the caller from the difference). */
export function hostsOfList(text: string): { hosts: string[]; skipped: number } {
  const hosts: string[] = []
  let skipped = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue
    const host = listedHost(line)
    if (host === null) skipped++
    else hosts.push(host)
  }
  return { hosts, skipped }
}

/** The packed set of a list of hosts: each once, sorted. */
export function packHosts(hosts: Iterable<string>): Uint8Array {
  const seen = new Set<string>()
  const entries: Array<{ hi: number; lo: number }> = []
  for (const host of hosts) {
    if (seen.has(host)) continue
    seen.add(host)
    entries.push(hashHost(host))
  }
  entries.sort((a, b) => a.hi - b.hi || a.lo - b.lo)
  // Two hosts with the same hash are one entry: the search would otherwise find either.
  const unique = entries.filter((e, i) => i === 0 || e.hi !== entries[i - 1]!.hi || e.lo !== entries[i - 1]!.lo)
  const bytes = new Uint8Array(HEADER_BYTES + unique.length * ENTRY_BYTES)
  const view = new DataView(bytes.buffer)
  bytes.set(MAGIC, 0)
  view.setUint32(4, unique.length)
  unique.forEach((e, i) => {
    const at = HEADER_BYTES + i * ENTRY_BYTES
    view.setUint16(at, e.hi)
    view.setUint32(at + 2, e.lo)
  })
  return bytes
}

/** A packed set, read. */
export class SafeSet {
  private readonly view: DataView
  readonly size: number

  // No parameter properties: Node reads this file as it is, by stripping the types only.
  private constructor(view: DataView, size: number) {
    this.view = view
    this.size = size
  }

  /** The set a packed file holds, or null when the bytes are not one: another header, a length that does not match, entries out of order (the search would miss hosts). */
  static read(bytes: Uint8Array): SafeSet | null {
    if (bytes.length < HEADER_BYTES || MAGIC.some((byte, i) => bytes[i] !== byte)) return null
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const size = view.getUint32(4)
    if (bytes.length !== HEADER_BYTES + size * ENTRY_BYTES) return null
    const set = new SafeSet(view, size)
    for (let i = 1; i < size; i++) if (set.compare(i - 1, view.getUint16(HEADER_BYTES + i * ENTRY_BYTES), view.getUint32(HEADER_BYTES + i * ENTRY_BYTES + 2)) >= 0) return null
    return set
  }

  /** Whether the entry at `index` is below (negative), equal to or above (positive) the hash. */
  private compare(index: number, hi: number, lo: number): number {
    const at = HEADER_BYTES + index * ENTRY_BYTES
    return this.view.getUint16(at) - hi || this.view.getUint32(at + 2) - lo
  }

  has(host: string): boolean {
    const { hi, lo } = hashHost(host)
    let from = 0
    let to = this.size - 1
    while (from <= to) {
      const middle = (from + to) >>> 1
      const order = this.compare(middle, hi, lo)
      if (order === 0) return true
      if (order < 0) from = middle + 1
      else to = middle - 1
    }
    return false
  }
}
