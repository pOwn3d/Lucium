// What an extension may reach through the `chrome.*` APIs the extension library (electron-chrome-extensions) implements, decided from the
// permissions its manifest declares, as pure functions. The library defines `cookies`, `tabs`, `webNavigation`, `windows`... for every
// extension and checks nothing; the extension platform defines an API only for an extension that declared the permission, and shows the address and
// title of a tab only to one that has "tabs" or a host permission for it (or that the user just invoked on that tab: "activeTab").
// src/main/engine/ece-router.ts applies these rules to the library's handlers and events.

import { MANIFEST_LIST_MAX, hostPatternsOf, isHostEntry, normalizeTabUrl } from './chrome-compat'
import { chromeAddressOf, isInternalScheme } from './internal-page'
import { isRecord } from './record'

// ---- the manifest ----

export interface ExtensionAccess {
  permissions: ReadonlySet<string>
  /** Match patterns of `host_permissions`, plus the ones a Manifest V2 extension lists among its `permissions` (see `hostPatternsOf`). */
  hosts: readonly string[]
}

export function accessOf(manifest: unknown): ExtensionAccess {
  const record = (typeof manifest === 'object' && manifest !== null ? manifest : {}) as { manifest_version?: unknown; permissions?: unknown; host_permissions?: unknown }
  // The entries the review sheet reads, and no other (`MANIFEST_LIST_MAX`).
  const declared = Array.isArray(record.permissions) ? record.permissions.slice(0, MANIFEST_LIST_MAX).filter((v): v is string => typeof v === 'string') : []
  return {
    permissions: new Set(declared.filter((entry) => !isHostEntry(entry))),
    hosts: hostPatternsOf(record)
  }
}

// ---- linear glob ----

export interface GlobLimits {
  maxPattern: number
  maxText: number
  maxSteps: number
}

const DEFAULT_GLOB_LIMITS: GlobLimits = { maxPattern: 512, maxText: 8192, maxSteps: 200_000 }

/**
 * `*` matches any run of characters, everything else is literal (the way the extension platform matches a title pattern, and how the extension
 * library does for a url). Two pointers and one place to go back to: the cost stays proportional to the product of the two
 * lengths, never exponential like a regular expression made of `.*.*.*`. A pattern or a text beyond the limits, or a match that
 * needs more steps than allowed, does not match.
 */
