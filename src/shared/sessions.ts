// Tab sessions (from Chrome Toolkit's "Sessions d'onglets"): the tabs of a space saved under a name, opened again in one click.
// Pure rules shared by the reducer (sidebar.ts), the loader (normalize) and the panel. What a session keeps, the limits, and how a
// session is turned back into tabs live here; the state changes themselves are the reducer's `session/*` actions.

import { tabName, type ArchivedTab, type AsideSpace, type Folder, type Session, type SessionTab, type SidebarState, type SplitView, type TabItem } from './model'
import { ARCHIVE_LIMIT, NAME_MAX, TITLE_MAX, cleanArchive, cleanFolders, cleanSpaces, cleanSplits, cleanTabs, isRecord, printable, uniqueRecords } from './state-clean'
import { isContainerId } from './container-id'
import { normalizeFolders } from './folders'
import { hostOf, isNavigableUrl } from './url'
import { getLanguage, t, tp } from './i18n'

/** Past this many sessions a new one is refused (a session is the user's own work: no older one is pushed out silently). */
export const SESSIONS_MAX = 100
/** A session keeps the first 500 tabs of the sidebar's order; the rest is left out. */
export const SESSION_TABS_MAX = 500
export const SESSION_NAME_MAX = 100
/** Longer addresses are not kept: every session is saved with the state at each change. */
export const SESSION_URL_MAX = 8192
/** Where a restored session opens: the current space, or a new one named after the session. */
export const SESSION_TARGETS = ['current', 'new-space'] as const
export type SessionTarget = (typeof SESSION_TARGETS)[number]
/** The icon of the space a session is restored into. */
export const SESSION_SPACE_EMOJI = '🗂️'
/** A space put aside keeps every tab it has, so one with more is not put aside at all (nothing is dropped to make it fit). */
export const ASIDE_TABS_MAX = 1000
/** An icon is kept with a tab put aside only as an address of this length at most: an inlined picture would swell the state file, and the page brings its own back. */
const ASIDE_FAVICON_MAX = 2048

const finite = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/**
 * A page a session keeps and opens again: the web and local files, as the Toolkit does (http, https, file). Never `about:blank`,
 * a script (`javascript:`), a `data:` page or one of the application's own pages: a file can be edited by hand, so this is also
 * checked when a session is restored.
 */
export const isSessionUrl = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= SESSION_URL_MAX && value !== 'about:blank' && !/\p{Cc}/u.test(value) && isNavigableUrl(value)

/** The name a session is given: single line, trimmed, at most `SESSION_NAME_MAX` characters. Empty when there is nothing usable. */
export const cleanSessionName = (value: unknown): string => printable(value, SESSION_NAME_MAX)?.trim() ?? ''

/**
 * "Session du 24/10/2026 14:32": the name given to a session saved without one (the Toolkit's automatic title), in the language of the
 * interface. In English the month is a word ("Session from 24 Oct 2026 at 14:32"), as in the dates of `sessionAge`: a date all in figures
 * reads as the 10th of November to one reader and the 11th of October to another.
 */
export function autoSessionName(now: number): string {
  const at = new Date(now)
  const two = (n: number) => String(n).padStart(2, '0')
  const date = getLanguage() === 'fr' ? `${two(at.getDate())}/${two(at.getMonth() + 1)}/${at.getFullYear()}` : at.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  return t('sessions.session-du-date-time', { date, time: `${two(at.getHours())}:${two(at.getMinutes())}` })
}

/** One page of a session as it is kept, or null when it is not a page a session keeps. A folder only means something for a pinned tab. */
export function cleanSessionTab(raw: unknown): SessionTab | null {
  if (!isRecord(raw)) return null
  const url = raw['url']
  if (!isSessionUrl(url)) return null
  const title = (printable(raw['title'], TITLE_MAX)?.trim() || hostOf(url) || url).slice(0, TITLE_MAX).trim()
  const tab: SessionTab = { url, title }
  if (raw['pinned'] === true) {
    tab.pinned = true
    const folder = printable(raw['folder'], NAME_MAX)?.trim()
    if (folder) {
      tab.folder = folder
      if (raw['folderBottom'] === true) tab.folderBottom = true
    }
  }
  // Only the shape of the id: the container may be gone by the time the session is restored (the page then opens in the profile's session).
  if (isContainerId(raw['container'])) tab.container = raw['container']
  return tab
}

