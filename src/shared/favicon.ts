// Finding the icon of a site without loading its page in a tab (favourites, pinned tabs and imported tabs that never loaded have none).
// Pure on purpose: the fetching lives in main/shell/favicon-resolver.ts, which hands this file the first 64 KB of a page and the
// bytes of an icon and gets back the addresses to try and a verdict. Nothing here touches the network or Electron.
//
// The HTML reader is a small tolerant scanner, not a parser: it only has to find <link rel="icon"> and <base href> in the head of
// a page it does not trust. It is linear in the input, never throws, keeps every list it builds bounded, and ignores comments and
// the text of <script>, <style>, <title>, <textarea> and <noscript>, where a browser would not see a link either.

import type { SidebarState, TabItem } from './model'
import { isInternalPageUrl } from './internal-page'
import { isUpgradableHost } from './privacy'
import { hslToHex, luminance } from './theme'

/** The first bytes of a page that are looked at: the icons are declared in the head, long before this. */
export const FAVICON_HTML_MAX = 65_536
/** The largest icon that is kept (the list of tabs is drawn at 16 px: anything bigger is a mistake, or a trap). */
export const FAVICON_FILE_MAX = 262_144
/** The longest address stored for an icon (state files keep it as is). */
export const FAVICON_URL_MAX = 2048
/** How many addresses are tried for one site: the best declared ones, then /favicon.ico. */
export const FAVICON_CANDIDATES_MAX = 4

const TAGS_MAX = 5000
const LINKS_MAX = 64
const ATTRIBUTES_MAX = 48
const ATTRIBUTE_VALUE_MAX = 4096

// ---------- what may be asked, and where ----------

/** A host that is on the public Internet (not this machine or the local network): the only kind a site-icon request goes to. */
export const isPublicHost = (hostname: string): boolean => isUpgradableHost(hostname)

export interface IconTarget {
  /** `https://exemple.fr`, the form `URL.origin` gives (the port is there when it is not the default one). */
  origin: string
  /** The page asked for, the root of the site. */
  root: string
  hostname: string
  /** `host[:port]`: how the engine test names a host. */
  host: string
  /** The address is https: nothing downgrades it to http. */
  secure: boolean
}

/** The site of an address, or null when the address is not a web page (a file, a data: URL, an extension page, a login in the address…). */
export function iconTarget(address: unknown): IconTarget | null {
  if (typeof address !== 'string' || address.length > FAVICON_URL_MAX || !URL.canParse(address)) return null
  const url = new URL(address)
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname === '' || url.username !== '' || url.password !== '') return null
  return { origin: url.origin, root: `${url.origin}/`, hostname: url.hostname, host: url.host, secure: url.protocol === 'https:' }
}

/**
 * Whether `icon` may stand for the icon of `page`: an https address (an http one only for a page that is itself http), without a
 * login, short enough to be stored. Never a data:, javascript: or file: address.
 */
export function iconAllowedFor(icon: unknown, page: string): boolean {
  if (typeof icon !== 'string' || icon.length > FAVICON_URL_MAX || !URL.canParse(icon)) return false
  const url = new URL(icon)
  if (url.hostname === '' || url.username !== '' || url.password !== '') return false
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && URL.canParse(page) && new URL(page).protocol === 'http:'
}

/** Whether a tab or favourite already shows an icon: an address the interface can load, or an inline image. */
export const hasIcon = (faviconUrl: unknown): boolean => typeof faviconUrl === 'string' && /^(?:https?:\/\/|data:image\/)/i.test(faviconUrl)

// ---------- reading the head of a page ----------

const CONTROL = /[\u0000-\u001f\u007f]/g
const SPACE = /[\t\n\f\r ]+/

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** The few character references an address is written with. Anything else stays as it is (it would fail the address check anyway). */
function decodeEntities(value: string): string {
  if (!value.includes('&')) return value
  return value.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g, (_all, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name) return ENTITIES[name]!
    const code = dec !== undefined ? Number(dec) : Number.parseInt(hex!, 16)
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '\ufffd'
  })
}

/** Elements whose text is not markup. A link written inside one (a template string in a script) is not a link of the page. */
const RAW_TEXT = new Set(['script', 'style', 'title', 'textarea', 'noscript', 'xmp', 'iframe', 'noembed', 'noframes'])

const isLetter = (c: string | undefined): boolean => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))
const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r'

interface Tag {
  name: string
  attributes: Map<string, string>
}

