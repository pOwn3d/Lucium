// Search engines a site declares about itself (OpenSearch): the discovery half of the "!" keywords.
//
// A page that wants to be searched from the address bar says so in its own head: <link rel="search" type="application/opensearchdescription+xml"
// title="…" href="/opensearch.xml">. That is all discovery reads: the links of the document that is already loaded, in an isolated world of
// the tab. No request is made to find out whether a site has one, and nothing is added without a click on a notice (once per site).
// Only that click reads the description file the link points to (one request, to the site the user is on, nothing sent along, a few
// kilobytes at most), because the search address is in it. Pure rules here; main/shell/search-discovery.ts holds the effects.
//
// Imported by the main process only (isOwnSite brings the public suffix list along).

import { DEFAULT_SITE_SEARCHES, SEARCH_DISCOVERY_SEEN_MAX, type Settings, type SidebarState, type SiteSearch } from './model'
import { BUILTIN_BANGS } from './bangs'
import { SITE_SEARCHES_MAX } from './state-clean'
import { isOwnSite, siteOf } from './party'
import { isSearchTemplate } from './url'
import { LOOPBACK_HOST } from './site-search'

/** Bytes of a description file that are read; a bigger one is refused. */
export const OPENSEARCH_FILE_MAX = 64 * 1024
/** Milliseconds given to that one request. */
export const OPENSEARCH_FETCH_TIMEOUT_MS = 4000
const DECLARED_MAX = 3
const TITLE_MAX = 60

export interface DeclaredSearch {
  /** The `title` of the link, tidied; empty when it has none. */
  title: string
  /** Address of the description file: absolute, on the site of the page. */
  href: string
}

/** The script that reads the declarations from the document. It returns the links as they are, for `cleanDeclaredSearches` to check. */
export const DECLARED_SEARCH_SCRIPT = String.raw`(() => {
  const found = []
  for (const link of document.querySelectorAll('link[rel~="search" i][type="application/opensearchdescription+xml" i][href]')) {
    if (found.length >= ${DECLARED_MAX + 2}) break
    found.push({ title: String(link.getAttribute('title') || '').slice(0, 200), href: String(link.href || '').slice(0, 2048) })
  }
  return found
})()`

/** An address a search may live at: https, or plain http on this machine (a site being built). The settings keep the same addresses (`isSearchAddress`). */
function isSecureOrLoopback(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOST.test(url.hostname))
}

/** The host of a page worth looking at (a web page on https, or on this machine), or null. */
export function discoverableHost(pageUrl: string): string | null {
  if (!URL.canParse(pageUrl)) return null
  const url = new URL(pageUrl)
  return isSecureOrLoopback(url) && url.username === '' && url.password === '' ? url.hostname : null
}

const printable = (value: unknown, max: number): string => (typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '')

/** What the page reported, checked: a few links whose files sit on the site of the page. Anything else is dropped. */
export function cleanDeclaredSearches(raw: unknown, pageUrl: string): DeclaredSearch[] {
  if (!Array.isArray(raw) || discoverableHost(pageUrl) === null) return []
  const out: DeclaredSearch[] = []
  for (const entry of raw.slice(0, DECLARED_MAX + 2)) {
    if (out.length >= DECLARED_MAX) break
    if (typeof entry !== 'object' || entry === null) continue
    const href = (entry as Record<string, unknown>)['href']
    if (typeof href !== 'string' || href.length > 2048 || !URL.canParse(href)) continue
    const url = new URL(href)
    if (!isSecureOrLoopback(url) || url.username !== '' || url.password !== '' || !isOwnSite(url.href, pageUrl)) continue
    out.push({ title: printable((entry as Record<string, unknown>)['title'], TITLE_MAX), href: url.href })
  }
  return out
}

/**
 * Whether a page that has just loaded is looked at for the search it declares at all: the setting is on, the window keeps a list of
 * searches to add to (a private window does not), the tab is not a private one (the site it visits would be recorded as offered, in the
 * state file), and the tab is the one on screen (a notice about a page nobody looks at would mislead).
 */
export function discoveryApplies(settings: Pick<Settings, 'searchDiscovery'>, tab: { isPrivate: boolean; privateTab?: boolean; shown: boolean }): boolean {
  return settings.searchDiscovery && !tab.isPrivate && tab.privateTab !== true && tab.shown
}

/** Sites remembered as offered, the newest last, none twice, no more than the list keeps. */
export function rememberSearchHost(seen: readonly string[], host: string): string[] {
  return [...seen.filter((h) => h !== host), host].slice(-SEARCH_DISCOVERY_SEEN_MAX)
}

/** The host of the address of a search of the user's, or null. */
const hostOfTemplate = (template: string): string | null => (URL.canParse(template.replace('%s', 'x')) ? new URL(template.replace('%s', 'x')).hostname : null)

/**
 * The search to offer for a page, or null: the setting is on, the page is on https (or this machine), the site was not offered its
 * search before, the user has not got a search of that site already and has room for another one.
 */
export function discoveryOffer(state: SidebarState, pageUrl: string, declared: readonly DeclaredSearch[]): DeclaredSearch | null {
  const { settings } = state
  const host = discoverableHost(pageUrl)
  const first = declared[0]
  if (!settings.searchDiscovery || host === null || !first) return null
  if (settings.searchDiscoverySeen.includes(host) || settings.siteSearches.length >= SITE_SEARCHES_MAX) return null
  if (settings.siteSearches.some((s) => { const own = hostOfTemplate(s.url); return own !== null && isOwnSite(`https://${own}/`, pageUrl) })) return null
  return first
}

