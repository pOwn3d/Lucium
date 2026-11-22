import { DISPLAY_ORIGIN, isInternalPageUrl } from './internal-page'

export interface ResolvedInput {
  kind: 'url' | 'search'
  url: string
}

const NAVIGABLE_SCHEMES = new Set(['http:', 'https:', 'file:'])
const SCHEME = /^([a-z][a-z0-9+.-]*):/i
const ALLOWED_SCHEMES = new Set(['http', 'https', 'file'])
const LOCAL_HOST = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/.*)?$/i
const DOMAIN_LIKE = /^[^\s/@]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i

/** Names that never leave the machine or the local network: no certificate authority signs for them (`isUpgradableHost` reads the same list). */
const LOCAL_ONLY_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.home.arpa', '.localdomain', '.intranet', '.corp']

/** Whether a host name (no port) ends in one of the names of a local network. */
export function hasLocalOnlySuffix(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return LOCAL_ONLY_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

/** The host of something typed without a scheme (`homeassistant.local:8123/x` gives `homeassistant.local`). */
function typedHost(text: string): string {
  return text.replace(/[/?#].*$/, '').replace(/:\d+$/, '')
}

/**
 * Turns what the user typed in the command bar into a navigable URL or a search.
 * Only http(s) and file URLs are navigated to: `javascript:` and friends fall back to a search. An address typed with its scheme stays an address
 * even when it cannot be read (`http://exa mple.com`, `http://[::1`): the user meant one, and is told it is not valid (`isNavigableUrl` is false
 * for it) rather than sent to a search.
 */
export function resolveInput(input: string, searchTemplate: string): ResolvedInput | null {
  const text = input.trim()
  if (!text) return null
  if (text === 'about:blank') return { kind: 'url', url: text }
  const scheme = SCHEME.exec(text)
  // "localhost:3000" parses as a scheme, so only trust a scheme followed by "//".
  if (scheme && /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const name = scheme[1]!.toLowerCase()
    return ALLOWED_SCHEMES.has(name) ? { kind: 'url', url: text } : search(text, searchTemplate)
  }
  // What only looks like an address (`javascript:x.com`, a port past 65535) and is none once a scheme is put before it is words to search for.
  if (!/\s/.test(text)) {
    if (LOCAL_HOST.test(text) && URL.canParse(`http://${text}`)) return { kind: 'url', url: `http://${text}` }
    // A name of the local network (`homeassistant.local:8123`) is typed for a device that speaks plain HTTP: no certificate authority signs for it, so
    // https:// could only fail (a blank page, in the first iPhone builds). An explicit `https://` is left as typed.
    if (DOMAIN_LIKE.test(text) && hasLocalOnlySuffix(typedHost(text)) && URL.canParse(`http://${text}`)) return { kind: 'url', url: `http://${text}` }
    if (DOMAIN_LIKE.test(text) && URL.canParse(`https://${text}`)) return { kind: 'url', url: `https://${text}` }
  }
  return search(text, searchTemplate)
}

/**
 * Whether what was typed is an address (a domain, an IP, `localhost`, a link) and not words to search for. Such text is never sent to the
 * search engine's suggestions. A link of a scheme the browser does not open (`ftp://`) is no search either, so it counts as an address.
 */
export function isTypedAddress(input: string): boolean {
  const text = input.trim()
  return resolveInput(text, '%s')?.kind === 'url' || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
}

function search(query: string, template: string): ResolvedInput {
  return { kind: 'search', url: template.replace('%s', encodeURIComponent(query)) }
}

/**
 * Host without "www.", or '' when `url` is not parseable (e.g. a half-typed query). '' as well for the Extensions page (`lucium-ui://extensions/`): its
 * "host" is a word of ours, and a site on a local network can be called `extensions` too, so every choice kept by host (zoom, permissions, boosts) would
 * have been shared between the two.
 */
export function hostOf(url: string): string {
  if (isInternalPageUrl(url)) return ''
  return URL.canParse(url) ? new URL(url).host.replace(/^www\./, '') : ''
}

/**
 * What the place of the address shows for a page: its host, or, for an address that has none, what the address itself says (`about:blank`, the name of a
 * local file, `data:`; `chrome://extensions` for the Extensions page). Never the title: a page writes its title, and a title that reads
 * « accounts.example.com » where the host is expected would pass for the site. '' when `url` is not an address.
 */
export function addressLabel(url: string): string {
  if (isInternalPageUrl(url)) return DISPLAY_ORIGIN
  const host = hostOf(url)
  if (host !== '' || !URL.canParse(url)) return host
  const { protocol, pathname } = new URL(url)
  if (protocol === 'about:') return `about:${pathname}`
  if (protocol === 'file:') return pathname.split('/').filter(Boolean).pop() ?? protocol
  return protocol
}

/** What a log may say of an address: its scheme and host. Never the path, the query or the fragment, which can hold a token or a private name. */
export function logOrigin(url: string): string {
  if (!URL.canParse(url)) return '(not an address)'
  const { protocol, host } = new URL(url)
  return host === '' ? protocol : `${protocol}//${host}`
}

/** A search address as the settings keep it: http(s), no blank or unprintable character, and the `%s` the query goes in. */
export function isSearchTemplate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && /^https?:\/\/\S+$/i.test(value) && value.includes('%s') && !/\p{Cc}/u.test(value)
}

/** The address check of every path that can open a tab (command bar, IPC, extensions, window.open, import). `file:` passes: a tab the user opens may be a local file. What a *page* may open is narrower (`isPageOpenUrl`, external-links.ts, which refuses `file:`). */
export function isNavigableUrl(url: string): boolean {
  return url === 'about:blank' || (URL.canParse(url) && NAVIGABLE_SCHEMES.has(new URL(url).protocol))
}

/**
 * An address no longer than `max`, on the same site as the whole one: what a tab keeps of an address too long to be kept. The end is what goes
 * (the fragment, the query, then the path), never the start: the host and the scheme are what the bar, the padlock and the site panel are read from.
 * A web address is written again from its origin, so that a name and a password of any length in front of the host (`https://bank.example:…@other.example/`)
 * cannot push the host past the cut and leave the name to be read as the site.
 */
export function cutAddress(url: string, max: number): string {
  if (url.length <= max) return url
  const prefix = /^view-source:/i.exec(url)?.[0] ?? ''
  const address = url.slice(prefix.length)
  if (URL.canParse(address)) {
    const { protocol, origin, pathname, search, hash } = new URL(address)
    if (protocol === 'http:' || protocol === 'https:') return `${prefix}${origin}${pathname}${search}${hash}`.slice(0, max)
  }
  return url.slice(0, max)
}

/** `view-source:` of a web page: Chromium's own view of the source, opened by the menu (View › Developer › View Source), never by a page. */
export function isViewSourceUrl(url: string): boolean {
  return /^view-source:https?:\/\/[^\s]+$/i.test(url)
}

/** A page of an extension (`chrome-extension://<id>/…`): it opens in a tab only when an extension asked for it (see `tab/open`). */
export function isExtensionPageUrl(url: string): boolean {
  return /^chrome-extension:\/\/[a-p]{32}\//.test(url)
}

/**
 * What the address of a page says about the connection it came over, for the mark beside the address and the footer of the site panel.
 * `http:` is a warning (nothing protects what is exchanged), and so is an `https:` page shown over a certificate that was let through although it
 * was not valid; any other `https:` page is secure. A page with no connection to judge (`file:`, `about:blank`, a page of an extension, `data:`) is neither: warning of it would cry wolf, and calling it secure would claim too much.
 * `view-source:` is the connection of the page whose source it shows.
 */
export type ConnectionState = 'secure' | 'insecure' | 'none'
export function connectionState(url: string, untrustedCertificate = false): ConnectionState {
  const address = url.replace(/^view-source:/i, '')
  if (!URL.canParse(address)) return 'none'
  const { protocol } = new URL(address)
  // An https page whose certificate was let through although it was not valid (`TabRuntime.untrustedCertificate`) is not secure: never a padlock.
  if (protocol === 'https:') return untrustedCertificate ? 'insecure' : 'secure'
  return protocol === 'http:' ? 'insecure' : 'none'
}

/** A host of this very machine (`localhost`, 127.0.0.0/8, `::1`): what a page sends there crosses no network. */
const THIS_MACHINE = /^(localhost|.+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i

/**
 * Whether the toolbar writes « Non sécurisé » beside the address: for a page whose connection is `insecure`, except a page in plain http served by this
 * very machine. Nothing of such a page travels where it could be read or changed, the engine itself treats it as a secure context, and the words in red
 * above every page a person is building would teach them to look past the warning. A certificate that was let through is always said, on any host.
 */
export function saysNotSecure(url: string, untrustedCertificate = false): boolean {
  if (connectionState(url, untrustedCertificate) !== 'insecure') return false
  return untrustedCertificate || !THIS_MACHINE.test(new URL(url.replace(/^view-source:/i, '')).hostname)
}

/** The mark of the connection in the sidebar: a padlock, a warning sign, or the "i" of a page that has no connection to speak of. */
export const CONNECTION_MARKS: Readonly<Record<ConnectionState, string>> = { secure: '🔒', insecure: '⚠', none: 'ⓘ' }

/** Hostname without port and without "www.", or '' when `url` is not parseable (or is the Extensions page: see `hostOf`). This is what a Tweak's host is compared to, and a rule of a container. */
export function hostnameOf(url: string): string {
  if (isInternalPageUrl(url)) return ''
  return URL.canParse(url) ? new URL(url).hostname.replace(/^www\./, '') : ''
}

/** The hostname as the URL parser gives it (no port; `www.` kept), or '' when `url` is not parseable. What a log or a per-site record of the engine names. */
export function urlHostname(url: string): string {
  if (isInternalPageUrl(url)) return ''
  return URL.canParse(url) ? new URL(url).hostname : ''
}

/** True when `url` is on `host` or one of its subdomains (any port). A trailing dot ("facebook.com.", "facebook.com%2e") names the same site, so it is dropped before comparing. */
export function matchesHost(host: string, url: string): boolean {
  const actual = hostnameOf(url).replace(/\.+$/, '')
  return actual !== '' && (actual === host || actual.endsWith(`.${host}`))
}
