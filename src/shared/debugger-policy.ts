// What chrome.debugger may do. The DevTools protocol can read and write far more than a web page: attached to a `file:` tab it reads
// local files, attached to a page of another extension it runs as that extension, and its `Browser`, `Target` and `Storage` domains
// reach beyond the tab. An extension with the "debugger" permission is trusted to drive web pages, not to leave them. The rules
// below say which pages it may attach to and which commands it may send; src/main/shell/extension-shims.ts applies them.

import { STORE_ORIGIN } from './web-store'
import { isRecord } from './record'

/** The Chrome Web Store: its page installs and uninstalls on a click, and a debugger on it could press that click (the extension platform refuses it too). */
const STORE_HOST = new URL(STORE_ORIGIN).hostname

/** The only pages an extension may attach to: a web page (not the Web Store), the blank page, and a page of the extension itself (Chromium's `MayAttachToURL`). */
export function debuggerTargetAllowed(url: string, extensionId: string): boolean {
  // A tab that has not loaded anything yet has no address.
  if (url === '' || url === 'about:blank') return true
  if (!URL.canParse(url)) return false
  const parsed = new URL(url)
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.hostname !== '' && parsed.hostname.toLowerCase() !== STORE_HOST
  return parsed.protocol === 'chrome-extension:' && parsed.host === extensionId
}

/**
 * Domains of the protocol refused to an extension, with the reason (none of them is in ALLOWED_DOMAINS below, which a test checks).
 * Whole domains that reach beyond the tab: the browser, its targets, its storage, its files, its certificate checks.
 * `ServiceWorker` and `BackgroundService` are served for the whole storage partition, not for the tab: `unregister`, `startWorker` and
 * `deliverPushMessage` act on the worker of any scope, and `enable` lists every registration of every site.
 * Those that reach the other worlds of the page and the storage of the other origins it frames: `Debugger` reads and rewrites any script by its
 * id (the content scripts of another extension included, which `scriptParsed` would announce), `DOMDebugger` hands back the listeners of every
 * world, `HeapProfiler` and `Memory` read the heap of every world (and `Memory` the profile of the browser process); `DOMStorage`, `IndexedDB`,
 * `CacheStorage` and `Database` name an origin or a storage key, so they read the storage of a framed site the cookie rule below keeps apart.
 * Those that answer, in place of the user, a question the browser asks for the page, or stand in for a device: `DeviceAccess` (picks the device in
 * a Bluetooth, USB or serial prompt), `FedCm` (picks the account in a federated sign-in box), `DigitalCredentials`, `Autofill` (fills the forms
 * with an address or a card), `BluetoothEmulation` and `SmartCardEmulation` (fake devices), `WebMCP`. Chrome does not serve them to
 * `chrome.debugger` either: its reference names the domains an extension may use, and none of these is among them.
 * https://developer.chrome.com/docs/extensions/reference/api/debugger
 * `WebAuthn` is refused although Chrome serves it: its virtual authenticator answers the passkey ceremony of the tab in place of the person and of
 * their key, and `WebAuthn.getCredentials` hands over the private keys it holds. An extension that drives pages has no need to sign in for the user.
 */
export const DENIED_DOMAINS: ReadonlySet<string> = new Set([
  'Browser',
  'Target',
  'Storage',
  'SystemInfo',
  'IO',
  'Tracing',
  'Extensions',
  'FileSystem',
  'Security',
  'Cast',
  'ServiceWorker',
  'BackgroundService',
  'Debugger',
  'DOMDebugger',
  'HeapProfiler',
  'Memory',
  'DOMStorage',
  'IndexedDB',
  'CacheStorage',
  'Database',
  'DeviceAccess',
  'FedCm',
  'DigitalCredentials',
  'Autofill',
  'BluetoothEmulation',
  'SmartCardEmulation',
  'WebMCP',
  'WebAuthn'
])

/**
 * The only domains an extension may use: a domain is refused unless it is named here. The list is
 * every domain of the protocol of Chromium 156 (Electron 45; read in the protocol types of playwright-core 1.64.1, built for Chrome
 * 156.0.8078.4) except those of DENIED_DOMAINS and two that serve the browser, not a tab: `PWA` (installs and launches the web apps of the
 * profile) and `Tethering` (forwards ports of the machine). A domain that a later Chromium adds stays refused until someone has read what it
 * does and put it here, or in DENIED_DOMAINS.
 */
export const ALLOWED_DOMAINS: ReadonlySet<string> = new Set([
  'Accessibility',
  'Ads',
  'Animation',
  'Audits',
  'Console',
  'CrashReportContext',
  'CSS',
  'DeviceOrientation',
  'DOM',
  'DOMSnapshot',
  'Emulation',
  'EventBreakpoints',
  'Fetch',
  'FindInPage',
  'HeadlessExperimental',
  'Input',
  'Inspector',
  'LayerTree',
  'Log',
  'Media',
  'Network',
  'Overlay',
  'Page',
  'Performance',
  'PerformanceTimeline',
  'Preload',
  'Profiler',
  'Runtime',
  'Schema',
  'WebAudio'
])

