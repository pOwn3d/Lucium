// What an extension that declared "history", "bookmarks" or "browsingData" is given, as pure functions: the answers of
// chrome.history and chrome.bookmarks in the shapes of the extension API, and what a chrome.browsingData request means here. Reading only, plus the
// one erasure Lucium already knows how to do safely: the data of named sites. The main process (shell/extension-shims.ts) feeds
// them the profile's history, the favourites and pinned tabs, and the engine's site-data erasure.

import type { Favorite, Folder, HistoryEntry, Space, TabItem } from './model'
import { favoriteProfile } from './favorite-scope'
import { parseSiteHost, type EngineSiteDataType } from './site-data'
import { t } from './i18n'
import { isRecord } from './record'

/** The `chrome.*` APIs of this file, which one setting (`extensionDataApis`) gives or takes away from every extension. */
export const DATA_APIS: readonly string[] = ['history', 'bookmarks', 'browsingData', 'sessions']

// The tables of the methods and events are in a file of their own, which imports nothing: the preload of the extension contexts reads them, and
// whatever it imports is built into it (this file reaches the catalogues of the interface's texts).
export { DATA_API_EVENTS, DATA_API_METHODS } from './extension-data-api'

/** The error an extension gets for a call that needs a write Lucium does not offer it. */
export const readOnlyError = (name: string): string => `chrome.${name} is not supported in Lucium: history and bookmarks are read-only for extensions.`

// ---------- chrome.history ----------

export interface HistoryItem {
  id: string
  url: string
  title: string
  lastVisitTime: number
  visitCount: number
  typedCount: number
}

export interface VisitItem {
  id: string
  visitId: string
  visitTime: number
  referringVisitId: string
  transition: 'link'
  isLocal: true
}

/** The default window of `history.search`: the last 24 hours. */
export const HISTORY_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000
export const HISTORY_DEFAULT_RESULTS = 100
export const HISTORY_MAX_RESULTS = 1000
const HISTORY_TEXT_MAX = 500

export interface HistoryQuery {
  text: string
  startTime: number
  endTime: number
  maxResults: number
}

const finiteTime = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined)

/** The query of `history.search`, as the extension API reads it. Null when it is not a query (the call then fails, as the API says). */
export function parseHistoryQuery(raw: unknown, now: number): HistoryQuery | null {
  if (!isRecord(raw) || typeof raw['text'] !== 'string' || raw['text'].length > HISTORY_TEXT_MAX) return null
  // The end of the range is exclusive: without one, a page visited in this very millisecond must still be in the answer.
  const endTime = finiteTime(raw['endTime']) ?? now + 1
  const startTime = finiteTime(raw['startTime']) ?? Math.max(0, now - HISTORY_DEFAULT_WINDOW_MS)
  const asked = typeof raw['maxResults'] === 'number' && Number.isInteger(raw['maxResults']) && raw['maxResults'] >= 0 ? raw['maxResults'] : HISTORY_DEFAULT_RESULTS
  return { text: raw['text'], startTime, endTime, maxResults: Math.min(asked, HISTORY_MAX_RESULTS) }
}

/** An id for a history entry that stays the same for the same page. */
const historyId = (url: string): string => `h${[...url].reduce((hash, ch) => (Math.imul(hash, 31) + ch.charCodeAt(0)) | 0, 7) >>> 0}`

export function toHistoryItem(entry: HistoryEntry): HistoryItem {
  return { id: historyId(entry.url), url: entry.url, title: entry.title, lastVisitTime: entry.lastVisitAt, visitCount: entry.visitCount, typedCount: 0 }
}

/**
 * `history.search`: the pages whose title or address holds every word of the text (case ignored), visited between the two times,
 * most recent first. Not the command bar's fuzzy match: an extension asking for "git" does not want a page that spells g, i, t far apart.
 */
export function searchHistory(entries: readonly HistoryEntry[], query: HistoryQuery): HistoryItem[] {
  const words = query.text.toLowerCase().split(/\s+/).filter(Boolean)
  return entries
    .filter((entry) => {
      if (entry.lastVisitAt < query.startTime || entry.lastVisitAt >= query.endTime) return false
      const haystack = `${entry.title}\n${entry.url}`.toLowerCase()
      return words.every((word) => haystack.includes(word))
    })
    .sort((a, b) => b.lastVisitAt - a.lastVisitAt)
    .slice(0, query.maxResults)
    .map(toHistoryItem)
}

