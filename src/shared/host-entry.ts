// A site as the lists of sites keep it (the sites never put to sleep, the sites where nothing is blocked): a host name, written one way.
// The one reading of what a person typed or pasted, and of what a saved list holds.

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const HOSTNAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`)
/** An IPv6 address as the URL parser writes it, in its brackets: it has checked the address and put it in its one canonical form. */
const IPV6_LITERAL = /^\[[0-9a-f:.]+\]$/
/** The longest host name the DNS allows. */
const HOSTNAME_MAX = 253

/**
 * The host a typed address stands for: lower case, no scheme, port, path or leading "www." (the address of a tab is compared the same way).
 * Null when it is neither a host name nor an IPv6 address, or when the text is longer than `textMax`. A pasted address works, so does "*.example.com".
 */
export function normalizeHostEntry(input: unknown, textMax: number): string | null {
  if (typeof input !== 'string') return null
  const text = input.trim().toLowerCase().replace(/^\*\./, '')
  if (text === '' || text.length > textMax) return null
  const address = /^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`
  if (!URL.canParse(address)) return null
  const url = new URL(address)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname.replace(/^www\./, '').replace(/\.$/, '')
  return host.length <= HOSTNAME_MAX && (HOSTNAME.test(host) || IPV6_LITERAL.test(host)) ? host : null
}

/** What a saved list may hold: valid hosts only (as `normalize` reads them), each once, in order, `max` at most. Anything else is dropped. */
export function cleanHostEntries(value: unknown, normalize: (entry: unknown) => string | null, max: number): string[] {
  if (!Array.isArray(value)) return []
  const hosts = new Set<string>()
  for (const entry of value) {
    const host = normalize(entry)
    if (host) hosts.add(host)
    if (hosts.size >= max) break
  }
  return [...hosts]
}