/** Reads the attributes of the tag that starts at `at` (just after its name). Null when the text ends inside the tag. */
function readAttributes(text: string, at: number): { attributes: Map<string, string>; end: number } | null {
  const attributes = new Map<string, string>()
  let pos = at
  for (;;) {
    while (pos < text.length && (isSpace(text[pos]!) || text[pos] === '/')) pos++
    if (pos >= text.length) return null
    if (text[pos] === '>') return { attributes, end: pos + 1 }
    const nameStart = pos
    // The first character is part of the name even when it is "=" (the HTML rule), so the loop always moves on.
    pos++
    while (pos < text.length && !isSpace(text[pos]!) && text[pos] !== '/' && text[pos] !== '>' && text[pos] !== '=') pos++
    const name = text.slice(nameStart, pos).toLowerCase()
    while (pos < text.length && isSpace(text[pos]!)) pos++
    let value = ''
    if (text[pos] === '=') {
      pos++
      while (pos < text.length && isSpace(text[pos]!)) pos++
      const quote = text[pos]
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(quote, pos + 1)
        if (close === -1) return null
        value = text.slice(pos + 1, close)
        pos = close + 1
      } else {
        const valueStart = pos
        while (pos < text.length && !isSpace(text[pos]!) && text[pos] !== '>') pos++
        value = text.slice(valueStart, pos)
      }
    }
    // The first of two attributes of one name wins, as in a browser; a value too long to be anything we look for is as good as absent.
    if (attributes.size < ATTRIBUTES_MAX && !attributes.has(name)) attributes.set(name, value.length > ATTRIBUTE_VALUE_MAX ? '' : value)
  }
}

/** Index of the end tag `</name` after `from`, ignoring case; -1 when there is none. */
function indexOfEndTag(text: string, name: string, from: number): number {
  for (let at = text.indexOf('</', from); at !== -1; at = text.indexOf('</', at + 2)) {
    if (text.slice(at + 2, at + 2 + name.length).toLowerCase() === name) return at
  }
  return -1
}

/** The start tags of the markup in `html` (its first `FAVICON_HTML_MAX` characters), in order, with the text of comments and raw-text elements left out. */
function* tagsOf(html: string): Generator<Tag> {
  const text = html.length > FAVICON_HTML_MAX ? html.slice(0, FAVICON_HTML_MAX) : html
  let pos = 0
  let seen = 0
  while (pos < text.length && seen < TAGS_MAX) {
    const lt = text.indexOf('<', pos)
    if (lt === -1) return
    const next = text[lt + 1]
    if (text.startsWith('<!--', lt)) {
      // "<!-->" and "<!--->" are comments that end at once; an unterminated one swallows the rest, as it does in a browser.
      if (text.startsWith('<!-->', lt)) pos = lt + 5
      else if (text.startsWith('<!--->', lt)) pos = lt + 6
      else {
        const end = text.indexOf('-->', lt + 4)
        if (end === -1) return
        pos = end + 3
      }
      continue
    }
    if (next === '!' || next === '?' || next === '/') {
      const end = text.indexOf('>', lt + 2)
      if (end === -1) return
      pos = end + 1
      continue
    }
    if (!isLetter(next)) {
      pos = lt + 1
      continue
    }
    let nameEnd = lt + 1
    while (nameEnd < text.length && !isSpace(text[nameEnd]!) && text[nameEnd] !== '/' && text[nameEnd] !== '>') nameEnd++
    const name = text.slice(lt + 1, nameEnd).toLowerCase()
    const read = readAttributes(text, nameEnd)
    if (!read) return
    seen++
    yield { name, attributes: read.attributes }
    pos = read.end
    if (name === 'plaintext') return
    if (RAW_TEXT.has(name)) {
      const close = indexOfEndTag(text, name, pos)
      if (close === -1) return
      pos = close
    }
  }
}

export type IconKind = 'icon' | 'apple'
export type IconFormat = 'png' | 'svg' | 'ico' | 'other'

export interface IconLink {
  /** The absolute address, without fragment. */
  url: string
  kind: IconKind
  /** The declared size in pixels nearest to what the sidebar shows; `Infinity` for "any"; 0 when none is declared. */
  size: number
  format: IconFormat
  /** Meant for a dark appearance (a `media` query on prefers-color-scheme: dark): the sidebar prefers the other one. */
  dark: boolean
  /** Position in the page. */
  order: number
}

/** The sizes a `sizes` attribute declares, in pixels (the larger side of each): `32x32 64x64` gives 32 and 64, `any` gives Infinity. */
function declaredSizes(sizes: string | undefined): number[] {
  if (!sizes) return []
  const out: number[] = []
  for (const token of sizes.toLowerCase().split(SPACE).slice(0, 16)) {
    if (token === 'any') out.push(Infinity)
    else {
      const match = /^(\d{1,5})x(\d{1,5})$/.exec(token)
      if (match) out.push(Math.max(Number(match[1]), Number(match[2])))
    }
  }
  return out
}