/** `history.getVisits({ url })`: Lucium keeps one line per page (its last visit and a count), so the visit it can show is the last one. */
export function visitsOf(entry: HistoryEntry | undefined): VisitItem[] {
  return entry ? [{ id: historyId(entry.url), visitId: '1', visitTime: entry.lastVisitAt, referringVisitId: '0', transition: 'link', isLocal: true }] : []
}

/** The address of a `{ url }` argument, which must be an http(s) one: that is all the history holds. */
export function historyUrl(raw: unknown): string | null {
  const url = isRecord(raw) ? raw['url'] : undefined
  return typeof url === 'string' && url.length <= 8192 && /^https?:\/\//i.test(url) && URL.canParse(url) ? url : null
}

// ---------- chrome.bookmarks ----------

export interface BookmarkNode {
  id: string
  parentId?: string
  index?: number
  url?: string
  title: string
  dateAdded?: number
  children?: BookmarkNode[]
  folderType?: 'bookmarks-bar' | 'other'
}

export const BOOKMARK_ROOT = '0'
export const BOOKMARK_FAVORITES = '1'
export const BOOKMARK_PINNED = '2'
const BOOKMARK_NODES_MAX = 5000

export interface BookmarkSource {
  favorites: readonly Favorite[]
  spaces: readonly Pick<Space, 'id' | 'name' | 'emoji' | 'profileId'>[]
  folders: readonly Pick<Folder, 'id' | 'spaceId' | 'name' | 'parentId'>[]
  tabs: readonly Pick<TabItem, 'id' | 'spaceId' | 'url' | 'title' | 'customTitle' | 'pinned' | 'folderId' | 'createdAt'>[]
}

/**
 * The tree an extension of one profile sees: the favourites of this profile under the bookmarks bar, and
 * the pinned tabs of the spaces that use this profile under "other bookmarks", each space a folder holding its pinned folders and tabs.
 * Another profile's pinned tabs are not in it. Capped, so that a huge state cannot make one answer enormous.
 */
export function bookmarkTree(source: BookmarkSource, profileId: string): BookmarkNode {
  let count = 0
  const room = (): boolean => count++ < BOOKMARK_NODES_MAX
  const link = (id: string, parentId: string, index: number, url: string, title: string, dateAdded?: number): BookmarkNode => ({ id, parentId, index, url, title, ...(dateAdded !== undefined ? { dateAdded } : {}) })

  const bar: BookmarkNode = { id: BOOKMARK_FAVORITES, parentId: BOOKMARK_ROOT, index: 0, title: t('extension-data.favoris'), folderType: 'bookmarks-bar', children: [] }
  source.favorites.filter((favorite) => favoriteProfile(favorite) === profileId).forEach((favorite) => {
    if (room()) bar.children!.push(link(`fav-${favorite.id}`, bar.id, bar.children!.length, favorite.url, favorite.title))
  })

  const pinned: BookmarkNode = { id: BOOKMARK_PINNED, parentId: BOOKMARK_ROOT, index: 1, title: t('extension-data.onglets-epingles'), folderType: 'other', children: [] }
  for (const space of source.spaces.filter((one) => one.profileId === profileId)) {
    if (!room()) break
    const spaceNode: BookmarkNode = { id: `space-${space.id}`, parentId: pinned.id, index: pinned.children!.length, title: `${space.emoji} ${space.name}`.trim(), children: [] }
    const pins = source.tabs.filter((tab) => tab.spaceId === space.id && tab.pinned)
    const folders = source.folders.filter((folder) => folder.spaceId === space.id)
    const fill = (parent: BookmarkNode, folderId: string | undefined): void => {
      // Walked down from the top of the space, so a loop of folders (each the parent of the other) is never reached.
      for (const folder of folders.filter((one) => (one.parentId ?? undefined) === folderId)) {
        if (!room()) return
        const node: BookmarkNode = { id: `folder-${folder.id}`, parentId: parent.id, index: parent.children!.length, title: folder.name, children: [] }
        parent.children!.push(node)
        fill(node, folder.id)
      }
      // A pinned tab sits in its folder, or loose at the top of the space (a folder that is gone leaves it loose).
      const known = new Set(folders.map((one) => one.id))
      for (const tab of pins.filter((one) => (folderId === undefined ? one.folderId === undefined || !known.has(one.folderId) : one.folderId === folderId))) {
        if (room()) parent.children!.push(link(`pin-${tab.id}`, parent.id, parent.children!.length, tab.url, tab.customTitle?.trim() || tab.title, tab.createdAt))
      }
    }
    fill(spaceNode, undefined)
    pinned.children!.push(spaceNode)
  }

  return { id: BOOKMARK_ROOT, title: '', children: [bar, pinned] }
}