/** The pages of a session: the good ones, in order, up to the limit. */
export function cleanSessionTabs(raw: unknown): SessionTab[] {
  const out: SessionTab[] = []
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (out.length >= SESSION_TABS_MAX) break
    const tab = cleanSessionTab(entry)
    if (tab) out.push(tab)
  }
  return out
}

/**
 * The sessions of a file: an id nobody else has, a name (a session whose name is lost is called "Session", its tabs are worth
 * more than its label), and at least one page, or a space put aside (which may be empty: it is kept for its theme and settings).
 * Newest first as saved, at most `SESSIONS_MAX`. One bad session costs only itself.
 */
export function cleanSessions(raw: unknown): Session[] {
  const out: Session[] = []
  for (const [entry, id] of uniqueRecords(raw)) {
    if (out.length >= SESSIONS_MAX) break
    const tabs = cleanSessionTabs(entry['tabs'])
    const space = cleanAside(entry['space'])
    if (tabs.length > 0 || space) out.push({ id, name: cleanSessionName(entry['name']) || t('sessions.session'), createdAt: finite(entry['createdAt']), tabs, ...(space ? { space } : {}) })
  }
  return out
}

/** How many of these tabs a session would keep, before the limit (the panel says when some are left out). */
export const savableCount = (tabs: readonly TabItem[]): number => tabs.filter((t) => isSessionUrl(t.pinned ? (t.anchorUrl ?? t.url) : t.url)).length

/**
 * What a session keeps of these tabs (the sidebar's order: pinned first, then Today). A pinned tab keeps the page it is pinned to,
 * not the one it wandered off to, so that restoring it never moves a pin; the folder it sits in is kept by name.
 */
export function sessionTabsOf(tabs: readonly TabItem[], folders: readonly Folder[]): SessionTab[] {
  const folderNames = new Map(folders.map((f) => [f.id, f.name]))
  const underTabs = new Set(folders.filter((f) => f.atBottom === true).map((f) => f.id))
  const out: SessionTab[] = []
  for (const tab of tabs) {
    if (out.length >= SESSION_TABS_MAX) break
    const url = tab.pinned ? (tab.anchorUrl ?? tab.url) : tab.url
    const kept = cleanSessionTab({
      url,
      // The title of the page it wandered off to would not describe the pin.
      title: url === tab.url ? tabName(tab) : hostOf(url),
      pinned: tab.pinned,
      folder: tab.folderId ? folderNames.get(tab.folderId) : undefined,
      folderBottom: tab.folderId !== undefined && underTabs.has(tab.folderId),
      container: tab.container
    })
    if (kept) out.push(kept)
  }
  return out
}

/** The pages of a session that may be opened: checked again, because a state in memory can hold what a file never could. */
export const restorableTabs = (session: Session): SessionTab[] => cleanSessionTabs(session.tabs)

interface IdSource {
  now: number
  newId: () => string
}

/**
 * Opens these pages as tabs of a space, after the tabs it has. A pinned page is pinned again, in the folder of that name (the
 * space's own when it has one, else a new folder at the root of its pinned list). The tabs are not loaded until they are shown.
 * `firstId` is the first tab opened, or null when there was nothing to open.
 */
export function appendSessionTabs(state: SidebarState, spaceId: string, pages: readonly SessionTab[], ctx: IdSource): { state: SidebarState; firstId: string | null } {
  if (pages.length === 0 || !state.spaces.some((s) => s.id === spaceId)) return { state, firstId: null }
  const folders = [...state.folders]
  const folderIds = new Map<string, string>()
  const folderFor = (name: string, bottom: boolean): string => {
    const known = folderIds.get(name)
    if (known) return known
    const own = folders.filter((f) => f.spaceId === spaceId && f.name === name)
    let id = (own.find((f) => !f.parentId) ?? own[0])?.id
    if (!id) {
      id = ctx.newId()
      folders.push({ id, spaceId, name, collapsed: false, ...(bottom ? { atBottom: true as const } : {}) })
    }
    folderIds.set(name, id)
    return id
  }
  const containers = new Set(state.settings.containers.map((c) => c.id))
  const opened = pages.map((page): TabItem => {
    const pinned = page.pinned === true
    return {
      id: ctx.newId(),
      spaceId,
      url: page.url,
      title: page.title,
      pinned,
      createdAt: ctx.now,
      lastActiveAt: ctx.now,
      ...(pinned ? { anchorUrl: page.url } : {}),
      ...(pinned && page.folder ? { folderId: folderFor(page.folder, page.folderBottom === true) } : {}),
      // A container that is gone leaves the page to the profile's session, as `pruneContainers` does for a file.
      ...(page.container !== undefined && containers.has(page.container) ? { container: page.container } : {})
    }
  })
  return { state: { ...state, folders, tabs: [...state.tabs, ...opened] }, firstId: opened[0]!.id }
}