/** How far a declared size is from what the sidebar wants (32 to 64 px): smaller is worse than larger, and a big picture only costs bytes. */
function sizeDistance(size: number, format: IconFormat, kind: IconKind): number {
  if (size === Infinity) return 0
  if (size === 0) {
    if (format === 'svg') return 0
    // The apple-touch-icon of a page that gives no size is 180 px by convention.
    return kind === 'apple' ? (180 - 64) / 2 : 16
  }
  if (size < 32) return 32 - size
  return size <= 64 ? 0 : (size - 64) / 2
}

const FORMAT_RANK: Record<IconFormat, number> = { png: 0, svg: 1, ico: 2, other: 3 }

function formatOf(type: string | undefined, url: URL): IconFormat {
  const declared = type?.toLowerCase().split(';')[0]?.trim()
  if (declared === 'image/png' || declared === 'image/apng') return 'png'
  if (declared === 'image/svg+xml') return 'svg'
  if (declared === 'image/x-icon' || declared === 'image/vnd.microsoft.icon' || declared === 'image/ico') return 'ico'
  if (declared) return 'other'
  const path = url.pathname.toLowerCase()
  if (path.endsWith('.png')) return 'png'
  if (path.endsWith('.svg')) return 'svg'
  if (path.endsWith('.ico')) return 'ico'
  return 'other'
}

/** The icons a page declares, resolved against the page (or its `<base href>`), with everything that is not a safe address left out. */
export function parseIconLinks(html: string, pageUrl: string): IconLink[] {
  if (typeof html !== 'string' || typeof pageUrl !== 'string' || !URL.canParse(pageUrl)) return []
  const page = new URL(pageUrl)
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return []
  let base: URL | null = null
  const raw: Array<{ href: string; kind: IconKind; sizes: number[]; type: string | undefined; dark: boolean }> = []
  for (const tag of tagsOf(html)) {
    if (tag.name === 'base') {
      const href = clean(tag.attributes.get('href'))
      // The first <base> that has an address decides, wherever it stands (a browser applies it to the links before it too).
      if (!base && href !== '' && URL.canParse(href, page)) {
        const candidate = new URL(href, page)
        if (candidate.protocol === 'http:' || candidate.protocol === 'https:') base = candidate
      }
      continue
    }
    if (tag.name !== 'link' || raw.length >= LINKS_MAX) continue
    const rel = decodeEntities(tag.attributes.get('rel') ?? '').toLowerCase().split(SPACE)
    const kind: IconKind | null = rel.includes('icon') ? 'icon' : rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed') ? 'apple' : null
    const href = clean(tag.attributes.get('href'))
    if (!kind || href === '' || href.length > FAVICON_URL_MAX) continue
    const media = decodeEntities(tag.attributes.get('media') ?? '').toLowerCase()
    raw.push({ href, kind, sizes: declaredSizes(decodeEntities(tag.attributes.get('sizes') ?? '')), type: tag.attributes.get('type'), dark: /prefers-color-scheme\s*:\s*dark/.test(media) })
  }
  const links: IconLink[] = []
  for (const [order, link] of raw.entries()) {
    const baseUrl = base ?? page
    if (!URL.canParse(link.href, baseUrl)) continue
    const url = new URL(link.href, baseUrl)
    url.hash = ''
    if (!iconAllowedFor(url.href, page.href)) continue
    const format = formatOf(link.type, url)
    // Of several declared sizes the one nearest to what is wanted counts.
    const size = link.sizes.length === 0 ? 0 : link.sizes.reduce((best, s) => (sizeDistance(s, format, link.kind) < sizeDistance(best, format, link.kind) ? s : best))
    links.push({ url: url.href, kind: link.kind, size, format, dark: link.dark, order })
  }
  return links
}

/** An attribute value as an address: character references decoded, controls removed, ends trimmed. */
function clean(value: string | undefined): string {
  return decodeEntities(value ?? '').replace(CONTROL, '').trim()
}

/** The declared icons, best first: the plain icons by size, then format; the apple-touch-icons only after them. */
export function rankIconLinks(links: readonly IconLink[]): IconLink[] {
  const key = (l: IconLink): number[] => [l.kind === 'icon' ? 0 : 1, l.dark ? 1 : 0, sizeDistance(l.size, l.format, l.kind), FORMAT_RANK[l.format], l.order]
  return [...links].sort((a, b) => {
    const [ka, kb] = [key(a), key(b)]
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!
    return 0
  })
}