// ---------- the description file ----------

export interface OpenSearchDescription {
  /** The `ShortName`, or null when the file has none. */
  name: string | null
  /** The search address, `%s` where the terms go. */
  template: string
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeXml(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,4}));/gi, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return XML_ENTITIES[name.toLowerCase()] ?? whole
    const code = dec !== undefined ? Number(dec) : parseInt(hex!, 16)
    return code >= 0x20 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole
  })
}

/** What fills the parameters of a template that are not the search terms; an optional one that is not here is simply left out. */
const FIXED_PARAMETERS: Record<string, string> = { inputEncoding: 'UTF-8', outputEncoding: 'UTF-8', language: '*', startPage: '1', startIndex: '1', count: '10' }
const TERMS_MARK = '\u0001'

/**
 * An OpenSearch template as the settings keep it: `{searchTerms}` becomes `%s`. Refuses a template with a parameter it cannot fill, with
 * the terms twice or not at all, with a "%s" of its own, that is not on https (or this machine) or that leaves the site of the page.
 */
export function openSearchTemplate(raw: string, pageUrl: string): string | null {
  const text = decodeXml(raw).trim()
  if (text.length === 0 || text.length > 2048 || /\p{Cc}/u.test(text) || text.includes('%s')) return null
  let terms = 0
  let refused = false
  const filled = text.replace(/\{([^{}]{1,40})\}/g, (_whole, inner: string) => {
    const optional = inner.endsWith('?')
    const name = inner.replace(/\?$/, '').replace(/^[\w-]+:/, '')
    if (name === 'searchTerms') {
      terms++
      return TERMS_MARK
    }
    const fixed = Object.hasOwn(FIXED_PARAMETERS, name) ? FIXED_PARAMETERS[name] : undefined
    if (fixed !== undefined) return fixed
    if (!optional) refused = true
    return ''
  })
  // A brace left over is a parameter that did not close; the mark is ours (the text has no control character), so it stands for the terms alone.
  if (refused || terms !== 1 || /[{}]/.test(filled)) return null
  const template = filled.replace(TERMS_MARK, '%s')
  if (!URL.canParse(template.replace('%s', 'x'))) return null
  const url = new URL(template.replace('%s', 'x'))
  if (!isSecureOrLoopback(url) || url.username !== '' || url.password !== '' || !isOwnSite(url.href, pageUrl) || !isSearchTemplate(template)) return null
  return template
}

const URL_TAG = /<(?:[\w.-]+:)?Url\b([^>]{0,3000})>/gi
const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]{0,2100})"|'([^']{0,2100})')/g
const SHORT_NAME = /<(?:[\w.-]+:)?ShortName\b[^>]{0,200}>([^<]{1,2000})</i

/** Reads the first web search (a GET `text/html` URL) of a description file. Null when the file has none the settings could keep. */
export function parseOpenSearch(xml: string, pageUrl: string): OpenSearchDescription | null {
  if (typeof xml !== 'string' || xml.length > OPENSEARCH_FILE_MAX) return null
  let tags = 0
  for (const tag of xml.matchAll(URL_TAG)) {
    if (++tags > 20) break
    const attributes = new Map<string, string>()
    for (const attribute of tag[1]!.matchAll(ATTRIBUTE)) attributes.set(attribute[1]!.toLowerCase(), attribute[2] ?? attribute[3] ?? '')
    const type = (attributes.get('type') ?? 'text/html').toLowerCase()
    const method = (attributes.get('method') ?? 'get').toLowerCase()
    if (method !== 'get' || (type !== 'text/html' && type !== 'application/xhtml+xml')) continue
    const template = openSearchTemplate(attributes.get('template') ?? '', pageUrl)
    if (!template) continue
    const name = printable(decodeXml(SHORT_NAME.exec(xml)?.[1] ?? ''), TITLE_MAX)
    return { name: name || null, template }
  }
  return null
}

/** A keyword for a site search made from a host ("fr.wikipedia.org" → "wikipedia"): letters and digits, at most 12, unlike every one in `taken`. */
export function suggestKeyword(host: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((k) => k.toLowerCase()))
  for (const bang of BUILTIN_BANGS) used.add(bang.keyword)
  for (const site of DEFAULT_SITE_SEARCHES) used.add(site.keyword)
  // The name of the site is the first label of its registrable domain ("fr.wikipedia.org" → "wikipedia"); a host that is an address has none.
  const word = (siteOf(`https://${host}/`) ?? host).split('.')[0]!.toLowerCase().replace(/[^a-z0-9]/g, '')
  const base = /^[a-z]/.test(word) ? word.slice(0, 10) : 'site'
  if (!used.has(base)) return base
  // Numbers one after the other (never a random one: the same host and the same list must always give the same answer).
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base.slice(0, 12 - String(n).length)}${n}`
    if (!used.has(candidate)) return candidate
  }
  return `${base.slice(0, 7)}${used.size}`
}

/** The search to keep for a description file read for a page, or null when it cannot be one. */
export function siteSearchFromDescription(description: OpenSearchDescription, declared: DeclaredSearch, host: string, taken: Iterable<string>): SiteSearch {
  return { keyword: suggestKeyword(host, taken), name: description.name ?? (declared.title || host), url: description.template }
}