/** The domain of a command or an event (`Runtime` of `Runtime.evaluate`). */
const domainOf = (method: string): string => method.slice(0, Math.max(0, method.indexOf('.')))

/**
 * Single commands that write outside the page or read what the page may not: browser-wide cookies, a download to a path of the
 * disk, a local file given to a file field (the page can then read it), a fetch with the credentials of the profile. Two more are refused
 * by what they carry, not by their name: a drag with files and a key that pastes (below).
 */
const DENIED_METHODS = new Set([
  'Network.getAllCookies',
  'Network.clearBrowserCookies',
  'Network.loadNetworkResource',
  'Network.setCookieControls',
  'Page.setDownloadBehavior',
  'Page.setInterceptFileChooserDialog',
  'Page.addCompilationCache',
  'DOM.setFileInputFiles',
  'Fetch.takeResponseBodyAsStream'
])

/**
 * A simulated drag that carries files (`Input.dispatchDragEvent`, `data.files`: paths of the disk): the page that gets the drop reads them, like
 * the file field `DOM.setFileInputFiles` fills. It is the only other command of the allowed domains that names a path of the disk (read in the
 * protocol of Chromium 156). Anything in `files` but an empty list is refused, a value that is not a list included.
 */
function dragCarriesFiles(params: Record<string, unknown>): boolean {
  const data = params['data']
  if (!isRecord(data)) return false
  const files = data['files']
  return files !== undefined && files !== null && !(Array.isArray(files) && files.length === 0)
}

/**
 * A simulated key that brings an editing command with it (`Input.dispatchKeyEvent`, `commands`): pasting puts the clipboard of the user in the
 * page, which then reads it, without the question the page itself would have to ask (`navigator.clipboard.readText()`). `yank` pastes the text
 * last cut by a keyboard shortcut of macOS. The names are compared whatever their case, as the editor looks them up; a list that is not one is refused.
 */
function keyPastes(params: Record<string, unknown>): boolean {
  const commands = params['commands']
  if (commands === undefined || commands === null) return false
  if (!Array.isArray(commands)) return true
  return commands.some((command) => typeof command !== 'string' || /paste|yank/i.test(command))
}

/** Commands whose address must be one an extension could attach to. */
const NAVIGATIONS = new Set(['Page.navigate'])

/** Commands that name an execution context. */
const CONTEXT_PARAMS = ['contextId', 'executionContextId', 'uniqueContextId'] as const

/** A page does not have this many live contexts; past it a context is simply not learned, and so cannot be named. */
const KNOWN_CONTEXTS_MAX = 10_000

// Not urlHostname (shared/url.ts): what is not an address is null, so that the check refuses it, and a host is compared in lower case whatever its scheme.
const cookieHostOf = (url: unknown): string | null => (typeof url === 'string' && URL.canParse(url) ? new URL(url).hostname.toLowerCase() : null)

/** A domain that belongs to the host (`.example.com` for `www.example.com`): cookies may be read and written for those only. */
function domainBelongs(domain: string, host: string): boolean {
  const bare = domain.replace(/^\./, '').toLowerCase()
  return bare !== '' && (host === bare || host.endsWith(`.${bare}`))
}

/** `Network.getCookies/setCookie/setCookies/deleteCookies`: only for the site of the tab, never for another one named in the command. */
function cookieScopeError(method: string, params: Record<string, unknown>, pageUrl: string): string | null {
  const host = cookieHostOf(pageUrl)
  if (host === null) return 'Not allowed'
  const sameSite = (url: unknown): boolean => {
    const other = cookieHostOf(url)
    return other !== null && (domainBelongs(other, host) || domainBelongs(host, other))
  }
  const check = (cookie: Record<string, unknown>): boolean => (cookie['url'] === undefined || sameSite(cookie['url'])) && (cookie['domain'] === undefined || (typeof cookie['domain'] === 'string' && (domainBelongs(cookie['domain'], host) || domainBelongs(host, cookie['domain']))))
  switch (method) {
    case 'Network.getCookies':
      // `urls` names any address: reading them would be reading another site's cookies.
      return params['urls'] === undefined ? null : 'Not allowed'
    case 'Network.setCookie':
    case 'Network.deleteCookies':
      return check(params) ? null : 'Not allowed'
    case 'Network.setCookies':
      return Array.isArray(params['cookies']) && params['cookies'].every((c) => isRecord(c) && check(c)) ? null : 'Not allowed'
    default:
      return null
  }
}

/** One attached tab: judges the commands the extension sends and the events the page reports. */
export class DebuggerGuard {
  /** Execution contexts of another extension's pages: the extension is not told of them, and cannot run code in them. */
  private readonly foreignContexts = new Set<number>()
  private readonly foreignUniqueContexts = new Set<string>()
  /**
   * The only contexts a command may name: those the page reported (or a command created) that are not another extension's. Context
   * numbers are small integers, so a list of the forbidden ones would let a command name one before the event that reports it.
   */
  private readonly knownContexts = new Set<number>()
  private readonly knownUniqueContexts = new Set<string>()