/**
 * The addresses to try for a page, best first, at most `FAVICON_CANDIDATES_MAX`: the icons the page declares (the plain ones by size
 * and format, then the apple-touch-icons), then `/favicon.ico` of the page's own origin as the last resort. `html` may be empty.
 * `usable` drops the addresses the caller will not ask for (a host it may not go to) before the count, so that they take no place.
 */
export function iconCandidates(html: string, pageUrl: string, usable: (address: string) => boolean = () => true): string[] {
  const target = iconTarget(pageUrl)
  if (!target) return []
  const declared = rankIconLinks(parseIconLinks(html, pageUrl)).map((l) => l.url)
  const last = new URL('/favicon.ico', target.root).href
  const out: string[] = []
  for (const url of declared) {
    if (out.length >= FAVICON_CANDIDATES_MAX - 1) break
    if (!out.includes(url) && usable(url)) out.push(url)
  }
  if (!out.includes(last)) out.push(last)
  return out
}

/** The one address to prefer for a page, or null when it is not a web page. */
export const pickIcon = (html: string, pageUrl: string): string | null => iconCandidates(html, pageUrl)[0] ?? null

// ---------- checking what came back ----------

export type SniffedFormat = 'png' | 'ico' | 'gif' | 'jpeg' | 'webp' | 'avif' | 'bmp' | 'svg'

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean => signature.every((b, i) => bytes[at + i] === b)

/** The picture format the first bytes announce, or null when they are not a picture a browser would show as an icon. */
export function sniffImage(bytes: Uint8Array): SniffedFormat | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  // An icon file: reserved 0, type 1, then a count of images that is not zero.
  if (startsWith(bytes, [0, 0, 1, 0]) && ((bytes[4] ?? 0) !== 0 || (bytes[5] ?? 0) !== 0)) return 'ico'
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp'
  if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69], 4)) return 'avif'
  if (startsWith(bytes, [0x42, 0x4d])) return 'bmp'
  // A vector picture: its root element is <svg> (after an optional byte-order mark, XML prolog, comments and doctype).
  const head = String.fromCharCode(...bytes.subarray(0, 1024))
  if (/^(?:\s|<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!doctype[^>]*>)*<svg[\s>]/i.test(head.replace(/^\u00ef\u00bb\u00bf/, ''))) return 'svg'
  return null
}

/**
 * Whether an answer is an icon worth keeping: a real picture of a reasonable size whose declared type does not contradict it. A server
 * that sends its HTML error page with a 200 is the usual trap, and a vector picture sent as anything but image/svg+xml would not show.
 */
export function acceptIcon(contentType: string | null | undefined, bytes: Uint8Array): boolean {
  if (bytes.length < 16 || bytes.length > FAVICON_FILE_MAX) return false
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase()
  const format = sniffImage(bytes)
  if (format === null) return false
  if (format === 'svg') return type === 'image/svg+xml'
  return type.startsWith('image/') || type === '' || type === 'application/octet-stream' || type === 'binary/octet-stream'
}

// ---------- which items want an icon ----------

/** One thing to find an icon for: `favorite:<id>` or `tab:<id>`, the address that stands for it, and how soon (0 favourites, 1 pinned tabs, 2 Today). */
export interface IconJob {
  id: string
  url: string
  rank: number
}

/**
 * The favourites and the tabs of the spaces being shown that have no icon, in the order they are worth fetching: the favourites, the
 * pinned tabs, then the tabs of Today. A tab with a page in memory is left alone (the page tells its own icon), and so is one the
 * user gave an emoji. `states` are the views of the windows that show the tabs; a favourite is common to them.
 */
export function iconsWanted(states: readonly SidebarState[], hasPage: (tabId: string) => boolean): IconJob[] {
  const jobs: IconJob[] = []
  const seen = new Set<string>()
  const add = (id: string, url: string, rank: number): void => {
    if (seen.has(id) || iconTarget(url) === null) return
    seen.add(id)
    jobs.push({ id, url, rank })
  }
  const first = states[0]
  for (const f of first?.favorites ?? []) if (!hasIcon(f.faviconUrl)) add(`favorite:${f.id}`, f.url, 0)
  // A private tab is never looked up: the lookup would ask its site again, and the interface would load the icon found through its own session,
  // whose disk cache outlives the private session (a private tab's page hands its icon over as data, see ephemeral-scope.ts).
  const wantsTab = (t: TabItem): boolean => t.private !== true && !hasIcon(t.faviconUrl) && !t.icon && !hasPage(t.id)
  for (const pinned of [true, false]) {
    for (const state of states) {
      for (const t of state.tabs) if (t.spaceId === state.activeSpaceId && t.pinned === pinned && wantsTab(t)) add(`tab:${t.id}`, t.url, pinned ? 1 : 2)
    }
  }
  return jobs
}


