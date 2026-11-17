// Small pieces of the behavior of the extension platform that extensions rely on and that the engine does not give them, as pure functions:
// the new tab URL, the shortcuts of extension commands, the redirect URL of an authorization flow, the shape of a download.

import type { DownloadInfo } from './model'
import { clamp } from './clamp'

// ---- URLs ----

/** The tab opened for `chrome://newtab`. Lucium has no such page: the tab is blank, ready for the extension to navigate. */
export const BLANK_TAB_URL = 'about:blank'

/** `chrome://newtab` (an agent opens its working tabs with it) means a blank tab here. Anything else is returned as it came. */
export function normalizeTabUrl<T>(url: T): T | string {
  return typeof url === 'string' && /^chrome:\/\/newtab\/?$/i.test(url.trim()) ? BLANK_TAB_URL : url
}

/**
 * The page a new window shows, from the `url` of chrome.windows.create (an address or a list of them: the first is used).
 * Null when there is none to show. Only web pages, a blank page and extension pages are allowed: a window is no way to open a file.
 */
export function normalizeWindowUrl(url: unknown): string | null {
  const first = Array.isArray(url) ? url[0] : url
  if (typeof first !== 'string' || first === '') return null
  const normalized = normalizeTabUrl(first)
  if (typeof normalized !== 'string' || !URL.canParse(normalized)) throw new Error('Invalid URL')
  const { protocol } = new URL(normalized)
  if (!['http:', 'https:', 'about:', 'chrome-extension:'].includes(protocol) || (protocol === 'about:' && normalized !== BLANK_TAB_URL)) throw new Error('Invalid URL')
  return normalized
}

/** What chrome.windows.update asks beyond the state the extension library handles: to have the focus, and a position or size. */
export interface WindowUpdate {
  focus: boolean
  bounds: { x?: number; y?: number; width?: number; height?: number } | null
}

/** A window an extension asks for is neither a speck nor bigger than any screen; the position stays within a sane range. */
export const MIN_WINDOW_SIZE = 120
export const MAX_WINDOW_SIZE = 16384
export const MAX_WINDOW_COORDINATE = 100_000

/**
 * The position and size an extension asked for (`left`, `top`, `width`, `height`), as whole numbers within limits. What is not a finite
 * number is left out (`NaN` would make the window refuse a size after it was created); null when nothing is left.
 */
export function windowBounds(props: unknown): WindowUpdate['bounds'] {
  const record = (typeof props === 'object' && props !== null ? props : {}) as Record<string, unknown>
  // Not clampOr (shared/clamp.ts): a coordinate is rounded, and one the extension did not give stays undefined, so that the window keeps its own.
  const boundedInteger = (value: unknown, min: number, max: number): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? clamp(Math.round(value), min, max) : undefined)
  const bounds = {
    x: boundedInteger(record['left'], -MAX_WINDOW_COORDINATE, MAX_WINDOW_COORDINATE),
    y: boundedInteger(record['top'], -MAX_WINDOW_COORDINATE, MAX_WINDOW_COORDINATE),
    width: boundedInteger(record['width'], MIN_WINDOW_SIZE, MAX_WINDOW_SIZE),
    height: boundedInteger(record['height'], MIN_WINDOW_SIZE, MAX_WINDOW_SIZE)
  }
  const given = Object.fromEntries(Object.entries(bounds).filter(([, value]) => value !== undefined)) as NonNullable<WindowUpdate['bounds']>
  return Object.keys(given).length > 0 ? given : null
}

export function windowUpdate(props: unknown): WindowUpdate {
  const record = (typeof props === 'object' && props !== null ? props : {}) as Record<string, unknown>
  return { focus: record['focused'] === true, bounds: windowBounds(props) }
}

// ---- command shortcuts (manifest "commands") ----

export interface ExtensionCommand {
  name: string
  description: string
  /** Electron accelerator ("Cmd+Shift+9"), or null when the manifest suggests none or one that is not valid. */
  accelerator: string | null
  /** The way it is shown on macOS ("⌘⇧9"), or '' when there is no shortcut. */
  label: string
}

const MODIFIER_ORDER = ['MacCtrl', 'Ctrl', 'Alt', 'Shift', 'Command'] as const

const KEY_NAMES: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Space: 'Space',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  Delete: 'Delete',
  Up: 'Up',
  Down: 'Down',
  Left: 'Left',
  Right: 'Right'
}

const KEY_LABELS: Record<string, string> = { Comma: ',', Period: '.', Space: 'Space', Up: '↑', Down: '↓', Left: '←', Right: '→', PageUp: '⇞', PageDown: '⇟', Home: '↖', End: '↘' }