/** Every node of a tree by id. */
export function bookmarkIndex(root: BookmarkNode): Map<string, BookmarkNode> {
  const nodes = new Map<string, BookmarkNode>()
  const visit = (node: BookmarkNode): void => {
    nodes.set(node.id, node)
    for (const child of node.children ?? []) visit(child)
  }
  visit(root)
  return nodes
}

/** A node without its children, which is how `get`, `getChildren` and `search` hand nodes out. */
export const bare = (node: BookmarkNode): BookmarkNode => {
  const { children: _children, ...rest } = node
  return rest
}

/** The ids of `bookmarks.get`: one id or a list of them. Null when it is neither. */
export function bookmarkIds(raw: unknown): string[] | null {
  const list = Array.isArray(raw) ? raw : [raw]
  return list.length > 0 && list.length <= 100 && list.every((id) => typeof id === 'string' && id.length <= 300) ? (list as string[]) : null
}

/** `bookmarks.search`: a text (every word in the title or the address) or `{ query, url, title }` (an exact address, an exact title). Links only, as the API returns them. */
export function searchBookmarks(root: BookmarkNode, raw: unknown): BookmarkNode[] | null {
  const query = typeof raw === 'string' ? { query: raw } : isRecord(raw) ? raw : null
  if (!query) return null
  const text = typeof query['query'] === 'string' ? query['query'].toLowerCase().split(/\s+/).filter(Boolean) : []
  const url = typeof query['url'] === 'string' ? query['url'] : undefined
  const title = typeof query['title'] === 'string' ? query['title'] : undefined
  return [...bookmarkIndex(root).values()]
    .filter((node) => node.url !== undefined)
    .filter((node) => (url === undefined || node.url === url) && (title === undefined || node.title === title))
    .filter((node) => text.every((word) => `${node.title}\n${node.url ?? ''}`.toLowerCase().includes(word)))
    .map(bare)
}

/** `bookmarks.getRecent(n)`: the links with a date, newest first. Favourites have none and come after. */
export function recentBookmarks(root: BookmarkNode, count: unknown): BookmarkNode[] | null {
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 1000) return null
  const links = [...bookmarkIndex(root).values()].filter((node) => node.url !== undefined)
  return links.sort((a, b) => (b.dateAdded ?? 0) - (a.dateAdded ?? 0)).slice(0, count).map(bare)
}

// ---------- chrome.browsingData ----------

/** The kinds of data an extension may ask to remove, as the extension API names them, and what each is here. */
const BROWSING_DATA_TYPES: Readonly<Record<string, EngineSiteDataType | 'history'>> = {
  cache: 'cache',
  cookies: 'cookies',
  localStorage: 'localStorage',
  indexedDB: 'indexedDB',
  serviceWorkers: 'serviceWorkers',
  cacheStorage: 'cacheStorage',
  history: 'history'
}

/** The API's other kinds (downloads, passwords, form data…): Lucium does not erase them for an extension. */
const BROWSING_DATA_UNSUPPORTED = ['appcache', 'downloads', 'fileSystems', 'formData', 'passwords', 'pluginData', 'webSQL'] as const

export const BROWSING_ORIGINS_MAX = 50

export interface BrowsingDataRequest {
  /** One entry per site: its host (port included) and the two origins that site's storage lives in. */
  sites: Array<{ host: string; origins: string[] }>
  types: Array<EngineSiteDataType | 'history'>
}

export type BrowsingDataParse = { ok: true; request: BrowsingDataRequest } | { ok: false; error: string }