  constructor(private readonly extensionId: string) {}

  /** The error the extension gets for a command, or null when the command goes through. `pageUrl` is where the tab is now. */
  command(method: unknown, params: unknown, pageUrl: string): string | null {
    if (typeof method !== 'string' || !/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(method)) return 'Invalid method name'
    const domain = domainOf(method)
    if (!ALLOWED_DOMAINS.has(domain) || DENIED_METHODS.has(method) || method.endsWith('.setDownloadBehavior')) return 'Not allowed'
    const body = isRecord(params) ? params : {}
    if (method === 'Input.dispatchDragEvent' && dragCarriesFiles(body)) return 'Not allowed'
    if (method === 'Input.dispatchKeyEvent' && keyPastes(body)) return 'Not allowed'
    if (NAVIGATIONS.has(method) && !(typeof body['url'] === 'string' && debuggerTargetAllowed(body['url'], this.extensionId) && body['url'] !== '')) return 'Not allowed'
    if (method.startsWith('Network.') && /Cookies?$/.test(method)) {
      const refused = cookieScopeError(method, body, pageUrl)
      if (refused) return refused
    }
    // The world it asks for may read the other origins of the page (`grantUniveralAccess` is the protocol's own spelling).
    if (method === 'Page.createIsolatedWorld' && (body['grantUniveralAccess'] === true || body['grantUniversalAccess'] === true)) return 'Not allowed'
    for (const key of CONTEXT_PARAMS) {
      const value = body[key]
      if (value === undefined || value === null) continue
      if (!(key === 'uniqueContextId' ? typeof value === 'string' && this.knownUniqueContexts.has(value) : typeof value === 'number' && this.knownContexts.has(value))) return 'Not allowed'
    }
    return null
  }

  /** What an answer teaches: the world `Page.createIsolatedWorld` made is of the page's own origin, and its number may be named from now on. */
  result(method: string, result: unknown): void {
    if (method === 'Page.createIsolatedWorld' && isRecord(result) && typeof result['executionContextId'] === 'number') this.learn(result['executionContextId'], undefined)
  }

  private learn(id: number | undefined, uniqueId: string | undefined): void {
    if (id !== undefined && this.knownContexts.size < KNOWN_CONTEXTS_MAX) this.knownContexts.add(id)
    if (uniqueId !== undefined && this.knownUniqueContexts.size < KNOWN_CONTEXTS_MAX) this.knownUniqueContexts.add(uniqueId)
  }

  /**
   * Whether the page's event may reach the extension. An execution context of another extension is held back (and remembered), and so is what
   * happens in it (its console messages, its exceptions: they carry handles to objects of that world). Nothing of a domain the extension may not
   * use reaches it either, whoever turned the domain on (Lucium attaches a debugger of its own to freeze a page).
   */
  event(method: string, params: unknown): boolean {
    if (!ALLOWED_DOMAINS.has(domainOf(method))) return false
    if (isRecord(params)) {
      const details = isRecord(params['exceptionDetails']) ? params['exceptionDetails'] : null
      const context = method === 'Runtime.executionContextDestroyed' ? undefined : (params['executionContextId'] ?? details?.['executionContextId'])
      if (typeof context === 'number' && this.foreignContexts.has(context)) return false
    }
    if (method === 'Runtime.executionContextCreated') {
      const context = isRecord(params) && isRecord(params['context']) ? params['context'] : null
      const origin = typeof context?.['origin'] === 'string' ? context['origin'] : ''
      if (context && origin.startsWith('chrome-extension://') && origin !== `chrome-extension://${this.extensionId}`) {
        if (typeof context['id'] === 'number') this.foreignContexts.add(context['id'])
        if (typeof context['uniqueId'] === 'string') this.foreignUniqueContexts.add(context['uniqueId'])
        return false
      }
      if (context) this.learn(typeof context['id'] === 'number' ? context['id'] : undefined, typeof context['uniqueId'] === 'string' ? context['uniqueId'] : undefined)
    }
    if (method === 'Runtime.executionContextsCleared') {
      this.knownContexts.clear()
      this.knownUniqueContexts.clear()
      this.foreignContexts.clear()
      this.foreignUniqueContexts.clear()
    }
    if (method === 'Runtime.executionContextDestroyed' && isRecord(params)) {
      if (typeof params['executionContextId'] === 'number') this.knownContexts.delete(params['executionContextId'])
      if (typeof params['executionContextUniqueId'] === 'string') this.knownUniqueContexts.delete(params['executionContextUniqueId'])
      // The id is not reused, but the event of a context the extension never heard of is of no use to it.
      if (typeof params['executionContextId'] === 'number') return !this.foreignContexts.delete(params['executionContextId'])
    }
    return true
  }
}