/**
 * A suggested key of a manifest ("Command+Shift+9", "MacCtrl+Y", "Ctrl+E") as macOS reads it. A valid key has at least one of
 * Ctrl/Alt/Command(/MacCtrl) with a letter, digit or named key; "Ctrl" in the cross-platform `default` stands for Command on a Mac.
 */
export function parseSuggestedKey(suggested: string, fromDefault: boolean): { accelerator: string; label: string } | null {
  const parts = suggested.split('+').map((p) => p.trim())
  const key = parts.pop() ?? ''
  const wanted = new Set<string>()
  for (const part of parts) {
    const modifier = part === 'Ctrl' && fromDefault ? 'Command' : part
    if (!(MODIFIER_ORDER as readonly string[]).includes(modifier) || wanted.has(modifier)) return null
    wanted.add(modifier)
  }
  // The key is a word of the manifest: only a name written in the table counts, never a member every object inherits ("constructor", "toString").
  const named = Object.hasOwn(KEY_NAMES, key) ? KEY_NAMES[key] : undefined
  const isFunctionKey = /^F([1-9]|1[0-2])$/.test(key)
  const keyName = named ?? (/^[A-Z0-9]$/.test(key) || isFunctionKey ? key : undefined)
  if (keyName === undefined) return null
  // A shortcut needs a modifier that is not just Shift, unless it is a function key.
  const strong = wanted.has('Ctrl') || wanted.has('Alt') || wanted.has('Command') || wanted.has('MacCtrl')
  if (!strong && !isFunctionKey) return null
  const accelerator = [
    ...(wanted.has('MacCtrl') || wanted.has('Ctrl') ? ['Ctrl'] : []),
    ...(wanted.has('Alt') ? ['Alt'] : []),
    ...(wanted.has('Shift') ? ['Shift'] : []),
    ...(wanted.has('Command') ? ['Cmd'] : []),
    keyName
  ].join('+')
  const label = `${wanted.has('MacCtrl') || wanted.has('Ctrl') ? '⌃' : ''}${wanted.has('Alt') ? '⌥' : ''}${wanted.has('Shift') ? '⇧' : ''}${wanted.has('Command') ? '⌘' : ''}${(Object.hasOwn(KEY_LABELS, key) ? KEY_LABELS[key] : undefined) ?? keyName}`
  return { accelerator, label }
}

/** The commands an extension declares, with the shortcut each gets on macOS. */
export function readCommands(manifest: unknown): ExtensionCommand[] {
  const commands = (manifest as { commands?: unknown } | null)?.commands
  if (typeof commands !== 'object' || commands === null) return []
  return Object.entries(commands as Record<string, unknown>).map(([name, details]) => {
    const record = (typeof details === 'object' && details !== null ? details : {}) as { description?: unknown; suggested_key?: Record<string, unknown> }
    const keys = record.suggested_key ?? {}
    const mac = typeof keys['mac'] === 'string' ? keys['mac'] : undefined
    const fallback = typeof keys['default'] === 'string' ? keys['default'] : undefined
    const parsed = mac !== undefined ? parseSuggestedKey(mac, false) : fallback !== undefined ? parseSuggestedKey(fallback, true) : null
    return { name, description: typeof record.description === 'string' ? record.description : '', accelerator: parsed?.accelerator ?? null, label: parsed?.label ?? '' }
  })
}

// ---- authorization flow (chrome.identity) ----

/** `chrome.identity.getRedirectURL`: the address an authorization server sends the browser back to. */
export function redirectUrl(extensionId: string, path = ''): string {
  return `https://${extensionId}.chromiumapp.org/${path.replace(/^\//, '')}`
}

/** Whether a navigation target is the end of an extension's own authorization flow. */
export function isAuthRedirect(url: string, extensionId: string): boolean {
  if (!URL.canParse(url)) return false
  const parsed = new URL(url)
  return parsed.protocol === 'https:' && parsed.hostname === `${extensionId}.chromiumapp.org`
}

/** An authorization page is a web page: no file:, javascript:, data: or extension page may be loaded in the window it gets. */
export function isAuthPageUrl(url: unknown): url is string {
  return typeof url === 'string' && URL.canParse(url) && ['http:', 'https:'].includes(new URL(url).protocol)
}

/** The texts of the errors an authorization flow ends with (the extension platform's own, which extensions match on). */
export const AUTH_ERRORS = {
  interactionRequired: 'User interaction required.',
  userRejected: 'The user did not approve access.',
  pageLoadFailed: 'Authorization page could not be loaded.',
  pageLoadTimedOut: 'Authorization page load timed out.',
  invalidUrl: 'Invalid URL',
  // The platform's own text for a second interactive flow while one is open.
  alreadyRunning: 'Only one interactive web auth flow can be present at a time.'
} as const