// ---------- a space put aside ----------

/** A tab as a space put aside keeps it: the same, without an icon that is a picture rather than an address. */
export function slimTab(tab: TabItem): TabItem {
  const icon = tab.faviconUrl
  if (icon === undefined || (/^https?:\/\//i.test(icon) && icon.length <= ASIDE_FAVICON_MAX)) return tab
  const { faviconUrl: _heavy, ...rest } = tab
  return rest
}

/** The split views of a space put aside that still hold together: two or more of its tabs, none of them in another split. */
function intactSplits(raw: unknown, spaceId: string, tabIds: ReadonlySet<string>): SplitView[] {
  const taken = new Set<string>()
  const out: SplitView[] = []
  for (const split of cleanSplits(raw)) {
    if (split.spaceId !== spaceId || split.tabIds.length < 2 || split.tabIds.some((id) => !tabIds.has(id) || taken.has(id))) continue
    split.tabIds.forEach((id) => taken.add(id))
    out.push(split)
  }
  return out
}

/** Why a space cannot be put aside now (a sentence for the user), or null when it can. The reducer refuses for the same reasons. */
export function asideRefusal(state: SidebarState, spaceId: string): string | null {
  if (!state.spaces.some((s) => s.id === spaceId)) return t('sessions.cet-espace-n-existe-plus')
  if (state.spaces.length <= 1) return t('sessions.il-faut-garder-au-moins-un-espace-celui-ci')
  if (state.sessions.length >= SESSIONS_MAX) return t('sessions.limite-de-sessions-max-sessions-atteinte-2', { SESSIONS_MAX })
  if (state.tabs.filter((t) => t.spaceId === spaceId).length > ASIDE_TABS_MAX) return t('sessions.cet-espace-a-plus-de-aside-tabs-max-onglets', { ASIDE_TABS_MAX })
  return null
}

/**
 * What puts the space back as it was: the space, its place, its folders and tabs (all of them, as the state holds them), its split
 * views, the tab on screen and its archive. Null when the space is unknown. The caller has checked `asideRefusal`.
 */
export function asideOf(state: SidebarState, spaceId: string): AsideSpace | null {
  const index = state.spaces.findIndex((s) => s.id === spaceId)
  if (index < 0) return null
  const tabs = state.tabs.filter((t) => t.spaceId === spaceId)
  const shown = state.activeTabBySpace[spaceId]
  return {
    space: state.spaces[index]!,
    index,
    folders: state.folders.filter((f) => f.spaceId === spaceId),
    tabs: tabs.map(slimTab),
    splits: state.splits.filter((sp) => sp.spaceId === spaceId),
    selected: shown && tabs.some((t) => t.id === shown) ? shown : null,
    archive: state.archive.filter((a) => a.spaceId === spaceId)
  }
}

/** The space put aside a file holds, repaired like the spaces, folders and tabs of the state itself; undefined when there is no usable space in it. */
export function cleanAside(raw: unknown): AsideSpace | undefined {
  if (!isRecord(raw)) return undefined
  const space = cleanSpaces([raw['space']])[0]
  if (!space) return undefined
  const spaceIds = new Set([space.id])
  const folders = normalizeFolders(cleanFolders(raw['folders']), spaceIds)
  const tabs = cleanTabs(raw['tabs'], spaceIds, new Map(folders.map((f) => [f.id, f.spaceId])))
    .slice(0, ASIDE_TABS_MAX)
    .map(slimTab)
  const tabIds = new Set(tabs.map((t) => t.id))
  const index = raw['index']
  const selected = raw['selected']
  return {
    space,
    index: typeof index === 'number' && Number.isFinite(index) ? Math.min(Math.max(Math.floor(index), 0), SESSIONS_MAX * 100) : 0,
    folders,
    tabs,
    splits: intactSplits(raw['splits'], space.id, tabIds),
    selected: typeof selected === 'string' && tabIds.has(selected) ? selected : null,
    archive: cleanArchive(raw['archive'], spaceIds)
  }
}

/**
 * The state with the space of `aside` back in it, as it was: at its place, with its folders, tabs, split views, selected tab and archive.
 * Every id comes back as it was unless the state has taken it since (a copy restored in between can hold the same space): that one is
 * made anew. The space becomes the one on screen. The caller drops the session it comes from.
 */
export function reopenAside(state: SidebarState, aside: AsideSpace, ctx: IdSource): SidebarState {
  const fresh = (id: string, taken: ReadonlySet<string>): string => (taken.has(id) ? ctx.newId() : id)
  const spaceId = fresh(aside.space.id, new Set(state.spaces.map((s) => s.id)))
  const folderTaken = new Set(state.folders.map((f) => f.id))
  const folderIds = new Map(aside.folders.map((f) => [f.id, fresh(f.id, folderTaken)]))
  const tabTaken = new Set(state.tabs.map((t) => t.id))
  const tabIds = new Map(aside.tabs.map((t) => [t.id, fresh(t.id, tabTaken)]))
  const splitTaken = new Set(state.splits.map((sp) => sp.id))
  const archiveTaken = new Set(state.archive.map((a) => a.id))

  const space = { ...aside.space, id: spaceId }
  const spaces = [...state.spaces]
  spaces.splice(Math.min(aside.index, spaces.length), 0, space)
  const folders = aside.folders.map(({ parentId, ...f }): Folder => {
    const parent = parentId ? folderIds.get(parentId) : undefined
    return { ...f, id: folderIds.get(f.id)!, spaceId, ...(parent ? { parentId: parent } : {}) }
  })
  const tabs = aside.tabs.map(({ folderId, ...t }): TabItem => {
    const folder = folderId ? folderIds.get(folderId) : undefined
    return { ...t, id: tabIds.get(t.id)!, spaceId, ...(folder ? { folderId: folder } : {}) }
  })
  const splits: SplitView[] = aside.splits.map((sp) => ({ ...sp, id: fresh(sp.id, splitTaken), spaceId, tabIds: sp.tabIds.map((id) => tabIds.get(id)!) }))
  const archive: ArchivedTab[] = aside.archive.map((a) => ({ ...a, id: fresh(a.id, archiveTaken), spaceId }))
  return {
    ...state,
    spaces,
    folders: [...state.folders, ...folders],
    tabs: [...state.tabs, ...tabs],
    splits: [...state.splits, ...splits],
    // The archive is listed newest first.
    archive: [...state.archive, ...archive].sort((a, b) => b.archivedAt - a.archivedAt).slice(0, ARCHIVE_LIMIT),
    activeSpaceId: spaceId,
    activeTabBySpace: { ...state.activeTabBySpace, [spaceId]: aside.selected ? (tabIds.get(aside.selected) ?? null) : null }
  }
}

/** How a link rule names the space it points to: its name, its name and that it waits aside, or that it was deleted. */
export function routeTargetLabel(state: Pick<SidebarState, 'spaces' | 'sessions'>, spaceId: string): string {
  const live = state.spaces.find((s) => s.id === spaceId)
  if (live) return live.name
  const aside = state.sessions.find((s) => s.space?.space.id === spaceId)
  return aside ? t('sessions.name-mis-de-cote-la-regle-reprend', { name: aside.space!.space.name }) : t('sessions.espace-supprime')
}

/** The sessions that are spaces put aside, newest first. */
export const asideSessions = (state: Pick<SidebarState, 'sessions'>): Session[] => state.sessions.filter((s) => s.space !== undefined)

export const tabsLabel = (n: number): string => tp('sessions.onglets', n)

/** When a session was saved, in the Toolkit's words: "il y a 5 min", "il y a 3 h", "il y a 2 j", then the date. */
export function sessionAge(createdAt: number, now: number): string {
  const seconds = (now - createdAt) / 1000
  if (seconds < 60) return t('sessions.a-l-instant')
  if (seconds < 3600) return t('sessions.il-y-a-count-min', { count: Math.floor(seconds / 60) })
  if (seconds < 86_400) return t('sessions.il-y-a-count-h', { count: Math.floor(seconds / 3600) })
  if (seconds < 86_400 * 7) return t('sessions.il-y-a-count-j', { count: Math.floor(seconds / 86_400) })
  return new Date(createdAt).toLocaleDateString(getLanguage() === 'fr' ? 'fr-FR' : 'en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}
