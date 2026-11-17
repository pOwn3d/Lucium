// The part of electron-chrome-extensions that Lucium has to reach into: its message router. The library keeps it private, and
// three things need it: taking back the chrome.* APIs it implements badly (native messaging), rewriting what it accepts
// (chrome://newtab), and delivering events it never sends (commands). Everything that touches its internals is in this file, and
// a change of shape fails loudly when a profile is created, so a library update cannot silently bring back what was taken away.

import type { ContextMenuParams, WebContents } from 'electron'
import type { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { actionBarStateFor } from '@shared/action-state'
import { iconClickTab } from '@shared/action-window'
import {
  accessOf,
  alreadyGranted,
  notGranted,
  extensionNavigableUrl,
  hasHostAccess,
  libraryCallError,
  libraryEventArgs,
  libraryResult,
  tabMatchesQuery,
  visibleTab,
  windowFilterOf,
  type AccessContext,
  type ActiveTabGrants,
  type ExtensionAccess
} from '@shared/extension-access'
import { isRecord } from '@shared/record'

export interface EceHandler {
  /** `sender` is the WebContents of an extension page, or the service worker. */
  callback: (event: { extension?: { id: string; manifest?: unknown }; sender?: unknown }, ...args: unknown[]) => unknown
}

/** A listener as the library's routing records it: a frame (`host`, the web contents of the page that asked) or a service worker (no sender kept). */
export interface EceListener {
  type?: unknown
  extensionId?: unknown
  host?: unknown
}

/** A message about a listener as Electron delivers it: from a page (`sender`) or from a service worker (`serviceWorker`). */
interface EceListenerMessage {
  type?: unknown
  sender?: unknown
  serviceWorker?: unknown
}

type EceListenerReceiver = (event: EceListenerMessage, extensionId: string, eventName: string) => unknown

export interface EceDelegate {
  onAddListener: EceListenerReceiver
  onRemoveListener: EceListenerReceiver
}

export interface EceRouter {
  /** The API handlers by name ("tabs.create"), as the library registered them. */
  handlers: Map<string, EceHandler>
  /** Sends an event to the listeners of an extension (all extensions when the id is undefined), waking its worker if needed. */
  sendEvent(extensionId: string | undefined, eventName: string, ...args: unknown[]): void
  /** Records a listener of `eventName` for the extension the message names (`crx-add-listener`, sent by `window.electron.addExtensionListener`). */
  addListener(listener: EceListener, extensionId: string, eventName: string): void
  /** Forgets one (`crx-remove-listener`). */
  removeListener(listener: EceListener, extensionId: string, eventName: string): void
  /** What receives the two messages above for every profile, and makes the listener handed to `addListener` and `removeListener`. */
  delegate: EceDelegate
  /** How `sendEvent` starts the worker of an extension for an event: set by Lucium (`installWorkerStart`), called only by the patched library. */
  startWorker?: (scope: string, extensionId: string, eventName: string) => Promise<{ send(channel: string, ...args: unknown[]): void }>
}

/** What the library throws when a message names an extension the session no longer has (electron-chrome-extensions, ExtensionRouter). */
const NOT_REGISTERED = /extension not registered in session/

export function routerOf(extensions: ElectronChromeExtensions): EceRouter {
  const router = (extensions as unknown as { ctx?: { router?: Partial<EceRouter> } }).ctx?.router
  if (!router || !(router.handlers instanceof Map) || typeof router.sendEvent !== 'function') {
    throw new Error('electron-chrome-extensions changed its internals: update src/main/engine/ece-router.ts')
  }
  return router as EceRouter
}

/**
 * Hands the library the way Lucium starts the worker of an extension for an event (worker-start.ts). Its `sendEvent` calls it only with the patch
 * (patches/electron-chrome-extensions@4.10.0.patch): without it, a burst of events to a worker that is starting loses all but the first. Call it
 * before anything wraps `sendEvent`. Answers false, with a line in the log, when the installed library does not call it (a new version, a patch
 * that no longer applies, an install not redone since the patch changed): the events go on as the library sends them.
 */
export function installWorkerStart(router: Pick<EceRouter, 'sendEvent' | 'startWorker'>, start: NonNullable<EceRouter['startWorker']>, warn: (message: string) => void = console.warn): boolean {
  router.startWorker = start
  if (Function.prototype.toString.call(router.sendEvent).includes('this.startWorker(')) return true
  warn('[extensions] electron-chrome-extensions does not call the worker start of Lucium (patches/electron-chrome-extensions@4.10.0.patch): run pnpm install')
  return false
}

/**
 * Adds entries to the menu a right-click on an extension's toolbar icon opens (after the entries the extension made itself). The menu
 * is built by `store.buildMenuItems` of the library; a change of shape fails loudly, like the router's.
 */
export function extendActionMenu<T>(extensions: ElectronChromeExtensions, extra: (extensionId: string) => T[]): void {
  const store = (extensions as unknown as { ctx?: { store?: { buildMenuItems?: unknown } } }).ctx?.store
  if (!store || typeof store.buildMenuItems !== 'function') throw new Error('electron-chrome-extensions changed its internals: update src/main/engine/ece-router.ts')
  const original = store.buildMenuItems as (extensionId: string, menuType: string) => T[]
  store.buildMenuItems = (extensionId: string, menuType: string): T[] => {
    const items = original.call(store, extensionId, menuType)
    return menuType === 'browser_action' || menuType === 'action' ? [...items, ...extra(extensionId)] : items
  }
}

/**
 * Its native messaging reads the host manifests another browser registered (and starts the hosts they name), cannot frame a message that arrives in
 * several chunks and crashes the main process on one that is too large. Lucium handles `runtime.connectNative` and
 * `runtime.sendNativeMessage` itself (see shell/native-messaging.ts), so the library's handlers are removed.
 */
export const LIBRARY_NATIVE_MESSAGING = ['runtime.connectNative', 'runtime.disconnectNative', 'runtime.sendNativeMessage'] as const

/** Removes handlers. Throws when one is not there: the library changed, and what we meant to take away may still be reachable. */
export function revokeHandlers(router: Pick<EceRouter, 'handlers'>, names: readonly string[]): void {
  for (const name of names) {
    if (!router.handlers.has(name)) throw new Error(`electron-chrome-extensions has no "${name}" handler any more: check src/main/engine/ece-router.ts`)
    router.handlers.delete(name)
  }
}

/**
 * `chrome.action.setIcon({ imageData })` for a Manifest V3 extension. The library's preload throws the image away ("not yet supported") and still sends the call,
 * and its handler then replaces the icon of the extension by an empty one: the toolbar icon is gone (ColorZilla, Stylus and every extension that draws its icon).
 * The shims (src/preload/extension-shims.ts) hand the images over as data URLs in `path`, the one field the library lets through; they are turned back into
 * `imageData` here, which is what the library's `crx://extension-icon` answer reads. A call with nothing to draw leaves the icon as it is.
 */
export function keepActionIcon(router: Pick<EceRouter, 'handlers'>): void {
  const isImage = (value: unknown): value is string => typeof value === 'string' && value.startsWith('data:image/')
  wrapHandler(router, 'browserAction.setIcon', (original) => (event, ...args) => {
    const details = isRecord(args[0]) ? args[0] : {}
    const { path, imageData, ...rest } = details
    const drawn = isRecord(path) ? Object.fromEntries(Object.entries(path).filter(([, value]) => isImage(value))) : isImage(path) ? { 19: path } : undefined
    if (drawn && Object.keys(drawn).length > 0) return original(event, { ...rest, imageData: drawn }, ...args.slice(1))
    // A path of the extension's own files, or an image the library already holds as data (Manifest V2): as it was sent.
    if (path !== undefined || imageData !== undefined) return original(event, details, ...args.slice(1))
    return undefined
  })
}

/** The context menu items the library keeps, by extension then by item id. The library keeps them private; a change of shape fails loudly. */
function contextMenuItemsOf(extensions: ElectronChromeExtensions): Map<string, Map<unknown, Record<string, unknown>>> {
  const menus = (extensions as unknown as { api?: { contextMenus?: { menus?: unknown } } }).api?.contextMenus?.menus
  if (!(menus instanceof Map)) throw new Error('electron-chrome-extensions changed its internals: update src/main/engine/ece-router.ts')
  return menus as Map<string, Map<unknown, Record<string, unknown>>>
}

/** What `chrome.contextMenus.update` can change in an item (its id and its owner are not among them). */
const UPDATABLE_MENU_PROPERTIES = ['type', 'title', 'checked', 'contexts', 'enabled', 'visible', 'parentId', 'documentUrlPatterns', 'targetUrlPatterns'] as const

/**
 * `chrome.contextMenus.update(id, properties)`: the library does nothing for it, and an extension that keeps its menu in step with the page (OneTab) keeps the
 * entries it first made. The item changes where it is, so the order of the menu stays. Throws, as the API does, when the extension has no such item.
 */
export function updateContextMenuItem(extensions: ElectronChromeExtensions, extensionId: string, menuItemId: unknown, properties: unknown): void {
  const items = contextMenuItemsOf(extensions).get(extensionId)
  const item = items?.get(menuItemId)
  if (!items || !item) throw new Error(`Cannot find menu item with id ${String(menuItemId)}`)
  const patch = isRecord(properties) ? properties : {}
  const next = { ...item }
  for (const key of UPDATABLE_MENU_PROPERTIES) if (key in patch && patch[key] !== undefined) next[key] = patch[key]
  items.set(menuItemId, next)
}

/**
 * The entries the extensions of a page's profile put in its right-click menu (`chrome.contextMenus`). The library builds them for a page of its own
 * session only, so a page never lists the entries of another profile's extensions. It also keys the entries it is building by the id the extension
 * gave them, across extensions: two extensions that both call an entry "open" get the last one's entry twice, and a click reaches the wrong
 * extension. They are built one extension at a time here. An extension whose entries the library cannot build (properties Electron refuses)
 * costs the page its entries and is logged, not the whole menu.
 */
export function extensionMenuItems<T>(extensions: ElectronChromeExtensions, contents: WebContents, params: ContextMenuParams, warn: (message: string) => void): T[] {
  const api = (extensions as unknown as { api?: { contextMenus?: { menus?: unknown } } }).api?.contextMenus
  if (!api || !(api.menus instanceof Map)) {
    // A right-click must still open the menu of the page: the entries of the extensions are what is lost, and every profile's first menu says why.
    warn('[extensions] electron-chrome-extensions changed its internals, the entries of the extensions are not in the menu of the page: update src/main/engine/ece-router.ts')
    return []
  }
  const all = api.menus as Map<string, unknown>
  const items: T[] = []
  try {
    for (const [extensionId, own] of [...all]) {
      api.menus = new Map([[extensionId, own]])
      try {
        items.push(...(extensions.getContextMenuItems(contents, params) as unknown as T[]))
      } catch (error) {
        warn(`[extensions] the entries of ${extensionId} could not be added to the menu of the page: ${(error as Error).message}`)
      }
    }
  } finally {
    api.menus = all
  }
  return items
}

/** Replaces a handler by a function of the original one. */
export function wrapHandler(router: Pick<EceRouter, 'handlers'>, name: string, wrap: (original: EceHandler['callback']) => EceHandler['callback']): void {
  const handler = router.handlers.get(name)
  if (!handler) throw new Error(`electron-chrome-extensions has no "${name}" handler any more: check src/main/engine/ece-router.ts`)
  handler.callback = wrap(handler.callback)
}

/**
 * The menu of an extension's toolbar icon (right click) lists what the extension added for it (`contextMenus` with `browser_action`);
 * the library asks `ctx.store.buildMenuItems` for those entries. Lucium puts its own after them (pin to the bar, unpin): `extra`
 * answers with ready-made menu items. Throws when the library keeps that function somewhere else, like the router above.
 */
export function addActionMenuItems(extensions: ElectronChromeExtensions, extra: (extensionId: string) => unknown[]): void {
  const store = (extensions as unknown as { ctx?: { store?: { buildMenuItems?: (extensionId: string, menuType: string) => unknown[] } } }).ctx?.store
  const original = store?.buildMenuItems
  if (!store || typeof original !== 'function') throw new Error('electron-chrome-extensions changed its internals: update src/main/engine/ece-router.ts')
  store.buildMenuItems = (extensionId, menuType) => {
    const items = original.call(store, extensionId, menuType)
    return menuType === 'browser_action' ? [...(Array.isArray(items) ? items : []), ...extra(extensionId)] : items
  }
}

/**
 * The window the library takes for the one the user is in (`windows.getCurrent`, `tabs.query({ currentWindow })`, the window of `tabs.create` and of `action.openPopup`
 * when none is named) is the last one it saw take the focus, and it only watches the windows it already knows, that is, the ones that have a page of its profile. A window
 * that took the focus before its first page (a new window the user starts working in) is never seen, and every extension of the profile then answers for the window that
 * had the focus before: a popup that reads "the current tab" gets the tab of another window. `follow(windowId)` tells the library about the window the application knows
 * the user is in, and says nothing for a window the profile has no page in (its extensions would learn the number of a window that is not theirs). Throws, like the
 * router's, when the library keeps what this needs somewhere else.
 */
export function windowFocusOf(extensions: ElectronChromeExtensions): { follow(windowId: number): void } {
  const library = extensions as unknown as { ctx?: { store?: { getWindowById?: unknown } }; api?: { windows?: { onFocusChanged?: unknown } } }
  const store = library.ctx?.store
  const windows = library.api?.windows
  if (!store || typeof store.getWindowById !== 'function' || !windows || typeof windows.onFocusChanged !== 'function') {
    throw new Error('electron-chrome-extensions changed its internals: update src/main/engine/ece-router.ts')
  }
  const knows = store.getWindowById.bind(store) as (windowId: number) => unknown
  const changed = windows.onFocusChanged.bind(windows) as (windowId: number) => void
  return {
    follow(windowId) {
      // The library does nothing when it already has this window, and tells the extensions (windows.onFocusChanged) when it does not.
      if (knows(windowId)) changed(windowId)
    }
  }
}

/**
 * A page that moves to another window of the application (a tab dropped on it, `adoptPage`) keeps its number, but the library keeps the window it was added with
 * (`tabToWindow`, and the `windowId` of its tab details). The popup of the window the tab moved to then looks for it in the old one, and the library does not see it as
 * the tab on show there. Like `addTab`, this tells the library the new window (and makes it one of the profile's windows). Throws, like the router's, when the library
 * keeps what this needs somewhere else.
 */
export function tabMovedTo(extensions: ElectronChromeExtensions, tab: object & { id: number }, window: object & { id: number }): void {
  interface Store {
    tabToWindow?: unknown
    tabDetailsCache?: unknown
    addWindow?: unknown
  }
  const store = (extensions as unknown as { ctx?: { store?: Store } }).ctx?.store
  if (!store || !(store.tabToWindow instanceof WeakMap) || !(store.tabDetailsCache instanceof Map) || typeof store.addWindow !== 'function') {
    throw new Error('electron-chrome-extensions changed its internals: update src/main/engine/ece-router.ts')
  }
  ;(store.tabToWindow as WeakMap<object, object>).set(tab, window)
  ;(store.addWindow as (window: object) => void).call(store, window)
  const details = (store.tabDetailsCache as Map<number, { windowId?: unknown }>).get(tab.id)
  if (details) details.windowId = window.id
}

/**
 * The library keeps one `active` flag per tab in its cache of tab details (what `tabs.query`, `tabs.get`, `tabs.onUpdated` and the `sender.tab` of a content script
 * answer), and `onActivated` rewrites it over the whole cache: every tab of every window becomes "inactive" except the one that was just activated. With two windows on one
 * profile, switching tabs in one window makes the tab on show in the other one "inactive" until something happens to that tab (a new title, a load), and activating that tab
 * again changes nothing, since the library sees it is already the window's active tab and returns early. A popup that asks `tabs.query({ active: true, currentWindow: true })`
 * in that window then gets no tab at all (the popup of Dashlane opened with nothing between its bars), and a content script is told its tab is in the background.
 * The library does know the tab on show in each window (`getActiveTabFromWebContents`): after every activation, early return included, the flags are put back to that.
 * Throws, like the router's, when the library keeps what this needs somewhere else.
 */
export function keepActiveTabPerWindow(extensions: ElectronChromeExtensions): void {
  interface TabContents {
    id: number
    isDestroyed(): boolean
  }
  const library = extensions as unknown as {
    ctx?: { store?: { tabs?: unknown; tabDetailsCache?: unknown; getActiveTabFromWebContents?: unknown } }
    api?: { tabs?: { onActivated?: unknown } }
  }
  const store = library.ctx?.store
  const tabsApi = library.api?.tabs
  if (!store || !(store.tabs instanceof Set) || !(store.tabDetailsCache instanceof Map) || typeof store.getActiveTabFromWebContents !== 'function' || !tabsApi || typeof tabsApi.onActivated !== 'function') {
    throw new Error('electron-chrome-extensions changed its internals: update src/main/engine/ece-router.ts')
  }
  const tabs = store.tabs as Set<TabContents>
  const details = store.tabDetailsCache as Map<number, { active?: boolean }>
  const shownIn = store.getActiveTabFromWebContents.bind(store) as (tab: TabContents) => { id: number } | undefined
  const original = tabsApi.onActivated.bind(tabsApi) as (tabId: number) => unknown
  // Called as `this.onActivated(...)` by the library itself (a tab that is added, `tabs.update({ active })`, `selectTab`): the instance's own property is what they reach.
  ;(tabsApi as { onActivated: (tabId: number) => unknown }).onActivated = (tabId) => {
    try {
      return original(tabId)
    } finally {
      for (const tab of tabs) {
        const cached = tab.isDestroyed() ? undefined : details.get(tab.id)
        if (cached) cached.active = shownIn(tab)?.id === tab.id
      }
    }
  }
}

// ---- what an extension may reach through the library ----

/**
 * The library defines `cookies`, `tabs`, `webNavigation`, `windows`... for every extension and checks no permission, while the API
 * exists only for an extension that declared it, and hides the address of a tab from one that may not read it.
 * `restrictLibraryApis` puts those rules in front of its handlers and its events (the rules themselves: shared/extension-access.ts).
 */
export interface LibraryGuard {
  grants: ActiveTabGrants
  /** The address of a tab by its number. */
  tabUrl(tabNumber: number): string | undefined
  /** The manifest of an extension loaded in this profile. */
  manifestOf(extensionId: string): unknown
  /** The extensions loaded in this profile. */
  extensionIds(): string[]
  /** The user invoked an extension (a click on its icon): for the tab it was clicked on, or the active one when no number is given. */
  activated(extensionId: string, tabNumber: number | undefined): void
  /** Whether the page that made a call (the `sender` the library hands its handlers) is one of the application's own, as opposed to a page or a worker of an extension. */
  fromInterface(sender: unknown): boolean
  /** Whether the window with this id shows a tab of this profile: an extension reaches the windows of its own profile only. */
  ownsWindow?(windowId: number): boolean
  /** The number of the tab on screen in the window the sender (a page of the interface) belongs to, when there is one in this profile. Nothing is opened to answer. */
  shownTabOfSender?(sender: unknown): number | undefined
  /** The same, and a window with no tab of this profile is given one: what a click on an icon needs, since the extension has to act somewhere. */
  activeTabOfSender?(sender: unknown): number | undefined | Promise<number | undefined>
  /**
   * Whether this tab (by its number) is a live tab of this profile in the window the sender (a page of the interface) belongs to. The library hangs a popup from the window it
   * added the tab with, so a click must never hand it a tab of another window. Absent: any number is taken for a tab of the window, like before; true when the window of the sender
   * cannot be told (nothing is refused for what is not known).
   */
  tabInWindowOfSender?(sender: unknown, tabNumber: number): boolean
  /**
   * `chrome://extensions`, `chrome://settings`… asked for by an extension: opens the page of the browser that stands for the address and returns true, or returns
   * false for any other address. Absent: no address of that kind is served, like before.
   */
  openChromePage?(extensionId: string, address: string): boolean
  /** An extension asked for optional permissions (`permissions.request`) where nothing can ask the person (`permissions` absent) and was refused: what it asked for and does not hold. Absent: nobody is told. */
  refused?(extensionId: string, asked: string[]): void
  /**
   * `chrome.permissions` for the extensions of this profile (optional-grants.ts): what each one holds beyond its manifest, and the question to the person. `sender`
   * is the page or the worker that asked. Absent: nothing can be granted, and a request for what the manifest does not give is refused.
   */
  permissions?: {
    request(extensionId: string, request: unknown, sender: unknown): Promise<boolean>
    contains(extensionId: string, request: unknown): boolean
    getAll(extensionId: string): { permissions: string[]; origins: string[] }
    remove(extensionId: string, request: unknown): boolean
  }
  /**
   * A style sheet for a tab the person lent to an extension with a click (activeTab): the library would put it in whatever document the tab has by the time its message gets
   * there, which may be another origin than the one lent. The engine puts it in and has the document confirm its origin (shared/active-tab-script.ts). Absent: the library's own
   * call is made, as before.
   */
  lentStyle?(extensionId: string, tabNumber: number, css: string): Promise<unknown>
  /** Diagnostics (LUCIUM_EXT_LOG=1): one line for a question about "the tab" that found none. Absent: nothing is written. */
  trace?(message: string): void
}

/**
 * What chrome.tabs.create answers when the page that opened is one of the browser's (Settings, a panel), not a tab: a `chrome.tabs.Tab` for a tab that is
 * not there, with no `id` (it is optional in the API's own type) and `WINDOW_ID_NONE`. Nothing it names can be closed, moved or scripted by mistake.
 */
export const NO_TAB = Object.freeze({ index: -1, windowId: -1, highlighted: false, active: false, pinned: false, incognito: false, discarded: false, autoDiscardable: true, groupId: -1 })

/**
 * Handlers the library registers for the toolbar element of the interface (`extensionContext: false`): they take the extension they mean
 * from their arguments, so an extension's own page must not reach them. `activate` hands the tab to whichever extension it names.
 */
const INTERFACE_ONLY = new Set(['browserAction.activate', 'browserAction.getState', 'browserAction.addObserver', 'browserAction.removeObserver'])

/**
 * The extension a page or worker belongs to, from its own address: the host of `chrome-extension://<id>/…` (a web contents tells it with
 * `getURL()`, a service worker with `scope`). Undefined for anything else. This is where a call really comes from, unlike the id it announces.
 */
export function extensionOfSender(sender: unknown): string | undefined {
  const source = sender as { getURL?: () => unknown; scope?: unknown } | null | undefined
  let address: unknown
  try {
    address = typeof source?.getURL === 'function' ? source.getURL() : source?.scope
  } catch (error) {
    // A web contents that is already destroyed throws: a call that cannot say where it came from is not served.
    console.warn('[extensions] cannot tell where a call to the extension library came from:', (error as Error).message)
    return undefined
  }
  if (typeof address !== 'string' || !URL.canParse(address)) return undefined
  const url = new URL(address)
  return url.protocol === 'chrome-extension:' ? url.host : undefined
}

/** Handlers that answer with tabs or windows, or that need a permission: all go through `libraryCallError` and `libraryResult`. */
const GUARDED_HANDLERS = [
  'cookies.get',
  'cookies.getAll',
  'cookies.set',
  'cookies.remove',
  'cookies.getAllCookieStores',
  'webNavigation.getFrame',
  'webNavigation.getAllFrames',
  'contextMenus.create',
  'contextMenus.remove',
  'contextMenus.removeAll',
  'notifications.clear',
  'notifications.create',
  'notifications.getAll',
  'notifications.getPermissionLevel',
  'notifications.update',
  'tabs.get',
  'tabs.getAllInWindow',
  'tabs.getCurrent',
  'tabs.create',
  'tabs.insertCSS',
  'tabs.update',
  'windows.get',
  'windows.getCurrent',
  'windows.getLastFocused',
  'windows.getAll',
  'windows.create',
  'windows.update'
] as const

/** `chrome.windows.WINDOW_ID_CURRENT`. */
const WINDOW_ID_CURRENT = -2

/**
 * The properties of a `tabs.create` / `action.openPopup` call without a `windowId` that names "the current window". The library takes the number for a window: it hands it
 * to the browser as it is (the tab opens in the first window) or finds no such window (no popup). Left out, it takes the window the user is in (see `windowFocusOf`).
 */
function withoutCurrentWindow(props: Record<string, unknown>): Record<string, unknown> {
  if (props['windowId'] !== WINDOW_ID_CURRENT) return props
  const { windowId: _current, ...rest } = props
  return rest
}

/** Why a call is refused, or null: it names an extension, and must come from a page or a worker of that extension. */
function callerRefusal(name: string, event: { extension?: { id: string }; sender?: unknown }): string | null {
  // No extension named: a handler that needs one was already refused by the library, and the others take none.
  if (!event.extension) return null
  const caller = extensionOfSender(event.sender)
  return caller === event.extension.id ? null : `${name} was called in the name of ${event.extension.id} by ${caller === undefined ? 'a page that is not an extension' : `the extension ${caller}`}`
}

/**
 * The extension of the worker whose message about a listener is being served, for the time the library serves it. The library keeps the
 * sender of a page in the listener it makes (`host`) and nothing of a worker: this is where a worker's listener gets the name to compare.
 */
let workerAsking: string | undefined
const followedDelegates = new WeakSet<EceDelegate>()

/**
 * Notes which worker sends each message about a listener. The library has one delegate for all the profiles, and hands its two receivers
 * to each worker as it starts: they are replaced here, once, before any worker of an extension runs. The messages of the pages keep the
 * receivers the library registered when it was loaded; a page's listener carries its sender, so it needs none of this.
 */
function followWorkerMessages(router: EceRouter): void {
  const delegate = router.delegate
  if (typeof delegate?.onAddListener !== 'function' || typeof delegate.onRemoveListener !== 'function') throw new Error('electron-chrome-extensions changed its internals: update src/main/engine/ece-router.ts')
  if (followedDelegates.has(delegate)) return
  followedDelegates.add(delegate)
  const following =
    (receive: EceListenerReceiver): EceListenerReceiver =>
    (event, extensionId, eventName) => {
      workerAsking = event?.type === 'service-worker' ? extensionOfSender(event.serviceWorker) : undefined
      try {
        return receive(event, extensionId, eventName)
      } finally {
        workerAsking = undefined
      }
    }
  delegate.onAddListener = following(delegate.onAddListener)
  delegate.onRemoveListener = following(delegate.onRemoveListener)
}

export function restrictLibraryApis(router: EceRouter, guard: LibraryGuard): void {
  const accessCache = new WeakMap<object, ExtensionAccess>()
  const accessOfManifest = (manifest: unknown): ExtensionAccess => {
    if (typeof manifest !== 'object' || manifest === null) return accessOf(manifest)
    let access = accessCache.get(manifest)
    if (!access) accessCache.set(manifest, (access = accessOf(manifest)))
    return access
  }
  const contextOf = (event: { extension?: { id: string; manifest?: unknown } }, name: string): AccessContext => {
    const extension = event.extension
    if (!extension) throw new Error(`${name} was sent from an unknown extension context`)
    // The manifest the profile reads for it, which holds what the person granted on request; the library's own is the one of the files.
    return { extensionId: extension.id, access: accessOfManifest(guard.manifestOf(extension.id) ?? extension.manifest), grants: guard.grants }
  }
  const env = { tabUrl: (tabNumber: number) => guard.tabUrl(tabNumber) }

  // The address a tab or a window opens: a web page, the blank page, or a page of the extension itself. The library lets a data: or
  // blob: document, a local file, or a page of another extension through, and loads it without the navigation checks.
  const validTabUrl = (extensionId: string, value: unknown): string => {
    const url = extensionNavigableUrl(value, extensionId)
    if (url === null) throw new Error('Invalid URL')
    return url
  }
  const withUrl = <T extends Record<string, unknown>>(extensionId: string, props: T): T => (props['url'] === undefined || props['url'] === '' ? props : { ...props, url: validTabUrl(extensionId, props['url']) })

  /** The properties of a tabs.create / update call without their `url` when it is one of the browser's own pages (which opens, here): null for any other address. */
  const withoutBrowserPage = (extensionId: string, props: Record<string, unknown>): Record<string, unknown> | null => {
    if (typeof props['url'] !== 'string' || guard.openChromePage?.(extensionId, props['url']) !== true) return null
    const { url: _opened, ...rest } = props
    return rest
  }

  for (const name of GUARDED_HANDLERS) {
    wrapHandler(router, name, (original) => async (event, ...args) => {
      const ctx = contextOf(event, name)
      const refused = libraryCallError(ctx, name, args, env)
      if (refused) throw new Error(refused)
      let callArgs = args
      if (name === 'tabs.create') {
        const props = isRecord(args[0]) ? args[0] : {}
        // The page that stands for the address is open: there is no tab to make or to answer with.
        if (withoutBrowserPage(ctx.extensionId, props) !== null) return NO_TAB
        // The library hands the window it is given to the browser as it is: a window of another profile would be made to show this extension's tab (and its space).
        const windowId = props['windowId']
        if (typeof windowId === 'number' && windowId > 0 && guard.ownsWindow && !guard.ownsWindow(windowId)) throw new Error(`No window with id: ${windowId}`)
        callArgs = [withUrl(ctx.extensionId, withoutCurrentWindow(props)), ...args.slice(1)]
      } else if (name === 'tabs.update') {
        // With a tab number the properties come second. The other properties still apply to the tab; only the address is not loaded.
        const at = typeof args[0] === 'number' ? 1 : 0
        const props = isRecord(args[at]) ? args[at] : {}
        const rest = withoutBrowserPage(ctx.extensionId, props)
        callArgs = [...args.slice(0, at), rest ?? withUrl(ctx.extensionId, props), ...args.slice(at + 1)]
      }
      else if (name === 'windows.create' && isRecord(args[0]) && args[0]['url'] !== undefined) {
        const url = args[0]['url']
        callArgs = [{ ...args[0], url: Array.isArray(url) ? url.map((one) => validTabUrl(ctx.extensionId, one)) : validTabUrl(ctx.extensionId, url) }, ...args.slice(1)]
      }
      else if (name === 'tabs.insertCSS' && guard.lentStyle) {
        // Where the extension holds no host permission for the page the tab shows, only the loan lets it in: the engine has the document confirm that it is of the origin that was lent.
        const [tabNumber, details] = args
        const url = typeof tabNumber === 'number' ? guard.tabUrl(tabNumber) : undefined
        if (typeof tabNumber === 'number' && url !== undefined && !hasHostAccess(ctx.access, url) && isRecord(details) && typeof details['code'] === 'string') return guard.lentStyle(ctx.extensionId, tabNumber, details['code'])
      }
      return libraryResult(ctx, name, await original(event, ...callArgs))
    })
  }

  // `chrome.windows.remove`: only a window that shows a tab of the profile of the extension, as `windows.update` moves only such a window
  // (electron-engine-profile.ts): a window of another profile, a private window, the Settings are not its to close.
  wrapHandler(router, 'windows.remove', (original) => async (event, ...args) => {
    contextOf(event, 'windows.remove')
    const windowId = args[0]
    if (guard.ownsWindow && (typeof windowId !== 'number' || !guard.ownsWindow(windowId))) throw new Error(`No window with id: ${String(windowId)}`)
    return original(event, ...args)
  })

  // `tabs.query` matches `title` and `url` with regular expressions built from the pattern, which a pattern of stars makes run for
  // minutes; it is matched here instead, by a linear matcher, and only against what the extension may read.
  wrapHandler(router, 'tabs.query', (original) => async (event, ...args) => {
    const ctx = contextOf(event, 'tabs.query')
    const { title, url, currentWindow, lastFocusedWindow, ...rest } = isRecord(args[0]) ? args[0] : ({} as Record<string, unknown>)
    const tabs = await original(event, rest)
    if (!Array.isArray(tabs)) return tabs
    // The window the library never filters by (see windowFilterOf): the one of the profile that had the focus last.
    const focusedWindow = currentWindow === undefined && lastFocusedWindow === undefined ? undefined : await lastFocusedWindowId(event)
    const inWindow = windowFilterOf({ currentWindow, lastFocusedWindow }, focusedWindow)
    const wanted = tabs.filter((tab) => isRecord(tab) && tabMatchesQuery(ctx, tab, { title, url }) && (inWindow === null || inWindow(tab)))
    // An extension that asks for "the tab" and is told there is none shows an empty page (a popup with nothing between its bars): the log says which question and why.
    if (wanted.length === 0 && guard.trace && (rest['active'] !== undefined || currentWindow !== undefined || lastFocusedWindow !== undefined)) {
      guard.trace(`tabs.query ${JSON.stringify({ active: rest['active'], currentWindow, lastFocusedWindow, windowId: rest['windowId'] })} by ${ctx.extensionId} found no tab: the library answered with ${tabs.length} (in windows ${JSON.stringify([...new Set(tabs.map((tab) => (isRecord(tab) ? tab['windowId'] : undefined)))])}), current window ${focusedWindow ?? 'unknown'}`)
    }
    // The library numbers the tabs it found; the numbering follows the ones that are left.
    const numbered = title === undefined && url === undefined && inWindow === null ? wanted : wanted.map((tab, index) => ({ ...(tab as Record<string, unknown>), index }))
    return numbered.map((tab) => visibleTab(ctx, tab))
  })
  const lastFocusedWindowId = async (event: Parameters<EceHandler['callback']>[0]): Promise<number | undefined> => {
    const last = await router.handlers.get('windows.getLastFocused')?.callback(event)
    return isRecord(last) && typeof last['id'] === 'number' ? last['id'] : undefined
  }

  // `chrome.permissions`: the library answers from a table of its own that grants whatever is asked. The profile answers instead: what the manifest
  // gives, what the person granted, and a request is a question to them. Where nothing can ask (no `permissions`), a request for what the manifest
  // does not hold is refused, and the person is told why in the journal of the extension (`refused`).
  const permissions = guard.permissions
  wrapHandler(router, 'permissions.request', () => (event, request) => {
    const ctx = contextOf(event, 'permissions.request')
    if (permissions) return permissions.request(ctx.extensionId, request, event.sender)
    const granted = alreadyGranted(ctx.access, request)
    if (!granted) guard.refused?.(ctx.extensionId, notGranted(ctx.access, request))
    return granted
  })
  if (permissions) {
    wrapHandler(router, 'permissions.contains', () => (event, request) => permissions.contains(contextOf(event, 'permissions.contains').extensionId, request))
    wrapHandler(router, 'permissions.getAll', () => (event) => permissions.getAll(contextOf(event, 'permissions.getAll').extensionId))
    wrapHandler(router, 'permissions.remove', () => (event, request) => permissions.remove(contextOf(event, 'permissions.remove').extensionId, request))
  }

  // Clicking the icon of an extension hands it the tab (activeTab).
  wrapHandler(router, 'browserAction.activate', (original) => async (event, ...args) => {
    let callArgs = args
    const details = args[0]
    if (isRecord(details) && details['eventType'] === 'click' && typeof details['extensionId'] === 'string') {
      // The icon says which tab it is for with the number the library last gave it, which is the tab of the window that last had the focus among those it knows:
      // with two windows on one profile that is the other window's tab, and the popup would hang from the other window (a window with no page yet is not known
      // to it at all). The tab on screen in the window of the icon is the one meant; the number the icon names is only for a window that shows none, and only
      // while that tab is still in the window (see iconClickTab). A window with no tab to give is given one.
      const named = typeof details['tabId'] === 'number' && details['tabId'] >= 0 ? details['tabId'] : undefined
      const here = (tabNumber: number): boolean => guard.tabInWindowOfSender?.(event.sender, tabNumber) ?? true
      let tab = iconClickTab({ shown: guard.shownTabOfSender?.(event.sender), named, namedIsHere: named !== undefined && here(named) })
      tab ??= await guard.activeTabOfSender?.(event.sender)
      // Whatever decided it, the library hangs the popup from the window of the tab it is given: a tab of another window opens the popup in that window, which is the
      // bug of a click in the middle window whose popup appeared in the one on the right. Nothing opens rather than that.
      const target = tab ?? named
      if (target !== undefined && !here(target)) throw new Error(`browserAction.activate: the tab ${target} is not in the window of the icon that was clicked`)
      if (tab !== undefined && tab !== named) callArgs = [{ ...details, tabId: tab }, ...args.slice(1)]
      guard.activated(details['extensionId'], tab)
    }
    return original(event, ...callArgs)
  })

  // `chrome.action.openPopup({ windowId })`: the library finds no window for WINDOW_ID_CURRENT and opens nothing; left out, the popup opens in the window the user is in.
  wrapHandler(router, 'browserAction.openPopup', (original) => (event, ...args) => original(event, ...(isRecord(args[0]) ? [withoutCurrentWindow(args[0]), ...args.slice(1)] : args)))

  // The toolbar of a window draws the tab on screen in that window, with what the extensions set for it (see actionBarStateFor): the library's state is one per profile.
  const shownTab = guard.shownTabOfSender
  if (shownTab) wrapHandler(router, 'browserAction.getState', (original) => async (event, ...args) => actionBarStateFor(await original(event, ...args), shownTab(event.sender)))

  // Whoever it says it is, a call is served in the name of the extension it comes from. The library resolves the caller from the id the
  // message announces and never compares it with the sender, so any page or worker of an extension of the profile could call with the
  // permissions of another (`window.electron` stays reachable in the page: the property cannot be deleted). Outermost wrapper of every handler.
  for (const name of [...router.handlers.keys()]) {
    wrapHandler(router, name, (original) => (event, ...args) => {
      const refusal = INTERFACE_ONLY.has(name) ? (guard.fromInterface(event.sender) ? null : `${name} is for the interface of the application only`) : callerRefusal(name, event)
      if (refusal) {
        console.warn(`[extensions] ${refusal}`)
        throw new Error(refusal)
      }
      return original(event, ...args)
    })
  }

  // Listening is the other half of `window.electron` (`addExtensionListener`): the message names the extension whose events it wants, and
  // the library records the page under that name without comparing it with the page. A page of one extension could then receive the
  // events of another in that one's version (the addresses of its tabs, its cookies, the clicks on its menus). A frame listens for its own
  // extension only, and so does a worker: the library sends a worker's events to the worker of the extension the message names, so one
  // that names another could start that one's worker at will and, by taking a listener away, cut it off from its own events. Any other
  // kind is refused: the library would send it to a page it does not have.
  if (typeof router.addListener !== 'function' || typeof router.removeListener !== 'function') throw new Error('electron-chrome-extensions changed its internals: update src/main/engine/ece-router.ts')
  followWorkerMessages(router)
  const refusedListener = (listener: EceListener | undefined, extensionId: string, eventName: string, what: string): boolean => {
    const caller = listener?.type === 'frame' ? extensionOfSender(listener.host) : listener?.type === 'service-worker' ? workerAsking : undefined
    if (caller !== undefined && caller === extensionId) return false
    console.warn(`[extensions] refused ${what} of ${String(eventName).slice(0, 64)} in the name of ${String(extensionId).slice(0, 64)} from ${caller === undefined ? 'a page that is not an extension' : `the extension ${caller}`}`)
    return true
  }
  // A page or a worker of an extension that was just removed from the profile can still send its listeners for a moment: the library then
  // throws from its message handler, which nothing catches. Such a late message is dropped, and said; any other error goes on.
  const whileLoaded = (record: () => void, extensionId: string, eventName: string, what: string): void => {
    try {
      record()
    } catch (error) {
      if (!(error instanceof Error) || !NOT_REGISTERED.test(error.message)) throw error
      console.warn(`[extensions] ignored ${what} of ${String(eventName).slice(0, 64)} for ${String(extensionId).slice(0, 64)}: the extension is no longer loaded in this profile`)
    }
  }
  const listen = router.addListener.bind(router)
  router.addListener = (listener, extensionId, eventName) => {
    if (!refusedListener(listener, extensionId, eventName, 'a listener')) whileLoaded(() => listen(listener, extensionId, eventName), extensionId, eventName, 'a listener')
  }
  const unlisten = router.removeListener.bind(router)
  router.removeListener = (listener, extensionId, eventName) => {
    if (!refusedListener(listener, extensionId, eventName, 'the removal of a listener')) whileLoaded(() => unlisten(listener, extensionId, eventName), extensionId, eventName, 'the removal of a listener')
  }

  // Events: each extension gets its own version of an event, or none.
  const send = router.sendEvent.bind(router)
  router.sendEvent = (targetExtensionId, eventName, ...args) => {
    for (const id of targetExtensionId === undefined ? guard.extensionIds() : [targetExtensionId]) {
      const manifest = guard.manifestOf(id)
      if (manifest === undefined) continue
      const filtered = libraryEventArgs({ extensionId: id, access: accessOfManifest(manifest), grants: guard.grants }, eventName, args)
      if (filtered !== null) send(id, eventName, ...filtered)
    }
  }
}