// ---- downloads (chrome.downloads) ----

export interface ChromeDownloadItem {
  id: number
  url: string
  finalUrl: string
  referrer: string
  filename: string
  incognito: false
  danger: 'safe'
  mime: string
  startTime: string
  endTime?: string
  state: 'in_progress' | 'interrupted' | 'complete'
  canResume: boolean
  paused: false
  error?: string
  bytesReceived: number
  totalBytes: number
  fileSize: number
  exists: boolean
  byExtensionId?: string
}

/**
 * The download as `chrome.downloads` shows it. `id` is the number the extension knows it by. `endedAt`: when the download ended, as the one who
 * followed it saw it; without it an ended download has no `endTime` (the field is optional), never the time of the question.
 */
export function toChromeDownload(id: number, info: DownloadInfo, byExtensionId?: string, endedAt?: number): ChromeDownloadItem {
  const state = info.state === 'completed' ? 'complete' : info.state === 'progressing' ? 'in_progress' : 'interrupted'
  return {
    id,
    url: info.url,
    finalUrl: info.url,
    referrer: '',
    filename: info.path,
    incognito: false,
    danger: 'safe',
    mime: '',
    startTime: new Date(info.startedAt).toISOString(),
    ...(state !== 'in_progress' && endedAt !== undefined && Number.isFinite(endedAt) ? { endTime: new Date(endedAt).toISOString() } : {}),
    state,
    canResume: false,
    paused: false,
    ...(info.state === 'cancelled' ? { error: 'USER_CANCELED' } : info.state === 'interrupted' ? { error: 'NETWORK_FAILED' } : {}),
    bytesReceived: info.receivedBytes,
    totalBytes: info.totalBytes,
    fileSize: info.state === 'completed' ? info.receivedBytes : info.totalBytes,
    exists: info.state === 'completed',
    ...(byExtensionId ? { byExtensionId } : {})
  }
}

export interface DownloadQuery {
  id?: number
  url?: string
  filename?: string
  state?: string
  query?: string[]
  limit?: number
}

/** `chrome.downloads.search`: exact id, url and state; `filename` and each `query` term are substrings (a term starting with "-" excludes). */
export function searchDownloads(items: ChromeDownloadItem[], query: DownloadQuery): ChromeDownloadItem[] {
  const matches = items.filter((item) => {
    if (query.id !== undefined && item.id !== query.id) return false
    if (query.url !== undefined && item.url !== query.url) return false
    if (query.state !== undefined && item.state !== query.state) return false
    if (query.filename !== undefined && !item.filename.includes(query.filename)) return false
    for (const term of query.query ?? []) {
      const haystack = `${item.url} ${item.filename}`.toLowerCase()
      const excluded = term.startsWith('-')
      const found = haystack.includes((excluded ? term.slice(1) : term).toLowerCase())
      if (excluded ? found : !found) return false
    }
    return true
  })
  return query.limit !== undefined && query.limit >= 0 ? matches.slice(0, query.limit) : matches
}

/**
 * Whether a download the browser is about to start is the one an extension asked for: its address is the one asked for, or one of the
 * addresses it went through (a redirect), compared in their normal form (`http://host` and `http://host/` are one address).
 */
export function isRequestedDownload(requested: string, urls: readonly string[]): boolean {
  const normal = (url: string): string => (URL.canParse(url) ? new URL(url).href : url)
  const wanted = normal(requested)
  return urls.some((url) => normal(url) === wanted)
}

/**
 * The file name an extension asks for, relative to the downloads folder: sub-folders are allowed, escaping the folder is not.
 * Returns null for a name that is absolute (its first part is empty), climbs out with "..", or is empty.
 */
export function safeDownloadName(filename: string): string | null {
  if (filename === '' || filename.includes('\0') || /^[a-z]:/i.test(filename)) return null
  const parts = filename.split(/[\\/]/)
  if (parts.some((part) => part === '..' || part === '')) return null
  return parts.join('/')
}

// ---- events Electron never delivers to an extension's service worker ----

/**
 * Electron 45 delivers these `chrome.*` events to extension pages but not to service workers (a worker listening for them hears
 * nothing). They are caught in a hidden page of the extension and handed to the worker (see `relayNativeEvent` in the engine).
 */
export const RELAYED_EVENTS = ['storage.onChanged', 'alarms.onAlarm', 'idle.onStateChanged'] as const
export type RelayedEvent = (typeof RELAYED_EVENTS)[number]