// ---------- applying what was found ----------

/** The icon found for one favourite or tab, and the origin it was looked up for. */
export interface IconFill {
  kind: 'favorite' | 'tab'
  id: string
  origin: string
  faviconUrl: string
}

/** The most entries one answer is read for: far more than the tabs a person keeps. */
const FILL_MAX = 1000

/**
 * The state with the icons of `entries` given to the favourites and tabs that have none. The entries come from a lookup that took
 * time, so each is checked against the state as it is now: the item still exists, still has no icon (a page that loaded in the
 * meantime tells its own, which stays), still stands on the origin the icon was looked up for, and the icon is an address that may
 * stand for it. Whatever fails is left out; the same state is returned when nothing is left.
 */
export function fillIcons(state: SidebarState, entries: unknown): SidebarState {
  if (!Array.isArray(entries)) return state
  const favorites = new Map<string, string>()
  const tabs = new Map<string, string>()
  const favoriteById = new Map(state.favorites.map((f) => [f.id, f]))
  const tabById = new Map(state.tabs.map((t) => [t.id, t]))
  for (const entry of entries.slice(0, FILL_MAX)) {
    if (typeof entry !== 'object' || entry === null) continue
    const { kind, id, origin, faviconUrl } = entry as Record<string, unknown>
    if (typeof id !== 'string' || typeof origin !== 'string' || typeof faviconUrl !== 'string') continue
    const item = kind === 'favorite' ? favoriteById.get(id) : kind === 'tab' ? tabById.get(id) : undefined
    // A private tab gets no remote address as its icon, whatever the answer says (see iconsWanted).
    if (!item || ('private' in item && item.private === true) || hasIcon(item.faviconUrl) || iconTarget(item.url)?.origin !== origin || !iconAllowedFor(faviconUrl, item.url)) continue
    const found = kind === 'favorite' ? favorites : tabs
    if (!found.has(id)) found.set(id, faviconUrl)
  }
  if (favorites.size === 0 && tabs.size === 0) return state
  return {
    ...state,
    favorites: favorites.size === 0 ? state.favorites : state.favorites.map((f) => (favorites.has(f.id) ? { ...f, faviconUrl: favorites.get(f.id)! } : f)),
    tabs: tabs.size === 0 ? state.tabs : state.tabs.map((t) => (tabs.has(t.id) ? { ...t, faviconUrl: tabs.get(t.id)! } : t))
  }
}

/** The stand-in icon of a page with no icon of its own: the first letter of its domain on a colour that
 *  always comes out the same for that domain. Null when the page has no usable address (the generic globe is shown then). */
export function monogramFor(address: unknown): { letter: string; hue: number } | null {
  if (typeof address !== 'string') return null
  // The Extensions page has no site, whatever its address says of a host: it has an icon of its own (a puzzle piece), never a letter.
  if (isInternalPageUrl(address)) return null
  let host = ''
  try {
    host = new URL(address).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
  const letter = host.charAt(0).toUpperCase()
  if (!/^[A-Z0-9]$/.test(letter)) return null
  let hash = 0
  for (const char of host) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return { letter, hue: hash % 360 }
}

/** The lightest ground a monogram takes, and the light ink of its letter (`--tone-on-dark` of tokens.css). */
const MONOGRAM_LIGHTNESS_MAX = 42
const MONOGRAM_LIGHTNESS_MIN = 20
const MONOGRAM_INK = '#f6f7fa'
export const MONOGRAM_CONTRAST_MIN = 4.5

/**
 * The ground of a monogram for its hue, as a CSS colour. At one lightness a yellow or a green is far lighter to the eye than a blue, and the letter
 * was under 4.5:1 on almost half of the hues: the lightness goes down, a point at a time, until the light letter is readable. A hue always
 * gives the same colour.
 */
export function monogramGround(hue: number): string {
  const ink = luminance(MONOGRAM_INK) + 0.05
  let lightness = MONOGRAM_LIGHTNESS_MAX
  while (lightness > MONOGRAM_LIGHTNESS_MIN && ink / (luminance(hslToHex({ h: hue, s: 0.45, l: lightness / 100 })) + 0.05) < MONOGRAM_CONTRAST_MIN) lightness--
  return `hsl(${hue} 45% ${lightness}%)`
}