export function globMatch(pattern: string, text: string, limits: GlobLimits = DEFAULT_GLOB_LIMITS): boolean {
  if (pattern.length > limits.maxPattern || text.length > limits.maxText) return false
  let p = 0
  let t = 0
  let star = -1
  let mark = 0
  let steps = 0
  while (t < text.length) {
    if (++steps > limits.maxSteps) return false
    if (p < pattern.length && pattern[p] === '*') {
      star = p++
      mark = t
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++
      t++
    } else if (star >= 0) {
      p = star + 1
      t = ++mark
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++
  return p === pattern.length
}

// ---- match patterns ----

export interface ParsedPattern {
  /** `<all_urls>`. */
  all: boolean
  scheme: string
  host: string
  /** undefined: any port. */
  port: string | undefined
  path: string
}

const patternCache = new Map<string, ParsedPattern | null>()
const WEB_SCHEMES = new Set(['http', 'https', 'ws', 'wss'])
const DEFAULT_PORTS: Record<string, string> = { http: '80', https: '443', ws: '80', wss: '443', ftp: '21' }

/** An extension match pattern (`https://*.example.com/*`, `<all_urls>`), or null when it is not one. */
export function parseMatchPattern(pattern: string): ParsedPattern | null {
  const cached = patternCache.get(pattern)
  if (cached !== undefined) return cached
  let parsed: ParsedPattern | null = null
  if (pattern === '<all_urls>') parsed = { all: true, scheme: '*', host: '*', port: undefined, path: '/*' }
  else if (pattern.length <= 2048) {
    const match = /^(\*|https?|wss?|ftp|file):\/\/([^/]*)(\/.*)$/.exec(pattern)
    if (match) {
      const [, scheme, authority, path] = match as unknown as [string, string, string, string]
      const hostAndPort = /^([^:]*)(?::(\*|\d{1,5}))?$/.exec(authority)
      const host = hostAndPort?.[1] ?? ''
      const validHost = scheme === 'file' ? host === '' : host === '*' || /^(\*\.)?[^*\s]+$/.test(host)
      if (hostAndPort && validHost) parsed = { all: false, scheme, host: host.toLowerCase(), port: hostAndPort[2] === '*' ? undefined : hostAndPort[2], path }
    }
  }
  if (patternCache.size > 256) patternCache.clear()
  patternCache.set(pattern, parsed)
  return parsed
}

export function isMatchPattern(pattern: string): boolean {
  return parseMatchPattern(pattern) !== null
}

export function matchPattern(pattern: string, url: string): boolean {
  const parsed = parseMatchPattern(pattern)
  if (!parsed || url.length > 8192 || !URL.canParse(url)) return false
  const target = new URL(url)
  const scheme = target.protocol.slice(0, -1)
  if (parsed.all) {
    if (!WEB_SCHEMES.has(scheme) && scheme !== 'ftp') return false
  } else if (parsed.scheme === '*' ? !WEB_SCHEMES.has(scheme) : parsed.scheme !== scheme) return false
  const host = target.hostname.toLowerCase()
  if (!parsed.all && parsed.host !== '*') {
    if (parsed.host.startsWith('*.')) {
      const base = parsed.host.slice(2)
      if (host !== base && !host.endsWith(`.${base}`)) return false
    } else if (parsed.host !== host) return false
  }
  if (parsed.port !== undefined && parsed.port !== (target.port || DEFAULT_PORTS[scheme] || '')) return false
  return globMatch(parsed.path, target.pathname + target.search)
}

export function hasHostAccess(access: ExtensionAccess, url: string): boolean {
  return access.hosts.some((pattern) => matchPattern(pattern, url))
}

// ---- activeTab ----

/**
 * The tabs the user handed to an extension by invoking it (a click on its icon, its keyboard shortcut): for those, and until the tab
 * goes to another origin or closes, an extension that declared "activeTab" may read and capture the page like one with a host
 * permission. The loan ends for good when the tab leaves the origin (`navigated`): coming back to it later does not bring it back.
 */
export class ActiveTabGrants {
  private readonly grants = new Map<string, string>()

  private static scope(url: string): string {
    // An opaque origin (about:blank, data:) is told apart by the whole address.
    const origin = URL.canParse(url) ? new URL(url).origin : url
    return origin === 'null' ? url : origin
  }

  grant(extensionId: string, tabNumber: number, url: string): void {
    // The Extensions page is the browser's own, like the pages of Chrome an extension is never handed (activeTab does not reach `chrome://`).
    if (isInternalScheme(url)) return
    this.grants.set(`${extensionId}:${tabNumber}`, ActiveTabGrants.scope(url))
  }

  /** `url` is where the tab is now: a grant does not follow the tab to another origin. */
  has(extensionId: string, tabNumber: number, url: string): boolean {
    const scope = this.grants.get(`${extensionId}:${tabNumber}`)
    return scope !== undefined && scope === ActiveTabGrants.scope(url)
  }

  /** The origin the tab was lent on, as the document that runs a script can tell it (`location.origin`); undefined when the tab is not lent to this extension. */
  originOf(extensionId: string, tabNumber: number): string | undefined {
    return this.grants.get(`${extensionId}:${tabNumber}`)
  }

  /**
   * The tab shows a new document, at `url`: what was lent on another origin ends here. Without it the grant would only sleep while the tab
   * is elsewhere, and wake up when a link, a redirect or the Back button brings the tab to the origin again, with no click of the user.
   */
  navigated(tabNumber: number, url: string): void {
    const scope = ActiveTabGrants.scope(url)
    for (const [key, held] of [...this.grants]) if (held !== scope && key.endsWith(`:${tabNumber}`)) this.grants.delete(key)
  }

  /** The person takes the tab back from one extension (it stops the capture of the sound of the tab): it has to be invoked again. */
  revoke(extensionId: string, tabNumber: number): void {
    this.grants.delete(`${extensionId}:${tabNumber}`)
  }

  forgetTab(tabNumber: number): void {
    for (const key of [...this.grants.keys()]) if (key.endsWith(`:${tabNumber}`)) this.grants.delete(key)
  }
}

// ---- what a tab shows ----

/** The caller: which extension, what its manifest declares, and which tabs it was handed. */
export interface AccessContext {
  extensionId: string
  access: ExtensionAccess
  grants: ActiveTabGrants
}

const TAB_PRIVATE_FIELDS = ['url', 'pendingUrl', 'title', 'favIconUrl'] as const

/** Whether the extension may see the address and the title of this tab ("tabs", a host permission for it, or activeTab). */
export function canReadTab(ctx: AccessContext, tab: Record<string, unknown>): boolean {
  if (ctx.access.permissions.has('tabs')) return true
  const url = typeof tab['url'] === 'string' ? tab['url'] : ''
  if (url === '') return true
  if (url.startsWith(`chrome-extension://${ctx.extensionId}/`)) return true
  // The address of the Extensions page is told to an extension that has "tabs" and to no other: no match pattern covers its scheme (`matchPattern`), and the
  // hand-over of activeTab is never made for it (`ActiveTabGrants.grant`).
  if (hasHostAccess(ctx.access, url)) return true
  return typeof tab['id'] === 'number' && ctx.grants.has(ctx.extensionId, tab['id'], url)
}

/** A tab as this extension may see it: without the address, the title and the icon when it may not read them, the Extensions page at the address of Chrome's. Never changes `tab`. */
export function visibleTab<T>(ctx: AccessContext, tab: T): T {
  if (!isRecord(tab)) return tab
  if (!canReadTab(ctx, tab)) {
    const copy: Record<string, unknown> = { ...tab }
    for (const field of TAB_PRIVATE_FIELDS) delete copy[field]
    return copy as T
  }
  const url = tab['url']
  const pending = tab['pendingUrl']
  if (!isInternalScheme(url) && !isInternalScheme(pending)) return tab
  return { ...tab, ...(typeof url === 'string' ? { url: chromeAddressOf(url) } : {}), ...(typeof pending === 'string' ? { pendingUrl: chromeAddressOf(pending) } : {}) } as T
}

/**
 * A `webNavigation` detail (an event's, or one frame of `getFrame` and `getAllFrames`) as this extension may be told it. It carries the address of the frame, so it is
 * judged like the address of a tab: the Extensions page is told at Chrome's address to an extension that may read tabs (`canReadTab`: "tabs" alone, for this page), and
 * to no other, which is told nothing of it (null). Any other detail is given as it was (the same object).
 */
export function visibleNavigation(ctx: AccessContext, details: unknown): unknown {
  if (!isRecord(details) || !isInternalScheme(details['url'])) return details
  return canReadTab(ctx, { url: details['url'] }) ? { ...details, url: chromeAddressOf(details['url'] as string) } : null
}

export function visibleWindow<T>(ctx: AccessContext, window: T): T {
  if (!isRecord(window) || !Array.isArray(window['tabs'])) return window
  return { ...window, tabs: window['tabs'].map((tab: unknown) => visibleTab(ctx, tab)) } as T
}

/** Whether `title` and `url` of a `tabs.query` can be matched against this tab: a filter must not tell what the extension may not read. */
export function tabMatchesQuery(ctx: AccessContext, tab: Record<string, unknown>, query: { title?: unknown; url?: unknown }): boolean {
  const filtersTitle = typeof query.title === 'string'
  const patterns = typeof query.url === 'string' ? [query.url] : Array.isArray(query.url) ? query.url.filter((u): u is string => typeof u === 'string') : []
  const filtersUrl = typeof query.url === 'string' || Array.isArray(query.url)
  if (!filtersTitle && !filtersUrl) return true
  if (!canReadTab(ctx, tab)) return false
  if (filtersTitle && !(typeof tab['title'] === 'string' && globMatch(query.title as string, tab['title']))) return false
  if (filtersUrl) {
    const url = typeof tab['url'] === 'string' ? chromeAddressOf(tab['url']) : ''
    // A real match pattern is matched as the extension platform does; anything else keeps the library's reading (a glob over the whole address).
    if (!patterns.some((pattern) => (isMatchPattern(pattern) ? matchPattern(pattern, url) : globMatch(pattern, url)))) return false
  }
  return true
}

/**
 * `tabs.query({ currentWindow, lastFocusedWindow })`. The library reads neither (only `windowId`), so the usual `query({ active: true, currentWindow: true })`
 * lists the tab on screen in every window of the profile, and an extension that takes the first one acts on a window the user is not in. `lastFocused` is the
 * window of the profile that had the focus last (what the extension platform calls the current window of a service worker). Null when the query asks for neither, and when
 * the library no longer knows that window (it keeps the number of a window that was closed): the tabs are then listed as they always were, not none.
 */
export function windowFilterOf(query: { currentWindow?: unknown; lastFocusedWindow?: unknown }, lastFocused: number | undefined): ((tab: Record<string, unknown>) => boolean) | null {
  const wanted = [query.currentWindow, query.lastFocusedWindow].filter((value): value is boolean => typeof value === 'boolean')
  if (wanted.length === 0 || lastFocused === undefined) return null
  return (tab) => wanted.every((inside) => (tab['windowId'] === lastFocused) === inside)
}

const ALL_SITES = ['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*']

/**
 * Whether the extension may capture this tab (`<all_urls>` declared, or activeTab for a tab the user handed to it). A host
 * permission for one site is not enough, and activeTab alone is not either: it needs the hand-over. Declaring every site covers any
 * page that is not the browser's own, a local file or another extension's page (a blank tab included).
 */
export function canCaptureTab(ctx: AccessContext, tab: { id: number; url: string }): boolean {
  const own = tab.url.startsWith(`chrome-extension://${ctx.extensionId}/`)
  const restricted = /^(file|chrome|chrome-extension|chrome-error|devtools|view-source|lucium-ui):/i.test(tab.url) && !own
  if (!restricted && ctx.access.hosts.some((host) => ALL_SITES.includes(host))) return true
  return ctx.access.permissions.has('activeTab') && ctx.grants.has(ctx.extensionId, tab.id, tab.url)
}

// ---- calls to the library's handlers ----

/** Handlers that need a permission, whatever they are called with. */
const PERMISSION_OF_HANDLER: Record<string, string> = {
  'cookies.get': 'cookies',
  'cookies.getAll': 'cookies',
  'cookies.set': 'cookies',
  'cookies.remove': 'cookies',
  'cookies.getAllCookieStores': 'cookies',
  'webNavigation.getFrame': 'webNavigation',
  'webNavigation.getAllFrames': 'webNavigation',
  'contextMenus.create': 'contextMenus',
  'contextMenus.remove': 'contextMenus',
  'contextMenus.removeAll': 'contextMenus',
  'notifications.clear': 'notifications',
  'notifications.create': 'notifications',
  'notifications.getAll': 'notifications',
  'notifications.getPermissionLevel': 'notifications',
  'notifications.update': 'notifications'
}

/** The top-level `chrome.*` namespaces the library defines for everyone and the extension platform only for an extension that declared the permission. */
export const NAMESPACE_PERMISSION: Readonly<Record<string, string>> = {
  cookies: 'cookies',
  webNavigation: 'webNavigation',
  contextMenus: 'contextMenus',
  notifications: 'notifications',
  topSites: 'topSites',
  privacy: 'privacy',
  webRequest: 'webRequest',
  downloads: 'downloads'
}

/** What the library's handlers are told about the world: the address of a tab. */
export interface CallEnv {
  tabUrl(tabNumber: number): string | undefined
}

export const noPermissionError = (name: string): string => `The extension has no permission to use chrome.${name}.`
export const noHostError = (url: string): string => `Cannot access contents of url "${url}". Extension manifest must request permission to access this host.`

const cookieUrl = (cookie: Record<string, unknown>): string =>
  `${cookie['secure'] === true ? 'https' : 'http'}://${String(cookie['domain'] ?? '').replace(/^\./, '')}${typeof cookie['path'] === 'string' ? cookie['path'] : '/'}`

/** The reason a call to one of the library's handlers is refused, or null when the extension may make it. */
export function libraryCallError(ctx: AccessContext, name: string, args: unknown[], env: CallEnv): string | null {
  const needed = PERMISSION_OF_HANDLER[name]
  if (needed !== undefined && !ctx.access.permissions.has(needed)) return noPermissionError(name)
  if (name === 'cookies.get' || name === 'cookies.set' || name === 'cookies.remove' || name === 'cookies.getAll') {
    const details = isRecord(args[0]) ? args[0] : {}
    const url = details['url']
    if (typeof url === 'string') return hasHostAccess(ctx.access, url) ? null : noHostError(url)
    // Writing and removing name a url; reading can go through the cookies the extension is allowed to see (see `visibleCookies`).
    if (name !== 'cookies.getAll') return 'No url specified.'
  }
  if (name === 'tabs.insertCSS') {
    const tabNumber = args[0]
    const url = typeof tabNumber === 'number' ? env.tabUrl(tabNumber) : undefined
    if (typeof tabNumber === 'number' && url !== undefined && !hasHostAccess(ctx.access, url) && !ctx.grants.has(ctx.extensionId, tabNumber, url)) return noHostError(url)
  }
  return null
}

/** Only the cookies of the sites the extension has a host permission for. */
export function visibleCookies(ctx: AccessContext, cookies: unknown): unknown {
  if (!Array.isArray(cookies)) return cookies
  return cookies.filter((cookie) => isRecord(cookie) && hasHostAccess(ctx.access, cookieUrl(cookie)))
}

/** What a library handler answers, as this extension may see it. */
export function libraryResult(ctx: AccessContext, name: string, result: unknown): unknown {
  switch (name) {
    case 'tabs.get':
    case 'tabs.getCurrent':
    case 'tabs.create':
    case 'tabs.update':
      return visibleTab(ctx, result)
    case 'tabs.query':
    case 'tabs.getAllInWindow':
      return Array.isArray(result) ? result.map((tab) => visibleTab(ctx, tab)) : result
    case 'windows.get':
    case 'windows.getCurrent':
    case 'windows.getLastFocused':
    case 'windows.create':
    case 'windows.update':
      return visibleWindow(ctx, result)
    case 'windows.getAll':
      return Array.isArray(result) ? result.map((window) => visibleWindow(ctx, window)) : result
    case 'webNavigation.getFrame':
      return visibleNavigation(ctx, result)
    case 'webNavigation.getAllFrames':
      // A frame that may not be told is a frame this extension does not know: the same answer as a tab that is not there.
      return Array.isArray(result) ? result.map((frame) => visibleNavigation(ctx, frame)).filter((frame) => frame !== null) : result
    case 'cookies.getAll':
      return visibleCookies(ctx, result)
    case 'cookies.get':
    case 'cookies.set':
      return isRecord(result) && !hasHostAccess(ctx.access, cookieUrl(result)) ? null : result
    default:
      return result
  }
}

/**
 * The arguments an event reaches this extension with, or null when it must not reach it at all (an event of an API it did not
 * declare, a cookie of a site it has no access to).
 */
export function libraryEventArgs(ctx: AccessContext, name: string, args: unknown[]): unknown[] | null {
  const api = name.split('.')[0] ?? ''
  const needed = NAMESPACE_PERMISSION[api]
  if (needed !== undefined && !ctx.access.permissions.has(needed)) return null
  // The events of `webNavigation` all begin with the details of the navigation, which carry its address.
  if (api === 'webNavigation') {
    const told = visibleNavigation(ctx, args[0])
    return told === null ? null : told === args[0] ? args : [told, ...args.slice(1)]
  }
  switch (name) {
    case 'tabs.onCreated':
    case 'browserAction.onClicked':
      return [visibleTab(ctx, args[0]), ...args.slice(1)]
    case 'commands.onCommand':
      return [args[0], visibleTab(ctx, args[1])]
    case 'tabs.onUpdated': {
      const tab = visibleTab(ctx, args[2])
      const change = args[1]
      if (!isRecord(change)) return [args[0], change, tab]
      if (!isRecord(args[2]) || canReadTab(ctx, args[2])) {
        // Readable: the same event, whole; the address of the Extensions page is the one of Chrome's.
        const told = typeof change['url'] === 'string' && isInternalScheme(change['url']) ? { ...change, url: chromeAddressOf(change['url']) } : change
        return told === change && tab === args[2] ? args : [args[0], told, tab]
      }
      const kept = Object.fromEntries(Object.entries(change).filter(([field]) => !(TAB_PRIVATE_FIELDS as readonly string[]).includes(field)))
      // An extension is not told about a change it may not read.
      return Object.keys(kept).length === 0 ? null : [args[0], kept, tab]
    }
    case 'windows.onCreated':
    case 'windows.onBoundsChanged':
      return [visibleWindow(ctx, args[0])]
    case 'cookies.onChanged': {
      const change = args[0]
      const cookie = isRecord(change) && isRecord(change['cookie']) ? change['cookie'] : null
      return cookie !== null && hasHostAccess(ctx.access, cookieUrl(cookie)) ? args : null
    }
    default:
      return args
  }
}

// ---- where an extension may send a tab ----

/**
 * The address a tab or a window opened by an extension may load, or null. Only a web page, the blank page and a page of the extension
 * itself: not a local file, a `data:` or `blob:` document, `view-source:`, a page of another extension, or one of the browser's.
 * An address that is not absolute is relative to the extension.
 */
export function extensionNavigableUrl(url: unknown, extensionId: string): string | null {
  if (typeof url !== 'string') return null
  const normalized = normalizeTabUrl(url.trim())
  if (typeof normalized !== 'string' || normalized === '') return null
  if (normalized === 'about:blank') return normalized
  const base = `chrome-extension://${extensionId}/`
  if (!URL.canParse(normalized, base)) return null
  const parsed = new URL(normalized, base)
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.hostname === '' ? null : parsed.href
  if (parsed.protocol === 'chrome-extension:') return parsed.host === extensionId ? parsed.href : null
  return null
}

// ---- optional permissions ----

/** What a request asks for that the manifest does not already hold: the names of the permissions and the sites, a few of them at most (they are shown to the person). */
export function notGranted(access: ExtensionAccess, request: unknown): string[] {
  const asked = isRecord(request) ? request : {}
  const permissions = Array.isArray(asked['permissions']) ? asked['permissions'] : []
  const origins = Array.isArray(asked['origins']) ? asked['origins'] : []
  const missing = [...permissions.filter((p) => !(typeof p === 'string' && access.permissions.has(p))), ...origins.filter((o) => !(typeof o === 'string' && access.hosts.includes(o)))]
  return missing.slice(0, 12).map((name) => String(name).slice(0, 120))
}

/** Where nothing can ask the person (see `LibraryGuard.permissions`), a request is answered by what the manifest already holds. */
export function alreadyGranted(access: ExtensionAccess, request: unknown): boolean {
  return notGranted(access, request).length === 0
}