export function isRelayedEvent(name: unknown): name is RelayedEvent {
  return typeof name === 'string' && (RELAYED_EVENTS as readonly string[]).includes(name)
}

/** The script that makes a page of the extension report one event to the main process. `extensionId` is checked: it ends up inside code. */
export function relayScript(extensionId: string, name: RelayedEvent): string {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('Invalid extension id')
  const [namespace, event] = name.split('.')
  return `(() => {
  const bridge = window.__luciumShim
  const api = chrome.${namespace}
  if (!bridge || !api) throw new Error('chrome.${namespace} is not available to relay ${name}')
  api.${event}.addListener((...args) => { bridge.call('${extensionId}', 'events', 'relay', ['${name}', args]).catch((error) => console.error('[lucium] relay of ${name} failed', error)) })
})()`
}

/** `chrome.runtime.onInstalled` and `onStartup`, which Electron does not fire either: what an extension loaded again should be told. */
export type LifecycleEvent = { event: 'onInstalled'; details: { reason: 'install' } | { reason: 'update'; previousVersion: string } } | { event: 'onStartup' }

/** `previous` is the version this extension had last time it was loaded in the profile, undefined when it never was. */
export function lifecycleEvents(previous: string | undefined, current: string): LifecycleEvent[] {
  if (previous === undefined) return [{ event: 'onInstalled', details: { reason: 'install' } }]
  if (previous !== current) return [{ event: 'onInstalled', details: { reason: 'update', previousVersion: previous } }, { event: 'onStartup' }]
  return [{ event: 'onStartup' }]
}

// ---- permissions of the APIs Lucium provides itself ----

const ALL_HOSTS = new Set(['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*'])

/**
 * How many entries a list of a manifest may hold (`permissions`, `host_permissions`, `content_scripts`, and the `matches` of all the content
 * scripts together). It is the one bound of everything that reads those lists: the sheet that shows what an extension asks for, and the rules
 * that grant it. A package that goes past it is refused (`manifestListsTooLong`), so nothing is ever granted from an entry the sheet did not read.
 */
export const MANIFEST_LIST_MAX = 512

/** Whether a list the review reads holds more entries than every reader of the manifest agrees to read. Counted as written: doubles and entries of the wrong kind too. */
export function manifestListsTooLong(manifest: unknown): boolean {
  if (typeof manifest !== 'object' || manifest === null) return false
  const record = manifest as Record<string, unknown>
  const size = (value: unknown): number => (Array.isArray(value) ? value.length : 0)
  if (size(record['permissions']) > MANIFEST_LIST_MAX || size(record['host_permissions']) > MANIFEST_LIST_MAX || size(record['content_scripts']) > MANIFEST_LIST_MAX) return true
  let matches = 0
  for (const script of Array.isArray(record['content_scripts']) ? record['content_scripts'] : []) {
    if (typeof script !== 'object' || script === null) continue
    matches += size((script as Record<string, unknown>)['matches'])
    if (matches > MANIFEST_LIST_MAX) return true
  }
  return false
}

/** A host match pattern (`<all_urls>`, `https://…`), as opposed to the name of a permission. */
export const isHostEntry = (entry: string): boolean => entry === '<all_urls>' || entry.includes('://')

/**
 * The host patterns a manifest grants. Manifest V2 lists them among its `permissions`; in Manifest V3 the extension platform ignores a pattern written
 * there and grants nothing for it, so neither do the rules built on this (`accessOf`, the review sheet, `shimAllowed`): what the sheet
 * says and what is granted stay one thing.
 */
export function hostPatternsOf(manifest: { manifest_version?: unknown; permissions?: unknown; host_permissions?: unknown } | undefined, limit = MANIFEST_LIST_MAX): string[] {
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.slice(0, limit).filter((v): v is string => typeof v === 'string') : [])
  return [...strings(manifest?.host_permissions), ...(manifest?.manifest_version === 2 ? strings(manifest.permissions).filter(isHostEntry) : [])]
}

/** What the shims ask the main process about the request rules of an extension. */
const NET_RULE_METHODS: ReadonlySet<string> = new Set(['mirror', 'getEnabledRulesets', 'updateEnabledRulesets', 'updateStaticRules', 'getDisabledRuleIds', 'getAvailableStaticRuleCount'])

/**
 * Whether an extension may call a `chrome.*` API that Lucium provides itself. The extension platform only defines an API for an extension that
 * declared its permission: the same rule has to hold here, or an extension without "debugger" could drive any tab.
 */