/**
 * `browsingData.remove(options, dataToRemove)`. Lucium erases the data of **named sites** and nothing wider: a call without `origins`
 * (the API reads it as everything) is refused, as is a start time (the storage cannot be erased by date) and any kind of data it does
 * not erase. An origin that is not a plain web origin is refused. Erasing on a doubt would be worse than not erasing.
 */
export function parseBrowsingData(rawOptions: unknown, rawTypes: unknown): BrowsingDataParse {
  const refuse = (error: string): BrowsingDataParse => ({ ok: false, error })
  const options = rawOptions === undefined || rawOptions === null ? {} : rawOptions
  if (!isRecord(options)) return refuse('Invalid options for browsingData.')
  if (!isRecord(rawTypes)) return refuse('Invalid data types for browsingData.')
  if (options['since'] !== undefined && options['since'] !== 0) return refuse('options.since is not supported in Lucium: the data of a site is erased whole.')
  if (options['excludeOrigins'] !== undefined && options['origins'] === undefined) return refuse('options.excludeOrigins needs options.origins in Lucium.')
  const origins = options['origins']
  if (!Array.isArray(origins) || origins.length === 0) return refuse('Lucium erases browsing data for named sites only: give options.origins.')
  if (origins.length > BROWSING_ORIGINS_MAX) return refuse(`At most ${BROWSING_ORIGINS_MAX} origins at once.`)
  const excluded = Array.isArray(options['excludeOrigins']) ? options['excludeOrigins'] : []

  const sites = new Map<string, { host: string; origins: string[] }>()
  for (const origin of origins) {
    if (typeof origin !== 'string' || origin.length > 300 || !/^https?:\/\//i.test(origin) || !URL.canParse(origin)) return refuse(`Not a web origin: ${String(origin).slice(0, 80)}`)
    const parsed = new URL(origin)
    // `https://a.example/path` is not an origin: it would name more than the extension typed, or less.
    if (parsed.origin !== origin) return refuse(`Not an origin (no path, no trailing slash): ${origin.slice(0, 80)}`)
    const site = parseSiteHost(parsed.host)
    if (!site) return refuse(`Not a site: ${origin.slice(0, 80)}`)
    if (excluded.includes(origin)) continue
    const known = sites.get(site.host) ?? { host: site.host, origins: [] }
    if (!known.origins.includes(origin)) known.origins.push(origin)
    sites.set(site.host, known)
  }
  if (sites.size === 0) return refuse('Every origin was excluded: nothing to erase.')

  const types: BrowsingDataRequest['types'] = []
  for (const [name, wanted] of Object.entries(rawTypes)) {
    if (wanted !== true) continue
    const type = Object.hasOwn(BROWSING_DATA_TYPES, name) ? BROWSING_DATA_TYPES[name] : undefined
    if (!type) return refuse(`Lucium does not erase "${name}" for an extension.`)
    if (!types.includes(type)) types.push(type)
  }
  if (types.length === 0) return refuse('No data type selected.')
  return { ok: true, request: { sites: [...sites.values()], types } }
}

/** The `removeCache`, `removeCookies`… shortcuts: the method name is the data type. */
export const BROWSING_DATA_METHODS: Readonly<Record<string, string>> = {
  removeCache: 'cache',
  removeCookies: 'cookies',
  removeLocalStorage: 'localStorage',
  removeIndexedDB: 'indexedDB',
  removeServiceWorkers: 'serviceWorkers',
  removeCacheStorage: 'cacheStorage',
  removeHistory: 'history'
}

/** `browsingData.settings()`: what can be removed here, and nothing is ticked for the user. */
export function browsingDataSettings(): { options: { since: number; originTypes: Record<string, boolean> }; dataToRemove: Record<string, boolean>; dataRemovalPermitted: Record<string, boolean> } {
  const supported = Object.fromEntries(Object.keys(BROWSING_DATA_TYPES).map((name) => [name, true]))
  const unsupported = Object.fromEntries(BROWSING_DATA_UNSUPPORTED.map((name) => [name, false]))
  return {
    options: { since: 0, originTypes: { unprotectedWeb: true, protectedWeb: false, extension: false } },
    dataToRemove: Object.fromEntries(Object.keys({ ...supported, ...unsupported }).map((name) => [name, false])),
    dataRemovalPermitted: { ...supported, ...unsupported }
  }
}
