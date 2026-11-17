// The Extensions page in a tab. Under Electron the browser has no `chrome://extensions` of its own, so the page of Lucium (the same bundle as before) is served to a tab
// under a scheme of its own, `lucium-ui:`, and the address the person sees and copies is `chrome://extensions`, as in Chrome.
//
// This module is the one place that says what an address of that page is. It takes no part in what a *web page* may open: a link, a script, a redirect or
// `window.open` can never lead here (`isNavigable` of the engine and `isPageOpenUrl` do not know the scheme), and only the shell, through the `allowInternalPages`
// flag of `tab/open` (sidebar-actions.ts), opens a tab on it. Pure, with no import: url.ts and the reducer read it.
//
// The check reads the raw text, not what a parser makes of it. Node's URL parser and Chromium's do not agree on a name written with a backslash, with
// userinfo or in another case (`lucium-ui://extensions\@evil/` is the host `evil` for one and `extensions` for the other), so an address is accepted only
// when it is already in the one canonical spelling both read the same way: plain ASCII, the scheme and the host in lower case, then `/` or `/shortcuts`.

/** The scheme the page is served under. Declared before the application is ready (privileged-schemes.ts) and served by the sessions of the tabs (engine/internal-pages.ts). */
export const INTERNAL_SCHEME = 'lucium-ui'
/** `standard` so that the address is read like a web one (a host, a path, a query) and the origin is exact; `secure` so that the page counts as a secure context. Nothing else: no fetch, no CORS, no bypass of the policy of content. */
export const INTERNAL_PRIVILEGES = { standard: true, secure: true } as const

const INTERNAL_HOST = 'extensions'
/** The origin of the page, as `frame.origin` and `location.origin` write it. */
export const INTERNAL_ORIGIN = `${INTERNAL_SCHEME}://${INTERNAL_HOST}`
/** The documents the preload of the page runs in (Electron's match patterns). */
export const INTERNAL_PAGES_MATCH = `${INTERNAL_ORIGIN}/*`
/** What the person sees where the address is: the scheme of Chrome's own page. */
export const DISPLAY_ORIGIN = 'chrome://extensions'
/** An address of the page is never longer: a query holds an id and a profile. */
const ADDRESS_MAX = 512

/** The two documents of the page: the list (and the page of one extension, which is `?id=`), and the shortcuts. Any other path is a file of the bundle or nothing. */
export type InternalPath = '/' | '/shortcuts'

const ADDRESS = /^lucium-ui:\/\/extensions(\/shortcuts|\/)(\?[^#]*)?(#.*)?$/
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/

export interface InternalPageParts {
  path: InternalPath
  /** With its `?`, or empty. */
  search: string
  /** With its `#`, or empty. */
  hash: string
}

/**
 * The parts of an address of the Extensions page, or null for anything else: another scheme, another host, another spelling of these (upper case,
 * userinfo, a port, a backslash, a space, a percent sign in the host, no slash after it), another path than the two documents of the page.
 */
export function internalPageParts(url: unknown): InternalPageParts | null {
  // The first test most addresses fail, as these are asked for every address of every request that names a host.
  if (typeof url !== 'string' || !url.startsWith(`${INTERNAL_SCHEME}://`) || url.length > ADDRESS_MAX || !PRINTABLE_ASCII.test(url)) return null
  const match = ADDRESS.exec(url)
  // What stands between `//` and the first `/` is exactly `extensions`, so no parser can read a user, a port or another host in it.
  if (!match || url.includes('\\')) return null
  return { path: match[1] as InternalPath, search: match[2] ?? '', hash: match[3] ?? '' }
}

/** Whether `url` is an address of the Extensions page: the one test every part of the application asks (the rest of this file and `isInternalOrigin` build on it). */
export function isInternalPageUrl(url: unknown): url is string {
  return internalPageParts(url) !== null
}

/**
 * Whether an address is on the scheme of the page, whatever follows it (a host, a path, a malformed rest): what a web page is kept from going to, in a frame, by a
 * redirect or by a window it opens. Wider than `isInternalPageUrl` on purpose: no address of that scheme is a web page's to reach.
 */
export function isInternalScheme(url: unknown): boolean {
  return typeof url === 'string' && /^\s*lucium-ui:/i.test(url)
}

/** Whether `origin` (the `frame.origin` of a message, the `location.origin` of a document) is the page's: an exact match, never a prefix. */
export function isInternalOrigin(origin: unknown): boolean {
  return origin === INTERNAL_ORIGIN
}

/**
 * What an extension is told of the page's address (`tab.url`, `tabs.onUpdated`, a `tabs.query` it filters by): the address of Chrome's own page, with its slash, which is
 * what an extension written for Chrome looks for. The scheme of ours is never told to an extension; any other address comes back as it was.
 */
export function chromeAddressOf(url: string): string {
  const parts = internalPageParts(url)
  return parts ? `${DISPLAY_ORIGIN}${parts.path}${parts.search}${parts.hash}` : url
}

/**
 * What the toolbar, the sidebar, the command bar and the clipboard say of an address: `chrome://extensions` for this page, what it was for any other.
 * Never read back as an address of the page (`extensionsPageOf` does that for what is typed, and the shell opens the real one).
 */
export function displayAddress(url: string): string {
  const parts = internalPageParts(url)
  if (!parts) return url
  const bare = parts.path === '/' && parts.search === '' && parts.hash === ''
  return `${DISPLAY_ORIGIN}${bare ? '' : parts.path}${parts.search}${parts.hash}`
}