export function shimAllowed(manifest: { manifest_version?: unknown; permissions?: unknown; host_permissions?: unknown; omnibox?: unknown } | undefined, api: string, method: string): boolean {
  // The same bound as the review sheet: a permission written past it was shown to nobody, and opens nothing.
  const declared = (value: unknown): string[] => (Array.isArray(value) ? value.slice(0, MANIFEST_LIST_MAX).filter((v): v is string => typeof v === 'string') : [])
  const permissions = new Set(declared(manifest?.permissions))
  switch (api) {
    // Only `permissions` is read, never `optional_permissions`: a facultative permission opens nothing until the person granted it, and the engine
    // then hands this the manifest with what was granted added to `permissions` (shared/optional-permissions.ts, `withGranted`).
    case 'sidePanel':
      return permissions.has('sidePanel')
    case 'tabGroups':
      return permissions.has('tabGroups')
    case 'debugger':
      return permissions.has('debugger')
    case 'nativeMessaging':
      return permissions.has('nativeMessaging')
    case 'identity':
      return permissions.has('identity')
    case 'downloads':
      return permissions.has('downloads')
    case 'contextMenus':
      // The library creates and removes the items; the update is ours.
      return method === 'update' && permissions.has('contextMenus')
    case 'clipboard':
      // What document.execCommand('paste') and ('copy') do on the extension platform for an extension that holds "clipboardRead" and "clipboardWrite".
      return (method === 'paste' && permissions.has('clipboardRead')) || (method === 'write' && permissions.has('clipboardWrite'))
    // The data APIs: each needs its own permission, whatever the method (the methods themselves are checked by the handler).
    case 'history':
      return permissions.has('history')
    case 'bookmarks':
      return permissions.has('bookmarks')
    case 'browsingData':
      return permissions.has('browsingData')
    // The request rules: Lucium applies them itself (shared/net-rules.ts), for an extension that holds one of the two permissions of the API.
    case 'declarativeNetRequest':
      return (permissions.has('declarativeNetRequest') || permissions.has('declarativeNetRequestWithHostAccess')) && NET_RULE_METHODS.has(method)
    case 'webRequest':
      // `answer`: what the blocking listeners of a context answer about a request it was asked about (engine/extension-net.ts).
      return permissions.has('webRequest') && (method === 'listen' || (method === 'answer' && permissions.has('webRequestBlocking')))
    // chrome.scripting on a tab lent with a click (shared/active-tab-script.ts): whether this tab was lent is `lentTab`.
    case 'scripting':
      return permissions.has('scripting') && permissions.has('activeTab') && (method === 'executeScript' || method === 'insertCSS' || method === 'removeCSS')
    // What the script of a lent tab asks of the workers of its extension, and what they answer (shared/lent-tab-runtime.ts): the extension must be one that can be lent a tab.
    case 'lentTab':
      return permissions.has('scripting') && permissions.has('activeTab') && (method === 'answer' || method === 'toTab' || method === 'changed')
    case 'runtime':
      // Which contexts exist (the side panel) is not something to hide: the extension platform answers for any extension.
      return method === 'sidePanelContexts'
    case 'events':
      // An extension asks for its own events, and reports its own: no permission is involved.
      return method === 'subscribe' || method === 'relay'
    case 'permissions':
      // Every extension may ask what it holds and ask for more: what it is given is the main process's to decide (optional-grants.ts).
      return method === 'request' || method === 'contains' || method === 'getAll' || method === 'remove'
    case 'tabs':
      if (method === 'group' || method === 'ungroup') return permissions.has('tabGroups')
      // Only a first filter: whether it may capture this tab, which needs the user to have handed it over with activeTab, is `canCaptureTab`.
      if (method === 'captureVisibleTab') return permissions.has('activeTab') || hostPatternsOf(manifest).some((host) => ALL_HOSTS.has(host))
      return method === 'discard'
    default:
      return false
  }
}

/**
 * Whether an event of an API Lucium provides itself may reach an extension. Like the calls, the events exist only for an extension
 * that declared the permission: the download of a file (its address, where it was saved) is not for an extension that cannot download.
 */
export function shimEventAllowed(manifest: { permissions?: unknown; host_permissions?: unknown; omnibox?: unknown } | undefined, api: string, event: string): boolean {
  switch (api) {
    case 'sidePanel':
    case 'tabGroups':
    case 'debugger':
    case 'nativeMessaging':
    case 'identity':
    case 'downloads':
    case 'history':
    case 'bookmarks':
    case 'browsingData':
      return shimAllowed(manifest, api, event)
    case 'webRequest':
      return shimAllowed(manifest, api, 'listen')
    default:
      return false
  }
}
